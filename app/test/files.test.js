import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Browser, startServer } from './helpers.js';
import { load } from '../src/config.js';
import { ACCOUNT_QUOTA_BYTES, MAX_FILE_BYTES, detectType } from '../src/files.js';

// A real 1x1 PNG, a minimal PDF and a few files that must be refused whatever their name.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const HTML = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)]);
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

let server;
let query;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
});
after(() => server.stop());

let accounts = 0;
async function devWithMilestone(title = 'Mockups') {
  accounts += 1;
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name: 'Files Studio', email: `files-${accounts}@example.com`, password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'App', client_name: 'Acme', client_email: 'acme@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const milestone = await dev.post(`${project.location}/milestones`, { title });
  await dev.get(milestone.location);
  return { dev, projectPath: project.location, milestonePath: milestone.location, milestoneId: Number(milestone.location.split('/').pop()) };
}

async function sendToClient(dev, milestonePath) {
  await dev.get(milestonePath);
  await dev.post(`${milestonePath}/send`);
  const page = await dev.get(milestonePath);
  return new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
}

const fileRows = (milestoneId) => query('SELECT * FROM files WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
const stored = (row) => fs.existsSync(`${server.uploadDir}/${row.storage_key.split('/').pop()}`);

test('storage: R2 with the four variables, disk in development, turned off in production without them', () => {
  const production = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), APP_URL: 'https://app.example', DATABASE_URL: 'postgres://db', INVITE_CODE: 'code' };
  const r2 = { FILES_R2_ACCESS_KEY_ID: 'id', FILES_R2_SECRET_ACCESS_KEY: 'secret', FILES_R2_BUCKET: 'signoff-files', FILES_R2_ENDPOINT: 'https://acc.eu.r2.cloudflarestorage.com' };
  assert.equal(load(production).files.storage, 'disabled');
  assert.equal(load({ ...production, FILES_R2_BUCKET: 'signoff-files' }).files.storage, 'disabled');
  assert.equal(load({ ...production, ...r2 }).files.storage, 'r2');
  assert.equal(load({ NODE_ENV: 'test' }).files.storage, 'disk');
});

test('the file type is checked on the real content, not the name or the type sent', async () => {
  assert.equal(detectType(PNG, 'a.png'), 'png');
  assert.equal(detectType(PDF, 'a.pdf'), 'pdf');
  assert.equal(detectType(Buffer.from('Notes\nLine 2'), 'notes.txt'), 'txt');
  assert.equal(detectType(HTML, 'photo.png'), null);
  assert.equal(detectType(HTML, 'page.txt'), null);
  assert.equal(detectType(SVG, 'logo.svg'), null);
  assert.equal(detectType(SVG, 'logo.txt'), null);
  assert.equal(detectType(EXE, 'report.pdf'), null);
  assert.equal(detectType(ZIP, 'notes.txt'), null);
  assert.equal(detectType(Buffer.from('echo hi'), 'script.sh'), null);

  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  const refused = [
    { name: 'photo.png', content: HTML, type: 'image/png' },
    { name: 'logo.svg', content: SVG, type: 'image/svg+xml' },
    { name: 'logo.png', content: SVG, type: 'image/png' },
    { name: 'invoice.pdf', content: EXE, type: 'application/pdf' },
    { name: 'archive.txt', content: ZIP, type: 'text/plain' },
    { name: 'page.html', content: HTML, type: 'text/html' },
  ];
  for (const file of refused) {
    const response = await dev.upload(`${milestonePath}/files`, [file]);
    assert.equal(response.status, 415, file.name);
    assert.match(JSON.parse(response.text).error, /was refused/);
  }
  assert.equal((await fileRows(milestoneId)).length, 0);

  const accepted = await dev.upload(`${milestonePath}/files`, [
    { name: 'home.png', content: PNG, type: 'image/png' },
    { name: '../../evil.html', content: PNG, type: 'text/html' },
    { name: 'brief.pdf', content: PDF },
    { name: 'notes.md', content: Buffer.from('# Notes\nAll good') },
  ]);
  assert.equal(accepted.status, 200);
  const rows = await fileRows(milestoneId);
  assert.deepEqual(rows.map((row) => [row.name, row.mime]), [
    ['home.png', 'image/png'],
    ['evil.png', 'image/png'],
    ['brief.pdf', 'application/pdf'],
    ['notes.md', 'text/plain; charset=utf-8'],
  ]);
  assert.equal(rows[0].sha256, sha(PNG));
  assert.match(rows[0].storage_key, /^files\/[0-9a-f]{48}$/, 'random storage key, not the file name');
  assert.ok(rows.every(stored));
});

