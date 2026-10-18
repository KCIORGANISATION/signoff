import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, approve, startServer } from './helpers.js';
import { parsePaymentLink, parsePaymentNote } from '../src/payment.js';

const LINK = 'https://buy.stripe.com/test_4gw5kE9xY';
const NOTE = 'IBAN BE71 0961 2345 6769\n<script>alert("x")</script> & "Invoice 14"';

let server;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

async function signUp(email) {
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name: 'Payment Studio', email, password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Shop', client_name: 'Acme', client_email: 'acme@example.com', currency: 'EUR' });
  return { dev, projectPath: project.location };
}

test('payment link validation: https only, valid URL, 500 characters max', () => {
  assert.equal(parsePaymentLink(LINK), LINK);
  assert.equal(parsePaymentLink('  https://paypal.me/studio  '), 'https://paypal.me/studio');
  assert.equal(parsePaymentLink(''), null);
  assert.equal(parsePaymentLink(undefined), null);

  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://buy.stripe.com/test',
    'https//buy.stripe.com',
    'not a url',
    'https://',
    'https://exa mple.com/pay',
    'https://checkout.stripe.com@evil.example/pay',
    'ftp://files.example.com',
    `https://example.com/${'a'.repeat(500)}`,
  ]) {
    assert.equal(parsePaymentLink(bad), false, bad);
  }

  assert.equal(parsePaymentNote('  IBAN BE00  '), 'IBAN BE00');
  assert.equal(parsePaymentNote(''), null);
  assert.equal(parsePaymentNote('x'.repeat(500)), 'x'.repeat(500));
  assert.equal(parsePaymentNote('x'.repeat(501)), false);
});

test('invalid payment links are refused by the milestone form', async () => {
  const { dev, projectPath } = await signUp('payment-form@example.com');

  for (const payment_link of ['javascript:alert(1)', 'http://buy.stripe.com/test', 'https//broken', 'data:text/html,hi']) {
    await dev.get(`${projectPath}/milestones/new`);
    const response = await dev.post(`${projectPath}/milestones`, { title: 'Design', payment_link });
    assert.equal(response.status, 400, payment_link);
    assert.match(response.text, /payment link must be a valid https:\/\/ URL/);
  }

  await dev.get(`${projectPath}/milestones/new`);
  const longNote = await dev.post(`${projectPath}/milestones`, { title: 'Design', payment_note: 'x'.repeat(501) });
  assert.equal(longNote.status, 400);

  const project = await dev.get(projectPath);
  assert.doesNotMatch(project.text, /Design/, 'nothing was saved');

  await dev.get(`${projectPath}/milestones/new`);
  const created = await dev.post(`${projectPath}/milestones`, { title: 'Design', payment_link: LINK });
  assert.equal(created.status, 302);

  await dev.get(`${created.location}/edit`);
  const edit = await dev.post(created.location, { title: 'Design', payment_link: 'javascript:alert(1)' });
  assert.equal(edit.status, 400);
  const page = await dev.get(created.location);
  assert.ok(page.text.includes(LINK), 'the previous link is kept');
});

test('the payment link and note reach the client only after approval', async () => {
  const { dev, projectPath } = await signUp('payment-flow@example.com');

  await dev.get(`${projectPath}/milestones/new`);
  const form = await dev.get(`${projectPath}/milestones/new`);
  assert.match(form.text, /Visible to the client only after they approve\. Signoff does not process any payment\./);
  const created = await dev.post(`${projectPath}/milestones`, {
    title: 'Checkout page',
    amount: '850',
    payment_link: LINK,
    payment_note: NOTE,
  });
  const milestonePath = created.location;
  await dev.get(milestonePath);
  await dev.post(`${milestonePath}/send`);
  const devPage = await dev.get(milestonePath);
  const reviewPath = new URL(devPage.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;

  const client = new Browser(server.base);
  // Neither the welcome card nor the milestone page carries the payment details before approval.
  for (const path of [reviewPath, `${reviewPath}/review`]) {
    const pending = await client.get(path);
    assert.equal(pending.status, 200);
    for (const secret of ['buy.stripe.com', 'test_4gw5kE9xY', 'BE71 0961', 'Invoice 14', 'Pay now']) {
      assert.ok(!pending.text.includes(secret), `"${secret}" is not in ${path} before approval`);
    }
  }
  assert.match((await client.get(`${reviewPath}/review`)).text, /After approving the milestone, you can pay through the link provided by the developer\./);

  await client.get('/lang/fr');
  for (const path of [reviewPath, `${reviewPath}/review`]) {
    const pendingFr = await client.get(path);
    assert.ok(!pendingFr.text.includes('buy.stripe.com'));
    assert.ok(!pendingFr.text.includes('Payer maintenant'));
  }
  await client.get('/lang/en');

  const approval = await approve(client, reviewPath);
  assert.equal(approval.status, 302);

  const approved = await client.get(reviewPath);
  assert.match(approved.text, /Pay now/);
  assert.ok(approved.text.includes(`href="${LINK}" target="_blank" rel="noopener noreferrer"`));
  assert.match(approved.text, /You will be redirected to buy\.stripe\.com\./);
  assert.match(approved.text, /850/);
  assert.ok(approved.text.includes('&lt;script&gt;alert(&#34;x&#34;)&lt;/script&gt; &amp; &#34;Invoice 14&#34;'), 'the note is escaped');
  assert.ok(!approved.text.includes('<script>alert'), 'no raw HTML from the note');

  const later = new Browser(server.base);
  await later.get('/lang/fr');
  const reopened = await later.get(reviewPath);
  assert.match(reopened.text, /Payer maintenant/);
  assert.match(reopened.text, /Vous allez être redirigé vers buy\.stripe\.com\./);
});

test('a milestone without payment details shows no payment block', async () => {
  const { dev, projectPath } = await signUp('payment-none@example.com');
  await dev.get(`${projectPath}/milestones/new`);
  const created = await dev.post(`${projectPath}/milestones`, { title: 'Logo' });
  await dev.get(created.location);
  await dev.post(`${created.location}/send`);
  const devPage = await dev.get(created.location);
  const reviewPath = new URL(devPage.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;

  const client = new Browser(server.base);
  await approve(client, reviewPath);
  const approved = await client.get(reviewPath);
  assert.match(approved.text, /You approved this milestone/);
  assert.doesNotMatch(approved.text, /Pay now/);
});
