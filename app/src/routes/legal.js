import { Router } from 'express';
import { config } from '../config.js';
import { legalText } from '../legal-config.js';

const router = Router();
const PAGES = { legal: 'legal', privacy: 'privacy', terms: 'terms' };

// Each page has one template per language: views/legal/<page>.<lang>.ejs
// legal('key') gives the values of legal-config.js; the beta sections show only with BETA_MODE.
for (const [path, page] of Object.entries(PAGES)) {
  router.get(`/${path}`, (req, res) => {
    res.render('legal/page', { page, body: `${page}.${req.lang}.ejs`, legal: legalText(req.lang), beta: config.beta.enabled });
  });
}

export default router;