test('size, count and account quota limits', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();

  const tooBig = Buffer.concat([PNG, Buffer.alloc(MAX_FILE_BYTES + 1 - PNG.length)]);
  const big = await dev.upload(`${milestonePath}/files`, [{ name: 'big.png', content: tooBig }]);
  assert.equal(big.status, 413);
  assert.match(JSON.parse(big.text).error, /10 MB at most/);

  for (let index = 0; index < 10; index += 1) {
    assert.equal((await dev.upload(`${milestonePath}/files`, [{ name: `shot-${index}.png`, content: PNG }])).status, 200);
  }
  const eleventh = await dev.upload(`${milestonePath}/files`, [{ name: 'shot-10.png', content: PNG }]);
  assert.equal(eleventh.status, 400);
  assert.match(JSON.parse(eleventh.text).error, /10 files at most/);
  assert.equal((await fileRows(milestoneId)).length, 10);

  const other = await devWithMilestone();
  await query(
    `INSERT INTO files (milestone_id, storage_key, name, mime, size, sha256) VALUES ($1, $2, 'huge.pdf', 'application/pdf', $3, 'x')`,
    [other.milestoneId, `files/quota-${other.milestoneId}`, ACCOUNT_QUOTA_BYTES - 50],
  );
  const overQuota = await other.dev.upload(`${other.milestonePath}/files`, [{ name: 'one-more.png', content: PNG }]);
  assert.equal(overQuota.status, 413);
  assert.match(JSON.parse(overQuota.text).error, /200 MB of storage/);
});

test('uploads need the CSRF token and an account', async () => {
  const { dev, milestonePath } = await devWithMilestone();
  const forged = await dev.upload(`${milestonePath}/files`, [{ name: 'a.png', content: PNG }], { csrf: 'forged' });
  assert.equal(forged.status, 403);

  const anonymous = new Browser(server.base);
  const response = await anonymous.upload(`${milestonePath}/files`, [{ name: 'a.png', content: PNG }]);
  assert.equal(response.status, 302);
  assert.equal(response.location, '/login');
});

test('files are served only to their developer and to a valid client link, with safe headers', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  await dev.upload(`${milestonePath}/files`, [{ name: 'home.png', content: PNG }, { name: 'brief.pdf', content: PDF }]);
  const [image, pdf] = await fileRows(milestoneId);
  const reviewPath = await sendToClient(dev, milestonePath);

  const own = await dev.download(`${milestonePath}/files/${image.id}`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, PNG);
  assert.equal(own.headers.get('content-type'), 'image/png');
  assert.match(own.headers.get('content-disposition'), /^inline; filename="?home\.png"?/);
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');

  const document = await dev.download(`${milestonePath}/files/${pdf.id}`);
  assert.match(document.headers.get('content-disposition'), /^attachment; filename="?brief\.pdf"?/);

  const intruder = await devWithMilestone();
  assert.equal((await intruder.dev.download(`${milestonePath}/files/${image.id}`)).status, 404);
  assert.equal((await intruder.dev.download(`${intruder.milestonePath}/files/${image.id}`)).status, 404);

  const client = new Browser(server.base);
  const review = await client.get(reviewPath);
  assert.ok(review.text.includes(`${reviewPath}/files/${image.id}`), 'thumbnail on the review page');
  assert.match(review.text, /brief\.pdf/);
  const viaLink = await client.download(`${reviewPath}/files/${pdf.id}`);
  assert.equal(viaLink.status, 200);
  assert.deepEqual(viaLink.body, PDF);
  assert.equal(viaLink.headers.get('x-content-type-options'), 'nosniff');
  assert.match(viaLink.headers.get('content-disposition'), /^attachment/);

  assert.equal((await client.download(`/r/not-the-right-token-at-all-000000/files/${image.id}`)).status, 404);
  const otherReview = await sendToClient(intruder.dev, intruder.milestonePath);
  assert.equal((await client.download(`${otherReview}/files/${image.id}`)).status, 404, 'a link for another milestone');
  assert.equal((await new Browser(server.base).download(`${milestonePath}/files/${image.id}`)).status, 302, 'no session');
});

