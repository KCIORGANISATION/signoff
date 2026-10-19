import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, approve, startServer } from './helpers.js';
import { computeHome, computeStats, lastMonths, periodStart } from '../src/stats.js';

let server;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

const NOW = new Date('2026-10-19T12:00:00Z');
const day = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
const empty = () => ({ projects: [], milestones: [], events: [], projectEvents: [] });

function project(id, fields = {}) {
  return { id, name: `Projet ${id}`, client_name: 'Client Démo', client_email: 'client-demo@example.com', status: 'active', created_at: day(10), ...fields };
}

function milestone(id, projectId, fields = {}) {
  return { id, project_id: projectId, status: 'draft', amount: null, currency: 'EUR', created_at: day(10), approved_at: null, ...fields };
}

// --- Calculations -----------------------------------------------------------

test('statistics with no data: zero counts, no rates, no averages, never NaN', () => {
  const stats = computeStats(empty(), { since: periodStart('12m', NOW), now: NOW });
  assert.equal(stats.empty, true);
  assert.deepEqual(stats.projects.byStatus, { active: 0, completed: 0, abandoned: 0 });
  assert.equal(stats.projects.abandonRate, null);
  assert.deepEqual(stats.milestones, { total: 0, approved: 0, waiting: 0, feedback: 0, averageProgress: null });
  assert.deepEqual(stats.amounts, []);
  assert.deepEqual(stats.speed, { approvalMs: null, feedbackRounds: null, approvedCount: 0 });
  assert.deepEqual(stats.clients, []);
  assert.ok(!JSON.stringify(stats).includes('NaN'));

  const home = computeHome(empty(), NOW);
  assert.deepEqual(home, { projects: null, milestones: null, amounts: null });
});

test('amounts in different currencies are never added together', () => {
  const data = empty();
  data.projects = [project(1), project(2)];
  data.milestones = [
    milestone(1, 1, { status: 'approved', amount: '0.10', approved_at: day(5) }),
    milestone(2, 1, { status: 'approved', amount: '0.20', approved_at: day(4) }),
    milestone(3, 2, { status: 'approved', amount: '1000', currency: 'USD', approved_at: day(3) }),
    milestone(4, 2, { status: 'sent', amount: '250.50', currency: 'USD' }),
    milestone(5, 1, { status: 'cancelled', amount: '75' }),
    milestone(6, 1, { status: 'not_done', amount: '25' }),
    milestone(7, 1, { status: 'draft', amount: null }),
  ];
  const stats = computeStats(data, { since: periodStart('12m', NOW), now: NOW });
  assert.deepEqual(stats.amounts, [
    { currency: 'EUR', approved: 30, pending: 0, cancelled: 10000 },
    { currency: 'USD', approved: 100000, pending: 25050, cancelled: 0 },
  ]);

  const home = computeHome(data, NOW);
  assert.equal(home.amounts.months.length, 12);
  assert.equal(home.amounts.months.at(-1), '2026-10');
  assert.deepEqual(home.amounts.currencies.map((c) => [c.currency, c.total]), [['USD', 100000], ['EUR', 30]]);
  assert.equal(home.amounts.currencies[1].months['2026-10'], 30, '0.10 + 0.20 is exactly 0.30');
});

