import { Router } from 'express';
import { absoluteUrl, config } from '../config.js';

const router = Router();

// Public pages shown before logging in. They never touch the database.
router.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  // A message left for this one visit, such as the confirmation of a deleted account.
  const notice = req.session.notice ? req.t(req.session.notice) : null;
  req.session.notice = null;
  res.render('home', { pageUrl: absoluteUrl(req, '/'), notice });
});

// Access to the beta is by invitation only. This page explains it and collects nothing.
router.get('/acces', (req, res) => {
  res.render('access', { contactEmail: config.contactEmail, pageUrl: absoluteUrl(req, '/acces') });
});

export default router;