test('after approval, files are frozen and listed with their fingerprint in the certificate', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  await dev.upload(`${milestonePath}/files`, [{ name: 'home.png', content: PNG }, { name: 'brief.pdf', content: PDF }]);
  const reviewPath = await sendToClient(dev, milestonePath);
  const client = new Browser(server.base);
  await client.get(reviewPath);
  await client.post(`${reviewPath}/approve`);
  const [image] = await fileRows(milestoneId);

  await dev.get(milestonePath);
  assert.equal((await dev.upload(`${milestonePath}/files`, [{ name: 'late.png', content: PNG }])).status, 409);
  assert.equal((await dev.post(`${milestonePath}/files/${image.id}/delete`)).status, 409);
  await assert.rejects(query('DELETE FROM files WHERE id = $1', [image.id]), /locked/);
  await assert.rejects(query(`UPDATE files SET sha256 = 'forged' WHERE id = $1`, [image.id]), /locked/);
  await assert.rejects(
    query(`INSERT INTO files (milestone_id, storage_key, name, mime, size, sha256) VALUES ($1, 'files/x', 'x.png', 'image/png', 1, 'x')`, [milestoneId]),
    /locked/,
  );
  const rows = await fileRows(milestoneId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(stored));

  const page = await dev.get(milestonePath);
  assert.doesNotMatch(page.text, /data-upload/, 'no drop zone');
  assert.doesNotMatch(page.text, /\/files\/\d+\/delete/, 'no delete button');

  for (const certificate of [await dev.get(`${milestonePath}/certificate`), await client.get(`${reviewPath}/certificate`)]) {
    assert.match(certificate.text, /home\.png/);
    assert.match(certificate.text, /brief\.pdf/);
    assert.ok(certificate.text.includes(sha(PNG)));
    assert.ok(certificate.text.includes(sha(PDF)));
  }
});

test('deleting a milestone or a project deletes its files from storage', async () => {
  const first = await devWithMilestone();
  await first.dev.upload(`${first.milestonePath}/files`, [{ name: 'a.png', content: PNG }]);
  const [fileA] = await fileRows(first.milestoneId);
  assert.ok(stored(fileA));
  await first.dev.get(`${first.milestonePath}/edit`);
  await first.dev.post(`${first.milestonePath}/delete`);
  assert.ok(!stored(fileA));

  const second = await devWithMilestone();
  await second.dev.upload(`${second.milestonePath}/files`, [{ name: 'b.pdf', content: PDF }]);
  const [fileB] = await fileRows(second.milestoneId);
  const reviewPath = await sendToClient(second.dev, second.milestonePath);
  const client = new Browser(server.base);
  await client.get(reviewPath);
  await client.post(`${reviewPath}/approve`);

  await second.dev.get(second.projectPath);
  const deleted = await second.dev.post(`${second.projectPath}/delete`);
  assert.equal(deleted.status, 302);
  assert.ok(!stored(fileB), 'approved files go too when the project is deleted');
  assert.equal((await fileRows(second.milestoneId)).length, 0);
});

test('a developer can delete a file before approval', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  await dev.upload(`${milestonePath}/files`, [{ name: 'draft.png', content: PNG }]);
  const [file] = await fileRows(milestoneId);
  await dev.get(milestonePath);
  const response = await dev.post(`${milestonePath}/files/${file.id}/delete`);
  assert.equal(response.status, 302);
  assert.equal((await fileRows(milestoneId)).length, 0);
  assert.ok(!stored(file));
});
