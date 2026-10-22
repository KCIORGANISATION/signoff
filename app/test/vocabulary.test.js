import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startServer, testOutbox } from './helpers.js';

let server;
let query;
let dictionaries;
let translator;
let termFor;
let UNCHANGED_PREFIXES;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
  ({ dictionaries, translator } = await import('../src/i18n.js'));
  ({ termFor, UNCHANGED_PREFIXES } = await import('../src/vocabulary.js'));
});
after(() => server.stop());

const changes = (key) => !UNCHANGED_PREFIXES.some((prefix) => key.startsWith(prefix));

test('the activity chooses the word: "delivery" for video, design, illustration and photography', () => {
  for (const activity of ['video', 'design', 'illustration', 'photography']) assert.equal(termFor(activity), 'delivery', activity);
  for (const activity of ['web_dev', 'writing', 'other', null, undefined, 'unknown']) assert.equal(termFor(activity), 'milestone', String(activity));
});

test('every text that says "milestone" has its "delivery" version, in English and in French', () => {
  const words = { en: /milestone/i, fr: /jalon/i };
  for (const lang of ['en', 'fr']) {
    const t = translator(lang, 'delivery');
    const plain = translator(lang);
    for (const key of Object.keys(dictionaries[lang])) {
      const text = t(key);
      if (changes(key)) assert.doesNotMatch(text, words[lang], `${lang} ${key}: ${text}`);
      else assert.equal(text, plain(key), `${lang} ${key} stays as it is`);
    }
  }
  // French agreements: the word is feminine.
  const fr = translator('fr', 'delivery');
  assert.equal(fr('milestone.new'), 'Nouvelle livraison');
  assert.equal(fr('status.approved'), 'Approuvée');
  assert.equal(fr('review.approved.title'), 'Livraison approuvée');
  assert.equal(fr('milestone.locked'), 'Cette livraison est approuvée et verrouillée. Toute modification se fait dans une nouvelle livraison.');
  assert.equal(translator('en', 'delivery')('project.milestones'), 'Deliveries');
  // The default does not move.
  assert.equal(translator('fr')('milestone.new'), 'Nouveau jalon');
  assert.equal(translator('fr', 'milestone')('status.approved'), 'Approuvé');
});

let signups = 0;
async function freelancer(email, activity) {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `192.0.2.${200 + signups}` });
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', name: 'Studio Démo', email, password: 'correct horse battery' });
  await dev.get('/welcome');
  await dev.post('/welcome', activity ? { intent: 'save', activity } : { intent: 'skip' });
  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const created = await dev.post(`${project.location}/milestones`, { title: 'Premier montage' });
  await dev.get(created.location);
  await dev.post(`${created.location}/deliverables`, { kind: 'url', label: 'Aperçu', url: 'https://preview.example.com' });
  await dev.post(`${created.location}/send`);
  const page = await dev.get(created.location);
  const reviewPath = new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  return { dev, projectPath: project.location, milestonePath: created.location, reviewPath };
}

test('a video editor reads "delivery" in their space, their client too, in English and in French', async () => {
  const { dev, projectPath, milestonePath, reviewPath } = await freelancer('video-editor@example.com', 'video');
  assert.equal(testOutbox.at(-1).to, 'client-demo@example.com');
  assert.match(testOutbox.at(-1).text, /has finished the delivery "Premier montage"/);

  let page = await dev.get(projectPath);
  assert.match(page.text, /Current delivery/);
  assert.doesNotMatch(page.text, />[^<]*\bmilestones?\b[^<]*</i, 'no visible "milestone"');
  page = await dev.get(`${projectPath}/milestones/new`);
  assert.match(page.text, /New delivery/);
  assert.match(page.text, /Delivery title/);

  await dev.get('/lang/fr');
  page = await dev.get(projectPath);
  assert.match(page.text, /Livraison actuelle/);
  page = await dev.get(milestonePath);
  assert.match(page.text, /Envoyée/);
  assert.doesNotMatch(page.text, />[^<]*\bjalons?\b[^<]*</i);

  const client = new Browser(server.base, { 'x-forwarded-for': '198.51.100.21' });
  page = await client.get(reviewPath);
  assert.match(page.text, /Studio Démo is asking you to approve a delivery/);
  page = await client.get(`${reviewPath}/review`);
  assert.match(page.text, /Approve this delivery/);
  assert.doesNotMatch(page.text, />[^<]*\bmilestones?\b[^<]*</i);

  const clientFr = new Browser(server.base, { 'accept-language': 'fr', 'x-forwarded-for': '198.51.100.22' });
  page = await clientFr.get(`${reviewPath}/review`);
  assert.match(page.text, /Approuver cette livraison/);
  assert.doesNotMatch(page.text, />[^<]*\bjalons?\b[^<]*</i);
});

test('a web developer, a writer and an account without an activity keep "milestone"', async () => {
  for (const [email, activity] of [['web-dev@example.com', 'web_dev'], ['writer@example.com', 'writing'], ['no-activity@example.com', null]]) {
    const { dev, projectPath, reviewPath } = await freelancer(email, activity);
    assert.match((await dev.get(projectPath)).text, /Current milestone/, email);
    const client = new Browser(server.base, { 'accept-language': 'fr', 'x-forwarded-for': '198.51.100.23' });
    assert.match((await client.get(`${reviewPath}/review`)).text, /Approuver ce jalon/, email);
  }
});

test('changing the activity in the profile changes the word right away', async () => {
  const { dev, projectPath, reviewPath } = await freelancer('switch@example.com', 'web_dev');
  assert.match((await dev.get(projectPath)).text, /Current milestone/);
  await dev.get('/profile');
  await dev.post('/profile', { first_name: 'Camille', last_name: 'Martin', name: 'Studio Démo', activity: 'photography' });
  assert.match((await dev.get(projectPath)).text, /Current delivery/);
  assert.match((await new Browser(server.base).get(`${reviewPath}/review`)).text, /Approve this delivery/);
  const user = (await query('SELECT activity FROM users WHERE email = $1', ['switch@example.com']))[0];
  assert.equal(user.activity, 'photography');
});
