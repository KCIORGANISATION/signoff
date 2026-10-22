import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { absoluteUrl, config } from '../config.js';
import { query, queryOne } from '../db.js';
import { emailPasswordReset } from '../email.js';
import { limiter, logIn } from './auth.js';
import { createPasswordReset, findValidReset } from '../password-reset.js';

const router = Router();

// During the beta, without an email service, the page says how to get a new password instead.
router.use('/forgot', (req, res, next) => {
  res.locals.betaNoEmail = config.beta.enabled && !config.resendApiKey;
  next();
});

router.get('/forgot', (req, res) => {
  res.render('auth/forgot', { error: null, values: {}, sent: false });
});

// The answer is the same whether or not the email has an account, so the form
// cannot be used to find out who is a Signoff user.
router.post('/forgot', limiter('auth/forgot', 5), async (req, res) => {
  const email = (req.body.email ?? '').trim().toLowerCase();
  const user = await queryOne('SELECT id, email, lang FROM users WHERE email = $1', [email]);

  if (user) {
    const token = await createPasswordReset(user.id);
    await emailPasswordReset({ to: user.email, lang: user.lang, link: absoluteUrl(req, `/reset/${token}`) });
  }

  res.render('auth/forgot', { error: null, values: { email }, sent: true });
});

router.get('/reset/:token', async (req, res) => {
  const reset = await findValidReset(req.params.token);
  if (!reset) return res.status(410).render('error', { message: req.t('reset.invalid') });

  res.render('auth/reset', { error: null, token: req.params.token });
});

router.post('/reset/:token', async (req, res) => {
  const reset = await findValidReset(req.params.token);
  if (!reset) return res.status(410).render('error', { message: req.t('reset.invalid') });

  const password = req.body.password ?? '';
  if (password.length < 8) {
    return res.status(400).render('auth/reset', { error: req.t('reset.error.password'), token: req.params.token });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await queryOne('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *', [passwordHash, reset.user_id]);
  // Every outstanding link for this account stops working once one has been used.
  await query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [reset.user_id]);

  logIn(req, user);
  res.redirect('/dashboard');
});

export default router;
