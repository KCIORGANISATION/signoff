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
  isLocked,
  latestApproval,
  listDeliverables,
  listEvents,
  newToken,
  toId,
  touchMilestone,
} from '../models.js';

const router = Router();
router.use(['/milestones', '/projects/:projectId/milestones'], requireAuth);

// SQL condition that is false once the milestone (whose id is the given parameter) is approved.
const unlocked = (param) => `EXISTS (SELECT 1 FROM milestones WHERE id = ${param} AND status <> 'approved')`;

function notFound(req, res) {
  res.status(404).render('error', { message: req.t('error.notFound') });
}

// An approved milestone is locked: its content is what the client approved.
// Only the payment link and note can still change.
function locked(req, res) {
  res.status(409).render('error', { message: req.t('milestone.locked.error') });
}

function readPaymentForm(body) {
  const paymentLink = parsePaymentLink(body.payment_link);
  const paymentNote = parsePaymentNote(body.payment_note);
  const values = {
    payment_link: paymentLink === false ? (body.payment_link ?? '').trim() : paymentLink,
    payment_note: paymentNote === false ? (body.payment_note ?? '').trim() : paymentNote,
  };
  let error = null;
  if (paymentLink === false) error = 'milestone.error.paymentLink';
  else if (paymentNote === false) error = 'milestone.error.paymentNote';
  return { values, error };
}

function readMilestoneForm(body) {
  const amountText = (body.amount ?? '').trim().replace(',', '.');
  const payment = readPaymentForm(body);
  const values = {
    title: (body.title ?? '').trim(),
    description: (body.description ?? '').trim(),
    amount: amountText === '' ? null : amountText,
    ...payment.values,
  };
  const amountValid = values.amount === null || (/^\d+(\.\d{1,2})?$/.test(values.amount));
  const error = !values.title || !amountValid ? 'milestone.error.fields' : payment.error;
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
    locked: isLocked(milestone),
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
  res.render('milestones/form', { project, milestone, values: milestone, error: null, locked: isLocked(milestone) });
});

router.post('/milestones/:id', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (isLocked(milestone)) return locked(req, res);

  const { values, error } = readMilestoneForm(req.body);
  if (error) {
    const project = await findProjectForUser(req.session.user.id, milestone.project_id);
    return res.status(400).render('milestones/form', { project, milestone, values, error: req.t(error) });
  }

  // The status check also covers an approval that lands while the form is being sent.
  const updated = await query(
    `UPDATE milestones
        SET title = $1, description = $2, amount = $3, payment_link = $4, payment_note = $5, updated_at = now()
      WHERE id = $6 AND status <> 'approved'
      RETURNING id`,
    [values.title, values.description, values.amount, values.payment_link, values.payment_note, milestone.id],
  );
  if (updated.length === 0) return locked(req, res);
  res.redirect(`/milestones/${milestone.id}`);
});

// Payment details stay editable after approval; they are not part of the approval record.
router.post('/milestones/:id/payment', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const { values, error } = readPaymentForm(req.body);
  if (error) {
    const project = await findProjectForUser(req.session.user.id, milestone.project_id);
    return res.status(400).render('milestones/form', {
      project, milestone, values: { ...milestone, ...values }, error: req.t(error), locked: isLocked(milestone),
    });
  }

  await query('UPDATE milestones SET payment_link = $1, payment_note = $2 WHERE id = $3', [
    values.payment_link,
    values.payment_note,
    milestone.id,
  ]);
  res.redirect(`/milestones/${milestone.id}#payment`);
});

// Starts a new draft milestone in the same project, for changes after an approval.
router.post('/milestones/:id/follow-up', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const followUp = await queryOne(
    `INSERT INTO milestones (project_id, title, token) VALUES ($1, $2, $3) RETURNING id`,
    [milestone.project_id, req.t('milestone.followUp.title', { title: milestone.title }), newToken()],
  );
  res.redirect(`/milestones/${followUp.id}/edit`);
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
  if (isLocked(milestone)) return locked(req, res);

  const label = (req.body.label ?? '').trim();

  if (req.body.kind === 'url') {
    const url = (req.body.url ?? '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return renderMilestone(req, res, milestone, { kind: 'url', message: req.t('milestone.error.url'), label, url }, 400);
    }
    await query(
      `INSERT INTO deliverables (milestone_id, kind, label, url)
       SELECT $1::int, 'url', $2::text, $3::text WHERE ${unlocked('$1::int')}`,
      [milestone.id, label, url],
    );
  } else {
    const body = (req.body.body ?? '').trim();
    if (!body) {
      return renderMilestone(req, res, milestone, { kind: 'note', message: req.t('milestone.error.note'), label, body }, 400);
    }
    await query(
      `INSERT INTO deliverables (milestone_id, kind, label, body)
       SELECT $1::int, 'note', $2::text, $3::text WHERE ${unlocked('$1::int')}`,
      [milestone.id, label, body],
    );
  }

  await touchMilestone(milestone.id);
  res.redirect(`/milestones/${milestone.id}#deliverables`);
});

router.post('/milestones/:id/deliverables/:deliverableId/delete', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (isLocked(milestone)) return locked(req, res);

  await query(`DELETE FROM deliverables WHERE id = $1 AND milestone_id = $2 AND ${unlocked('$2')}`, [
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
