import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import { CURRENCIES, findProjectForUser } from '../models.js';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readProjectForm(body) {
  const values = {
    name: (body.name ?? '').trim(),
    client_name: (body.client_name ?? '').trim(),
    client_email: (body.client_email ?? '').trim(),
    currency: CURRENCIES.includes(body.currency) ? body.currency : 'EUR',
  };
  const valid = values.name && values.client_name && EMAIL_PATTERN.test(values.client_email);
  return { values, valid };
}

router.get('/dashboard', requireAuth, async (req, res) => {
  const userId = req.session.user.id;

  const projects = await query(
    `SELECT p.*,
            COUNT(m.id)::int AS milestone_count,
            COUNT(m.id) FILTER (WHERE m.status = 'approved')::int AS approved_count,
            MAX(m.updated_at) AS last_activity
       FROM projects p
       LEFT JOIN milestones m ON m.project_id = p.id
      WHERE p.user_id = $1
      GROUP BY p.id
      ORDER BY COALESCE(MAX(m.updated_at), p.created_at) DESC`,
    [userId],
  );

  const milestones = await query(
    `SELECT m.id, m.title, m.status, m.amount, m.project_id, p.currency,
            COALESCE((SELECT MAX(e.created_at) FROM review_events e WHERE e.milestone_id = m.id), m.updated_at) AS last_activity
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
      WHERE p.user_id = $1
      ORDER BY m.id`,
    [userId],
  );

  const waiting = milestones
    .filter((m) => m.status === 'sent' || m.status === 'viewed')
    .map((m) => ({ ...m, project: projects.find((p) => p.id === m.project_id) }));

  for (const project of projects) {
    project.milestones = milestones.filter((m) => m.project_id === project.id);
  }

  res.render('dashboard', { projects, waiting });
});

router.get('/projects/new', requireAuth, (req, res) => {
  res.render('projects/form', { project: null, values: { currency: 'EUR' }, error: null, currencies: CURRENCIES });
});

router.post('/projects', requireAuth, async (req, res) => {
  const { values, valid } = readProjectForm(req.body);
  if (!valid) {
    return res.status(400).render('projects/form', {
      project: null, values, error: req.t('project.error.fields'), currencies: CURRENCIES,
    });
  }

  const project = await queryOne(
    `INSERT INTO projects (user_id, name, client_name, client_email, currency)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.session.user.id, values.name, values.client_name, values.client_email, values.currency],
  );
  res.redirect(`/projects/${project.id}`);
});

router.get('/projects/:id', requireAuth, async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return res.status(404).render('error', { message: req.t('error.notFound') });

  const milestones = await query('SELECT * FROM milestones WHERE project_id = $1 ORDER BY id', [project.id]);
  res.render('projects/show', { project, milestones });
});

router.get('/projects/:id/edit', requireAuth, async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return res.status(404).render('error', { message: req.t('error.notFound') });

  res.render('projects/form', { project, values: project, error: null, currencies: CURRENCIES });
});

router.post('/projects/:id', requireAuth, async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return res.status(404).render('error', { message: req.t('error.notFound') });

  const { values, valid } = readProjectForm(req.body);
  if (!valid) {
    return res.status(400).render('projects/form', {
      project, values, error: req.t('project.error.fields'), currencies: CURRENCIES,
    });
  }

  await query(
    'UPDATE projects SET name = $1, client_name = $2, client_email = $3, currency = $4 WHERE id = $5',
    [values.name, values.client_name, values.client_email, values.currency, project.id],
  );
  res.redirect(`/projects/${project.id}`);
});

router.post('/projects/:id/delete', requireAuth, async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.id);
  if (!project) return res.status(404).render('error', { message: req.t('error.notFound') });

  await query('DELETE FROM projects WHERE id = $1', [project.id]);
  res.redirect('/dashboard');
});

export default router;
