import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieSession from 'cookie-session';
import helmet from 'helmet';
import { config, feedbackLink } from './config.js';
import { query, queryOne } from './db.js';
import { languages, translator, useTerm } from './i18n.js';
import { termFor } from './vocabulary.js';
import { formatters } from './format.js';
import { csrfProtection } from './csrf.js';
import { citationTag, describe } from './text.js';
import { UPLOAD_RULES } from './files.js';
import authRoutes from './routes/auth.js';
import passwordRoutes from './routes/password.js';
import legalRoutes from './routes/legal.js';
import projectRoutes from './routes/projects.js';
import milestoneRoutes from './routes/milestones.js';
import reviewRoutes from './routes/review.js';
import homeRoutes from './routes/home.js';
import dashboardRoutes from './routes/dashboard.js';
import profileRoutes, { requireNames } from './routes/profile.js';
import accountRoutes from './routes/account.js';
import betaRoutes, { requireBetaRules } from './routes/beta.js';
import statsRoutes from './routes/stats.js';
import cronRoutes from './routes/cron.js';
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

// The logo for a given place on a page: ids made unique, underlines ready to be drawn,
// or hidden from screen readers when the name is already said next to it.
function logoMarkup({ id = 'logo', animated = false, decorative = false } = {}) {
  let svg = logoSvg.replace(/id="([\w-]+)"/g, `id="$1-${id}"`).replace(/url\(#([\w-]+)\)/g, `url(#$1-${id})`);
  if (animated) svg = svg.replace(/<path /g, '<path pathLength="1" ');
  if (decorative) svg = svg.replace(/\s(role|aria-label)="[^"]*"/g, '').replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
  return svg;
}

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

  // The signed-in account, read on each request: an account deleted elsewhere is logged out
  // here too, and the vocabulary and the beta acceptance always follow the latest profile.
  app.use(async (req, res, next) => {
    if (!req.session.user) return next();
    req.account = await queryOne('SELECT id, activity, beta_rules_accepted_at FROM users WHERE id = $1', [req.session.user.id]);
    if (!req.account) req.session.user = null;
    next();
  });

  // Language, translation and formatting helpers available in every view.
  app.use((req, res, next) => {
    // The language the visitor chose, else the one their browser asks for by name, else French.
    const asked = (req.get('accept-language') || '').trim();
    const browser = asked && asked !== '*' ? req.acceptsLanguages(...languages) : false;
    const lang = languages.includes(req.session.lang) ? req.session.lang : browser || 'fr';
    req.lang = lang;
    res.locals.lang = lang;
    useTerm(req, res, termFor(req.account?.activity));
    res.locals.fmt = formatters(lang);
    res.locals.currentUser = req.session.user ?? null;
    res.locals.currentPath = req.originalUrl;
    res.locals.logoSvg = logoSvg;
    res.locals.logo = logoMarkup;
    res.locals.citeTag = (position) => citationTag(lang, position);
    res.locals.describe = describe;
    res.locals.feedback = feedbackLink();
    res.locals.uploadRules = UPLOAD_RULES;
    // The beta banner: on while BETA_MODE is, until hidden for the rest of the session.
    res.locals.betaBanner = config.beta.enabled && Boolean(req.session.user) && !req.session.betaBannerHidden;
    next();
  });

  // The deadline check is called by a scheduler with a secret, not by a browser form.
  app.use(cronRoutes);

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

  app.use(requireBetaRules);
  app.use(requireNames);
  app.use(homeRoutes);
  app.use(betaRoutes);
  app.use(authRoutes);
  app.use(passwordRoutes);
  app.use(legalRoutes);
  app.use(dashboardRoutes);
  app.use(accountRoutes);
  app.use(profileRoutes);
  app.use(statsRoutes);
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
