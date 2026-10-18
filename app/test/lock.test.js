import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer } from './helpers.js';

let server;
let query;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
});
after(() => server.stop());

function certificateBody(page) {
  return page.text.match(/<article class="certificate">[\s\S]*<\/article>/)[0];
}

// A developer, a project and a milestone with one deliverable, approved by the client.
async function approvedMilestone(email) {
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name: 'Lock Studio', email, password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Brand', client_name: 'Acme', client_email: 'acme@example.com', currency: 'EUR' });
  const projectPath = project.location;

  await dev.get(`${projectPath}/milestones/new`);
  const created = await dev.post(`${projectPath}/milestones`, {
    title: 'Logo v1',
    description: 'Three proposals',
    amount: '900',
    payment_link: 'https://buy.stripe.com/first',
  });
  const milestonePath = created.location;
  const milestoneId = Number(milestonePath.split('/').pop());
  await dev.get(milestonePath);
  await dev.post(`${milestonePath}/deliverables`, { kind: 'url', label: 'Figma', url: 'https://figma.com/file/abc' });
  const draft = await dev.get(milestonePath);
  const deliverableAction = draft.text.match(/action="(\/milestones\/\d+\/deliverables\/\d+\/delete)"/)[1];
  await dev.post(`${milestonePath}/send`);
  const sent = await dev.get(milestonePath);
  const reviewPath = new URL(sent.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;

  const client = new Browser(server.base, { 'x-forwarded-for': '198.51.100.4', 'user-agent': 'LockBrowser/2.0' });
  await client.get(reviewPath);
  await client.post(`${reviewPath}/approve`);

  return { dev, client, projectPath, milestonePath, milestoneId, deliverableAction, reviewPath };
}

test('an approved milestone is locked on the server and its certificate does not change', async () => {
  const { dev, milestonePath, deliverableAction } = await approvedMilestone('lock@example.com');
  const before = certificateBody(await dev.get(`${milestonePath}/certificate`));
  assert.match(before, /Logo v1/);
  assert.match(before, /Three proposals/);
  assert.match(before, /figma\.com\/file\/abc/);
  assert.match(before, /198\.51\.100\.4/);
  assert.match(before, /LockBrowser\/2\.0/);
  assert.match(before, /Acme/);

  const page = await dev.get(milestonePath);
  assert.match(page.text, /This milestone is approved and locked\. Any change goes in a new milestone\./);
  assert.match(page.text, /Create a follow-up milestone/);
  assert.doesNotMatch(page.text, /\/deliverables\/\d+\/delete/, 'no remove button');
  assert.doesNotMatch(page.text, /action="\/milestones\/\d+\/deliverables"/, 'no add form');

  const edit = await dev.get(`${milestonePath}/edit`);
  assert.doesNotMatch(edit.text, /name="title"/, 'the edit page only offers payment fields');
  assert.match(edit.text, /name="payment_link"/);

  const attempts = [
    [milestonePath, { title: 'Logo v2', description: 'Changed', amount: '1' }],
    [`${milestonePath}/deliverables`, { kind: 'url', label: 'New', url: 'https://example.com/new' }],
    [`${milestonePath}/deliverables`, { kind: 'note', label: 'New', body: 'Added later' }],
    [deliverableAction, {}],
  ];
  for (const [path, form] of attempts) {
    const response = await dev.post(path, form);
    assert.equal(response.status, 409, path);
  }

  const after = certificateBody(await dev.get(`${milestonePath}/certificate`));
  assert.equal(after, before, 'the certificate is unchanged');
  const unchanged = await dev.get(milestonePath);
  assert.match(unchanged.text, /Logo v1/);
  assert.doesNotMatch(unchanged.text, /Logo v2|Added later|example\.com\/new/);
});

test('the payment link stays editable after approval', async () => {
  const { dev, client, milestonePath, reviewPath } = await approvedMilestone('lock-payment@example.com');
  const before = certificateBody(await dev.get(`${milestonePath}/certificate`));

  await dev.get(`${milestonePath}/edit`);
  const invalid = await dev.post(`${milestonePath}/payment`, { payment_link: 'javascript:alert(1)' });
  assert.equal(invalid.status, 400);

  const saved = await dev.post(`${milestonePath}/payment`, {
    payment_link: 'https://paypal.me/lockstudio/900',
    payment_note: 'IBAN BE71 0961 2345 6769',
  });
  assert.equal(saved.status, 302);

  const review = await client.get(reviewPath);
  assert.ok(review.text.includes('href="https://paypal.me/lockstudio/900"'));
  assert.match(review.text, /IBAN BE71 0961 2345 6769/);
  assert.doesNotMatch(review.text, /buy\.stripe\.com\/first/);

  assert.equal(certificateBody(await dev.get(`${milestonePath}/certificate`)), before);
});

test('"Create a follow-up milestone" starts a new draft in the same project', async () => {
  const { dev, projectPath, milestonePath } = await approvedMilestone('lock-follow@example.com');
  await dev.get(milestonePath);
  const response = await dev.post(`${milestonePath}/follow-up`);
  assert.equal(response.status, 302);
  assert.match(response.location, /^\/milestones\/\d+\/edit$/);

  const form = await dev.get(response.location);
  assert.match(form.text, /value="Logo v1 \(follow-up\)"/);
  assert.match(form.text, /name="title"/, 'the follow-up is editable');

  const project = await dev.get(projectPath);
  assert.match(project.text, /Logo v1 \(follow-up\)/);
  assert.match(project.text, /badge-draft/);
});

test('the database refuses to change an approval record or a locked milestone', async () => {
  const { dev, projectPath, milestoneId } = await approvedMilestone('lock-db@example.com');

  await assert.rejects(query(`UPDATE review_events SET ip = '0.0.0.0' WHERE milestone_id = $1`, [milestoneId]), /append-only/);
  await assert.rejects(query(`DELETE FROM review_events WHERE milestone_id = $1`, [milestoneId]), /append-only/);
  await assert.rejects(query(`UPDATE milestones SET title = 'Forged' WHERE id = $1`, [milestoneId]), /locked/);
  await assert.rejects(query(`UPDATE milestones SET status = 'sent' WHERE id = $1`, [milestoneId]), /locked/);
  await assert.rejects(query(`DELETE FROM deliverables WHERE milestone_id = $1`, [milestoneId]), /locked/);
  await assert.rejects(
    query(`INSERT INTO deliverables (milestone_id, kind, body) VALUES ($1, 'note', 'x')`, [milestoneId]),
    /locked/,
  );
  await query(`UPDATE milestones SET payment_note = 'ok' WHERE id = $1`, [milestoneId]);

  await dev.get(projectPath);
  const deleted = await dev.post(`${projectPath}/delete`);
  assert.equal(deleted.status, 302, 'deleting the project still removes everything');
  assert.equal((await query('SELECT 1 FROM review_events WHERE milestone_id = $1', [milestoneId])).length, 0);
  assert.equal((await query('SELECT 1 FROM deliverables WHERE milestone_id = $1', [milestoneId])).length, 0);
});
