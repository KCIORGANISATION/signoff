import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer } from './helpers.js';

let server;
let query;
let config;
let load;
let feedbackLink;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
  ({ config, load, feedbackLink } = await import('../src/config.js'));
});
after(() => server.stop());

// Each test sets the beta settings it needs; they go back to "off" after it.
function setBeta({ enabled = false, responsibleName = '', feedbackUrl = '', contactEmail = '', resendApiKey = '' } = {}) {
  Object.assign(config.beta, { enabled, responsibleName });
  Object.assign(config, { feedbackUrl, contactEmail, resendApiKey });
}
afterEach(() => setBeta());

const PASSWORD = 'correct horse battery';
let signups = 0;
async function signUp(email, extra = {}, headers = {}) {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `192.0.2.${10 + signups}`, ...headers });
  await dev.get('/signup');
  const response = await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', email, password: PASSWORD, ...extra });
  return { dev, response };
}

const acceptedAt = async (email) => (await query('SELECT beta_rules_accepted_at FROM users WHERE email = $1', [email]))[0].beta_rules_accepted_at;

test('without BETA_MODE, nothing of the beta shows', async () => {
  const { dev, response } = await signUp('no-beta@example.com');
  assert.equal(response.status, 302, 'no box to tick');
  assert.equal(await acceptedAt('no-beta@example.com'), null);

  const dashboard = await dev.get('/dashboard');
  assert.equal(dashboard.status, 200);
  assert.doesNotMatch(dashboard.text, /beta-banner|Test beta/);
  assert.equal((await dev.get('/beta')).status, 404);
  assert.equal((await dev.get('/beta/accept')).status, 404);
  assert.doesNotMatch((await new Browser(server.base).get('/signup')).text, /name="beta_rules"/);
  assert.doesNotMatch((await new Browser(server.base).get('/forgot')).text, /not active yet during the beta/);
});

test('BETA_MODE parses true or 1 only', () => {
  assert.equal(load({ BETA_MODE: 'true', NODE_ENV: 'test' }).beta.enabled, true);
  assert.equal(load({ BETA_MODE: ' TRUE ', NODE_ENV: 'test' }).beta.enabled, true);
  assert.equal(load({ BETA_MODE: '1', NODE_ENV: 'test' }).beta.enabled, true);
  assert.equal(load({ BETA_MODE: 'false', NODE_ENV: 'test' }).beta.enabled, false);
  assert.equal(load({ BETA_MODE: 'yes please', NODE_ENV: 'test' }).beta.enabled, false);
  assert.equal(load({ NODE_ENV: 'test' }).beta.enabled, false);
  assert.equal(load({ BETA_RESPONSIBLE_NAME: '  Studio Démo ', NODE_ENV: 'test' }).beta.responsibleName, 'Studio Démo');
});

test('the /beta page gives the rules, the person responsible and the legal pages', async () => {
  setBeta({ enabled: true });
  const visitor = new Browser(server.base);
  let page = await visitor.get('/beta');
  assert.equal(page.status, 200, 'public, no login needed');
  assert.match(page.text, /<h1[^>]*>Beta rules<\/h1>/);
  assert.match(page.text, /It is a trial: bugs are normal/);
  assert.match(page.text, /Only use test data/);
  assert.match(page.text, /may be deleted at any time\. You can also delete your own account/);
  assert.match(page.text, /no guarantee of availability/);
  assert.match(page.text, /The first load can take up to a minute \(test hosting\)\./);
  assert.match(page.text, /run by <strong>the beta publisher<\/strong>/);
  assert.match(page.text, /href="\/privacy"/);
  assert.match(page.text, /href="\/terms"/);
  assert.match(page.text, /Ask the person who invited you/, 'no feedback link configured');
  assert.doesNotMatch(page.text, /beta-banner/, 'no banner for visitors');

  setBeta({ enabled: true, responsibleName: 'Studio <Démo>', feedbackUrl: 'https://discord.example/invite/abc' });
  page = await new Browser(server.base, { 'accept-language': 'fr' }).get('/beta');
  assert.match(page.text, /Règles de la bêta/);
  assert.match(page.text, /Le premier chargement peut prendre jusqu’à une minute \(hébergement de test\)\./);
  assert.match(page.text, /menée par <strong>Studio &lt;Démo&gt;<\/strong>/, 'the name is escaped');
  assert.match(page.text, /<a href="https:\/\/discord\.example\/invite\/abc" target="_blank" rel="noopener noreferrer">Donner un retour/);
});

