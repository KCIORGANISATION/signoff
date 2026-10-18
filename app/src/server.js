import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieSession from 'cookie-session';
import { migrate } from './db.js';
import { languages, translator } from './i18n.js';
import { formatters } from './format.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import milestoneRoutes from './routes/milestones.js';
import reviewRoutes from './routes/review.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me') {
  console.warn('Warning: set SESSION_SECRET in .env to a long random string.');
}

await migrate();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(here, 'views'));

app.use(express.static(path.join(here, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: 'signoff',
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    httpOnly: true,
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
  res.locals.landingUrl = process.env.LANDING_URL || 'https://github.com/KCIORGANISATION/signoff';
  next();
});

app.get('/lang/:code', (req, res) => {
  if (languages.includes(req.params.code)) req.session.lang = req.params.code;
  const back = typeof req.query.back === 'string' && req.query.back.startsWith('/') && !req.query.back.startsWith('//');
  res.redirect(back ? req.query.back : '/');
});

app.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));

app.use(authRoutes);
app.use(projectRoutes);
app.use(milestoneRoutes);
app.use(reviewRoutes);

app.use((req, res) => {
  res.status(404).render('error', { message: req.t('error.notFound') });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', { message: res.locals.t ? res.locals.t('error.generic') : 'Error' });
});

app.listen(port, () => {
  console.log(`Signoff running on http://localhost:${port}`);
});