test('abandoned projects: abandon rate and reasons, from the last abandon event', () => {
  const data = empty();
  data.projects = [
    project(1, { status: 'abandoned' }),
    project(2, { status: 'abandoned' }),
    project(3, { status: 'completed' }),
    project(4, { status: 'active' }),
    project(5, { status: 'active' }), // abandoned once, then reopened
  ];
  data.projectEvents = [
    { project_id: 1, type: 'abandoned', reason: 'other', created_at: day(9) },
    { project_id: 1, type: 'abandoned', reason: 'client_stopped', created_at: day(5) },
    { project_id: 2, type: 'abandoned', reason: 'unforeseen', created_at: day(5) },
    { project_id: 5, type: 'abandoned', reason: 'client_stopped', created_at: day(5) },
  ];
  data.milestones = [
    milestone(1, 4, { status: 'approved', approved_at: day(2) }),
    milestone(2, 4, { status: 'sent' }),
    milestone(3, 5, { status: 'feedback' }),
    milestone(4, 1, { status: 'cancelled' }),
  ];
  const stats = computeStats(data, { since: null, now: NOW });
  assert.deepEqual(stats.projects.byStatus, { active: 2, completed: 1, abandoned: 2 });
  assert.equal(stats.projects.abandonRate, 0.4);
  assert.deepEqual(stats.projects.reasons, { client_stopped: 1, unforeseen: 1, other: 0 });
  assert.deepEqual(stats.milestones, { total: 4, approved: 1, waiting: 1, feedback: 1, averageProgress: 0.25 });
});

test('the period keeps only what happened in it; speed and clients follow the client answers', () => {
  const data = empty();
  data.projects = [
    project(1, { created_at: day(400), client_email: 'Client-Demo@Example.com ' }),
    project(2, { created_at: day(20), client_name: 'Client Démo', client_email: 'client-demo@example.com' }),
    project(3, { created_at: day(100), client_name: 'Atelier Lumière', client_email: 'atelier@example.com' }),
  ];
  data.milestones = [
    milestone(1, 1, { created_at: day(400), status: 'approved', amount: '100', approved_at: day(390) }),
    milestone(2, 2, { created_at: day(20), status: 'approved', amount: '200', approved_at: day(10) }),
    milestone(3, 3, { created_at: day(100), status: 'approved', amount: '300', approved_at: day(60) }),
  ];
  data.events = [
    { milestone_id: 1, type: 'sent', created_at: day(395) },
    { milestone_id: 1, type: 'approved', created_at: day(390) },
    { milestone_id: 2, type: 'sent', created_at: day(14) },
    { milestone_id: 2, type: 'feedback', created_at: day(13) },
    { milestone_id: 2, type: 'sent', created_at: day(12) },
    { milestone_id: 2, type: 'approved', created_at: day(10) },
    { milestone_id: 3, type: 'sent', created_at: day(64) },
    { milestone_id: 3, type: 'approved', created_at: day(60) },
  ];

  const month = computeStats(data, { since: periodStart('30d', NOW), now: NOW });
  assert.equal(month.projects.total, 1);
  assert.equal(month.milestones.total, 1);
  assert.deepEqual(month.amounts, [{ currency: 'EUR', approved: 20000, pending: 0, cancelled: 0 }]);
  assert.equal(month.speed.approvedCount, 1);
  assert.equal(month.speed.approvalMs, 4 * 24 * 60 * 60 * 1000, 'from the first sending to the approval');
  assert.equal(month.speed.feedbackRounds, 1);
  assert.equal(month.clients.length, 1);
  assert.deepEqual(month.clients[0], {
    email: 'client-demo@example.com', name: 'Client Démo', projects: 1, feedback: 1, responseMs: 1.5 * 24 * 60 * 60 * 1000,
  });

  const year = computeStats(data, { since: periodStart('12m', NOW), now: NOW });
  assert.equal(year.projects.total, 2);
  assert.deepEqual(year.amounts, [{ currency: 'EUR', approved: 50000, pending: 0, cancelled: 0 }]);
  assert.equal(year.speed.feedbackRounds, 0.5);

  const all = computeStats(data, { since: null, now: NOW });
  assert.equal(all.projects.total, 3);
  assert.equal(all.clients.length, 2, 'the same client email, in any case, is one client');
  assert.equal(all.clients[0].projects, 2);

  assert.deepEqual(lastMonths(new Date('2026-01-15T00:00:00Z'), 3), ['2025-11', '2025-12', '2026-01']);
});

// --- Pages ------------------------------------------------------------------

let signups = 0;
async function signUp(email) {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `198.51.100.${signups}` });
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', first_name: 'Camille', last_name: 'Martin', email, password: 'correct horse battery' });
  return dev;
}

