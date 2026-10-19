import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import { CURRENCIES, findProjectForUser } from '../models.js';
import { storageKeys } from '../files.js';
import { storage } from '../storage.js';
import { emailProjectClosed } from '../email.js';
import {
  ABANDON_REASONS,
  NOTES_MAX_LENGTH,
  PROJECT_STATUSES,
  REASON_MAX_LENGTH,
  addProjectEvent,
  arrangeMilestones,
  cleanText,
  closeProject,
  isOpen,
  listProjectEvents,
  milestonesWithProgress,
  nextStep,
  readNotes,
  reopenProject,
  saveNotes,
} from '../projects.js';

const router = Router();
router.use('/projects', requireAuth);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PROJECT_LIMITS = { name: 120, client_name: 120, client_email: 254, description: 5000 };
const FILTERS = ['active', 'completed', 'abandoned', 'all'];

function readProjectForm(body) {
  const description = cleanText(body.description, PROJECT_LIMITS.description);
  const values = {
    name: (body.name ?? '').trim(),
    client_name: (body.client_name ?? '').trim(),
    client_email: (body.client_email ?? '').trim(),
    description: description === false ? String(body.description ?? '') : description ?? '',
    currency: CURRENCIES.includes(body.currency) ? body.currency : 'EUR',
  };
  let error = null;
  if (!values.name || !values.client_name || !EMAIL_PATTERN.test(values.client_email)) error = 'project.error.fields';
  else if (
    values.name.length > PROJECT_LIMITS.name ||
    values.client_name.length > PROJECT_LIMITS.client_name ||
    values.client_email.length > PROJECT_LIMITS.client_email ||
    description === false
  ) error = 'project.error.length';
  return { values, error };
}

function notFound(req, res) {
  res.status(404).render('error', { message: req.t('error.notFound') });
}

// A completed or abandoned project is read-only until it is reopened.
function closed(req, res) {
  res.status(409).render('error', { message: req.t('project.closed.error') });
}

function wantsJson(req) {
  return (req.get('accept') ?? '').includes('application/json');
}

function renderForm(res, locals, status = 200) {
  res.status(status).render('projects/form', { currencies: CURRENCIES, limits: PROJECT_LIMITS, ...locals });
}

router.get('/projects', async (req, res) => {
  const filter = FILTERS.includes(req.query.filter) ? req.query.filter : 'active';
  const projects = await query(
    `SELECT * FROM projects WHERE user_id = $1
      ORDER BY (SELECT MAX(m.updated_at) FROM milestones m WHERE m.project_id = projects.id) DESC NULLS LAST, created_at DESC`,
    [req.session.user.id],
  );
  const counts = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, projects.filter((p) => p.status === status).length]));
  counts.all = projects.length;

  const shown = filter === 'all' ? projects : projects.filter((p) => p.status === filter);
  const milestones = await milestonesWithProgress(shown.map((p) => p.id));
  for (const project of shown) {
    const own = milestones.filter((m) => m.project_id === project.id);
    project.progress = arrangeMilestones(own);
    project.next = nextStep(project, own);
  }

  res.render('projects/index', { projects: shown, filter, filters: FILTERS, counts });
});

router.get('/projects/new', (req, res) => {
  renderForm(res, { project: null, values: { currency: 'EUR' }, error: null });
});