test('signing up during the beta needs the box ticked, and records when', async () => {
  setBeta({ enabled: true });
  const form = await new Browser(server.base).get('/signup');
  assert.match(form.text, /name="beta_rules" value="yes" required/);
  assert.match(form.text, /I understand this is a test beta: I do not send any real client file or data\./);
  assert.match(form.text, /href="\/beta"/);

  const refused = await signUp('beta-unticked@example.com');
  assert.equal(refused.response.status, 400);
  assert.match(refused.response.text, /Tick the box to confirm you understand the beta rules\./);
  assert.equal(Number((await query('SELECT count(*) FROM users WHERE email = $1', ['beta-unticked@example.com']))[0].count), 0);

  const { dev, response } = await signUp('beta-ticked@example.com', { beta_rules: 'yes' });
  assert.equal(response.status, 302);
  const date = await acceptedAt('beta-ticked@example.com');
  assert.ok(date instanceof Date && Date.now() - date.getTime() < 60_000);
  assert.equal((await dev.get('/dashboard')).status, 200, 'no second question');
});

test('an existing account sees the box at its next visit, and the date is recorded', async () => {
  const { dev } = await signUp('beta-existing@example.com');
  setBeta({ enabled: true });

  const login = new Browser(server.base);
  await login.get('/login');
  await login.post('/login', { email: 'beta-existing@example.com', password: PASSWORD });
  for (const path of ['/dashboard', '/projects', '/stats', '/profile']) {
    const response = await login.get(path);
    assert.equal(response.status, 303, path);
    assert.equal(response.location, `/beta/accept?back=${encodeURIComponent(path)}`, path);
  }
  assert.equal((await dev.get('/profile/delete')).status, 200, 'deleting the account stays possible');

  const page = await login.get('/beta/accept?back=%2Fstats');
  assert.match(page.text, /Before you continue/);
  const unticked = await login.post('/beta/accept', { back: '/stats' });
  assert.equal(unticked.status, 400);
  assert.equal(await acceptedAt('beta-existing@example.com'), null);

  const accepted = await login.post('/beta/accept', { back: '/stats', beta_rules: 'yes' });
  assert.equal(accepted.location, '/stats');
  assert.ok(await acceptedAt('beta-existing@example.com'));
  assert.equal((await login.get('/dashboard')).status, 200);

  const offsite = await login.post('/beta/accept', { back: '//evil.example', beta_rules: 'yes' });
  assert.equal(offsite.location, '/dashboard', 'never sends elsewhere');
});

test('the banner shows in the signed-in space, hides for the session, and comes back at the next login', async () => {
  setBeta({ enabled: true });
  const { dev } = await signUp('beta-banner@example.com', { beta_rules: 'yes' });
  let page = await dev.get('/projects');
  assert.match(page.text, /class="beta-banner"/);
  assert.match(page.text, /Test beta\. Do not send any real client file or data\. <a href="\/beta">Beta rules<\/a>/);

  await dev.get('/lang/fr');
  assert.match((await dev.get('/projects')).text, /Bêta de test\. N’envoyez aucun fichier ni donnée réelle de client\. <a href="\/beta">Règles de la bêta<\/a>/);
  await dev.get('/lang/en');

  assert.equal((await dev.request('POST', '/beta/dismiss', { back: '/projects' })).status, 403, 'CSRF checked');
  const hidden = await dev.post('/beta/dismiss', { back: '/projects' });
  assert.equal(hidden.location, '/projects');
  page = await dev.get('/projects');
  assert.doesNotMatch(page.text, /class="beta-banner"/);
  assert.doesNotMatch((await dev.get('/dashboard')).text, /class="beta-banner"/, 'hidden for the whole session');

  await dev.post('/logout');
  await dev.get('/login');
  await dev.post('/login', { email: 'beta-banner@example.com', password: PASSWORD });
  assert.match((await dev.get('/dashboard')).text, /class="beta-banner"/, 'back after logging in again');

  setBeta();
  assert.doesNotMatch((await dev.get('/dashboard')).text, /class="beta-banner"/);
});

