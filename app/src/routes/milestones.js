import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import { absoluteUrl, baseUrl } from '../config.js';
import { emailReviewReminder, emailReviewRequest, emailSupplementProposed } from '../email.js';
import { parsePaymentLink, parsePaymentNote } from '../payment.js';
import { ACCOUNT_QUOTA_BYTES, listFiles, storageKeys, usedBytes } from '../files.js';
import { storage } from '../storage.js';
import { renderFeedback } from '../text.js';
import { clientPage, hidePayment } from './review.js';
import { canRemind, isOpen } from '../projects.js';
import { SUPPLEMENT_LIMITS, currentFrame, feedbackDecisions, readSupplementForm, revisionCount } from '../scope.js';
import { checkDeadlines, isOverdue } from '../deadlines.js';
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

// SQL condition that is false once the milestone (whose id is the given parameter) is approved,
// or set aside when its project was completed or abandoned.
const unlocked = (param) => `EXISTS (SELECT 1 FROM milestones WHERE id = ${param} AND status IN ('draft', 'sent', 'viewed', 'feedback'))`;

function notFound(req, res) {
  res.status(404).render('error', { message: req.t('error.notFound') });
}

// An approved milestone is locked: its content is what the client approved.
// Only the payment link and note can still change.
function locked(req, res) {
  res.status(409).render('error', { message: req.t('milestone.locked.error') });
}

// A completed or abandoned project is read-only until it is reopened.
function closed(req, res) {
  res.status(409).render('error', { message: req.t('project.closed.error') });
}

const projectClosed = (milestone) => milestone.project_status !== 'active';

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

// Emails the review link to the client, for a draft or after feedback. Returns whether it was sent.
async function sendToClient(req, milestone) {
  if (milestone.status !== 'draft' && milestone.status !== 'feedback') return false;
  // With a validation delay in the frame, each sending sets the date the client should decide by.
  const frame = await currentFrame(milestone.project_id);
  const updated = await query(
    `UPDATE milestones
        SET status = 'sent', updated_at = now(),
            due_at = CASE WHEN $2::int IS NULL THEN NULL ELSE now() + make_interval(days => $2::int) END
      WHERE id = $1 AND status IN ('draft', 'feedback') RETURNING id`,
    [milestone.id, frame.validation_days],
  );
  if (updated.length === 0) return false;
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
  return true;
}

// The milestone form has three buttons: save the draft, send to the client, or preview as the client.
async function afterSave(req, res, milestoneId) {
  if (req.body.intent === 'send') {
    const milestone = await findMilestoneForUser(req.session.user.id, milestoneId);
    await sendToClient(req, milestone);
    return res.redirect(`/milestones/${milestoneId}#share`);
  }
  if (req.body.intent === 'preview') return res.redirect(`/milestones/${milestoneId}/preview`);
  res.redirect(`/milestones/${milestoneId}`);
}

async function renderMilestone(req, res, milestone, formError = null, status = 200) {
  if (milestone.due_at) await checkDeadlines({ baseUrl: baseUrl(req), milestoneIds: [milestone.id] });
  const [deliverables, events, approval, files, used, frame, decisions] = await Promise.all([
    listDeliverables(milestone.id),
    listEvents(milestone.id),
    latestApproval(milestone.id),
    listFiles(milestone.id),
    usedBytes(req.session.user.id),
    currentFrame(milestone.project_id),
    feedbackDecisions(milestone.id),
  ]);
  const revisions = await revisionCount(milestone.id, frame);
  // Feedback citations (/fichier2) link to the files as they were when the client wrote.
  const current = new Map(files.map((file) => [file.id, file]));
  for (const event of events) {
    if (event.type !== 'feedback' || !event.message) continue;
    const cited = typeof event.files === 'string' ? JSON.parse(event.files) : event.files;
    event.html = renderFeedback(event.message, cited, (file) =>
      current.has(file.id) ? `/milestones/${milestone.id}/files/${file.id}` : null,
    );
  }
  const editedAfterApproval =
    milestone.approved_at !== null && new Date(milestone.updated_at) > new Date(milestone.approved_at);

  res.status(status).render('milestones/show', {
    milestone,
    deliverables,
    events,
    approval,
    files,
    filesEnabled: storage.enabled,
    quota: { used, total: ACCOUNT_QUOTA_BYTES },
    editedAfterApproval,
    locked: isLocked(milestone),
    projectClosed: projectClosed(milestone),
    canRemind: !projectClosed(milestone) && canRemind({ ...milestone, last_contact_at: lastContact(events) }),
    expired: isExpired(milestone),
    link: milestone.status === 'draft' ? null : reviewLink(req, milestone),
    formError,
    frame,
    revisions,
    decisions,
    overdue: isOverdue(milestone),
    canPropose: !projectClosed(milestone) && !isExpired(milestone),
  });
}