test('the statistics tab needs an account and shows only its own figures', async () => {
  assert.equal((await new Browser(server.base).get('/stats')).status, 302);

  const dev = await signUp('stats-owner@example.com');
  let page = await dev.get('/stats');
  assert.equal(page.status, 200);
  assert.match(page.text, /No statistics yet/);
  assert.match(page.text, /href="\/stats" aria-current="page"/);

  await dev.get('/projects/new');
  const project = await dev.post('/projects', { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-stats@example.com', currency: 'EUR' });
  await dev.get(`${project.location}/milestones/new`);
  const milestone = await dev.post(`${project.location}/milestones`, { title: 'Maquettes', amount: '1234.56' });
  await dev.get(milestone.location);
  await dev.post(`${milestone.location}/deliverables`, { kind: 'url', label: 'Staging', url: 'https://staging.example.com' });
  await dev.post(`${milestone.location}/send`);
  const sent = await dev.get(milestone.location);
  const reviewPath = new URL(sent.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  await approve(new Browser(server.base), reviewPath);

  page = await dev.get('/stats?period=30d');
  assert.match(page.text, /href="\/stats\?period=30d" aria-current="page"/);
  assert.match(page.text, /<th scope="row">EUR<\/th><td>€1,234.56<\/td>/);
  assert.match(page.text, /Client Démo<span class="row-meta">client-stats@example.com/);
  assert.doesNotMatch(page.text, /revenue|profit|turnover/i);

  await dev.get('/lang/fr');
  const fr = await dev.get('/stats?period=all');
  await dev.get('/lang/en');
  assert.match(fr.text, /1\s234,56\s€/);
  assert.doesNotMatch(fr.text, /revenu|bénéfice|chiffre d.affaires/i);

  const other = await signUp('stats-other@example.com');
  const theirs = await other.get('/stats?period=all');
  assert.match(theirs.text, /No statistics yet/);
  assert.doesNotMatch(theirs.text, /client-stats@example.com/);

  // An unknown period falls back to 12 months.
  assert.match((await dev.get('/stats?period=<script>')).text, /href="\/stats\?period=12m" aria-current="page"/);
});

test('the home tab greets by name, and shows a greyed example chart before any data', async () => {
  const dev = await signUp('home-chart@example.com');
  let home = await dev.get('/dashboard');
  assert.match(home.text, /<h1 class="hello">Hello Camille Martin<\/h1>/);
  assert.match(home.text, /href="\/profile">Add your line of work/);
  assert.match(home.text, /class="chart is-example"/);
  assert.match(home.text, /No project yet: here is an example/);
  assert.match(home.text, /data-chart-pick="projects" aria-current="true"/);

  home = await dev.get('/dashboard?chart=milestones');
  assert.match(home.text, /data-chart-pick="milestones" aria-current="true"/);
  assert.match(home.text, /data-chart-panel="projects" hidden/);
  assert.equal((await dev.get('/dashboard?chart=nope')).status, 200);

  await dev.get('/projects/new');
  await dev.post('/projects', { name: 'Atelier Lumière', client_name: 'Client Démo', client_email: 'client-home@example.com', currency: 'EUR' });
  home = await dev.get('/dashboard');
  const projects = home.text.match(/data-chart-panel="projects"[\s\S]*?<\/figure>/)[0];
  assert.doesNotMatch(projects, /is-example/);
  assert.match(projects, /<th scope="row">In progress<\/th><td>1<\/td>/);
});

test('an empty account never shows an empty chart: every panel has its example', async () => {
  const dev = await signUp('home-empty@example.com');
  const home = await dev.get('/dashboard');
  for (const name of ['projects', 'amounts', 'milestones']) {
    const panel = home.text.match(new RegExp(`data-chart-panel="${name}"[\\s\\S]*?</figure>`))[0];
    assert.match(panel, /class="chart is-example"/, name);
    assert.match(panel, /class="chart-fill/, `${name} has bars`);
  }
});
