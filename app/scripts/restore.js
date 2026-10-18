// Downloads a backup from Cloudflare R2 and restores it into a TEST database.
// Usage:
//   node scripts/restore.js --list          list the backups in R2
//   node scripts/restore.js                 restore the latest backup
//   node scripts/restore.js <key>           restore one backup, e.g. signoff/2026-10-19T01-00-12Z.dump
// Needs RESTORE_DATABASE_URL (the test database, its tables are replaced),
// R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT, and pg_restore.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import pg from 'pg';
import { PREFIX, fail, r2 } from './r2.js';
import { run } from './run.js';

const { client, bucket } = r2();

async function listBackups() {
  const backups = [];
  let token;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }));
    backups.push(...(page.Contents ?? []).filter((item) => item.Key.endsWith('.dump')));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return backups.sort((a, b) => a.Key.localeCompare(b.Key));
}

const argument = process.argv[2];

if (argument === '--list') {
  const backups = await listBackups();
  if (backups.length === 0) console.log('No backups yet.');
  for (const item of backups) console.log(`${item.Key}  ${(item.Size / 1024).toFixed(1)} KB`);
  process.exit(0);
}

const target = process.env.RESTORE_DATABASE_URL;
if (!target) fail('Missing environment variable: RESTORE_DATABASE_URL (the test database to restore into).');
if (process.env.DATABASE_URL && target === process.env.DATABASE_URL) {
  fail('RESTORE_DATABASE_URL is the same as DATABASE_URL. Restore into a separate test database, never into production.');
}

let key = argument;
if (!key) {
  const backups = await listBackups();
  if (backups.length === 0) fail('No backups found in R2.');
  key = backups.at(-1).Key;
}

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-restore-')), 'backup.dump');

try {
  console.log(`Downloading ${bucket}/${key}`);
  const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(object.Body, fs.createWriteStream(file));

  console.log('Restoring into the test database');
  // --clean --if-exists replaces the tables that already exist in the target.
  await run('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '--exit-on-error', `--dbname=${target}`, file]);

  const db = new pg.Client({ connectionString: target });
  await db.connect();
  for (const table of ['users', 'projects', 'milestones', 'deliverables', 'review_events']) {
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM ${table}`);
    console.log(`  ${table}: ${rows[0].count} rows`);
  }
  await db.end();
  console.log('Restore finished.');
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
