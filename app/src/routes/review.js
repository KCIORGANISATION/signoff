import { Router } from 'express';
import { query } from '../db.js';
import { notifyDeveloper } from '../notify.js';
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

// Client-facing pages. No account: the secret token in the URL is the access.
const router = Router();

function developerUrl(req, milestone) {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/milestones/${milestone.id}`;
}

function clientDetails(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? '' };
}

// Loads the milestone for the token, or answers with a 404 / expired page.
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

  const deliverables = await listDeliverables(milestone.id);
  res.render('review/show', { milestone, deliverables, error: null });
});

router.post('/r/:token/approve', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (milestone.status !== 'sent' && milestone.status !== 'viewed') return res.redirect(`/r/${req.params.token}`);

  const deliverables = await listDeliverables(milestone.id);
  // The status check in the WHERE clause makes a double click record only one approval.
  const updated = await query(
    `UPDATE milestones
        SET status = 'approved', approved_at = now(), updated_at = now(),
            expires_at = now() + make_interval(days => $2)
      WHERE id = $1 AND status IN ('sent', 'viewed')
      RETURNING id`,
    [milestone.id, LINK_LIFETIME_DAYS],
  );
  if (updated.length === 0) return res.redirect(`/r/${req.params.token}`);

  await addEvent(milestone.id, 'approved', {
    ...clientDetails(req),
    clientName: milestone.client_name,
    snapshot: buildSnapshot(milestone, deliverables),
  });

  await notifyDeveloper({
    to: milestone.dev_email,
    subject: `${milestone.client_name} approved "${milestone.title}"`,
    text: `${milestone.client_name} approved the milestone "${milestone.title}" (${milestone.project_name}).\n\n${developerUrl(req, milestone)}`,
  });

  res.redirect(`/r/${req.params.token}`);
});

router.post('/r/:token/feedback', async (req, res) => {
  const milestone = await loadMilestone(req, res);
  if (!milestone) return;
  if (milestone.status !== 'sent' && milestone.status !== 'viewed') return res.redirect(`/r/${req.params.token}`);

  const message = (req.body.message ?? '').trim();
  if (!message) {
    const deliverables = await listDeliverables(milestone.id);
    return res.status(400).render('review/show', { milestone, deliverables, error: req.t('review.feedback.error') });
  }

  const updated = await query(
    `UPDATE milestones SET status = 'feedback', updated_at = now()
      WHERE id = $1 AND status IN ('sent', 'viewed')
      RETURNING id`,
    [milestone.id],
  );
  if (updated.length === 0) return res.redirect(`/r/${req.params.token}`);

  await addEvent(milestone.id, 'feedback', { ...clientDetails(req), clientName: milestone.client_name, message });

  await notifyDeveloper({
    to: milestone.dev_email,
    subject: `${milestone.client_name} left feedback on "${milestone.title}"`,
    text: `${milestone.client_name} left feedback on "${milestone.title}" (${milestone.project_name}):\n\n${message}\n\n${developerUrl(req, milestone)}`,
  });

  res.redirect(`/r/${req.params.token}`);
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
