// Gives a beta tester a new password link when emails are not active.
// Usage: npm run admin:reset-password -- <email>
// Prints a one-time link, valid 24 hours, that lets the tester choose a new password.
// The link is shown once here and stored nowhere (the database only keeps its hash).
import { emailArgument, fail, requireDatabase } from './admin.js';

requireDatabase();
const email = emailArgument('npm run admin:reset-password -- <email>');

const { findUserByEmail } = await import('../src/account.js');
const { createPasswordReset } = await import('../src/password-reset.js');
const { config } = await import('../src/config.js');
const { close } = await import('../src/db.js');

const LIFETIME_MINUTES = 24 * 60;

try {
  const user = await findUserByEmail(email);
  if (!user) fail(`No account with the email ${email}.`);
  const token = await createPasswordReset(user.id, LIFETIME_MINUTES);
  const link = `${config.appUrl}/reset/${token}`;
  console.log(`\nPassword reset link for ${email} (works once, for 24 hours):\n\n  ${link}\n`);
  if (!config.appUrl) console.log('APP_URL is not set: put the address of the app in front of this path.\n');
  console.log('Send it to the tester privately. Opening it lets them choose a new password and logs them in.');
} finally {
  await close();
}
