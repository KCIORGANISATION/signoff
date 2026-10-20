import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Browser, startServer, testOutbox } from './helpers.js';

let server;
let query;
let checkDeadlines;
let deadlineSchedule;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
  ({ checkDeadlines, deadlineSchedule } = await import('../src/deadlines.js'));
});
after(() => server.stop());

const CRON_SECRET = process.env.CRON_SECRET;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let signups = 0;
async function signUp(email) {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `192.0.2.${100 + signups}` });
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', name: 'Studio Démo', email, password: 'correct horse battery' });
  return dev;
}

async function createProject(dev, frame = {}) {
  await dev.get('/projects/new');
  const response = await dev.post('/projects', {
    name: 'Atelier Lumière',
    client_name: 'Client Démo',
    client_email: 'client-demo@example.com',
    currency: 'EUR',
    ...frame,
  });
  assert.equal(response.status, 302, response.text.slice(0, 200));
  return { path: response.location, id: Number(response.location.split('/').pop()) };
}

async function sentMilestone(dev, projectPath, title = 'Maquettes') {
  await dev.get(`${projectPath}/milestones/new`);
  const created = await dev.post(`${projectPath}/milestones`, { title, amount: '500' });
  await dev.get(created.location);
  await dev.post(`${created.location}/deliverables`, { kind: 'url', label: 'Staging', url: 'https://staging.example.com' });
  await dev.post(`${created.location}/send`);
  const page = await dev.get(created.location);
  const reviewPath = new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  return { path: created.location, id: Number(created.location.split('/').pop()), reviewPath };
}

async function acceptFrameAs(client, reviewPath) {
  const page = await client.get(reviewPath);
  const version = page.text.match(/name="version" value="(\d+)"/)[1];
  return client.post(`${reviewPath}/frame`, { accept: 'yes', version });
}

async function giveFeedback(client, reviewPath, message) {
  await client.get(`${reviewPath}/review`);
  return client.post(`${reviewPath}/feedback`, { message });
}

const status = async (id) => (await query('SELECT status FROM milestones WHERE id = $1', [id]))[0].status;
const events = (id, type) => query('SELECT * FROM review_events WHERE milestone_id = $1 AND type = $2 ORDER BY id', [id, type]);

// --- 3.1 Frame ----------------------------------------------------------------

