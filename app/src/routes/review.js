import { Router } from 'express';
import { query } from '../db.js';
import { absoluteUrl } from '../config.js';
import { emailApproved, emailFeedback } from '../email.js';
import {
  LINK_LIFETIME_DAYS,
  addEvent,
  buildSnapshot,
  certificateData,
  clientHistory,
  findMilestoneByToken,
  isExpired,
  latestApproval,
  listDeliverables,
  milestonePosition,
} from '../models.js';
import { paymentDomain } from '../payment.js';
import { findFile, listFiles, sendFile } from '../files.js';
import { storage } from '../storage.js';
import { describe } from '../text.js';
import { isClosedForClient } from '../projects.js';

const MAX_NAME_LENGTH = 120;

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
  // A milestone set aside before it was ever sent was never shown to the client either.
  if (!milestone || milestone.status === 'draft' || milestone.status_before_close === 'draft') {
    res.status(404).render('error', { message: req.t('error.notFound') });
    return null;
  }
  if (isExpired(milestone)) {
    res.status(410).render('review/expired', { milestone });
    return null;
  }
  return hidePayment(milestone);
}

// The payment link and note leave the server only once the milestone is approved.
// Before that, the page only knows whether the developer gave payment details.
export function hidePayment(milestone) {
  const { payment_link: link, payment_note: note } = milestone;
  delete milestone.payment_link;
  delete milestone.payment_note;
  milestone.hasPayment = Boolean(link || note);
  milestone.payment =
    milestone.status === 'approved' && (link || note)
      ? { link, domain: link ? paymentDomain(link) : null, note }
      : null;
  return milestone;
}

// Everything the client milestone page shows. fileBase is where the files are served:
// the client link, or the developer's own URL for the "view as client" preview.
export async function clientPage(milestone, { fileBase, preview = false, mode = 'choose', error = null, values = {} }) {
  const [deliverables, files, history, position, approval] = await Promise.all([
    listDeliverables(milestone.id),
    listFiles(milestone.id),
    clientHistory(milestone),
    milestonePosition(milestone),
    milestone.status === 'approved' ? latestApproval(milestone.id) : null,
  ]);
  return {
    milestone,
    approval,
    deliverables,
    files,
    history,
    position,
    description: describe(milestone.description),
    fileBase,
    preview,
    // The project was completed or abandoned: the page says so and takes no decision.
    closed: isClosedForClient(milestone),
    mode,
    error,
    values,
  };
}

async function markViewed(req, milestone) {
  if (milestone.status !== 'sent') return;
  const updated = await query(`UPDATE milestones SET status = 'viewed' WHERE id = $1 AND status = 'sent' RETURNING id`, [
    milestone.id,
  ]);
  if (updated.length > 0) await addEvent(milestone.id, 'viewed', clientDetails(req));
  milestone.status = 'viewed';
}

function renderReview(req, res, milestone, options = {}, status = 200) {
  return clientPage(milestone, { fileBase: `/r/${req.params.token}/files`, ...options }).then((page) =>
    res.status(status).render('review/show', page),
  );
}

// The link opens on a short welcome card; once approved or answered, it opens on the milestone.
router.get('/r/:token', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  await markViewed(req, milestone);

  if (milestone.status !== 'viewed') return renderReview(req, res, milestone);
  const position = await milestonePosition(milestone);
  res.render('review/welcome', { milestone, position });
});

router.get('/r/:token/review', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  await markViewed(req, milestone);
  await renderReview(req, res, milestone);
});

router.post('/r/:token/approve', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (isClosedForClient(milestone) || (milestone.status !== 'sent' && milestone.status !== 'viewed')) {
    return res.redirect(`/r/${req.params.token}`);
  }

  // The client types their full name: it is recorded with the approval and shown on the certificate.
  const name = (req.body.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME_LENGTH) {
    return renderReview(req, res, milestone, { mode: 'approve', error: req.t('review.approve.nameError'), values: { name } }, 400);
  }

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
    clientName: name,
    snapshot: buildSnapshot(approved, deliverables, files),
  });

  await emailApproved({ ...developerEmail(req, milestone), clientName: name });

  res.redirect(`/r/${req.params.token}`);
});

router.post('/r/:token/feedback', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (isClosedForClient(milestone) || (milestone.status !== 'sent' && milestone.status !== 'viewed')) {
    return res.redirect(`/r/${req.params.token}`);
  }

  const message = (req.body.message ?? '').trim();
  if (!message) {
    return renderReview(req, res, milestone, { mode: 'feedback', error: req.t('review.feedback.error') }, 400);
  }

  const updated = await query(
    `UPDATE milestones SET status = 'feedback', updated_at = now()
      WHERE id = $1 AND status IN ('sent', 'viewed')
      RETURNING id`,
    [milestone.id],
  );
  if (updated.length === 0) return res.redirect(`/r/${req.params.token}`);

  // The files in the order the client saw them, so their /fichierN citations keep their meaning.
  const files = (await listFiles(milestone.id)).map(({ id, name }) => ({ id, name }));
  await addEvent(milestone.id, 'feedback', { ...clientDetails(req), clientName: milestone.client_name, message, files });

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