// When the client was last sent the link or reminded of it. Events are newest first.
function lastContact(events) {
  return events.find((event) => event.type === 'sent' || event.type === 'reminded')?.created_at ?? null;
}

// The create / edit form. An existing milestone also shows its files and upload zone.
async function renderForm(req, res, locals, status = 200) {
  const { milestone } = locals;
  const [files, used] = milestone
    ? await Promise.all([listFiles(milestone.id), usedBytes(req.session.user.id)])
    : [[], 0];
  res.status(status).render('milestones/form', {
    locked: false,
    ...locals,
    files,
    filesEnabled: storage.enabled,
    quota: { used, total: ACCOUNT_QUOTA_BYTES },
  });
}

router.get('/projects/:projectId/milestones/new', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.projectId);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  await renderForm(req, res, { project, milestone: null, values: {}, error: null });
});

router.post('/projects/:projectId/milestones', async (req, res) => {
  const project = await findProjectForUser(req.session.user.id, req.params.projectId);
  if (!project) return notFound(req, res);
  if (!isOpen(project)) return closed(req, res);

  const { values, error } = readMilestoneForm(req.body);
  if (error) {
    return renderForm(req, res, { project, milestone: null, values, error: req.t(error) }, 400);
  }

  const milestone = await queryOne(
    `INSERT INTO milestones (project_id, title, description, amount, payment_link, payment_note, token)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [project.id, values.title, values.description, values.amount, values.payment_link, values.payment_note, newToken()],
  );
  await afterSave(req, res, milestone.id);
});

router.get('/milestones/:id', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  await renderMilestone(req, res, milestone);
});

router.get('/milestones/:id/edit', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);

  const project = await findProjectForUser(req.session.user.id, milestone.project_id);
  await renderForm(req, res, { project, milestone, values: milestone, error: null, locked: isLocked(milestone) });
});

router.post('/milestones/:id', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);
  if (isLocked(milestone)) return locked(req, res);

  const { values, error } = readMilestoneForm(req.body);
  if (error) {
    const project = await findProjectForUser(req.session.user.id, milestone.project_id);
    return renderForm(req, res, { project, milestone, values, error: req.t(error) }, 400);
  }

  // The status check also covers an approval that lands while the form is being sent.
  const updated = await query(
    `UPDATE milestones
        SET title = $1, description = $2, amount = $3, payment_link = $4, payment_note = $5, updated_at = now()
      WHERE id = $6 AND status IN ('draft', 'sent', 'viewed', 'feedback')
      RETURNING id`,
    [values.title, values.description, values.amount, values.payment_link, values.payment_note, milestone.id],
  );
  if (updated.length === 0) return locked(req, res);
  await afterSave(req, res, milestone.id);
});

// The client page as the client would see it now, without sending anything or recording any event.
router.get('/milestones/:id/preview', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  milestone.dev_name = req.session.user.name;
  const page = await clientPage(hidePayment(milestone), { fileBase: `/milestones/${milestone.id}/files`, preview: true });
  res.render('review/show', page);
});

// Payment details stay editable after approval; they are not part of the approval record.
router.post('/milestones/:id/payment', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);

  const { values, error } = readPaymentForm(req.body);
  if (error) {
    const project = await findProjectForUser(req.session.user.id, milestone.project_id);
    return renderForm(req, res, {
      project, milestone, values: { ...milestone, ...values }, error: req.t(error), locked: isLocked(milestone),
    }, 400);
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
  if (projectClosed(milestone)) return closed(req, res);

  const followUp = await queryOne(
    `INSERT INTO milestones (project_id, title, token) VALUES ($1, $2, $3) RETURNING id`,
    [milestone.project_id, req.t('milestone.followUp.title', { title: milestone.title }), newToken()],
  );
  res.redirect(`/milestones/${followUp.id}/edit`);
});

router.post('/milestones/:id/delete', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);

  const keys = await storageKeys('SELECT storage_key FROM files WHERE milestone_id = $1', [milestone.id]);
  await query('DELETE FROM milestones WHERE id = $1', [milestone.id]);
  await storage.removeQuietly(keys);
  res.redirect(`/projects/${milestone.project_id}`);
});

router.post('/milestones/:id/deliverables', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);
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
  if (projectClosed(milestone)) return closed(req, res);
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
  if (projectClosed(milestone)) return closed(req, res);

  await sendToClient(req, milestone);
  res.redirect(`/milestones/${milestone.id}#share`);
});

// Emails the same link again to a client who has not answered yet, at most once a day.
router.post('/milestones/:id/remind', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);

  const events = await listEvents(milestone.id);
  if (canRemind({ ...milestone, last_contact_at: lastContact(events) })) {
    await addEvent(milestone.id, 'reminded');
    await emailReviewReminder({
      to: milestone.client_email,
      lang: req.lang,
      devName: req.session.user.name,
      clientName: milestone.client_name,
      title: milestone.title,
      projectName: milestone.project_name,
      link: reviewLink(req, milestone),
    });
  }
  const back = { home: '/dashboard', project: `/projects/${milestone.project_id}` }[req.body.back];
  res.redirect(back ?? `/milestones/${milestone.id}#share`);
});