router.post('/projects', async (req, res) => {
  const { values, error } = readProjectForm(req.body);
  if (error) return renderForm(res, { project: null, values, error: req.t(error) }, 400);

  const project = await queryOne(
    `INSERT INTO projects (user_id, name, client_name, client_email, currency, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.session.user.id, values.name, values.client_name, values.client_email, values.currency, values.description],
  );
  await addProjectEvent(project.id, 'created', { to: 'active' });
  res.redirect(`/projects/${project.id}`);
});

router.get('/projects/:id', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);

  const [milestones, events, notes] = await Promise.all([
    milestonesWithProgress([project.id]),
    listProjectEvents(project.id),
    readNotes(project.id),
  ]);
  res.render('projects/show', {
    project,
    milestones,
    ...arrangeMilestones(milestones),
    next: nextStep(project, milestones),
    events,
    notes,
    notesMax: NOTES_MAX_LENGTH,
    open: isOpen(project),
  });
});

router.get('/projects/:id/edit', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  renderForm(res, { project, values: project, error: null });
});

router.post('/projects/:id', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  const { values, error } = readProjectForm(req.body);
  if (error) return renderForm(res, { project, values, error: req.t(error) }, 400);

  await query(
    `UPDATE projects SET name = $1, client_name = $2, client_email = $3, currency = $4, description = $5
      WHERE id = $6 AND status = 'active'`,
    [values.name, values.client_name, values.client_email, values.currency, values.description, project.id],
  );
  res.redirect(`/projects/${project.id}`);
});

router.post('/projects/:id/delete', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);

  const keys = await storageKeys(
    'SELECT f.storage_key FROM files f JOIN milestones m ON m.id = f.milestone_id WHERE m.project_id = $1',
    [project.id],
  );
  await query('DELETE FROM projects WHERE id = $1', [project.id]);
  await storage.removeQuietly(keys);
  res.redirect('/projects');
});

// ---------------------------------------------------------------------------
// Complete, abandon, reopen. Each GET is the confirmation page; the browser
// script shows the same form in a dialog.
// ---------------------------------------------------------------------------
async function renderStateForm(req, res, project, mode, { error = null, values = {}, status = 200 } = {}) {
  const unapproved = await query(
    `SELECT id, title, status FROM milestones WHERE project_id = $1 AND status <> 'approved' ORDER BY id`,
    [project.id],
  );
  res.status(status).render('projects/state', {
    project,
    mode,
    unapproved,
    reasons: ABANDON_REASONS,
    reasonMax: REASON_MAX_LENGTH,
    error,
    values,
  });
}

router.get('/projects/:id/complete', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);
  await renderStateForm(req, res, project, 'complete');
});

router.post('/projects/:id/complete', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  // Unapproved milestones become "not done": the developer has to say so explicitly.
  const pending = await queryOne(
    `SELECT COUNT(*)::int AS count FROM milestones WHERE project_id = $1 AND status <> 'approved'`,
    [project.id],
  );
  if (pending.count > 0 && req.body.confirm_unapproved !== 'yes') {
    return renderStateForm(req, res, project, 'complete', { error: req.t('project.complete.confirmError'), status: 400 });
  }

  const event = await closeProject(project.id, 'completed');
  if (!event) return closed(req, res);
  res.redirect(`/projects/${project.id}`);
});

router.get('/projects/:id/abandon', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);
  await renderStateForm(req, res, project, 'abandon');
});

router.post('/projects/:id/abandon', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  const reason = ABANDON_REASONS.includes(req.body.reason) ? req.body.reason : null;
  const note = cleanText(req.body.note, REASON_MAX_LENGTH);
  const notify = req.body.notify_client === 'yes';
  const values = { reason, note: note === false ? String(req.body.note ?? '') : note, notify };
  if (!reason || note === false) {
    const error = req.t(reason ? 'project.reason.tooLong' : 'project.abandon.reasonError', { max: REASON_MAX_LENGTH });
    return renderStateForm(req, res, project, 'abandon', { error, values, status: 400 });
  }

  const event = await closeProject(project.id, 'abandoned', { reason, note });
  if (!event) return closed(req, res);
  if (notify) {
    await emailProjectClosed({
      to: project.client_email,
      lang: req.lang,
      devName: req.session.user.name,
      clientName: project.client_name,
      projectName: project.name,
    });
  }
  res.redirect(`/projects/${project.id}`);
});

router.get('/projects/:id/reopen', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (isOpen(project)) return res.redirect(`/projects/${project.id}`);
  await renderStateForm(req, res, project, 'reopen');
});

router.post('/projects/:id/reopen', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return notFound(req, res);
  if (isOpen(project)) return res.redirect(`/projects/${project.id}`);

  const note = cleanText(req.body.note, REASON_MAX_LENGTH);
  if (!note) {
    const error = req.t(note === false ? 'project.reason.tooLong' : 'project.reopen.reasonError', { max: REASON_MAX_LENGTH });
    return renderStateForm(req, res, project, 'reopen', { error, values: { note: String(req.body.note ?? '') }, status: 400 });
  }

  await reopenProject(project.id, project.status, note);
  res.redirect(`/projects/${project.id}`);
});

// ---------------------------------------------------------------------------
// Private notes. Saved by the page as the developer types; a plain form without JavaScript.
// ---------------------------------------------------------------------------
router.post('/projects/:id/notes', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) {
    if (wantsJson(req)) return res.status(404).json({ error: req.t('error.notFound') });
    return notFound(req, res);
  }

  const body = String(req.body.body ?? '').replace(/\r\n?/g, '\n');
  if (body.length > NOTES_MAX_LENGTH) {
    const message = req.t('notes.tooLong', { max: NOTES_MAX_LENGTH });
    if (wantsJson(req)) return res.status(400).json({ error: message });
    return res.status(400).render('error', { message });
  }

  const saved = await saveNotes(project.id, body);
  if (wantsJson(req)) return res.json({ ok: true, savedAt: saved.updated_at });
  res.redirect(`/projects/${project.id}#notes`);
});

export default router;
