// Shared by the admin scripts (npm run admin:*). They run on Kostia's computer against the
// database of DATABASE_URL, never through a web route.
import readline from 'node:readline/promises';

export function fail(message) {
  console.error(message);
  process.exit(1);
}

// Must run before anything imports src/db.js, which would otherwise open the local database.
export function requireDatabase() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set: this script only runs against a real database (e.g. DATABASE_URL=... in app/.env).');
  }
  // Sessions play no part here: no warning about SESSION_SECRET.
  process.env.SIGNOFF_CLI = '1';
}

export function emailArgument(usage) {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`Usage: ${usage}`);
  return email;
}

export async function ask(question) {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim();
  } finally {
    prompt.close();
  }
}
