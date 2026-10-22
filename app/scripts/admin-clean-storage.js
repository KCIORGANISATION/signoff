// Deletes the stored files whose deletion failed or was postponed (table storage_orphans).
// Usage: npm run admin:clean-storage   (needs DATABASE_URL and the FILES_R2_* variables)
import { fail, requireDatabase } from './admin.js';

requireDatabase();
const { config } = await import('../src/config.js');
if (config.files.storage !== 'r2') fail('FILES_R2_* are not all set: the files cannot be reached from here.');

const { storage } = await import('../src/storage.js');
const { close } = await import('../src/db.js');

try {
  const removed = await storage.cleanOrphans();
  console.log(removed === 0 ? 'Nothing to clean.' : `${removed} file(s) deleted from storage.`);
} catch (error) {
  fail(`Storage still refuses (${error.name}). The list is kept; try again later.`);
} finally {
  await close();
}