test('the client accepts the frame before their first decision; a new version asks again', async () => {
  const dev = await signUp('frame@example.com');
  const project = await createProject(dev, { frame_included: 'Cinq pages, textes fournis par le client.', frame_revisions: '2', frame_days: 'none' });
  const frames = await query('SELECT * FROM project_frames WHERE project_id = $1', [project.id]);
  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].version, frames[0].revisions, frames[0].validation_days], [1, 2, null]);

  const milestone = await sentMilestone(dev, project.path);
  const client = new Browser(server.base, { 'x-forwarded-for': '198.51.100.7' });
  let page = await client.get(milestone.reviewPath);
  assert.match(page.text, /The working frame of this project/);
  assert.match(page.text, /Cinq pages, textes fournis par le client\./);
  assert.match(page.text, /2 per milestone/);
  assert.match(page.text, /I have read and accept this frame/);

  // No decision before the frame is accepted: nothing changes, the client is sent back to the frame.
  const early = await client.post(`${milestone.reviewPath}/approve`, { name: 'Jane Client' });
  assert.equal(early.location, milestone.reviewPath);
  const earlyFeedback = await client.post(`${milestone.reviewPath}/feedback`, { message: 'Trop tôt' });
  assert.equal(earlyFeedback.location, milestone.reviewPath);
  assert.equal(await status(milestone.id), 'viewed');
  page = await client.get(`${milestone.reviewPath}/review`);
  assert.match(page.text, /Accept the frame first/);

  // The box must be ticked.
  await client.get(milestone.reviewPath);
  const unticked = await client.post(`${milestone.reviewPath}/frame`, { version: '1' });
  assert.equal(unticked.status, 400);
  assert.match(unticked.text, /Tick the box/);

  const accepted = await acceptFrameAs(client, milestone.reviewPath);
  assert.equal(accepted.location, `${milestone.reviewPath}/review`);
  const rows = await query('SELECT * FROM frame_acceptances WHERE project_id = $1', [project.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ip, '198.51.100.7');
  assert.deepEqual(rows[0].snapshot, { version: 1, included: 'Cinq pages, textes fournis par le client.', revisions: 2, validation_days: null });
  page = await client.get(`${milestone.reviewPath}/review`);
  assert.match(page.text, /Version 1, accepted on/);
  assert.match(page.text, /data-mode-set="approve"/);

  // The frame is a record: the database refuses to change it.
  await assert.rejects(query('UPDATE project_frames SET revisions = 9 WHERE project_id = $1', [project.id]), /append-only/);
  await assert.rejects(query('DELETE FROM frame_acceptances WHERE project_id = $1', [project.id]), /append-only/);

  // Saving the project without touching the frame creates no version; changing it does.
  await dev.get(`${project.path}/edit`);
  await dev.post(project.path, { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR', frame_included: 'Cinq pages, textes fournis par le client.', frame_revisions: '2', frame_days: 'none' });
  assert.equal((await query('SELECT * FROM project_frames WHERE project_id = $1', [project.id])).length, 1);
  await dev.post(project.path, { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR', frame_included: 'Six pages.', frame_revisions: '3', frame_days: '5' });
  assert.equal((await query('SELECT * FROM project_frames WHERE project_id = $1', [project.id])).length, 2);

  page = await client.get(milestone.reviewPath);
  assert.match(page.text, /The working frame has changed/);
  assert.match(page.text, /Six pages\./);
  assert.equal((await client.post(`${milestone.reviewPath}/approve`, { name: 'Jane Client' })).location, milestone.reviewPath);
  // An acceptance sent for an older version does not count for the new one.
  await client.get(milestone.reviewPath);
  assert.equal((await client.post(`${milestone.reviewPath}/frame`, { accept: 'yes', version: '1' })).location, milestone.reviewPath);
  await acceptFrameAs(client, milestone.reviewPath);
  assert.equal((await query('SELECT * FROM frame_acceptances WHERE project_id = $1', [project.id])).length, 2);

  const show = await dev.get(project.path);
  assert.match(show.text, /Version 2, accepted by the client on/);
  assert.match(show.text, /Earlier versions \(1\)/);
});

test('a project without a frame works as before: nothing to accept, unlimited revisions', async () => {
  const dev = await signUp('noframe@example.com');
  const project = await createProject(dev);
  assert.equal((await query('SELECT * FROM project_frames WHERE project_id = $1', [project.id])).length, 0);
  const milestone = await sentMilestone(dev, project.path);
  const client = new Browser(server.base);
  const welcome = await client.get(milestone.reviewPath);
  assert.doesNotMatch(welcome.text, /I have read and accept this frame/);
  assert.match(welcome.text, /\/review"/);
  await giveFeedback(client, milestone.reviewPath, 'Une petite correction');
  const [feedback] = await events(milestone.id, 'feedback');
  assert.deepEqual([feedback.round, feedback.round_limit, feedback.over_limit], [1, null, false]);
  assert.equal((await query('SELECT due_at FROM milestones WHERE id = $1', [milestone.id]))[0].due_at, null);
});

test('the frame fields are validated', async () => {
  const dev = await signUp('frame-invalid@example.com');
  await dev.get('/projects/new');
  for (const fields of [{ frame_revisions: '11' }, { frame_revisions: '-1' }, { frame_days: '0' }, { frame_days: '31' }, { frame_days: 'soon' }, { frame_included: 'x'.repeat(2001) }]) {
    const response = await dev.post('/projects', { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR', ...fields });
    assert.equal(response.status, 400, JSON.stringify(fields).slice(0, 40));
  }
  assert.equal((await query("SELECT COUNT(*)::int AS n FROM projects p JOIN users u ON u.id = p.user_id WHERE u.email = 'frame-invalid@example.com'"))[0].n, 0);
});

// --- 3.2 Revisions ------------------------------------------------------------

test('revision counter: beyond the limit the feedback is still sent, marked, and the developer decides', async () => {
  const dev = await signUp('revisions@example.com');
  const project = await createProject(dev, { frame_revisions: '1' });
  const milestone = await sentMilestone(dev, project.path);
  const client = new Browser(server.base);
  await acceptFrameAs(client, milestone.reviewPath);

  let page = await client.get(`${milestone.reviewPath}/review`);
  assert.match(page.text, /This feedback will be revision 1 of 1\./);
  await giveFeedback(client, milestone.reviewPath, 'Changer la couleur du bouton');
  assert.equal(await status(milestone.id), 'feedback');

  let devPage = await dev.get(milestone.path);
  assert.match(devPage.text, /Revision 1 of 1/);
  assert.match(devPage.text, /revision 1 of 1/);

  await dev.post(`${milestone.path}/send`);
  page = await client.get(`${milestone.reviewPath}/review`);
  assert.match(page.text, /The 1 revisions included in the frame are used/);
  const before = testOutbox.length;
  const response = await giveFeedback(client, milestone.reviewPath, 'Ajouter une page Événements');
  assert.equal(response.status, 302, 'never refused');
  assert.equal(await status(milestone.id), 'feedback');

  const feedbacks = await events(milestone.id, 'feedback');
  assert.deepEqual(feedbacks.map((f) => [f.round, f.round_limit, f.over_limit]), [[1, 1, false], [2, 1, true]]);
  const alert = testOutbox.slice(before).find((m) => m.to === 'revisions@example.com');
  assert.match(alert.subject, /beyond the included revisions/);

  devPage = await dev.get(milestone.path);
  assert.match(devPage.text, /Revision 2: beyond the 1 included/);
  assert.match(devPage.text, /Beyond the included revisions/);
  assert.ok(devPage.text.includes(`/feedback/${feedbacks[1].id}/accept`));
  assert.ok(devPage.text.includes(`/supplements/new?feedback=${feedbacks[1].id}`));

  // "Accept anyway" exists only for a feedback beyond the limit, and is recorded once.
  assert.equal((await dev.post(`${milestone.path}/feedback/${feedbacks[0].id}/accept`)).status, 404);
  await dev.post(`${milestone.path}/feedback/${feedbacks[1].id}/accept`);
  await dev.post(`${milestone.path}/feedback/${feedbacks[1].id}/accept`);
  assert.equal((await events(milestone.id, 'revision_accepted')).length, 1);
  devPage = await dev.get(milestone.path);
  assert.match(devPage.text, /Accepted anyway/);

  const other = await signUp('revisions-other@example.com');
  assert.equal((await other.post(`${milestone.path}/feedback/${feedbacks[1].id}/out-of-scope`)).status, 404);
});

// --- 3.3 Out of scope and supplements -------------------------------------------

test('out of scope → supplement: accepted becomes a new milestone, declined stays out of scope', async () => {
  const dev = await signUp('supplement@example.com');
  const project = await createProject(dev, { frame_included: 'Cinq pages.' });
  const milestone = await sentMilestone(dev, project.path);
  const client = new Browser(server.base, { 'x-forwarded-for': '198.51.100.21' });
  await acceptFrameAs(client, milestone.reviewPath);
  await giveFeedback(client, milestone.reviewPath, 'Pouvez-vous ajouter une boutique ?');
  const [feedback] = await events(milestone.id, 'feedback');

  // The form is only for a feedback of this milestone, and only for its owner.
  const stranger = await signUp('supplement-stranger@example.com');
  assert.equal((await stranger.get(`${milestone.path}/supplements/new?feedback=${feedback.id}`)).status, 404);
  assert.equal((await dev.get(`${milestone.path}/supplements/new?feedback=999999`)).status, 404);

  await dev.get(milestone.path);
  await dev.post(`${milestone.path}/feedback/${feedback.id}/out-of-scope`);
  assert.equal((await events(milestone.id, 'out_of_scope')).length, 1);

  let form = await dev.get(`${milestone.path}/supplements/new?feedback=${feedback.id}`);
  assert.match(form.text, /Pouvez-vous ajouter une boutique \?/);
  const invalid = await dev.post(`${milestone.path}/supplements`, { feedback_id: feedback.id, title: '', amount: '0' });
  assert.equal(invalid.status, 400);
  const before = testOutbox.length;
  await dev.post(`${milestone.path}/supplements`, { feedback_id: feedback.id, title: 'Boutique en ligne', description: 'Dix produits', amount: '1200,50' });
  let [supplement] = await query('SELECT * FROM supplements WHERE milestone_id = $1', [milestone.id]);
  assert.deepEqual([supplement.status, supplement.amount, supplement.currency], ['proposed', '1200.50', 'EUR']);
  const proposal = testOutbox.slice(before).find((m) => m.to === 'client-demo@example.com');
  assert.match(proposal.subject, /proposes a supplement: “Boutique en ligne”/);

  let page = await client.get(`${milestone.reviewPath}/review`);
  assert.match(page.text, /Supplement proposed/);
  assert.match(page.text, /€1,200.50/);

  // A supplement can only be answered through the link of its own milestone.
  const otherMilestone = await sentMilestone(dev, project.path, 'Pages produits');
  assert.equal((await client.post(`${otherMilestone.reviewPath}/supplements/${supplement.id}/accept`)).status, 404);
  await client.get(`${milestone.reviewPath}/review`);
  assert.equal((await client.post(`${milestone.reviewPath}/supplements/${supplement.id}/accept`, { comment: 'x'.repeat(1001) })).status, 400);

  await client.post(`${milestone.reviewPath}/supplements/${supplement.id}/accept`, { comment: 'D’accord' });
  [supplement] = await query('SELECT * FROM supplements WHERE id = $1', [supplement.id]);
  assert.equal(supplement.status, 'accepted');
  assert.equal(supplement.ip, '198.51.100.21');
  const [created] = await query('SELECT * FROM milestones WHERE id = $1', [supplement.milestone_created_id]);
  assert.deepEqual([created.project_id, created.title, created.amount, created.status], [project.id, 'Boutique en ligne', '1200.50', 'draft']);

  // A decided supplement does not change: a second answer is ignored, and the database refuses edits.
  await client.post(`${milestone.reviewPath}/supplements/${supplement.id}/decline`);
  assert.equal((await query('SELECT status FROM supplements WHERE id = $1', [supplement.id]))[0].status, 'accepted');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM milestones WHERE project_id = $1', [project.id]))[0].n, 3);
  await assert.rejects(query(`UPDATE supplements SET amount = 1 WHERE id = $1`, [supplement.id]), /locked/);
  assert.deepEqual((await events(milestone.id, 'supplement_accepted')).map((e) => e.message), ['D’accord']);

  // Declined: recorded, and the request stays out of scope.
  await dev.post(`${milestone.path}/send`);
  await giveFeedback(client, milestone.reviewPath, 'Et une version anglaise ?');
  const second = (await events(milestone.id, 'feedback'))[1];
  await dev.get(`${milestone.path}/supplements/new?feedback=${second.id}`);
  await dev.post(`${milestone.path}/supplements`, { feedback_id: second.id, title: 'Version anglaise', amount: '300' });
  const declined = (await query('SELECT * FROM supplements WHERE feedback_id = $1', [second.id]))[0];
  await client.get(`${milestone.reviewPath}/review`);
  await client.post(`${milestone.reviewPath}/supplements/${declined.id}/decline`, { comment: 'Pas maintenant' });
  assert.equal((await query('SELECT status FROM supplements WHERE id = $1', [declined.id]))[0].status, 'declined');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM milestones WHERE project_id = $1', [project.id]))[0].n, 3);
  const marks = await query(`SELECT snapshot FROM review_events WHERE milestone_id = $1 AND type = 'out_of_scope'`, [milestone.id]);
  assert.deepEqual(marks.map((m) => m.snapshot.feedback_id), [feedback.id, second.id]);

  page = await dev.get(project.path);
  assert.match(page.text, /Supplement accepted/);
  assert.match(page.text, /Supplement declined/);

  const stats = await dev.get('/stats?period=all');
  assert.match(stats.text, /<td>2<\/td><td>2<\/td><td>1 of 2<\/td><\/tr>/, 'feedback, out of scope, supplements accepted');
});

// --- 3.4 Deadlines --------------------------------------------------------------

test('deadline schedule: halfway and the day before, one reminder when the delay is short', () => {
  const sent = new Date('2026-10-01T10:00:00Z');
  const four = deadlineSchedule(sent, new Date(sent.getTime() + 4 * DAY));
  assert.deepEqual(four.reminders.map((r) => [r.kind, r.at.toISOString()]), [
    ['half', '2026-10-03T10:00:00.000Z'],
    ['eve', '2026-10-04T10:00:00.000Z'],
  ]);
  assert.deepEqual(deadlineSchedule(sent, new Date(sent.getTime() + 2 * DAY)).reminders.map((r) => r.kind), ['half']);
  assert.deepEqual(deadlineSchedule(sent, new Date(sent.getTime() + DAY)).reminders.map((r) => r.kind), ['half']);
});

test('deadlines: reminders once each, the developer told when it passes, never an automatic approval', async () => {
  const dev = await signUp('deadline@example.com');
  const project = await createProject(dev, { frame_days: '4' });
  const milestone = await sentMilestone(dev, project.path);
  const [row] = await query('SELECT due_at FROM milestones WHERE id = $1', [milestone.id]);
  const [sent] = await events(milestone.id, 'sent');
  assert.ok(Math.abs(new Date(row.due_at) - new Date(sent.created_at) - 4 * DAY) < 5000, 'due four days after the sending');

  const base = 'https://app.example.com';
  const at = (ms) => new Date(new Date(sent.created_at).getTime() + ms);
  const clientMails = () => testOutbox.filter((m) => m.to === 'client-demo@example.com' && /by /.test(m.subject));

  const startMails = clientMails().length;
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(DAY), milestoneIds: [milestone.id] }), { reminders: 0, overdue: 0 });
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(2 * DAY + HOUR), milestoneIds: [milestone.id] }), { reminders: 1, overdue: 0 });
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(2 * DAY + 2 * HOUR), milestoneIds: [milestone.id] }), { reminders: 0, overdue: 0 }, 'idempotent');
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(3 * DAY + HOUR), milestoneIds: [milestone.id] }), { reminders: 1, overdue: 0 });
  assert.equal(clientMails().length - startMails, 2);
  assert.match(clientMails().at(-1).text, new RegExp(`${base}/r/`));

  const devMails = testOutbox.filter((m) => m.to === 'deadline@example.com').length;
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(4 * DAY + HOUR), milestoneIds: [milestone.id] }), { reminders: 0, overdue: 1 });
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: at(5 * DAY), milestoneIds: [milestone.id] }), { reminders: 0, overdue: 0 });
  assert.equal(testOutbox.filter((m) => m.to === 'deadline@example.com').length - devMails, 1);
  assert.deepEqual((await events(milestone.id, 'deadline_reminder')).map((e) => e.snapshot.kind), ['half', 'eve']);
  assert.equal((await events(milestone.id, 'deadline_passed')).length, 1);
  assert.equal(await status(milestone.id), 'sent', 'nothing is approved automatically');

  // Both reminders due at once (no check ran in between): one email for the two.
  const late = await sentMilestone(dev, project.path, 'Pages produits');
  const lateSent = (await events(late.id, 'sent'))[0].created_at;
  const before = clientMails().length;
  assert.deepEqual(await checkDeadlines({ baseUrl: base, now: new Date(new Date(lateSent).getTime() + 3 * DAY + HOUR), milestoneIds: [late.id] }), { reminders: 1, overdue: 0 });
  assert.equal(clientMails().length - before, 1);
  assert.equal((await events(late.id, 'deadline_reminder')).length, 2);
});

