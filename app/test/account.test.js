import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Browser, approve, startServer } from './helpers.js';

let server;
let query;
let storage;
let useStorage;
let deleteAccount;
let createPasswordReset;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
  ({ storage, useStorage } = await import('../src/storage.js'));
  ({ deleteAccount } = await import('../src/account.js'));
  ({ createPasswordReset } = await import('../src/password-reset.js'));
});
after(() => server.stop());

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d5f1d00000000049454e44ae426082', 'hex');
const PASSWORD = 'correct horse battery';

let signups = 0;
async function signUp(email) {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `192.0.2.${150 + signups}` });
  await dev.get('/signup');
  const response = await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', name: 'Studio Démo', email, password: PASSWORD });
  assert.equal(response.status, 302);
  return dev;
}

async function userId(email) {
  return (await query('SELECT id FROM users WHERE email = $1', [email]))[0]?.id;
}

// An account with everything a project can hold: a frame accepted by the client, an approved
// milestone with a file, a deliverable and its certificate, a feedback over the limit with a
// proposed supplement, notes, and a pending password reset.
async function fullAccount(email) {
  const dev = await signUp(email);
  await dev.get('/projects/new');
  const project = await dev.post('/projects', {
    name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR',
    frame_included: 'Trois pages.', frame_revisions: '1', frame_days: 'none',
  });
  const projectPath = project.location;
  const projectId = Number(projectPath.split('/').pop());
  await dev.get(projectPath);
  await dev.post(`${projectPath}/notes`, { body: 'Notes privées' });

  async function sent(title) {
    await dev.get(`${projectPath}/milestones/new`);
    const created = await dev.post(`${projectPath}/milestones`, { title, amount: '300' });
    await dev.get(created.location);
    await dev.post(`${created.location}/deliverables`, { kind: 'url', label: 'Staging', url: 'https://staging.example.com' });
    const id = Number(created.location.split('/').pop());
    await dev.get(created.location);
    const upload = await dev.upload(`/milestones/${id}/files`, [{ name: `${title}.png`, content: PNG, type: 'image/png' }]);
    assert.equal(upload.status, 200, upload.text);
    await dev.post(`${created.location}/send`);
    const page = await dev.get(created.location);
    const reviewPath = new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
    return { id, path: created.location, reviewPath };
  }

  const client = new Browser(server.base, { 'x-forwarded-for': '198.51.100.9' });
  const approved = await sent('Maquettes');
  const page = await client.get(approved.reviewPath);
  const version = page.text.match(/name="version" value="(\d+)"/)[1];
  await client.post(`${approved.reviewPath}/frame`, { accept: 'yes', version });
  await approve(client, approved.reviewPath);

  const open = await sent('Pages');
  await client.get(`${open.reviewPath}/review`);
  await client.post(`${open.reviewPath}/feedback`, { message: 'Premier retour' });
  await dev.get(open.path);
  await dev.post(`${open.path}/send`);
  await client.get(`${open.reviewPath}/review`);
  await client.post(`${open.reviewPath}/feedback`, { message: 'Second retour, au-delà' });
  const feedback = (await query(`SELECT id FROM review_events WHERE milestone_id = $1 AND type = 'feedback' ORDER BY id DESC`, [open.id]))[0];
  await dev.get(`${open.path}/supplements/new?feedback=${feedback.id}`);
  const supplement = await dev.post(`${open.path}/supplements`, { feedback_id: String(feedback.id), title: 'Page en plus', amount: '150' });
  assert.equal(supplement.status, 302, supplement.text.slice(0, 300));
  const supplementId = (await query('SELECT id FROM supplements WHERE milestone_id = $1', [open.id]))[0].id;
  await client.get(`${open.reviewPath}/review`);
  await client.post(`${open.reviewPath}/supplements/${supplementId}/accept`, { comment: 'OK' });
  assert.equal((await query('SELECT status FROM supplements WHERE id = $1', [supplementId]))[0].status, 'accepted');

  await createPasswordReset(await userId(email));
  const keys = (await query(
    `SELECT f.storage_key FROM files f JOIN milestones m ON m.id = f.milestone_id WHERE m.project_id = $1`, [projectId],
  )).map((row) => row.storage_key);
  assert.equal(keys.length, 2);
  return { dev, client, projectId, approved, open, keys };
}

