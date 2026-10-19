import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, approve, startServer, testOutbox } from './helpers.js';

let server;
let query;
before(async () => {
  server = await startServer();
  ({ query } = await import('../src/db.js'));
});
after(() => server.stop());

// Each account signs up from its own address, so the sign-up rate limit is not reached.
let signups = 0;
async function signUp(email, name = 'Studio Démo') {
  signups += 1;
  const dev = new Browser(server.base, { 'x-forwarded-for': `192.0.2.${signups}` });
  await dev.get('/signup');
  await dev.post('/signup', { invite_code: 'beta-2026', name, email, password: 'correct horse battery' });
  return dev;
}

async function createProject(dev, fields = {}) {
  await dev.get('/projects/new');
  const response = await dev.post('/projects', {
    name: 'Atelier Lumière',
    client_name: 'Client Démo',
    client_email: 'client-demo@example.com',
    currency: 'EUR',
    description: 'Site vitrine de cinq pages',
    ...fields,
  });
  assert.equal(response.status, 302);
  return { path: response.location, id: Number(response.location.split('/').pop()) };
}

async function createMilestone(dev, projectPath, title, { send = false, content = true } = {}) {
  await dev.get(`${projectPath}/milestones/new`);
  const created = await dev.post(`${projectPath}/milestones`, { title, amount: '500' });
  const path = created.location;
  if (content) {
    await dev.get(path);
    await dev.post(`${path}/deliverables`, { kind: 'url', label: 'Staging', url: 'https://staging.example.com' });
  }
  let reviewPath = null;
  if (send) {
    await dev.get(path);
    await dev.post(`${path}/send`);
    const page = await dev.get(path);
    reviewPath = new URL(page.text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  }
  return { path, id: Number(path.split('/').pop()), reviewPath };
}

async function statuses(projectId) {
  const rows = await query('SELECT title, status FROM milestones WHERE project_id = $1 ORDER BY id', [projectId]);
  return Object.fromEntries(rows.map((row) => [row.title, row.status]));
}

async function projectStatus(projectId) {
  return (await query('SELECT status FROM projects WHERE id = $1', [projectId]))[0].status;
}

test('the home tab guides a new account through its first three steps', async () => {
  const dev = await signUp('guide@example.com');

  let home = await dev.get('/dashboard');
  assert.match(home.text, /Welcome\. Let(&#39;|')s create your first project\./);
  assert.match(home.text, /aria-current="step"[\s\S]*Create your first project/);
  assert.match(home.text, /href="\/projects\/new"/);
  assert.match(home.text, /<nav class="app-tabs"[\s\S]*href="\/dashboard" aria-current="page"[\s\S]*href="\/projects"/);

  const project = await createProject(dev);
  home = await dev.get('/dashboard');
  assert.match(home.text, /create its first milestone/);
  assert.ok(home.text.includes(`href="${project.path}/milestones/new"`));

  const milestone = await createMilestone(dev, project.path, 'Maquettes');
  home = await dev.get('/dashboard');
  assert.match(home.text, /One last step: send the link to your client\./);
  assert.ok(home.text.includes(`href="${milestone.path}#share"`));

  await dev.post(`${milestone.path}/send`);
  home = await dev.get('/dashboard');
  assert.doesNotMatch(home.text, /class="glass onboard/);
  assert.match(home.text, /Next steps/);
  assert.match(home.text, /Waiting for Client Démo on “Maquettes”, sent today\./);
});

test('the French home page speaks to the developer formally', async () => {
  const dev = await signUp('guide-fr@example.com');
  await dev.get('/lang/fr');
  const home = await dev.get('/dashboard');
  assert.match(home.text, /Bienvenue\. Créons votre premier projet\./);
  assert.match(home.text, /<\/svg>\s*Accueil<\/a>/);
  assert.match(home.text, /<\/svg>\s*Projets<\/a>/);
});

test('projects: created in steps with a description, listed as cards with a filter', async () => {
  const dev = await signUp('cards@example.com');
  const form = await dev.get('/projects/new');
  assert.match(form.text, /data-steps/);
  assert.match(form.text, /Step 1 of 3/);

  const tooLong = await dev.post('/projects', {
    name: 'x'.repeat(121), client_name: 'Client Démo', client_email: 'client-demo@example.com', currency: 'EUR',
  });
  assert.equal(tooLong.status, 400);

  const first = await createProject(dev, { name: 'Projet de démonstration', description: 'Refonte <b>complète</b>' });
  await createProject(dev, { name: 'Atelier Lumière' });

  const page = await dev.get(first.path);
  assert.match(page.text, /Refonte &lt;b&gt;complète&lt;\/b&gt;/, 'the description is escaped');
  assert.match(page.text, /Your project has no milestone yet\./);
  assert.match(page.text, /Create your first milestone/);

  await dev.get(first.path);
  await dev.post(`${first.path}/complete`);

  let list = await dev.get('/projects');
  assert.match(list.text, /Atelier Lumière/);
  assert.doesNotMatch(list.text, /Projet de démonstration/, 'completed projects are not in the default filter');
  assert.match(list.text, /In progress <span class="count">1<\/span>/);
  assert.match(list.text, /href="\/projects\/\d+\/complete" data-modal/);
  assert.match(list.text, /href="\/projects\/\d+\/abandon" data-modal/);

  list = await dev.get('/projects?filter=completed');
  assert.match(list.text, /Projet de démonstration/);
  assert.doesNotMatch(list.text, /Atelier Lumière<\/a>/);
  list = await dev.get('/projects?filter=all');
  assert.match(list.text, /Projet de démonstration/);
  assert.match(list.text, /Atelier Lumière/);
});

test('the next-step banner follows the state of the current milestone', async () => {
  const dev = await signUp('next@example.com');
  const project = await createProject(dev);

  const empty = await createMilestone(dev, project.path, 'Accueil', { content: false });
  assert.match((await dev.get(project.path)).text, /“Accueil” is empty: add what your client will review\./);

  await dev.get(empty.path);
  await dev.post(`${empty.path}/deliverables`, { kind: 'note', label: '', body: 'Texte de la page' });
  assert.match((await dev.get(project.path)).text, /“Accueil” is ready to be reviewed\.[\s\S]*Send the link to the client/);

  await dev.post(`${empty.path}/send`);
  const waiting = await dev.get(project.path);
  assert.match(waiting.text, /Waiting for Client Démo on “Accueil”, sent today\./);
  assert.match(waiting.text, /The link was sent less than a day ago/, 'no reminder right after sending');

  const reviewPath = new URL((await dev.get(empty.path)).text.match(/id="share-url"[^>]*value="([^"]+)"/)[1]).pathname;
  const client = new Browser(server.base);
  await client.get(`${reviewPath}/review`);
  await client.post(`${reviewPath}/feedback`, { message: 'Le titre est trop petit' });
  assert.match((await dev.get(project.path)).text, /Client Démo left feedback on “Accueil”/);

  await dev.get(empty.path);
  await dev.post(`${empty.path}/send`);
  await approve(client, reviewPath);
  const done = await dev.get(project.path);
  assert.match(done.text, /Every milestone is approved\. Complete the project, or add a milestone\./);
  assert.match(done.text, /See completed or archived milestones \(1\)/);
});

test('a client who has not answered can be reminded once a day', async () => {
  const dev = await signUp('remind@example.com');
  const project = await createProject(dev, { client_email: 'remind-client@example.com' });
  const fresh = await createMilestone(dev, project.path, 'Logo', { send: true });
  const emails = () => testOutbox.filter((email) => email.to === 'remind-client@example.com');
  const count = emails().length;

  await dev.get(fresh.path);
  await dev.post(`${fresh.path}/remind`);
  assert.equal(emails().length, count, 'not right after sending the link');

  // A milestone sent two days ago (the log is append-only, so the old event is inserted as such).
  const old = await createMilestone(dev, project.path, 'Charte');
  await query(`UPDATE milestones SET status = 'sent' WHERE id = $1`, [old.id]);
  await query(`INSERT INTO review_events (milestone_id, type, created_at) VALUES ($1, 'sent', now() - interval '2 days')`, [old.id]);

  const page = await dev.get(old.path);
  assert.match(page.text, /Remind the client/);
  const reminded = await dev.post(`${old.path}/remind`, { back: 'project' });
  assert.equal(reminded.location, project.path);
  assert.equal(emails().length, count + 1);
  assert.match(emails().at(-1).subject, /Reminder/);
  assert.match(emails().at(-1).text, /\/r\/[\w-]{32}/);

  await dev.get(old.path);
  await dev.post(`${old.path}/remind`);
  assert.equal(emails().length, count + 1, 'only once a day');
  const events = await query(`SELECT type FROM review_events WHERE milestone_id = $1 ORDER BY id`, [old.id]);
  assert.deepEqual(events.map((e) => e.type), ['sent', 'reminded']);
  assert.equal((await query('SELECT status FROM milestones WHERE id = $1', [old.id]))[0].status, 'sent', 'a reminder changes nothing else');
});

test('completing a project: simple when all is approved, explicit otherwise', async () => {
  const dev = await signUp('complete@example.com');
  const project = await createProject(dev);
  const approved = await createMilestone(dev, project.path, 'Approuvé', { send: true });
  await approve(new Browser(server.base), approved.reviewPath);
  const waiting = await createMilestone(dev, project.path, 'En attente', { send: true });
  await createMilestone(dev, project.path, 'Brouillon');

  const confirm = await dev.get(`${project.path}/complete`);
  assert.match(confirm.text, /data-modal-content/);
  assert.match(confirm.text, /will be marked “not done”/);
  assert.match(confirm.text, /En attente/);
  assert.match(confirm.text, /Brouillon/);
  assert.doesNotMatch(confirm.text, /<li><span>Approuvé<\/span>/);

  const refused = await dev.post(`${project.path}/complete`);
  assert.equal(refused.status, 400);
  assert.equal(await projectStatus(project.id), 'active');

  const done = await dev.post(`${project.path}/complete`, { confirm_unapproved: 'yes' });
  assert.equal(done.status, 302);
  assert.equal(await projectStatus(project.id), 'completed');
  assert.deepEqual(await statuses(project.id), { Approuvé: 'approved', 'En attente': 'not_done', Brouillon: 'not_done' });

  const client = new Browser(server.base);
  const closedPage = await client.get(`${waiting.reviewPath}/review`);
  assert.match(closedPage.text, /This project is closed/);
  assert.doesNotMatch(closedPage.text, /data-mode-set="approve"/);
  await approve(client, waiting.reviewPath);
  assert.equal((await statuses(project.id))['En attente'], 'not_done', 'no decision is accepted');
  const approvedPage = await client.get(approved.reviewPath);
  assert.match(approvedPage.text, /Milestone approved/, 'an approved milestone keeps its page and certificate');

  const events = await query('SELECT type, from_status, to_status, milestones FROM project_events WHERE project_id = $1 ORDER BY id', [project.id]);
  assert.deepEqual(events.map((e) => e.type), ['created', 'completed']);
  assert.equal(events[1].milestones.length, 2);

  const twice = await dev.post(`${project.path}/complete`, { confirm_unapproved: 'yes' });
  assert.equal(twice.status, 409);

  const simple = await createProject(dev, { name: 'Projet de démonstration' });
  const all = await createMilestone(dev, simple.path, 'Unique', { send: true });
  await approve(new Browser(server.base), all.reviewPath);
  const plain = await dev.get(`${simple.path}/complete`);
  assert.match(plain.text, /Every milestone is approved/);
  assert.doesNotMatch(plain.text, /confirm_unapproved/);
  assert.equal((await dev.post(`${simple.path}/complete`)).status, 302);
  assert.equal(await projectStatus(simple.id), 'completed');
});

test('abandoning a project: a reason, cancelled milestones, approved ones stay locked, the client sees it closed', async () => {
  const dev = await signUp('abandon@example.com');
  const project = await createProject(dev, { client_email: 'abandon-client@example.com' });
  const approved = await createMilestone(dev, project.path, 'Approuvé', { send: true });
  await approve(new Browser(server.base), approved.reviewPath);
  const sent = await createMilestone(dev, project.path, 'Envoyé', { send: true });
  const draft = await createMilestone(dev, project.path, 'Brouillon');
  const draftToken = (await query('SELECT token FROM milestones WHERE id = $1', [draft.id]))[0].token;

  await dev.get(`${project.path}/abandon`);
  const noReason = await dev.post(`${project.path}/abandon`, { note: 'Budget coupé' });
  assert.equal(noReason.status, 400);
  assert.match(noReason.text, /Choose why you are abandoning this project/);
  assert.equal((await dev.post(`${project.path}/abandon`, { reason: 'bogus' })).status, 400);
  assert.equal((await dev.post(`${project.path}/abandon`, { reason: 'other', note: 'x'.repeat(501) })).status, 400);
  assert.equal(await projectStatus(project.id), 'active');

  const forged = await dev.request('POST', `${project.path}/abandon`, { _csrf: 'forged', reason: 'other' });
  assert.equal(forged.status, 403);

  const before = testOutbox.length;
  const done = await dev.post(`${project.path}/abandon`, { reason: 'client_stopped', note: 'Budget coupé' });
  assert.equal(done.status, 302);
  assert.equal(testOutbox.length, before, 'the client is not emailed unless asked');
  assert.equal(await projectStatus(project.id), 'abandoned');
  assert.deepEqual(await statuses(project.id), { Approuvé: 'approved', Envoyé: 'cancelled', Brouillon: 'cancelled' });

  const [event] = await query(`SELECT * FROM project_events WHERE project_id = $1 AND type = 'abandoned'`, [project.id]);
  assert.equal(event.reason, 'client_stopped');
  assert.equal(event.note, 'Budget coupé');
  await assert.rejects(query('UPDATE project_events SET note = $1 WHERE id = $2', ['changed', event.id]), /append-only/);

  // The approved milestone is still locked by the database itself.
  await assert.rejects(query(`UPDATE milestones SET title = 'changed' WHERE id = $1`, [approved.id]), /locked/);
  await assert.rejects(query(`UPDATE milestones SET status = 'cancelled' WHERE id = $1`, [approved.id]), /locked/);

  // The project and its milestones are read-only.
  assert.equal((await dev.get(`${project.path}/edit`)).status, 409);
  assert.equal((await dev.post(project.path, { name: 'x', client_name: 'y', client_email: 'z@example.com' })).status, 409);
  assert.equal((await dev.get(`${project.path}/milestones/new`)).status, 409);
  assert.equal((await dev.post(`${project.path}/milestones`, { title: 'Nouveau' })).status, 409);
  assert.equal((await dev.get(`${sent.path}/edit`)).status, 409);
  assert.equal((await dev.post(sent.path, { title: 'Changé' })).status, 409);
  assert.equal((await dev.post(`${sent.path}/deliverables`, { kind: 'note', body: 'x' })).status, 409);
  assert.equal((await dev.post(`${sent.path}/send`)).status, 409);
  assert.equal((await dev.post(`${sent.path}/remind`)).status, 409);
  assert.equal((await dev.post(`${sent.path}/delete`)).status, 409);
  assert.equal((await dev.upload(`/milestones/${sent.id}/files`, [{ name: 'a.txt', content: 'hello', type: 'text/plain' }])).status, 409);
  const page = await dev.get(sent.path);
  assert.match(page.text, /The project is abandoned: this milestone is read-only\./);
  assert.match(page.text, /this milestone is cancelled/);

  const client = new Browser(server.base);
  const closed = await client.get(sent.reviewPath);
  assert.equal(closed.status, 200);
  assert.match(closed.text, /This project is closed/);
  await client.get(`${sent.reviewPath}/review`);
  await client.post(`${sent.reviewPath}/feedback`, { message: 'Encore une chose' });
  await approve(client, sent.reviewPath);
  assert.equal((await statuses(project.id))['Envoyé'], 'cancelled');
  assert.equal((await query(`SELECT COUNT(*)::int AS n FROM review_events WHERE milestone_id = $1 AND type IN ('feedback', 'approved')`, [sent.id]))[0].n, 0);
  assert.equal((await client.get(`/r/${draftToken}`)).status, 404, 'a draft the client never received stays unknown');
  assert.match((await client.get(approved.reviewPath)).text, /Milestone approved/);
});

test('abandoning can email the client a neutral message', async () => {
  const dev = await signUp('notify@example.com');
  const project = await createProject(dev, { client_email: 'notify-client@example.com' });
  await dev.get(`${project.path}/abandon`);
  await dev.post(`${project.path}/abandon`, { reason: 'unforeseen', notify_client: 'yes' });
  const email = testOutbox.findLast((message) => message.to === 'notify-client@example.com');
  assert.ok(email);
  assert.match(email.subject, /is closed/);
  assert.match(email.text, /Nothing is expected from you/);
});

test('reopening puts the project and its milestones back as they were', async () => {
  const dev = await signUp('reopen@example.com');
  const project = await createProject(dev);
  const approved = await createMilestone(dev, project.path, 'Approuvé', { send: true });
  await approve(new Browser(server.base), approved.reviewPath);
  const sent = await createMilestone(dev, project.path, 'Envoyé', { send: true });
  await createMilestone(dev, project.path, 'Brouillon');

  await dev.get(`${project.path}/abandon`);
  await dev.post(`${project.path}/abandon`, { reason: 'other' });

  const page = await dev.get(`${project.path}/reopen`);
  assert.match(page.text, /Reopen “Atelier Lumière”\?/);
  assert.equal((await dev.post(`${project.path}/reopen`, { note: '  ' })).status, 400);
  assert.equal(await projectStatus(project.id), 'abandoned');

  assert.equal((await dev.post(`${project.path}/reopen`, { note: 'Le client revient' })).status, 302);
  assert.equal(await projectStatus(project.id), 'active');
  assert.deepEqual(await statuses(project.id), { Approuvé: 'approved', Envoyé: 'sent', Brouillon: 'draft' });

  const client = new Browser(server.base);
  await approve(client, sent.reviewPath);
  assert.equal((await statuses(project.id))['Envoyé'], 'approved', 'the client can decide again');

  await dev.get(`${project.path}/complete`);
  await dev.post(`${project.path}/complete`, { confirm_unapproved: 'yes' });
  await dev.get(`${project.path}/reopen`);
  await dev.post(`${project.path}/reopen`, { note: 'Une page de plus' });
  assert.deepEqual(await statuses(project.id), { Approuvé: 'approved', Envoyé: 'approved', Brouillon: 'draft' });

  const events = await query('SELECT type, note FROM project_events WHERE project_id = $1 ORDER BY id', [project.id]);
  assert.deepEqual(events.map((e) => e.type), ['created', 'abandoned', 'reopened', 'completed', 'reopened']);
  assert.equal(events[2].note, 'Le client revient');
  const show = await dev.get(project.path);
  assert.match(show.text, /Project history \(5\)/);
  assert.match(show.text, /Le client revient/);
});

test('notes are private: saved for the developer, never shown to the client or another account', async () => {
  const dev = await signUp('notes@example.com');
  const project = await createProject(dev);
  const milestone = await createMilestone(dev, project.path, 'Maquettes', { send: true });
  const secret = 'NOTE-PRIVEE-7f3a <script>';

  await dev.get(project.path);
  const saved = await dev.request('POST', `${project.path}/notes`, { _csrf: dev.csrf, body: secret });
  assert.equal(saved.status, 302);
  const json = await fetch(`${server.base}${project.path}/notes`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    },
    body: new URLSearchParams({ _csrf: dev.csrf, body: `${secret}\r\nligne 2` }),
  });
  assert.equal(json.status, 200);
  assert.equal((await json.json()).ok, true);

  const page = await dev.get(project.path);
  assert.ok(page.text.includes('NOTE-PRIVEE-7f3a &lt;script&gt;'), 'the notes are shown, escaped');
  assert.ok(!page.text.includes(secret));

  assert.equal((await dev.post(`${project.path}/notes`, { body: 'x'.repeat(10001) })).status, 400);
  assert.equal((await dev.post(`${project.path}/notes`, { body: `${'x'.repeat(9999)}\r\n` })).status, 302, 'a line break counts once');
  await dev.post(`${project.path}/notes`, { body: secret });

  const client = new Browser(server.base);
  const clientPages = [
    milestone.reviewPath,
    `${milestone.reviewPath}/review`,
    `${milestone.reviewPath}/certificate`,
  ];
  for (const path of clientPages) {
    const response = await client.get(path);
    assert.equal(response.status, 200, path);
    assert.ok(!response.text.includes('NOTE-PRIVEE-7f3a'), `${path} does not show the notes`);
  }
  const feedback = await client.post(`${milestone.reviewPath}/feedback`, { message: 'Bien reçu' });
  assert.ok(!feedback.text.includes('NOTE-PRIVEE-7f3a'));
  assert.ok(!(await client.get(milestone.reviewPath)).text.includes('NOTE-PRIVEE-7f3a'));
  const preview = await dev.get(`${milestone.path}/preview`);
  assert.ok(!preview.text.includes('NOTE-PRIVEE-7f3a'), 'not even in the "view as client" preview');

  const emails = testOutbox.filter((email) => email.to === 'client-demo@example.com');
  assert.ok(emails.every((email) => !email.text.includes('NOTE-PRIVEE-7f3a')));

  const { readFileSync } = await import('node:fs');
  for (const file of ['src/routes/review.js', 'src/models.js']) {
    assert.ok(!readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').includes('project_notes'), `${file} never reads the notes`);
  }

  const other = await signUp('notes-other@example.com');
  await other.get('/dashboard');
  assert.equal((await other.post(`${project.path}/notes`, { body: 'piraté' })).status, 404);
  assert.equal((await other.get(project.path)).status, 404);
  const [row] = await query('SELECT body FROM project_notes WHERE project_id = $1', [project.id]);
  assert.equal(row.body, secret);
});

test("another account gets a 404 on every project route", async () => {
  const owner = await signUp('owner@example.com');
  const project = await createProject(owner);
  const milestone = await createMilestone(owner, project.path, 'Maquettes', { send: true });

  const other = await signUp('intruder@example.com');
  await other.get('/dashboard');
  for (const path of [project.path, `${project.path}/edit`, `${project.path}/complete`, `${project.path}/abandon`, `${project.path}/reopen`]) {
    assert.equal((await other.get(path)).status, 404, `GET ${path}`);
  }
  for (const path of [`${project.path}/complete`, `${project.path}/abandon`, `${project.path}/reopen`, `${project.path}/notes`, `${project.path}/delete`, `${milestone.path}/remind`]) {
    assert.equal((await other.post(path, { reason: 'other', note: 'x', confirm_unapproved: 'yes' })).status, 404, `POST ${path}`);
  }
  assert.equal(await projectStatus(project.id), 'active');
  assert.ok(!(await other.get('/projects?filter=all')).text.includes('Atelier Lumière'));
});

test('projects that existed before this change keep working as "in progress"', async () => {
  const dev = await signUp('legacy@example.com');
  const [user] = await query(`SELECT id FROM users WHERE email = 'legacy@example.com'`);
  const [legacy] = await query(
    `INSERT INTO projects (user_id, name, client_name, client_email, currency) VALUES ($1, 'Projet de démonstration', 'Client Démo', 'client-demo@example.com', 'EUR') RETURNING *`,
    [user.id],
  );
  assert.equal(legacy.status, 'active');
  assert.equal(legacy.description, '');

  const page = await dev.get(`/projects/${legacy.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /In progress/);
  assert.doesNotMatch(page.text, /Project history/, 'no journal rows for an old project, and nothing breaks');
  const list = await dev.get('/projects');
  assert.match(list.text, /Projet de démonstration/);
});

test('the projects pages fit a phone: no fixed widths wider than 390px in the new styles', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const workspace = css.slice(css.indexOf('Developer workspace'), css.indexOf('   Motion'));
  for (const match of workspace.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)) {
    assert.ok(Number(match[1]) <= 390, `width ${match[1]}px`);
  }
  assert.match(workspace, /\.app-tabs-track[\s\S]*overflow-x: auto/);
});