test('the deadline route needs CRON_SECRET; the check also runs when a page opens', async () => {
  const dev = await signUp('cron@example.com');
  const project = await createProject(dev, { frame_days: '2' });
  const milestone = await sentMilestone(dev, project.path);
  await query(`UPDATE milestones SET due_at = now() - interval '1 hour' WHERE id = $1`, [milestone.id]);

  const call = (headers = {}, method = 'POST') => fetch(`${server.base}/cron/deadlines`, { method, headers });
  assert.equal((await call()).status, 401, 'no secret');
  assert.equal((await call({ authorization: 'Bearer wrong-secret' })).status, 401, 'wrong secret');
  assert.equal((await call({ authorization: `Bearer ${CRON_SECRET}x` })).status, 401, 'longer secret');
  assert.equal(await status(milestone.id), 'sent');
  assert.equal((await events(milestone.id, 'deadline_passed')).length, 0);

  const first = await call({ authorization: `Bearer ${CRON_SECRET}` });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.overdue >= 1);
  const again = await (await call({ authorization: `Bearer ${CRON_SECRET}` }, 'GET')).json();
  assert.equal(again.overdue, 0, 'calling twice changes nothing more');
  assert.equal((await events(milestone.id, 'deadline_passed')).length, 1);
  assert.equal(await status(milestone.id), 'sent', 'never approved automatically');

  const page = await dev.get(milestone.path);
  assert.match(page.text, /No answer from the client: the deadline was/);
  const home = await dev.get('/dashboard');
  assert.match(home.text, /No answer from Client Démo on “Maquettes”/);
  const client = new Browser(server.base);
  await acceptFrameAs(client, milestone.reviewPath);
  assert.match((await client.get(`${milestone.reviewPath}/review`)).text, /The decision was expected by/);

  // Opening the page records a passed deadline even if no scheduled check ran.
  const other = await sentMilestone(dev, project.path, 'Pages produits');
  await query(`UPDATE milestones SET due_at = now() - interval '1 hour' WHERE id = $1`, [other.id]);
  await dev.get(other.path);
  assert.equal((await events(other.id, 'deadline_passed')).length, 1);
});

