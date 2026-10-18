import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import { absoluteUrl } from '../config.js';
import { emailReviewRequest } from '../email.js';
import { parsePaymentLink, parsePaymentNote } from '../payment.js';
import {
  addEvent,
  certificateData,
  findMilestoneForUser,
  findProjectForUser,
  isExpired,
  latestApproval,
  listDeliverables,
  listEvents,
  newToken,
  toId,
  touchMilestone,
} from '../models.js';

const router = Router();
router.use(['/milestones', '/projects/:projectId/milestones'], requireAuth);

function notFound(req, res) {
  res.status(404).render('error', { message: req.t('error.notFound') });
}

function readMilestoneForm(body) {
  const amountText = (body.amount ?? '').trim().replace(',', '.');
  const paymentLink = parsePaymentLink(body.payment_link);
  const paymentNote = parsePaymentNote(body.payment_note);
  const values = {
    title: (body.title ?? '').trim(),
    description: (body.description ?? '').trim(),
    amount: amountText === '' ? null : amountText,
    payment_link: paymentLink === false ? (body.payment_link ?? '').trim() : paymentLink,
    payment_note: paymentNote === false ? (body.payment_note ?? '').trim() : paymentNote,
  };
  const amountValid = values.amount === null || (/^\d+(\.\d{1,2})?$/.test(values.amount));

  let error = null;
  if (!values.title || !amountValid) error = 'milestone.error.fields';
  else if (paymentLink === false) error = 'milestone.error.paymentLink';
  else if (paymentNote === false) error = 'milestone.error.paymentNote';
  return { values, error };
}

function reviewLink(req, milestone) {
  return absoluteUrl(req, `/r/${milestone.token}`);
}

async function renderMilestone(req, res, milestone, formError = null, status = 200) {
  const [deliverables, events, approval] = await Promise.all([
    listDeliverables(milestone.id),
    listEvents(milestone.id),
    latestApproval(milestone.id),
  ]);
  const editedAfterApproval =
    milestone.approved_at !== null && new Date(milestone.updated_at) > new Date(milestone.approved_at);

  res.status(status).render('milestones/show', {
    milestone,
    deliverables,
    events,
    approval,
    editedAfterApproval,
    expired: isExpired(milestone),
    link: milestone.status === 'draft' ? null : reviewLink(req, milestone),
    formError,
  });
}

router.get('/projects/:projectId/milestones/new', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.projectId);
  if (!project) return notFound(req, res);

  res.render('milestones/form', { project, milestone: null, values: {}, error: null });
});

router.post('/projects/:projectId/milestones', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.projectId);
  if (!project) return notFound(req, res);

  const { values, error } = readMilestoneForm(req.body);
  if (error) {
    return res.status(400).render('milestones/form', { project, milestone: null, values, error: req.t(error) });
  }

  const milestone = await queryOne(
    `INSERT INTO milestones (project_id, title, description, amount, payment_link, payment_note, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [project.id, values.title, values.description, values.amount, values.payment_link, values.payment_note, newToken()],
  );
  res.redirect(`/milestones/${milestone.id}`);
});

router.get('/milestones/:id', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  await renderMilestone(req, res, milestone);
});

router.get('/milestones/:id/edit', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const project = await findProjectForUser(req.session.user.id, milestone.project_id);
  res.render('milestones/form', { project, milestone, values: milestone, error: null });
});

router.post('/milestones/:id', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const { values, error } = readMilestoneForm(req.body);
  if (error) {
    const project = await findProjectForUser(req.session.user.id, milestone.project_id);
    return res.status(400).render('milestones/form', { project, milestone, values, error: req.t(error) });
  }

  await query(
    `UPDATE milestones
        SET title = $1, description = $2, amount = $3, payment_link = $4, payment_note = $5, updated_at = now()
      WHERE id = $6`,
    [values.title, values.description, values.amount, values.payment_link, values.payment_note, milestone.id],
  );
  res.redirect(`/milestones/${milestone.id}`);
});

router.post('/milestones/:id/delete', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  await query('DELETE FROM milestones WHERE id = $1', [milestone.id]);
  res.redirect(`/projects/${milestone.project_id}`);
});

router.post('/milestones/:id/deliverables', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const label = (req.body.label ?? '').trim();

  if (req.body.kind === 'url') {
    const url = (req.body.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return renderMilestone(req, res, milestone, { kind: 'url', message: req.t('milestone.error.url'), label, url }, 400);
    }
    await query(
      `INSERT INTO deliverables (milestone_id, kind, label, url) VALUES ($1, 'url', $2, $3)`,
      [milestone.id, label, url],
    );
  } else {
    const body = (req.body.body ?? '').trim();
    if (!body) {
      return renderMilestone(req, res, milestone, { kind: 'note', message: req.t('milestone.error.note'), label, body }, 400);
    }
    await query(
      `INSERT INTO deliverables (milestone_id, kind, label, body) VALUES ($1, 'note', $2, $3)`,
      [milestone.id, label, body],
    );
  }

  await touchMilestone(milestone.id);
  res.redirect(`/milestones/${milestone.id}#deliverables`);
});

router.post('/milestones/:id/deliverables/:deliverableId/delete', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  await query('DELETE FROM deliverables WHERE id = $1 AND milestone_id = $2', [
    toId(req.params.deliverableId),
    milestone.id,
  ]);
  await touchMilestone(milestone.id);
  res.redirect(`/milestones/${milestone.id}#deliverables`);
});

// Emails the review link to the client. The page also shows the link so the developer can copy it.
router.post('/milestones/:id/send', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  if (milestone.status === 'draft' || milestone.status === 'feedback') {
    await query(`UPDATE milestones SET status = 'sent', updated_at = now() WHERE id = $1`, [milestone.id]);
    await addEvent(milestone.id, 'sent');
    await emailReviewRequest({
      to: milestone.client_email,
      lang: req.lang,
      devName: req.session.user.name,
      clientName: milestone.client_name,
      title: milestone.title,
      projectName: milestone.project_name,
      link: reviewLink(req, milestone),
    });
  }
  res.redirect(`/milestones/${milestone.id}#share`);
});

router.get('/milestones/:id/certificate', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const approval = await latestApproval(milestone.id);
  res.render('milestones/certificate', {
    certificate: approval ? certificateData(milestone, approval) : null,
    backUrl: `/milestones/${milestone.id}`,
  });
});

export default router;
