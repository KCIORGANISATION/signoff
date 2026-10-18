import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// With DATABASE_URL we talk to a real Postgres server (e.g. Neon).
// Without it we use PGlite, a full Postgres that runs inside Node and
// stores its files in ./data (or only in memory during tests).
async function connect() {
  if (config.databaseUrl) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl: local ? false : true, max: 5 });
    // Hosted Postgres closes idle connections; the pool reconnects, so this must not crash the app.
    pool.on('error', (error) => console.error('Database connection error:', error.message));
    return pool;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  if (config.test) return new PGlite();
  const dataDir = path.join(here, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return new PGlite(dataDir);
}

const client = await connect();

export async function query(sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

// Creates any missing table. Every statement in schema.sql is safe to run on each start.
export async function migrate() {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  // PGlite runs several statements with exec(); pg does it with query().
  if (client.exec) await client.exec(schema);
  else await client.query(schema);
}

export async function close() {
  if (client.end) await client.end();
  else await client.close();
}
