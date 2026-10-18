import { Router } from 'express';

const router = Router();
const PAGES = { legal: 'legal', privacy: 'privacy', terms: 'terms' };

// Each page has one template per language: views/legal/<page>.<lang>.ejs
for (const [path, page] of Object.entries(PAGES)) {
  router.get(`/${path}`, (req, res) => {
    res.render('legal/page', { page, body: `${page}.${req.lang}.ejs` });
  });
}

export default router;
