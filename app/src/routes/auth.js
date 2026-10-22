import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { BUSINESS_NAME_MAX_LENGTH, hasNames, readNames } from '../profile.js';

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
  req.session.user = { id: user.id, name: user.name, email: user.email, named: hasNames(user) };
  req.session.lang = user.lang;
  // The beta banner comes back at each login, even if it was hidden in the last session.
  req.session.betaBannerHidden = null;
}

router.use('/signup', (req, res, next) => {
  res.locals.inviteRequired = Boolean(config.inviteCode);
  res.locals.betaRules = config.beta.enabled;
  next();
});

router.get('/signup', (req, res) => {
  res.render('auth/signup', { error: null, values: {} });
});

router.post('/signup', limiter('auth/signup'), async (req, res) => {
  const businessName = (req.body.name ?? '').trim().replace(/\s+/g, ' ');
  const names = readNames(req.body);
  const email = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  const fail = (key) =>
    res.status(400).render('auth/signup', { error: req.t(key), values: { ...names.values, name: businessName, email } });

  if (!validInviteCode(req.body.invite_code)) return fail('auth.error.invite');
  if (names.error === 'profile.error.names' || !EMAIL_PATTERN.test(email) || password.length < 8) return fail('auth.error.fields');
  if (names.error || businessName.length > BUSINESS_NAME_MAX_LENGTH) return fail('profile.error.length');
  const betaAccepted = config.beta.enabled && req.body.beta_rules === 'yes';
  if (config.beta.enabled && !betaAccepted) return fail('beta.accept.error');
  // The name clients see: the business name if given, else the person's name.
  const name = businessName || `${names.values.first_name} ${names.values.last_name}`;

  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return fail('auth.error.taken');

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await queryOne(
    `INSERT INTO users (name, first_name, last_name, email, password_hash, lang, beta_rules_accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END) RETURNING *`,
    [name, names.values.first_name, names.values.last_name, email, passwordHash, req.lang, betaAccepted],
  );
  logIn(req, user);
  res.redirect('/welcome');
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