// Every row an account can own, counted table by table.
async function rowsOf(id, projectId) {
  const count = async (sql, params) => Number((await query(sql, params))[0].count);
  const milestones = 'SELECT id FROM milestones WHERE project_id = $1';
  return {
    users: await count('SELECT count(*) FROM users WHERE id = $1', [id]),
    password_resets: await count('SELECT count(*) FROM password_resets WHERE user_id = $1', [id]),
    projects: await count('SELECT count(*) FROM projects WHERE id = $1', [projectId]),
    milestones: await count('SELECT count(*) FROM milestones WHERE project_id = $1', [projectId]),
    deliverables: await count(`SELECT count(*) FROM deliverables WHERE milestone_id IN (${milestones})`, [projectId]),
    files: await count(`SELECT count(*) FROM files WHERE milestone_id IN (${milestones})`, [projectId]),
    review_events: await count(`SELECT count(*) FROM review_events WHERE milestone_id IN (${milestones})`, [projectId]),
    project_events: await count('SELECT count(*) FROM project_events WHERE project_id = $1', [projectId]),
    project_notes: await count('SELECT count(*) FROM project_notes WHERE project_id = $1', [projectId]),
    project_frames: await count('SELECT count(*) FROM project_frames WHERE project_id = $1', [projectId]),
    frame_acceptances: await count('SELECT count(*) FROM frame_acceptances WHERE project_id = $1', [projectId]),
    supplements: await count('SELECT count(*) FROM supplements WHERE project_id = $1', [projectId]),
  };
}

const stored = (key) => fs.existsSync(path.join(server.uploadDir, path.basename(key)));

test('"Delete my account" deletes everything, approved milestones and stored files included, and nothing of anyone else', async () => {
  const mine = await fullAccount('delete-me@example.com');
  const other = await fullAccount('keep-me@example.com');
  const id = await userId('delete-me@example.com');
  const otherId = await userId('keep-me@example.com');

  const before = await rowsOf(id, mine.projectId);
  for (const [table, count] of Object.entries(before)) assert.ok(count > 0, `${table} has rows before`);
  assert.ok(mine.keys.every(stored));

  const page = await mine.dev.get('/profile');
  assert.match(page.text, /href="\/profile\/delete"/);
  const confirm = await mine.dev.get('/profile/delete');
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /your projects \(1\) and their milestones \(3\), approved ones included/);
  assert.match(confirm.text, /your files \(2\), from the database and from file storage/);
  assert.match(confirm.text, /the links you sent to your clients stop working/);
  assert.match(confirm.text, /backups keep a copy until they expire/);
  assert.match(confirm.text, /Type DELETE to confirm/);

  const wrongPassword = await mine.dev.post('/profile/delete', { password: 'not my password', confirm: 'DELETE' });
  assert.equal(wrongPassword.status, 401);
  assert.match(wrongPassword.text, /Wrong password\. Nothing was deleted\./);
  const wrongWord = await mine.dev.post('/profile/delete', { password: PASSWORD, confirm: 'delete' });
  assert.equal(wrongWord.status, 400);
  assert.match(wrongWord.text, /Type DELETE in capital letters/);
  const noCsrf = await mine.dev.request('POST', '/profile/delete', { password: PASSWORD, confirm: 'DELETE' });
  assert.equal(noCsrf.status, 403);
  assert.deepEqual(await rowsOf(id, mine.projectId), before, 'nothing deleted by refused attempts');

  // A second browser logged in to the same account.
  const elsewhere = new Browser(server.base, { 'x-forwarded-for': '192.0.2.199' });
  await elsewhere.get('/login');
  await elsewhere.post('/login', { email: 'delete-me@example.com', password: PASSWORD });
  assert.equal((await elsewhere.get('/dashboard')).status, 200);

  await mine.dev.get('/profile/delete');
  const deleted = await mine.dev.post('/profile/delete', { password: PASSWORD, confirm: 'DELETE' });
  assert.equal(deleted.status, 302);
  assert.equal(deleted.location, '/');
  const home = await mine.dev.get('/');
  assert.match(home.text, /Your account and all its data have been deleted\./);
  assert.doesNotMatch((await mine.dev.get('/')).text, /have been deleted/, 'the message shows once');
  assert.equal((await mine.dev.get('/dashboard')).location, '/login', 'the session is over');
  assert.equal((await elsewhere.get('/dashboard')).location, '/login', 'other sessions of the account end too');

  for (const [table, count] of Object.entries(await rowsOf(id, mine.projectId))) assert.equal(count, 0, `${table} is empty`);
  assert.ok(!mine.keys.some(stored), 'stored files are deleted');
  assert.equal((await mine.client.get(mine.approved.reviewPath)).status, 404, 'client links stop working');
  assert.equal(Number((await query('SELECT count(*) FROM storage_orphans'))[0].count), 0);

  // The other account is untouched, and its approved milestone is still locked.
  const otherRows = await rowsOf(otherId, other.projectId);
  for (const [table, count] of Object.entries(otherRows)) assert.ok(count > 0, `${table} of the other account is kept`);
  assert.ok(other.keys.every(stored));
  assert.equal((await other.dev.get(other.approved.path)).status, 200);
  await assert.rejects(query(`UPDATE milestones SET title = 'Forged' WHERE id = $1`, [other.approved.id]), /locked/);
});

