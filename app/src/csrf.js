import crypto from 'node:crypto';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Synchronizer-token CSRF protection: each session gets a random token, every
// form sends it back in a hidden "_csrf" field, and any POST without the
// matching token is rejected. Views read it as `csrfToken`.
export function csrfProtection(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrfToken = req.session.csrf;

  if (SAFE_METHODS.has(req.method)) return next();
  if (sameToken(req.body?._csrf ?? '', req.session.csrf)) return next();

  res.status(403).render('error', { message: req.t('error.csrf') });
}
