import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { query } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.join(here, '..', 'uploads');

// Private Cloudflare R2 bucket (S3 protocol). Nothing in it is public: the app streams every file.
function r2Backend(options) {
  const client = new S3Client({
    region: 'auto',
    endpoint: options.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  });
  return {
    enabled: true,
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async read(key) {
      const object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      return object.Body;
    },
    async remove(keys) {
      for (let start = 0; start < keys.length; start += 1000) {
        const batch = keys.slice(start, start + 1000).map((Key) => ({ Key }));
        await client.send(new DeleteObjectsCommand({ Bucket: options.bucket, Delete: { Objects: batch, Quiet: true } }));
      }
    },
  };
}

// Local development only: Render wipes its disk on every deploy.
function diskBackend(dir) {
  const fullPath = (key) => path.join(dir, path.basename(key));
  return {
    enabled: true,
    async put(key, body) {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(fullPath(key), body, { flag: 'wx' });
    },
    async read(key) {
      return fs.createReadStream(fullPath(key));
    },
    async remove(keys) {
      await Promise.all(keys.map((key) => fs.promises.rm(fullPath(key), { force: true })));
    },
  };
}

const disabledBackend = {
  enabled: false,
  async put() {
    throw new Error('File storage is not configured.');
  },
  async read() {
    throw new Error('File storage is not configured.');
  },
  async remove() {},
};

function createBackend(mode, options = {}) {
  if (options.backend) return options.backend;
  if (mode === 'r2') return r2Backend(options.r2 ?? config.files.r2);
  if (mode === 'disk') return diskBackend(options.dir ?? LOCAL_DIR);
  return disabledBackend;
}

let backend = createBackend(config.files.storage);

// Tests switch between a temporary folder, a disabled storage, or a backend of their own.
export function useStorage(mode, options) {
  backend = createBackend(mode, options);
}

export const storage = {
  get enabled() {
    return backend.enabled;
  },
  put: (key, body, contentType) => backend.put(key, body, contentType),
  read: (key) => backend.read(key),
  // Deleting a milestone, project or account must not fail because storage is unreachable:
  // the database rows are already gone, so the leftover keys (random, nothing personal) are
  // kept in storage_orphans for "npm run admin:clean-storage". Returns false when they were.
  async removeQuietly(keys) {
    if (keys.length === 0) return true;
    try {
      await backend.remove(keys);
      return true;
    } catch (error) {
      console.error(`Could not delete ${keys.length} file(s) from storage (${error.name}); kept in storage_orphans.`);
      await storage.later(keys);
      return false;
    }
  },
  // Records files to delete later with "npm run admin:clean-storage".
  async later(keys) {
    if (keys.length === 0) return;
    try {
      await query('INSERT INTO storage_orphans (storage_key) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [keys]);
    } catch (error) {
      console.error('Could not record the leftover files:', error.message, keys);
    }
  },
  // Retries the deletions that failed. Throws, and keeps the list, if storage still refuses.
  async cleanOrphans() {
    const keys = (await query('SELECT storage_key FROM storage_orphans ORDER BY created_at')).map((row) => row.storage_key);
    if (keys.length === 0) return 0;
    await backend.remove(keys);
    await query('DELETE FROM storage_orphans WHERE storage_key = ANY($1::text[])', [keys]);
    return keys.length;
  },
};
