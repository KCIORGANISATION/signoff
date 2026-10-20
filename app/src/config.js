import crypto from 'node:crypto';

// Reads and checks the environment once. In production the app refuses to
// start when a required variable is missing, rather than running half-configured.
export function load(env) {
  const production = env.NODE_ENV === 'production';
  const errors = [];

  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32 || sessionSecret === 'change-me') {
    if (production) {
      errors.push('SESSION_SECRET must be a random string of at least 32 characters.');
    } else {
      // A throwaway secret: sessions simply reset when the dev server restarts.
      sessionSecret = crypto.randomBytes(32).toString('hex');
      if (env.NODE_ENV !== 'test') console.warn('SESSION_SECRET is not set: using a temporary one, you will be logged out on restart.');
    }
  }

  if (production) {
    if (!env.APP_URL) errors.push('APP_URL is required (public URL of the app, used in client links and emails).');
    if (!env.DATABASE_URL) errors.push('DATABASE_URL is required (the local database is for development only).');
    if (!env.INVITE_CODE) errors.push('INVITE_CODE is required (nobody could sign up without it).');
    if (!env.RESEND_API_KEY) console.warn('RESEND_API_KEY is not set: emails are printed in the logs instead of being sent.');
  }
  // Secret of the deadline check route (/cron/deadlines). Without it the route is off.
  const cronSecret = env.CRON_SECRET ?? '';
  if (cronSecret && cronSecret.length < 32) errors.push('CRON_SECRET must be a random string of at least 32 characters.');
  if (production && !cronSecret) console.warn('CRON_SECRET is not set: deadline reminders only run when the pages concerned are opened.');
  if (env.RESEND_API_KEY && !env.EMAIL_FROM) errors.push('EMAIL_FROM is required when RESEND_API_KEY is set.');

  // File uploads go to a private R2 bucket. Without its four variables the app still
  // starts: uploads are stored on disk in development and turned off in production.
  const r2Names = ['FILES_R2_ACCESS_KEY_ID', 'FILES_R2_SECRET_ACCESS_KEY', 'FILES_R2_BUCKET', 'FILES_R2_ENDPOINT'];
  const r2Missing = r2Names.filter((name) => !env[name]);
  let filesStorage = 'r2';
  if (r2Missing.length > 0) {
    filesStorage = production ? 'disabled' : 'disk';
    if (r2Missing.length < r2Names.length) {
      console.warn(`File uploads: missing ${r2Missing.join(', ')}; uploads are ${production ? 'turned off' : 'stored on disk'}.`);
    } else if (production) {
      console.warn('FILES_R2_* variables are not set: file uploads are turned off.');
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  }

  // Number of reverse proxies in front of the app (Render has one), so that
  // req.ip is the client's real address and not the proxy's.
  const trustProxy = env.TRUST_PROXY !== undefined ? Number(env.TRUST_PROXY) : production ? 1 : 0;

  return {
    production,
    test: env.NODE_ENV === 'test',
    appUrl: (env.APP_URL || '').replace(/\/$/, ''),
    contactEmail: validEmail(env.CONTACT_EMAIL),
    sessionSecret,
    inviteCode: env.INVITE_CODE || '',
    databaseUrl: env.DATABASE_URL || '',
    resendApiKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    cronSecret,
    trustProxy: Number.isInteger(trustProxy) && trustProxy >= 0 ? trustProxy : 1,
    files: {
      storage: filesStorage,
      r2: {
        accessKeyId: env.FILES_R2_ACCESS_KEY_ID || '',
        secretAccessKey: env.FILES_R2_SECRET_ACCESS_KEY || '',
        bucket: env.FILES_R2_BUCKET || '',
        endpoint: env.FILES_R2_ENDPOINT || '',
      },
    },
  };
}

export const config = load(process.env);

// Absolute URL for a path, for links that leave the app (emails, copied links).
export function absoluteUrl(req, pathname) {
  const base = config.appUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}${pathname}`;
}

// Base URL for links in emails sent outside a page request: APP_URL, else the request's host.
export function baseUrl(req) {
  return config.appUrl || `${req.protocol}://${req.get('host')}`;
}

// Optional contact address shown on the "Request access" page. Ignored if it does not look like an email.
function validEmail(value) {
  const email = (value || '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email) ? email : '';
}
