import { queryOne } from './db.js';
import { storage } from './storage.js';

// What deleting this account would remove, for the confirmation page and the admin script.
export function accountSummary(userId) {
  return queryOne(
    `SELECT (SELECT count(*) FROM projects p WHERE p.user_id = u.id)::int AS projects,
            (SELECT count(*) FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.user_id = u.id)::int AS milestones,
            (SELECT count(*) FROM milestones m JOIN projects p ON p.id = m.project_id
              WHERE p.user_id = u.id AND m.status = 'approved')::int AS approved,
            (SELECT count(*) FROM files f JOIN milestones m ON m.id = f.milestone_id JOIN projects p ON p.id = m.project_id
              WHERE p.user_id = u.id)::int AS files
       FROM users u
      WHERE u.id = $1`,
    [userId],
  );
}

// Deletes an account and everything in it, approved milestones and their proofs included.
//
// The database part is one statement, so it is all or nothing. Deleting the user cascades to
// projects, then milestones, then their deliverables, files, review events, frames, supplements
// and notes. The lock triggers (schema.sql) still refuse to change or delete those rows while
// their parent exists, but let them go once the parent row is gone: that is exactly what a
// cascade does, so no setting or bypass is needed and the lock stays whole for everything else.
//
// Stored files go afterwards, once their rows are gone. If storage fails, the account is still
// deleted and the leftover keys wait in storage_orphans (see storage.removeQuietly).
//
// Used by the "Delete my account" page and by "npm run admin:delete-user", which passes
// filesLater when it cannot reach the production storage: the files then wait in storage_orphans.
// Returns null if there was no such account, else { files, filesRemoved }.
export async function deleteAccount(userId, { filesLater = false } = {}) {
  const row = await queryOne(
    `WITH doomed AS (
       SELECT f.storage_key
         FROM files f
         JOIN milestones m ON m.id = f.milestone_id
         JOIN projects p ON p.id = m.project_id
        WHERE p.user_id = $1
     ), gone AS (
       DELETE FROM users WHERE id = $1 RETURNING id
     )
     SELECT (SELECT count(*) FROM gone)::int AS deleted,
            COALESCE((SELECT array_agg(storage_key) FROM doomed), '{}') AS keys`,
    [userId],
  );
  if (row.deleted === 0) return null;
  if (filesLater) {
    await storage.later(row.keys);
    return { files: row.keys.length, filesRemoved: row.keys.length === 0 };
  }
  const filesRemoved = await storage.removeQuietly(row.keys);
  return { files: row.keys.length, filesRemoved };
}

export function findUserByEmail(email) {
  return queryOne('SELECT * FROM users WHERE email = $1', [String(email ?? '').trim().toLowerCase()]);
}

