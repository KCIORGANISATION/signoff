import { Router } from 'express';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  ACTIVITIES,
  BUSINESS_NAME_MAX_LENGTH,
  DELIVERIES,
  findUser,
  hasNames,
  readNames,
  readQuestionnaire,
} from '../profile.js';

const router = Router();
router.use(['/welcome', '/profile'], requireAuth);

const WORKSPACE = /^\/(dashboard|projects|milestones|stats)(\/|$)/;

// Accounts created before first and last names existed are asked for them on their next visit.
export async function requireNames(req, res, next) {
  const user = req.session.user;
  if (!user || user.named || req.method !== 'GET' || !WORKSPACE.test(req.path)) return next();
  if (hasNames(await findUser(user.id))) {
    req.session.user = { ...user, named: true };
    return next();
  }
  res.redirect('/welcome');
}

const choices = { activities: ACTIVITIES, deliveries: DELIVERIES };

// After sign-up: two optional questions, and the names if the account has none yet.
router.get('/welcome', async (req, res) => {
  const user = await findUser(req.session.user.id);
  res.render('profile/welcome', { ...choices, needNames: !hasNames(user), values: user, error: null });
});

router.post('/welcome', async (req, res) => {
  const user = await findUser(req.session.user.id);
  const needNames = !hasNames(user);
  const names = needNames ? readNames(req.body) : { values: user, error: null };
  const skip = req.body.intent === 'skip';
  const answers = skip ? { values: { activity: null, activity_other: null, delivers: null }, error: null } : readQuestionnaire(req.body);

  const error = names.error ?? answers.error;
  if (error) {
    return res.status(400).render('profile/welcome', {
      ...choices, needNames, values: { ...names.values, ...answers.values }, error: req.t(error),
    });
  }

  await query(
    `UPDATE users SET first_name = $1, last_name = $2, activity = $3, activity_other = $4, delivers = $5, questionnaire_at = now()
      WHERE id = $6`,
    [names.values.first_name, names.values.last_name, answers.values.activity, answers.values.activity_other, answers.values.delivers, user.id],
  );
  req.session.user = { ...req.session.user, named: true };
  res.redirect('/dashboard');
});

router.get('/profile', async (req, res) => {
  const user = await findUser(req.session.user.id);
  res.render('profile/edit', { ...choices, values: user, error: null, saved: req.query.saved === '1' });
});

router.post('/profile', async (req, res) => {
  const names = readNames(req.body);
  const answers = readQuestionnaire(req.body);
  const businessName = String(req.body.name ?? '').trim().replace(/\s+/g, ' ');
  let error = names.error ?? answers.error;
  if (!error && businessName.length > BUSINESS_NAME_MAX_LENGTH) error = 'profile.error.length';
  if (error) {
    return res.status(400).render('profile/edit', {
      ...choices, values: { ...names.values, ...answers.values, name: businessName }, error: req.t(error), saved: false,
    });
  }

  const name = businessName || `${names.values.first_name} ${names.values.last_name}`;
  const user = await queryOne(
    `UPDATE users SET name = $1, first_name = $2, last_name = $3, activity = $4, activity_other = $5, delivers = $6
      WHERE id = $7 RETURNING *`,
    [name, names.values.first_name, names.values.last_name, answers.values.activity, answers.values.activity_other, answers.values.delivers, req.session.user.id],
  );
  req.session.user = { ...req.session.user, name: user.name, named: true };
  res.redirect('/profile?saved=1');
});

export default router;