test('the lock on approved milestones stays whole outside account deletion', async () => {
  const account = await fullAccount('lock-after-delete@example.com');
  const { id } = account.approved;
  await deleteAccount(await userId('other-unknown@example.com'));

  await assert.rejects(query(`UPDATE milestones SET title = 'Forged' WHERE id = $1`, [id]), /locked/);
  await assert.rejects(query(`UPDATE milestones SET status = 'sent' WHERE id = $1`, [id]), /locked/);
  await assert.rejects(query('DELETE FROM deliverables WHERE milestone_id = $1', [id]), /locked/);
  await assert.rejects(query('DELETE FROM files WHERE milestone_id = $1', [id]), /locked/);
  await assert.rejects(query('DELETE FROM review_events WHERE milestone_id = $1', [id]), /append-only/);
  await assert.rejects(query(`UPDATE review_events SET client_name = 'x' WHERE milestone_id = $1`, [id]), /append-only/);
  await assert.rejects(query('DELETE FROM frame_acceptances WHERE project_id = $1', [account.projectId]), /append-only/);
  await assert.rejects(query('DELETE FROM project_frames WHERE project_id = $1', [account.projectId]), /append-only/);
});

test('when storage fails, the account is still deleted and the leftover files are listed for cleaning', async () => {
  const account = await fullAccount('storage-down@example.com');
  const id = await userId('storage-down@example.com');
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  useStorage('custom', { backend: { enabled: true, remove: async () => { throw new Error('unreachable'); } } });
  try {
    const result = await deleteAccount(id);
    assert.deepEqual(result, { files: 2, filesRemoved: false });
  } finally {
    console.error = originalError;
    useStorage('disk', { dir: server.uploadDir });
  }
  assert.equal(await userId('storage-down@example.com'), undefined);
  const orphans = (await query('SELECT storage_key FROM storage_orphans ORDER BY storage_key')).map((row) => row.storage_key);
  assert.deepEqual(orphans, [...account.keys].sort());
  assert.equal(errors.length, 1);
  assert.doesNotMatch(errors[0], /storage-down@example\.com|Camille|files\//, 'the log has no personal data and no keys');

  assert.equal(await storage.cleanOrphans(), 2);
  assert.ok(!account.keys.some(stored));
  assert.equal(Number((await query('SELECT count(*) FROM storage_orphans'))[0].count), 0);
});

test('account deletion is rate limited', async () => {
  const dev = await signUp('delete-rate@example.com');
  for (let i = 0; i < 5; i += 1) {
    await dev.get('/profile/delete');
    assert.equal((await dev.post('/profile/delete', { password: 'wrong', confirm: 'DELETE' })).status, 401);
  }
  await dev.get('/profile/delete');
  const blocked = await dev.post('/profile/delete', { password: PASSWORD, confirm: 'DELETE' });
  assert.equal(blocked.status, 429);
  assert.ok(await userId('delete-rate@example.com'), 'still there');
});

// --- Admin scripts -------------------------------------------------------------

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function runScript(name, args, env = {}) {
  const clean = { ...process.env, DATABASE_URL: '', ...env };
  return spawnSync(process.execPath, [path.join('scripts', name), ...args], { cwd: appDir, env: clean, encoding: 'utf8', input: '' });
}

test('the admin scripts refuse to run without DATABASE_URL', () => {
  for (const script of ['admin-reset-password.js', 'admin-delete-user.js', 'admin-clean-storage.js']) {
    const result = runScript(script, ['someone@example.com']);
    assert.equal(result.status, 1, script);
    assert.match(result.stderr, /DATABASE_URL is not set/, script);
    assert.equal(result.stdout, '', script);
  }
});

test('the admin scripts need an email', () => {
  const result = runScript('admin-delete-user.js', [], { DATABASE_URL: 'postgresql://nobody@127.0.0.1:1/none' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: npm run admin:delete-user -- <email>/);
});

test('the reset link the admin script hands out lets the tester choose a new password once', async () => {
  await signUp('forgot-beta@example.com');
  const token = await createPasswordReset(await userId('forgot-beta@example.com'), 24 * 60);
  const [reset] = await query(`SELECT expires_at > now() + interval '23 hours' AS long FROM password_resets WHERE user_id = $1 ORDER BY id DESC`, [await userId('forgot-beta@example.com')]);
  assert.equal(reset.long, true);

  const tester = new Browser(server.base);
  assert.equal((await tester.get(`/reset/${token}`)).status, 200);
  const changed = await tester.post(`/reset/${token}`, { password: 'a brand new password' });
  assert.equal(changed.location, '/dashboard');
  assert.equal((await new Browser(server.base).get(`/reset/${token}`)).status, 410, 'only once');
});
