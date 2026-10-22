import crypto from 'node:crypto';
import { queryOne } from './db.js';

// Password reset links: a random token is given out once; only its hash is stored.
export const RESET_LIFETIME_MINUTES = 60;

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Creates a reset link for an account and returns its token (for "/reset/<token>").
// Used by "Forgot password" and by "npm run admin:reset-password".
export async function createPasswordReset(userId, minutes = RESET_LIFETIME_MINUTES) {
  const token = crypto.randomBytes(32).toString('base64url');
  await queryOne(
    `INSERT INTO password_resets (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(mins => $3)) RETURNING id`,
    [userId, hashToken(token), minutes],
  );
  return token;
}

export function findValidReset(token) {
  return queryOne(
    `SELECT r.id, r.user_id
       FROM password_resets r
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
    [hashToken(String(token))],
  );
}
