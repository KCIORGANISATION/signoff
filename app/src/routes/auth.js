import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { queryOne } from '../db.js';

const router = Router();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).render('auth/login', { error: req.t('auth.error.rate'), values: req.body });
  },
});

function logIn(req, user) {
  req.session.user = { id: user.id, name: user.name, email: user.email };
}

router.get('/signup', (req, res) => {
  res.render('auth/signup', { error: null, values: {} });
});

router.post('/signup', async (req, res) => {
  const name = (req.body.name ?? '').trim();
  const email = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  if (!name || !EMAIL_PATTERN.test(email) || password.length < 8) {
    return res.status(400).render('auth/signup', { error: req.t('auth.error.fields'), values: { name, email } });
  }

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    return res.status(400).render('auth/signup', { error: req.t('auth.error.taken'), values: { name, email } });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await queryOne(
    'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *',
    [name, email, passwordHash],
  );
  logIn(req, user);
  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('auth/login', { error: null, values: {} });
});

router.post('/login', loginLimiter, async (req, res) => {
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
