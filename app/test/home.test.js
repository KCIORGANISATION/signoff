import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer } from './helpers.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';

let server;
before(async () => {
  server = await startServer();
});
after(() => server?.stop());

test('the home page presents Signoff to visitors, with one h1, its meta tags and the ways in', async () => {
  const visitor = new Browser(server.base);
  const page = await visitor.get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<html lang="en">/);
  assert.equal(page.text.match(/<h1[\s>]/g).length, 1, 'a single h1');
  assert.match(page.text, /<title>Signoff · Every milestone approved, in writing<\/title>/);
  assert.match(page.text, /<meta name="description" content="[^"]+">/);
  assert.match(page.text, /<meta property="og:title" content="[^"]+">/);
  assert.match(page.text, /<meta property="og:description" content="[^"]+">/);
  assert.doesNotMatch(page.text, /og:image/, 'no image from elsewhere');
  assert.doesNotMatch(page.text, /name="robots" content="noindex"/, 'the public page can be indexed');
  assert.ok(page.text.includes('href="/signup"'), 'invitation code → sign up');
  assert.ok(page.text.includes('href="/login"'), 'log in');
  assert.ok(page.text.includes('href="/acces"'), 'request access');
  for (const part of ['data-demo', 'data-demo-pick="files"', 'aria-pressed="false"', 'aria-live="polite"', 'video-frame', 'eIDAS']) {
    assert.ok(page.text.includes(part), `has ${part}`);
  }
  // Nothing comes from another site: no script, font, video or picture.
  assert.doesNotMatch(page.text.replace(/<link rel="canonical"[^>]*>/, ''), /(src|href)="(https?:)?\/\//);
  assert.doesNotMatch(page.text, /netlify/i, 'no link to the old landing page');
});

test('the home page is in French by default, and follows the language the visitor picks', async () => {
  const noPreference = new Browser(server.base, { 'accept-language': '*' });
  const page = await noPreference.get('/');
  assert.match(page.text, /<html lang="fr">/);
  assert.match(page.text, /Chaque jalon approuvé\. Par écrit, avec la date\./);
  assert.match(page.text, /J&#39;ai un code d&#39;invitation/);

  await noPreference.get('/lang/en?back=/');
  assert.match((await noPreference.get('/')).text, /Every milestone approved\. In writing, with the date\./);

  const french = new Browser(server.base, { 'accept-language': 'fr-BE,fr;q=0.9' });
  assert.match((await french.get('/')).text, /<html lang="fr">/);
});

test('a logged-in developer going to / lands on their dashboard', async () => {
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', name: 'Home Studio', email: 'home@example.com', password: 'correct horse battery' });
  const home = await dev.get('/');
  assert.equal(home.status, 302);
  assert.equal(home.location, '/dashboard');
});

test('/acces explains the invitation-only beta, collects nothing, and shows the contact address only when set', async () => {
  const visitor = new Browser(server.base);
  const page = await visitor.get('/acces');
  assert.equal(page.status, 200);
  assert.match(page.text, /Access to the Signoff beta is by invitation\./);
  assert.doesNotMatch(page.text, /<form|<input|<textarea/, 'no form at all');
  assert.doesNotMatch(page.text, /mailto:/);

  config.contactEmail = 'beta@signoff.example';
  try {
    const withContact = await visitor.get('/acces');
    assert.ok(withContact.text.includes('<a href="mailto:beta@signoff.example">beta@signoff.example</a>'));
  } finally {
    config.contactEmail = '';
  }
});

test('"Powered by Signoff" on client pages points to the app home page', async () => {
  const dev = new Browser(server.base);
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', name: 'Powered Studio', email: 'powered@example.com', password: 'correct horse battery' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Site', client_name: 'Acme', client_email: 'powered-client@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const milestone = await dev.post(`${project.location}/milestones`, { title: 'Homepage', intent: 'send' });
  const shown = await dev.get(milestone.location.replace('#share', ''));
  const reviewPath = new URL(shown.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  const page = await new Browser(server.base).get(reviewPath);
  assert.match(page.text, /Powered by <a href="\/" target="_blank" rel="noopener">Signoff<\/a>/);
  assert.doesNotMatch(page.text, /netlify|github\.com/i);
});

// Last: the database is closed, and the public pages still answer.
test('the home page and /acces do not need the database', async () => {
  await server.stop();
  server = null;
  const app = createApp().listen(0);
  await new Promise((resolve) => app.once('listening', resolve));
  const visitor = new Browser(`http://127.0.0.1:${app.address().port}`);
  try {
    assert.equal((await visitor.get('/health')).status, 503, 'the database is really gone');
    assert.equal((await visitor.get('/')).status, 200);
    assert.equal((await visitor.get('/acces')).status, 200);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
