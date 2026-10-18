// Dumps the production database and uploads the dump to Cloudflare R2.
// Usage: node scripts/backup.js
// Needs DATABASE_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT
// and pg_dump of the same major version as the server, or newer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PREFIX, fail, r2 } from './r2.js';
import { run } from './run.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('Missing environment variable: DATABASE_URL');
const { client, bucket } = r2();

// e.g. signoff/2026-10-19T01-00-12Z.dump: names sort in date order.
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-');
const key = `${PREFIX}${stamp}.dump`;
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signoff-backup-')), 'backup.dump');

try {
  // Custom format: compressed, and restorable table by table with pg_restore.
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', `--file=${file}`, `--dbname=${databaseUrl}`]);
  const size = fs.statSync(file).size;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file),
      ContentLength: size,
      ContentType: 'application/octet-stream',
    }),
  );

  const stored = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (stored.ContentLength !== size) throw new Error(`Uploaded size ${stored.ContentLength} does not match ${size} bytes.`);

  console.log(`Backup uploaded: ${bucket}/${key} (${(size / 1024).toFixed(1)} KB)`);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}
