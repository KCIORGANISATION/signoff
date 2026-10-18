import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// With DATABASE_URL we talk to a real Postgres server (e.g. Neon).
// Without it we use PGlite, a full Postgres that runs inside Node and
// stores its files in ./data, so nothing needs to be installed locally.
async function connect() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const ssl = process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false };
    return new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl });
  }
  const { PGlite } = await import('@electric-sql/pglite');
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

export async function migrate() {
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  // PGlite runs several statements with exec(); pg does it with query().
  if (client.exec) await client.exec(schema);
  else await client.query(schema);
}
