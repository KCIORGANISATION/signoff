import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, findLink, startServer, testOutbox } from './helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

test('full flow: sign up, project, milestone, client link, approval, timestamped sign-off', async () => {
  const dev = new Browser(server.base);

  await dev.get('/signup');
  const signup = await dev.post('/signup', {
    invite_code: 'beta-2026',
    name: 'Studio Test',
    email: 'dev@example.com',
    password: 'correct horse battery',
  });
  assert.equal(signup.status, 302);
  assert.equal(signup.location, '/dashboard');

  await dev.get('/projects/new');
  const project = await dev.post('/projects', {
    name: 'Website redesign',
    client_name: 'Acme',
    client_email: 'client@example.com',
    currency: 'EUR',
  });
  assert.equal(project.status, 302);
  const projectPath = project.location;

  await dev.get(`${projectPath}/milestones/new`);
  const milestone = await dev.post(`${projectPath}/milestones`, {
    title: 'Homepage design',
    description: 'Desktop and mobile mockups',
    amount: '1200',
  });
  assert.equal(milestone.status, 302);
  const milestonePath = milestone.location;

  await dev.get(milestonePath);
  await dev.post(`${milestonePath}/deliverables`, { kind: 'url', label: 'Staging', url: 'https://staging.example.com' });

  await dev.get(milestonePath);
  const sent = await dev.post(`${milestonePath}/send`);
  assert.equal(sent.status, 302);

  const invitation = testOutbox.find((email) => email.to === 'client@example.com');
  assert.ok(invitation, 'the client is emailed the review link');
  const reviewLink = findLink(invitation.text);
  assert.match(reviewLink, /\/r\/[\w-]{32}$/);

  const page = await dev.get(milestonePath);
  assert.ok(page.text.includes(reviewLink), 'the developer sees the same link');

  const client = new Browser(server.base, { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'TestBrowser/1.0' });
  const review = await client.get(reviewLink);
  assert.equal(review.status, 200);
  assert.match(review.text, /Homepage design/);
  assert.match(review.text, /staging\.example\.com/);

  const before = Date.now();
  const approve = await client.post(`${new URL(reviewLink).pathname}/approve`);
  assert.equal(approve.status, 302);

  const approvedPage = await client.get(reviewLink);
  assert.match(approvedPage.text, /certificate/);

  assert.ok(
    testOutbox.some((email) => email.to === 'dev@example.com' && /approved/.test(email.subject)),
    'the developer is emailed about the approval',
  );

  const certificate = await dev.get(`${milestonePath}/certificate`);
  assert.equal(certificate.status, 200);
  assert.match(certificate.text, /203\.0\.113\.7/, 'the real client IP is recorded');
  assert.match(certificate.text, /TestBrowser\/1\.0/);
  const stamp = certificate.text.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/);
  assert.ok(stamp, 'the certificate shows a UTC timestamp');
  const approvedAt = new Date(`${stamp[1].replace(' ', 'T')}Z`).getTime();
  assert.ok(Math.abs(approvedAt - before) < 60_000, 'the timestamp is the moment of approval');
  assert.match(certificate.text, /Homepage design/);

  const clientCertificate = await client.get(`${new URL(reviewLink).pathname}/certificate`);
  assert.equal(clientCertificate.status, 200);
  assert.match(clientCertificate.text, /203\.0\.113\.7/);
});

test('sign-up needs the invitation code', async () => {
  const visitor = new Browser(server.base);
  await visitor.get('/signup');
  const response = await visitor.post('/signup', {
    invite_code: 'wrong',
    name: 'Someone',
    email: 'someone@example.com',
    password: 'long enough password',
  });
  assert.equal(response.status, 400);
  assert.match(response.text, /invitation code is not valid/);
});

test('forms without a valid CSRF token are rejected', async () => {
  const visitor = new Browser(server.base);
  await visitor.get('/login');
  const response = await visitor.request('POST', '/login', { _csrf: 'forged', email: 'dev@example.com', password: 'x' });
  assert.equal(response.status, 403);
});

test('password reset: emailed link, new password, link used once', async () => {
  const visitor = new Browser(server.base);
  await visitor.get('/signup');
  await visitor.post('/signup', {
    invite_code: 'beta-2026',
    name: 'Forgetful',
    email: 'forgetful@example.com',
    password: 'first password',
  });

  const anonymous = new Browser(server.base);
  await anonymous.get('/forgot');
  const unknown = await anonymous.post('/forgot', { email: 'nobody@example.com' });
  const known = await anonymous.post('/forgot', { email: 'forgetful@example.com' });
  assert.equal(unknown.status, 200);
  assert.equal(known.status, 200);

  const email = testOutbox.findLast((message) => message.to === 'forgetful@example.com');
  assert.ok(email, 'a reset email is sent');
  assert.equal(testOutbox.filter((message) => message.to === 'nobody@example.com').length, 0);
  const resetPath = new URL(findLink(email.text)).pathname;

  const form = await anonymous.get(resetPath);
  assert.equal(form.status, 200);
  const reset = await anonymous.post(resetPath, { password: 'second password' });
  assert.equal(reset.status, 302);
  assert.equal(reset.location, '/dashboard');

  assert.equal((await anonymous.get(resetPath)).status, 410, 'the link works only once');

  const fresh = new Browser(server.base);
  await fresh.get('/login');
  assert.equal((await fresh.post('/login', { email: 'forgetful@example.com', password: 'first password' })).status, 401);
  assert.equal((await fresh.post('/login', { email: 'forgetful@example.com', password: 'second password' })).status, 302);
});

test('health check, legal pages and security headers', async () => {
  const visitor = new Browser(server.base);

  const health = await visitor.get('/health');
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { status: 'ok' });

  for (const path of ['/legal', '/privacy', '/terms']) {
    assert.equal((await visitor.get(path)).status, 200, path);
  }

  const login = await visitor.get('/login');
  for (const path of ['/legal', '/privacy', '/terms']) {
    assert.ok(login.text.includes(`href="${path}"`), `footer links to ${path}`);
  }
  assert.ok(login.headers.get('content-security-policy'));
  assert.equal(login.headers.get('x-content-type-options'), 'nosniff');
});
