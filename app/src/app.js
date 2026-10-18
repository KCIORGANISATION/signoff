import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieSession from 'cookie-session';
import helmet from 'helmet';
import { config } from './config.js';
import { query, queryOne } from './db.js';
import { languages, translator } from './i18n.js';
import { formatters } from './format.js';
import { csrfProtection } from './csrf.js';
import { citationTag, describe } from './text.js';
import authRoutes from './routes/auth.js';
import passwordRoutes from './routes/password.js';
import legalRoutes from './routes/legal.js';
import projectRoutes from './routes/projects.js';
import milestoneRoutes from './routes/milestones.js';
import reviewRoutes from './routes/review.js';
import fileRoutes, { UPLOAD_PATH, uploadParser } from './routes/files.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(here, '..', 'node_modules');
const publicDir = path.join(here, '..', 'public');

// The logo lives in one replaceable file, public/logo.svg. It is also inlined in the pages
// so its handwritten text uses the Caveat font the app serves.
const logoSvg = fs
  .readFileSync(path.join(publicDir, 'logo.svg'), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<\?xml[^>]*>/, '')
  .trim();

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  app.set('trust proxy', config.trustProxy);

  // Used by Render to check that the app and its database are up.
  app.get('/health', async (req, res) => {
    try {
      await queryOne('SELECT 1');
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('Health check failed:', error.message);
      res.status(503).json({ status: 'error' });
    }
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Local development runs on plain http.
          upgradeInsecureRequests: config.production ? [] : null,
        },
      },
      strictTransportSecurity: config.production,
    }),
  );
  app.use(express.static(publicDir));
  // Fonts are served by the app itself, so visitors' IP addresses are not sent to Google.
  app.use('/fonts/jakarta', express.static(path.join(modules, '@fontsource', 'plus-jakarta-sans', 'files')));
  app.use('/fonts/caveat', express.static(path.join(modules, '@fontsource', 'caveat', 'files')));
  app.use('/fonts/jetbrains-mono', express.static(path.join(modules, '@fontsource', 'jetbrains-mono', 'files')));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    cookieSession({
      name: 'signoff',
      secret: config.sessionSecret,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: config.production,
    }),
  );

  // Language, translation and formatting helpers available in every view.
  app.use((req, res, next) => {
    const lang = languages.includes(req.session.lang) ? req.session.lang : req.acceptsLanguages(...languages) || 'en';
    req.lang = lang;
    req.t = translator(lang);
    res.locals.lang = lang;
    res.locals.t = req.t;
    res.locals.fmt = formatters(lang);
    res.locals.currentUser = req.session.user ?? null;
    res.locals.currentPath = req.originalUrl;
    res.locals.landingUrl = config.landingUrl;
    res.locals.logoSvg = logoSvg;
    res.locals.citeTag = (position) => citationTag(lang, position);
    res.locals.describe = describe;
    next();
  });

  // File uploads are multipart: their form, including the CSRF token, is read here first.
  app.post(UPLOAD_PATH, uploadParser);
  app.use(csrfProtection);

  app.get('/lang/:code', async (req, res) => {
    if (languages.includes(req.params.code)) {
      req.session.lang = req.params.code;
      if (req.session.user) await query('UPDATE users SET lang = $1 WHERE id = $2', [req.params.code, req.session.user.id]);
    }
    const back = typeof req.query.back === 'string' && req.query.back.startsWith('/') && !req.query.back.startsWith('//');
    res.redirect(back ? req.query.back : '/');
  });

  app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

  app.use(authRoutes);
  app.use(passwordRoutes);
  app.use(legalRoutes);
  app.use(projectRoutes);
  app.use(fileRoutes);
  app.use(milestoneRoutes);
  app.use(reviewRoutes);

  app.use((req, res) => {
    res.status(404).render('error', { message: req.t('error.notFound') });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    const t = res.locals.t ?? translator('en');
    res.status(500).render('error', { message: t('error.generic') });
  });

  return app;
}
