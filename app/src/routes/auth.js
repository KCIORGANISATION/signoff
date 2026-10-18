import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { queryOne } from '../db.js';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function limiter(view, limit = 10) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).render(view, { error: req.t('auth.error.rate'), values: { email: req.body.email }, sent: false });
    },
  });
}

// Without INVITE_CODE (local development only) anyone can sign up.
function validInviteCode(code) {
  if (!config.inviteCode) return true;
  const given = crypto.createHash('sha256').update(String(code ?? '').trim()).digest();
  const expected = crypto.createHash('sha256').update(config.inviteCode).digest();
  return crypto.timingSafeEqual(given, expected);
}

export function logIn(req, user) {
  req.session.user = { id: user.id, name: user.name, email: user.email };
  req.session.lang = user.lang;
}

router.use('/signup', (req, res, next) => {
  res.locals.inviteRequired = Boolean(config.inviteCode);
  next();
});

router.get('/signup', (req, res) => {
  res.render('auth/signup', { error: null, values: {} });
});

router.post('/signup', limiter('auth/signup'), async (req, res) => {
  const name = (req.body.name ?? '').trim();
  const email = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  const fail = (key) =>
    res.status(400).render('auth/signup', { error: req.t(key), values: { name, email } });

  if (!validInviteCode(req.body.invite_code)) return fail('auth.error.invite');
  if (!name || !EMAIL_PATTERN.test(email) || password.length < 8) return fail('auth.error.fields');

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return fail('auth.error.taken');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await queryOne(
    'INSERT INTO users (name, email, password_hash, lang) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, email, passwordHash, req.lang],
  );
  logIn(req, user);
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { error: null, values: {} });
});

router.post('/login', limiter('auth/login'), async (req, res) => {
  const email = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  const user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
  const valid = user && (await bcrypt.compare(password, user.password_hash));
  if (!valid) {
    return res.status(401).render('auth/login', { error: req.t('auth.error.invalid'), values: { email } });
  }

  logIn(req, user);
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.user = null;
  res.redirect('/login');
});

export default router;
