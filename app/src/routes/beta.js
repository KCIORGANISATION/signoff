import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { requireAuth } from '../auth.js';

// Closed test beta (BETA_MODE=true): the rules page, the banner of the signed-in space,
// and the acceptance of the rules. With BETA_MODE off, none of this exists.
const router = Router();

const GATED = /^\/(dashboard|projects|milestones|stats|welcome)(\/|$)|^\/profile\/?$/;

// A path inside the app to go back to after a form, never another site.
export function safeBack(value, fallback = '/dashboard') {
  const back = typeof value === 'string' ? value : '';
  return back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/\\') ? back : fallback;
}

// Accounts that have not accepted the rules yet (created before the beta, or while it was off)
// are asked to on their next visit. Deleting the account stays possible without accepting.
export function requireBetaRules(req, res, next) {
  if (!config.beta.enabled || !req.account || req.account.beta_rules_accepted_at || !GATED.test(req.path)) return next();
  res.redirect(303, `/beta/accept?back=${encodeURIComponent(req.method === 'GET' ? req.originalUrl : '/dashboard')}`);
}

router.use('/beta', (req, res, next) => {
  if (!config.beta.enabled) return res.status(404).render('error', { message: req.t('error.notFound') });
  next();
});

router.get('/beta', (req, res) => {
  res.render('beta/rules', { responsible: config.beta.responsibleName || req.t('beta.responsible.default') });
});

router.post('/beta/dismiss', requireAuth, (req, res) => {
  req.session.betaBannerHidden = true;
  res.redirect(safeBack(req.body.back));
});

router.get('/beta/accept', requireAuth, (req, res) => {
  if (req.account.beta_rules_accepted_at) return res.redirect(safeBack(req.query.back));
  res.render('beta/accept', { back: safeBack(req.query.back), error: null });
});

router.post('/beta/accept', requireAuth, async (req, res) => {
  const back = safeBack(req.body.back);
  if (req.body.beta_rules !== 'yes') {
    return res.status(400).render('beta/accept', { back, error: req.t('beta.accept.error') });
  }
  await query('UPDATE users SET beta_rules_accepted_at = now() WHERE id = $1 AND beta_rules_accepted_at IS NULL', [req.session.user.id]);
  res.redirect(back);
});

export default router;
