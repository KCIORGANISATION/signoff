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

let visitors = 0;
function visitor() {
  visitors += 1;
  return new Browser(server.base, { 'x-forwarded-for': `203.0.113.${visitors}` });
}

async function signUp(email, fields = {}) {
  const dev = visitor();
  await dev.get('/signup');
  const response = await dev.post('/signup', {
    invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', email, password: 'correct horse battery', ...fields,
  });
  return { dev, response };
}

const userRow = async (email) => (await query('SELECT * FROM users WHERE email = $1', [email]))[0];

test('sign-up asks for first and last name; the business name is optional', async () => {
  const { response: missing } = await signUp('names-missing@example.com', { first_name: '  ' });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /id="first_name"/);
  assert.equal(await userRow('names-missing@example.com'), undefined);

  const { response: tooLong } = await signUp('names-long@example.com', { last_name: 'x'.repeat(81) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.text, /One of the names is too long/);

  const { response } = await signUp('names-ok@example.com');
  assert.equal(response.status, 302);
  assert.equal(response.location, '/welcome');
  const user = await userRow('names-ok@example.com');
  assert.equal(user.first_name, 'Camille');
  assert.equal(user.last_name, 'Martin');
  assert.equal(user.name, 'Camille Martin', 'clients see the person’s name without a business name');

  await signUp('names-business@example.com', { name: 'Atelier Lumière' });
  assert.equal((await userRow('names-business@example.com')).name, 'Atelier Lumière');
});

test('the two questions after sign-up can be skipped or answered', async () => {
  const { dev } = await signUp('welcome-skip@example.com');
  let page = await dev.get('/welcome');
  assert.equal(page.status, 200);
  assert.match(page.text, /Two quick questions/);
  assert.match(page.text, /value="video"/);
  assert.match(page.text, /value="both"/);
  assert.doesNotMatch(page.text, /id="first_name"/, 'names are already known');

  const skipped = await dev.post('/welcome', { intent: 'skip', activity: 'video' });
  assert.equal(skipped.location, '/dashboard');
  let user = await userRow('welcome-skip@example.com');
  assert.equal(user.activity, null, 'skip records no answer');
  assert.ok(user.questionnaire_at);

  const { dev: other } = await signUp('welcome-save@example.com');
  await other.get('/welcome');
  await other.post('/welcome', { intent: 'save', activity: 'other', activity_other: '  Motion   design ', delivers: 'files' });
  user = await userRow('welcome-save@example.com');
  assert.deepEqual([user.activity, user.activity_other, user.delivers], ['other', 'Motion design', 'files']);
  page = await other.get('/dashboard');
  assert.match(page.text, /<p class="hello-activity">Motion design<\/p>/);

  // Values that are not offered are not stored.
  await other.get('/welcome');
  await other.post('/welcome', { intent: 'save', activity: 'astronaut', delivers: 'pizzas' });
  user = await userRow('welcome-save@example.com');
  assert.deepEqual([user.activity, user.delivers], [null, null]);

  // Without the CSRF token nothing is saved.
  const forged = await other.request('POST', '/welcome', { intent: 'save', activity: 'video' });
  assert.equal(forged.status, 403);
  assert.equal((await userRow('welcome-save@example.com')).activity, null);
});

test('an account created before names existed is asked for them on its next visit', async () => {
  const { dev } = await signUp('names-old@example.com');
  await query("UPDATE users SET first_name = NULL, last_name = NULL, name = 'Studio Démo' WHERE email = 'names-old@example.com'");
  await dev.post('/logout');
  const login = visitor();
  await login.get('/login');
  const logged = await login.post('/login', { email: 'names-old@example.com', password: 'correct horse battery' });
  assert.equal(logged.location, '/dashboard');

  for (const path of ['/dashboard', '/projects', '/stats']) {
    assert.equal((await login.get(path)).location, '/welcome', path);
  }
  const page = await login.get('/welcome');
  assert.match(page.text, /Tell us your name/);
  assert.match(page.text, /id="first_name"/);

  const missing = await login.post('/welcome', { intent: 'skip', first_name: 'Camille', last_name: '' });
  assert.equal(missing.status, 400, 'skipping the questions does not skip the names');
  assert.match(missing.text, /Enter your first and last name/);

  const saved = await login.post('/welcome', { intent: 'skip', first_name: 'Camille', last_name: 'Martin' });
  assert.equal(saved.location, '/dashboard');
  const user = await userRow('names-old@example.com');
  assert.equal(user.name, 'Studio Démo', 'the name clients see does not change');
  assert.equal(user.first_name, 'Camille');
  assert.equal((await login.get('/dashboard')).status, 200);
});

test('My profile edits names, business name and answers; output is escaped', async () => {
  assert.equal((await new Browser(server.base).get('/profile')).location, '/login');

  const { dev } = await signUp('profile-edit@example.com');
  const home = await dev.get('/dashboard');
  assert.match(home.text, /href="\/profile"[^>]*aria-label="My profile \(Camille Martin\)"/);

  let page = await dev.get('/profile');
  assert.equal(page.status, 200);
  assert.match(page.text, /value="Camille"/);

  const invalid = await dev.post('/profile', { first_name: 'Camille', last_name: 'Martin', activity: 'other', activity_other: 'x'.repeat(61) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.text, /60 characters at most/);

  const saved = await dev.post('/profile', {
    first_name: '<b>Léa</b>', last_name: 'Dupont', name: 'Atelier <i>Lumière</i>', activity: 'photography', delivers: 'links',
  });
  assert.equal(saved.location, '/profile?saved=1');
  page = await dev.get('/profile?saved=1');
  assert.match(page.text, /Your profile is saved/);
  assert.match(page.text, /value="photography" checked/);
  assert.match(page.text, /value="links" checked/);

  const greeting = await dev.get('/dashboard');
  assert.match(greeting.text, /Hello &lt;b&gt;Léa&lt;\/b&gt; Dupont/);
  assert.doesNotMatch(greeting.text, /<b>Léa<\/b>/);
  assert.match(greeting.text, /<p class="hello-activity">Photography<\/p>/);
  assert.equal((await userRow('profile-edit@example.com')).name, 'Atelier <i>Lumière</i>');

  // Clearing the business name falls back to the person's name.
  await dev.get('/profile');
  await dev.post('/profile', { first_name: 'Léa', last_name: 'Dupont', name: '' });
  assert.equal((await userRow('profile-edit@example.com')).name, 'Léa Dupont');

  const forged = await dev.request('POST', '/profile', { first_name: 'X', last_name: 'Y' });
  assert.equal(forged.status, 403);
  assert.equal((await userRow('profile-edit@example.com')).first_name, 'Léa');
});

test('the French home page says Bonjour with first and last name and the activity', async () => {
  const { dev } = await signUp('profile-fr@example.com');
  await dev.get('/welcome');
  await dev.post('/welcome', { intent: 'save', activity: 'web_dev', delivers: 'both' });
  await dev.get('/lang/fr');
  const home = await dev.get('/dashboard');
  assert.match(home.text, /<h1 class="hello">Bonjour Camille Martin<\/h1>/);
  assert.match(home.text, /<p class="hello-activity">Développement web<\/p>/);
  assert.match(home.text, />\s*Statistiques<\/a>/);
  const welcome = await dev.get('/welcome');
  assert.match(welcome.text, /Passer/);
});
