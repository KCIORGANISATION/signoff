import { Router } from 'express';
import { query } from '../db.js';
import { absoluteUrl } from '../config.js';
import { emailApproved, emailFeedback } from '../email.js';
import {
  LINK_LIFETIME_DAYS,
  addEvent,
  buildSnapshot,
  certificateData,
  findMilestoneByToken,
  isExpired,
  latestApproval,
  listDeliverables,
} from '../models.js';
import { paymentDomain } from '../payment.js';
import { findFile, listFiles, sendFile } from '../files.js';
import { storage } from '../storage.js';

// Client-facing pages. No account: the secret token in the URL is the access.
const router = Router();

function developerEmail(req, milestone) {
  return {
    to: milestone.dev_email,
    lang: milestone.dev_lang,
    clientName: milestone.client_name,
    title: milestone.title,
    projectName: milestone.project_name,
    link: absoluteUrl(req, `/milestones/${milestone.id}`),
  };
}

// req.ip is the client's real address because of the "trust proxy" setting.
function clientDetails(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? '' };
}

// Loads the milestone for the token, or answers with a 404 / expired page.
// Payment details are removed until the client approves, so no page can leak them.
async function loadMilestone(req, res) {
  const milestone = await findMilestoneByToken(req.params.token);
  if (!milestone || milestone.status === 'draft') {
    res.status(404).render('error', { message: req.t('error.notFound') });
    return null;
  }
  if (isExpired(milestone)) {
    res.status(410).render('review/expired', { milestone });
    return null;
  }
  const { payment_link: link, payment_note: note } = milestone;
  delete milestone.payment_link;
  delete milestone.payment_note;
  milestone.payment =
    milestone.status === 'approved' && (link || note)
      ? { link, domain: link ? paymentDomain(link) : null, note }
      : null;
  return milestone;
}

router.get('/r/:token', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;

  if (milestone.status === 'sent') {
    await query(`UPDATE milestones SET status = 'viewed' WHERE id = $1`, [milestone.id]);
    await addEvent(milestone.id, 'viewed', clientDetails(req));
    milestone.status = 'viewed';
  }

  const [deliverables, files] = await Promise.all([listDeliverables(milestone.id), listFiles(milestone.id)]);
  res.render('review/show', { milestone, deliverables, files, error: null });
});

router.post('/r/:token/approve', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (milestone.status !== 'sent' && milestone.status !== 'viewed') return res.redirect(`/r/${req.params.token}`);

  // The status check in the WHERE clause makes a double click record only one approval.
  // Once approved, the milestone is locked, so the snapshot below is exactly what was approved.
  const updated = await query(
    `UPDATE milestones
        SET status = 'approved', approved_at = now(), updated_at = now(),
            expires_at = now() + make_interval(days => $2)
      WHERE id = $1 AND status IN ('sent', 'viewed')
      RETURNING id`,
    [milestone.id, LINK_LIFETIME_DAYS],
  );
  if (updated.length === 0) return res.redirect(`/r/${req.params.token}`);

  const approved = await findMilestoneByToken(req.params.token);
  const [deliverables, files] = await Promise.all([listDeliverables(milestone.id), listFiles(milestone.id)]);
  await addEvent(milestone.id, 'approved', {
    ...clientDetails(req),
    clientName: approved.client_name,
    snapshot: buildSnapshot(approved, deliverables, files),
  });

  await emailApproved(developerEmail(req, milestone));

  res.redirect(`/r/${req.params.token}`);
});

router.post('/r/:token/feedback', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (milestone.status !== 'sent' && milestone.status !== 'viewed') return res.redirect(`/r/${req.params.token}`);

  const message = (req.body.message ?? '').trim();
  if (!message) {
    const [deliverables, files] = await Promise.all([listDeliverables(milestone.id), listFiles(milestone.id)]);
    return res.status(400).render('review/show', { milestone, deliverables, files, error: req.t('review.feedback.error') });
  }

  const updated = await query(
    `UPDATE milestones SET status = 'feedback', updated_at = now()
      WHERE id = $1 AND status IN ('sent', 'viewed')
      RETURNING id`,
    [milestone.id],
  );
  if (updated.length === 0) return res.redirect(`/r/${req.params.token}`);

  await addEvent(milestone.id, 'feedback', { ...clientDetails(req), clientName: milestone.client_name, message });

  await emailFeedback({ ...developerEmail(req, milestone), message });

  res.redirect(`/r/${req.params.token}`);
});

// A file of this milestone, for whoever holds its valid client link.
router.get('/r/:token/files/:fileId', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  const file = await findFile(milestone.id, req.params.fileId);
  if (!file) return res.status(404).render('error', { message: req.t('error.notFound') });
  if (!storage.enabled) return res.status(503).render('error', { message: req.t('files.unavailable') });
  await sendFile(res, file);
});

router.get('/r/:token/certificate', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;

  const approval = await latestApproval(milestone.id);
  res.render('milestones/certificate', {
    certificate: approval ? certificateData(milestone, approval) : null,
    backUrl: `/r/${req.params.token}`,
  });
});

export default router;