// --- 3.5 Proof file -------------------------------------------------------------

test('the proof file gathers the records of the project, for its owner only', async () => {
  const dev = await signUp('proof@example.com');
  const project = await createProject(dev, { frame_included: 'Cinq pages.', frame_revisions: '2' });
  await dev.get(`${project.path}/milestones/new`);
  const created = await dev.post(`${project.path}/milestones`, { title: 'Maquettes', amount: '500' });
  await dev.get(created.location);
  const content = 'Bonjour, voici le brief.\n';
  const upload = await dev.upload(`${created.location}/files`, [{ name: 'brief.txt', content, type: 'text/plain' }]);
  assert.equal(upload.status, 200, upload.text);
  await dev.post(`${created.location}/send`);
  const sharePage = await dev.get(created.location);
  const reviewPath = new URL(sharePage.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;

  const client = new Browser(server.base);
  await acceptFrameAs(client, reviewPath);
  await giveFeedback(client, reviewPath, 'Plus de contraste');
  await dev.post(`${created.location}/send`);
  await client.get(`${reviewPath}/review`);
  await client.post(`${reviewPath}/approve`, { name: 'Jane Client' });

  const proof = await dev.get(`${project.path}/proof`);
  assert.equal(proof.status, 200);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  assert.ok(proof.text.includes(`SHA-256 ${sha}`), 'file fingerprint');
  assert.match(proof.text, /Accepted by the client on/);
  assert.match(proof.text, /Cinq pages\./);
  assert.match(proof.text, /Approved by Jane Client on/);
  assert.match(proof.text, /Plus de contraste/);
  assert.match(proof.text, /revision 1 of 2/);
  assert.match(proof.text, /Project created/);
  assert.match(proof.text, /not a qualified electronic signature under eIDAS/);
  assert.match(proof.text, /data-print/);

  const other = await signUp('proof-other@example.com');
  assert.equal((await other.get(`${project.path}/proof`)).status, 404);
  assert.equal((await new Browser(server.base).get(`${project.path}/proof`)).status, 302);
  assert.equal((await client.get(`${project.path}/proof`)).status, 302, 'the client link gives no access');
});

test('deleting a milestone or a project still works with frames, acceptances and supplements', async () => {
  const dev = await signUp('delete-scope@example.com');
  const project = await createProject(dev, { frame_revisions: '0' });
  const milestone = await sentMilestone(dev, project.path);
  const client = new Browser(server.base);
  await acceptFrameAs(client, milestone.reviewPath);
  await giveFeedback(client, milestone.reviewPath, 'Une demande en plus');
  const [feedback] = await events(milestone.id, 'feedback');
  assert.equal(feedback.over_limit, true, 'zero revisions included: the first feedback is beyond');
  await dev.get(`${milestone.path}/supplements/new?feedback=${feedback.id}`);
  await dev.post(`${milestone.path}/supplements`, { feedback_id: feedback.id, title: 'Page en plus', amount: '90' });

  await dev.get(milestone.path);
  assert.equal((await dev.post(`${milestone.path}/delete`)).status, 302);
  const [acceptance] = await query('SELECT milestone_id FROM frame_acceptances WHERE project_id = $1', [project.id]);
  assert.equal(acceptance.milestone_id, null, 'the acceptance stays, without its milestone');
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM supplements WHERE project_id = $1', [project.id]))[0].n, 0);

  await dev.get(project.path);
  assert.equal((await dev.post(`${project.path}/delete`)).status, 302);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM project_frames WHERE project_id = $1', [project.id]))[0].n, 0);
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM frame_acceptances WHERE project_id = $1', [project.id]))[0].n, 0);
});
