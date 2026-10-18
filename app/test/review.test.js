import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, approve, startServer, testOutbox } from './helpers.js';
import { describe, renderFeedback } from '../src/text.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PAY_LINK = 'https://buy.stripe.com/test_preview_secret';

let server;
let query;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
});
after(() => server.stop());

let accounts = 0;
async function devWithMilestone(fields = {}) {
  accounts += 1;
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name: 'Review Studio', email: `review-${accounts}@example.com`, password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Atelier', client_name: 'Acme', client_email: `client-${accounts}@example.com`, currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const milestone = await dev.post(`${project.location}/milestones`, { title: 'Homepage v1', amount: '500', ...fields });
  const milestoneId = Number(milestone.location.split('/').pop());
  return { dev, projectPath: project.location, milestonePath: `/milestones/${milestoneId}`, milestoneId, clientEmail: `client-${accounts}@example.com` };
}

async function sendToClient(dev, milestonePath) {
  await dev.get(milestonePath);
  await dev.post(`${milestonePath}/send`);
  const page = await dev.get(milestonePath);
  return new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
}

const events = (milestoneId) => query('SELECT * FROM review_events WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
const status = async (milestoneId) => (await query('SELECT status FROM milestones WHERE id = $1', [milestoneId]))[0].status;

test('descriptions become paragraphs, lists and a "not included" note', () => {
  const blocks = describe('New homepage:\n- header\n- contact form\n\nPas inclus : pricing page, blog.\n\nThanks!');
  assert.deepEqual(blocks, [
    { type: 'text', text: 'New homepage:' },
    { type: 'list', items: ['header', 'contact form'] },
    { type: 'excluded', label: 'Pas inclus', text: 'pricing page, blog.' },
    { type: 'text', text: 'Thanks!' },
  ]);
  assert.deepEqual(describe(''), []);
});

test('file citations in feedback are escaped first, then linked to the file they named', () => {
  const files = [{ id: 7, name: 'home "v2".png' }, { id: 9, name: 'brief.pdf' }];
  const html = renderFeedback('<img src=x onerror=alert(1)> /fichier1 & /file2, /file3, a/file1, /fichier1x', files, (file) =>
    file.id === 9 ? null : `/milestones/3/files/${file.id}`,
  );
  assert.ok(html.startsWith('&lt;img src=x onerror=alert(1)&gt; '), 'raw HTML is escaped');
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<a class="cite" href="/milestones/3/files/7" target="_blank" rel="noopener" title="home &#34;v2&#34;.png">/fichier1</a>'));
  assert.ok(html.includes('&amp; <span class="cite cite-missing">/file2</span>'), 'a file that is gone is not a link');
  assert.ok(html.includes('<span class="cite cite-missing">/file3</span>'), 'a number past the list is not a link');
  assert.ok(html.includes('a/file1'), 'only a whole citation counts');
  assert.ok(html.includes('/fichier1x'));
  assert.equal(renderFeedback('/file1', null, () => '/x'), '<span class="cite cite-missing">/file1</span>', 'old feedback without a file list');
});

test('the client link opens on a welcome card, then the milestone page; approving needs a full name', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  const reviewPath = await sendToClient(dev, milestonePath);

  const client = new Browser(server.base, { 'x-forwarded-for': '192.0.2.10' });
  const welcome = await client.get(reviewPath);
  assert.equal(welcome.status, 200);
  assert.match(welcome.text, /Review Studio is asking you to approve a milestone/);
  assert.match(welcome.text, /Milestone 1 of 1/);
  assert.match(welcome.text, /€500\.00/);
  assert.ok(welcome.text.includes(`href="${reviewPath}/review"`));
  assert.equal(await status(milestoneId), 'viewed');

  const page = await client.get(`${reviewPath}/review`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Homepage v1/);
  assert.match(page.text, /Sent by Review Studio on/);
  assert.ok(page.text.includes(`action="${reviewPath}/approve"`));
  assert.equal((await events(milestoneId)).filter((e) => e.type === 'viewed').length, 1, 'viewed is recorded once');

  const noName = await client.post(`${reviewPath}/approve`, { name: '   ' });
  assert.equal(noName.status, 400);
  assert.match(noName.text, /Type your full name to approve the milestone\./);
  assert.equal(await status(milestoneId), 'viewed', 'nothing recorded without a name');

  const tooLong = await client.post(`${reviewPath}/approve`, { name: 'x'.repeat(121) });
  assert.equal(tooLong.status, 400);

  const approved = await client.post(`${reviewPath}/approve`, { name: '  Marie   Dupont ' });
  assert.equal(approved.status, 302);
  const approval = (await events(milestoneId)).find((e) => e.type === 'approved');
  assert.equal(approval.client_name, 'Marie Dupont');
  assert.match((await client.get(reviewPath)).text, /Recorded in the name of Marie Dupont/);
  assert.match((await dev.get(`${milestonePath}/certificate`)).text, /Marie Dupont/);
  assert.ok(testOutbox.some((email) => /Marie Dupont approved "Homepage v1"/.test(email.subject)));
});

