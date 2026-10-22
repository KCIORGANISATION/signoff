import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../auth.js';
import { accountSummary, deleteAccount } from '../account.js';
import { findUser } from '../profile.js';

const router = Router();
router.use('/profile/delete', requireAuth);

async function renderDelete(req, res, { error = null, status = 200 } = {}) {
  const summary = await accountSummary(req.session.user.id);
  res.status(status).render('profile/delete', { summary, keyword: req.t('account.delete.keyword'), error });
}

const deleteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => renderDelete(req, res, { error: req.t('auth.error.rate'), status: 429 }),
});

router.get('/profile/delete', (req, res) => renderDelete(req, res));

// Asks for the password and the typed word, then deletes everything and ends the session.
router.post('/profile/delete', deleteLimiter, async (req, res) => {
  const user = await findUser(req.session.user.id);
  const valid = user && (await bcrypt.compare(String(req.body.password ?? ''), user.password_hash));
  if (!valid) return renderDelete(req, res, { error: req.t('account.delete.error.password'), status: 401 });

  const keyword = req.t('account.delete.keyword');
  if (String(req.body.confirm ?? '').trim() !== keyword) {
    return renderDelete(req, res, { error: req.t('account.delete.error.word', { word: keyword }), status: 400 });
  }

  await deleteAccount(user.id);
  // A brand-new session: only the language and the confirmation shown once on the home page.
  req.session = { lang: req.lang, notice: 'account.deleted' };
  res.redirect('/');
});

export default router;