test('"Forgot password" during the beta explains how to get a new one when emails are off', async () => {
  setBeta({ enabled: true, contactEmail: 'beta@example.com' });
  let page = await new Browser(server.base).get('/forgot');
  assert.match(page.text, /Emails are not active yet during the beta\. Write to us to reset your password: <a href="mailto:beta@example.com" >Give feedback<\/a>\./);
  assert.match(page.text, /name="email"/, 'the form still works as before');

  const before = (await query('SELECT count(*) FROM password_resets'))[0].count;
  await signUp('beta-forgot@example.com', { beta_rules: 'yes' });
  const visitor = new Browser(server.base, { 'x-forwarded-for': '192.0.2.250' });
  await visitor.get('/forgot');
  const sent = await visitor.post('/forgot', { email: 'beta-forgot@example.com' });
  assert.match(sent.text, /not active yet during the beta/);
  assert.doesNotMatch(sent.text, /a reset link is on its way/);
  assert.equal(Number((await query('SELECT count(*) FROM password_resets'))[0].count), Number(before) + 1, 'the link is still created and logged');

  setBeta({ enabled: true });
  page = await new Browser(server.base).get('/forgot');
  assert.match(page.text, /Ask the person who invited you to reset your password/);

  setBeta({ enabled: true, resendApiKey: 're_test' });
  page = await new Browser(server.base).get('/forgot');
  assert.doesNotMatch(page.text, /not active yet during the beta/, 'with an email service, the normal page');
});

// --- Feedback link ---------------------------------------------------------------

test('the feedback address must be an https:// URL', () => {
  const url = (value) => load({ FEEDBACK_URL: value, NODE_ENV: 'test' }).feedbackUrl;
  assert.equal(url('https://discord.gg/abc123'), 'https://discord.gg/abc123');
  assert.equal(url('  https://forms.example/beta?x=1  '), 'https://forms.example/beta?x=1');
  assert.equal(url('http://discord.gg/abc123'), '');
  assert.equal(url('javascript:alert(1)'), '');
  assert.equal(url('https://user:pass@example.com'), '');
  assert.equal(url('https://example.com/"><script>'), '');
  assert.equal(url('discord.gg/abc'), '');
  assert.equal(url(''), '');

  assert.deepEqual(feedbackLink({ feedbackUrl: 'https://discord.gg/abc', contactEmail: 'a@example.com' }), { href: 'https://discord.gg/abc', external: true });
  assert.deepEqual(feedbackLink({ feedbackUrl: '', contactEmail: 'a@example.com' }), { href: 'mailto:a@example.com', external: false });
  assert.equal(feedbackLink({ feedbackUrl: '', contactEmail: '' }), null);
});

test('"Give feedback" is in the signed-in space: the URL, else the email, else nothing', async () => {
  const { dev } = await signUp('feedback-link@example.com');
  const footer = async (path = '/dashboard') => (await dev.get(path)).text.match(/<footer[\s\S]*<\/footer>/)[0];

  assert.doesNotMatch(await footer(), /Give feedback/);

  setBeta({ contactEmail: 'beta@example.com' });
  assert.match(await footer(), /<a href="mailto:beta@example.com" >.*Give feedback/s);

  setBeta({ feedbackUrl: 'https://discord.example/invite/abc', contactEmail: 'beta@example.com' });
  for (const path of ['/dashboard', '/projects', '/stats', '/profile']) {
    assert.match(await footer(path), /<a href="https:\/\/discord\.example\/invite\/abc" target="_blank" rel="noopener noreferrer">.*Give feedback/s, path);
  }
  assert.doesNotMatch((await new Browser(server.base).get('/login')).text, /Give feedback/, 'not for visitors');
});

// --- Upload limits ---------------------------------------------------------------

test('the upload form shows the real accepted types and limits', async () => {
  const { dev } = await signUp('upload-rules@example.com');
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const created = await dev.post(`${project.location}/milestones`, { title: 'Maquettes' });
  const page = await dev.get(created.location);
  assert.match(page.text, /Accepted files: \.png, \.jpg, \.jpeg, \.gif, \.webp, \.pdf, \.txt, \.md, \.csv, \.log\./);
  assert.match(page.text, /10 MB max per file, 10 files per milestone, 200 MB in total\./);
  assert.match(page.text, /data-max-bytes="10485760"/);

  const id = created.location.split('/').pop();
  const refused = await dev.upload(`/milestones/${id}/files`, [{ name: 'page.html', content: '<html></html>', type: 'text/html' }]);
  assert.equal(refused.status, 415);
  assert.match(JSON.parse(refused.text).error, /"page\.html" was refused: its type is not accepted\. Accepted files: \.png/);
});