test('feedback keeps the files in the order the client saw them, and the developer sees /fichierN as links', async () => {
  const { dev, milestonePath, milestoneId } = await devWithMilestone();
  await dev.get(milestonePath);
  await dev.upload(`${milestonePath}/files`, [{ name: 'home.png', content: PNG }]);
  await dev.upload(`${milestonePath}/files`, [{ name: 'brief.pdf', content: PDF }]);
  const files = await query('SELECT id, name FROM files WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
  const reviewPath = await sendToClient(dev, milestonePath);

  const client = new Browser(server.base);
  const page = await client.get(`${reviewPath}/review`);
  assert.ok(page.text.includes('data-cite="/file1"'), 'one pill per file');
  assert.ok(page.text.includes('data-cite="/file2"'));

  const message = 'On /fichier2 the logo is blurry. /file1 <b>looks</b> great.';
  assert.equal((await client.post(`${reviewPath}/feedback`, { message })).status, 302);

  const feedback = (await events(milestoneId)).find((e) => e.type === 'feedback');
  assert.equal(feedback.message, message, 'stored as plain text');
  assert.deepEqual(feedback.files, files.map(({ id, name }) => ({ id, name })));

  const sent = await client.get(reviewPath);
  assert.match(sent.text, /Feedback sent/);

  let devPage = await dev.get(milestonePath);
  assert.ok(devPage.text.includes(`<a class="cite" href="/milestones/${milestoneId}/files/${files[1].id}" target="_blank" rel="noopener" title="brief.pdf">/fichier2</a>`));
  assert.ok(devPage.text.includes(`href="/milestones/${milestoneId}/files/${files[0].id}"`));
  assert.ok(devPage.text.includes('&lt;b&gt;looks&lt;/b&gt;'), 'the feedback text is escaped');
  assert.ok(!devPage.text.includes('<b>looks</b>'));

  // The developer removes the first file: /fichier2 still points at brief.pdf, /file1 is no longer a link.
  await dev.post(`${milestonePath}/files/${files[0].id}/delete`);
  devPage = await dev.get(milestonePath);
  assert.ok(devPage.text.includes(`href="/milestones/${milestoneId}/files/${files[1].id}" target="_blank" rel="noopener" title="brief.pdf">/fichier2</a>`));
  assert.ok(devPage.text.includes('<span class="cite cite-missing">/file1</span>'));
});

test('"view as client" shows the client page without sending, recording or revealing anything', async () => {
  const { dev, milestonePath, milestoneId, clientEmail } = await devWithMilestone({ payment_link: PAY_LINK, payment_note: 'IBAN BE99 preview' });

  const draft = await dev.get(`${milestonePath}/preview`);
  assert.equal(draft.status, 200);
  assert.match(draft.text, /Preview: this is what your client sees/);
  assert.match(draft.text, /Homepage v1/);
  assert.match(draft.text, /Approve this milestone/);
  assert.doesNotMatch(draft.text, /action="\/r\//, 'no form posts to the client link');
  assert.ok(!draft.text.includes(PAY_LINK) && !draft.text.includes('BE99'), 'no payment details before approval');
  assert.equal(await status(milestoneId), 'draft');
  assert.equal((await events(milestoneId)).length, 0);
  assert.equal(testOutbox.filter((email) => email.to === clientEmail).length, 0, 'no email to the client');

  await sendToClient(dev, milestonePath);
  const before = (await events(milestoneId)).length;
  await dev.get(`${milestonePath}/preview`);
  assert.equal(await status(milestoneId), 'sent', 'the preview is not a client view');
  assert.equal((await events(milestoneId)).length, before);

  const stranger = new Browser(server.base);
  await stranger.get('/signup');
  await stranger.post('/signup', { invite_code: 'beta-2026', name: 'Other', email: 'review-stranger@example.com', password: 'correct horse battery' });
  assert.equal((await stranger.get(`${milestonePath}/preview`)).status, 404);
  assert.equal((await new Browser(server.base).get(`${milestonePath}/preview`)).status, 302, 'login required');
});

test('the milestone form saves a draft, opens the preview, or sends to the client', async () => {
  const { dev, projectPath } = await devWithMilestone();

  await dev.get(`${projectPath}/milestones/new`);
  const preview = await dev.post(`${projectPath}/milestones`, { title: 'Preview first', intent: 'preview' });
  assert.match(preview.location, /^\/milestones\/\d+\/preview$/);
  const previewId = Number(preview.location.split('/')[2]);
  assert.equal(await status(previewId), 'draft');

  await dev.get(`/milestones/${previewId}/edit`);
  const sent = await dev.post(`/milestones/${previewId}`, { title: 'Preview first', intent: 'send' });
  assert.equal(sent.location, `/milestones/${previewId}#share`);
  assert.equal(await status(previewId), 'sent');
  assert.ok(testOutbox.some((email) => email.subject.includes('"Preview first"')));

  await dev.get(`/milestones/${previewId}/edit`);
  const saved = await dev.post(`/milestones/${previewId}`, { title: 'Preview first, renamed', intent: 'save' });
  assert.equal(saved.location, `/milestones/${previewId}`);
  assert.equal(await status(previewId), 'sent');
});

test('every page uses the same stylesheet and self-hosted fonts', async () => {
  const visitor = new Browser(server.base);
  const css = await visitor.get('/style.css');
  assert.match(css.text, /--green: #3ee08f/);
  assert.match(css.text, /prefers-reduced-motion/);
  assert.doesNotMatch(css.text, /url\(['"]?https?:|@import/, 'nothing loaded from another site');
  const logo = await visitor.get('/logo.svg');
  assert.match(logo.headers.get('content-type'), /image\/svg\+xml/);
  const login = await visitor.get('/login');
  assert.ok(login.text.includes('href="/style.css"'));
  assert.ok(login.text.includes('href="/favicon.svg"'));
});