// ---------------------------------------------------------------------------
// Out-of-scope requests, revisions beyond the frame, and paid supplements.
// ---------------------------------------------------------------------------
async function findFeedback(milestoneId, eventId) {
  const id = toId(eventId);
  if (!id) return null;
  return queryOne(`SELECT * FROM review_events WHERE id = $1 AND milestone_id = $2 AND type = 'feedback'`, [id, milestoneId]);
}

// Records a decision about one feedback once: marking it out of scope, or accepting it beyond the limit.
async function recordFeedbackDecision(milestoneId, type, feedbackId) {
  const exists = await queryOne(
    `SELECT 1 FROM review_events WHERE milestone_id = $1 AND type = $2 AND (snapshot->>'feedback_id')::int = $3`,
    [milestoneId, type, feedbackId],
  );
  if (!exists) await addEvent(milestoneId, type, { snapshot: { feedback_id: feedbackId } });
}

router.post('/milestones/:id/feedback/:eventId/out-of-scope', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  const feedback = await findFeedback(milestone.id, req.params.eventId);
  if (!feedback) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);

  await recordFeedbackDecision(milestone.id, 'out_of_scope', feedback.id);
  res.redirect(`/milestones/${milestone.id}#feedback-${feedback.id}`);
});

// "Accept anyway": the feedback beyond the included revisions is handled as part of the milestone.
router.post('/milestones/:id/feedback/:eventId/accept', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  const feedback = await findFeedback(milestone.id, req.params.eventId);
  if (!feedback || !feedback.over_limit) return notFound(req, res);
  if (projectClosed(milestone)) return closed(req, res);

  await recordFeedbackDecision(milestone.id, 'revision_accepted', feedback.id);
  res.redirect(`/milestones/${milestone.id}#feedback-${feedback.id}`);
});

async function renderSupplementForm(req, res, milestone, feedback, { values = {}, error = null, status = 200 } = {}) {
  res.status(status).render('milestones/supplement', { milestone, feedback, values, error, limits: SUPPLEMENT_LIMITS });
}

router.get('/milestones/:id/supplements/new', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  const feedback = await findFeedback(milestone.id, req.query.feedback);
  if (!feedback) return notFound(req, res);
  if (projectClosed(milestone) || isExpired(milestone)) return closed(req, res);

  await renderSupplementForm(req, res, milestone, feedback);
});

router.post('/milestones/:id/supplements', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return notFound(req, res);
  const feedback = await findFeedback(milestone.id, req.body.feedback_id);
  if (!feedback) return notFound(req, res);
  if (projectClosed(milestone) || isExpired(milestone)) return closed(req, res);

  const { values, error } = readSupplementForm(req.body);
  if (error) return renderSupplementForm(req, res, milestone, feedback, { values, error: req.t(error), status: 400 });

  // Proposing a supplement for a request means it is out of scope; if it is declined, it stays so.
  await recordFeedbackDecision(milestone.id, 'out_of_scope', feedback.id);
  const supplement = await queryOne(
    `INSERT INTO supplements (project_id, milestone_id, feedback_id, title, description, amount, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [milestone.project_id, milestone.id, feedback.id, values.title, values.description, values.amount, milestone.currency],
  );
  await addEvent(milestone.id, 'supplement_proposed', {
    snapshot: { supplement_id: supplement.id, feedback_id: feedback.id, title: supplement.title, amount: supplement.amount, currency: supplement.currency },
  });
  await emailSupplementProposed({
    to: milestone.client_email,
    lang: req.lang,
    devName: req.session.user.name,
    clientName: milestone.client_name,
    title: supplement.title,
    projectName: milestone.project_name,
    amount: res.locals.fmt.money(supplement.amount, supplement.currency),
    link: absoluteUrl(req, `/r/${milestone.token}/review`),
  });
  res.redirect(`/milestones/${milestone.id}#feedback-${feedback.id}`);
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
