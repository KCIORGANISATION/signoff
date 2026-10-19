import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { query, queryOne } from '../db.js';
import { requireAuth } from '../auth.js';
import { storage } from '../storage.js';
import { findMilestoneForUser, isLocked, toId, touchMilestone } from '../models.js';
import {
  ACCOUNT_QUOTA_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MILESTONE,
  cleanName,
  detectType,
  findFile,
  listFiles,
  newStorageKey,
  sendFile,
  sha256,
  typeInfo,
  usedBytes,
} from '../files.js';

export const UPLOAD_PATH = '/milestones/:id/files';

// Shown in messages, in megabytes.
const LIMITS = {
  size: MAX_FILE_BYTES / 1024 / 1024,
  count: MAX_FILES_PER_MILESTONE,
  quota: ACCOUNT_QUOTA_BYTES / 1024 / 1024,
};

// The browser script asks for JSON so it can show errors next to the drop zone.
function wantsJson(req) {
  return (req.get('accept') ?? '').includes('application/json');
}

function fail(req, res, status, message) {
  if (wantsJson(req)) return res.status(status).json({ error: message });
  res.status(status).render('error', { message });
}

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => fail(req, res, 429, req.t('files.error.rate')),
});

const parseFiles = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_MILESTONE, fields: 5, parts: MAX_FILES_PER_MILESTONE + 5 },
}).array('files', MAX_FILES_PER_MILESTONE);

const LIMIT_MESSAGES = {
  LIMIT_FILE_SIZE: 'files.error.size',
  LIMIT_FILE_COUNT: 'files.error.count',
  LIMIT_UNEXPECTED_FILE: 'files.error.count',
};

// Reads the multipart form before the CSRF check, which needs the _csrf field it carries.
// Mounted in app.js ahead of the CSRF middleware, for this one route only.
export const uploadParser = [
  requireAuth,
  uploadLimiter,
  (req, res, next) => {
    if (!storage.enabled) return fail(req, res, 503, req.t('files.disabled'));
    parseFiles(req, res, (error) => {
      if (error) req.uploadError = LIMIT_MESSAGES[error.code] ?? 'files.error.upload';
      next();
    });
  },
];

const router = Router();
router.use('/milestones', requireAuth);

router.post(UPLOAD_PATH, async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return fail(req, res, 404, req.t('error.notFound'));
  if (milestone.project_status !== 'active') return fail(req, res, 409, req.t('project.closed.error'));
  if (isLocked(milestone)) return fail(req, res, 409, req.t('milestone.locked.error'));
  if (req.uploadError) {
    return fail(req, res, req.uploadError === 'files.error.size' ? 413 : 400, req.t(req.uploadError, LIMITS));
  }

  const incoming = req.files ?? [];
  if (incoming.length === 0) return fail(req, res, 400, req.t('files.error.none'));

  const accepted = [];
  for (const file of incoming) {
    const type = detectType(file.buffer, file.originalname);
    if (!type) return fail(req, res, 415, req.t('files.error.type', { name: file.originalname }));
    accepted.push({ buffer: file.buffer, type, name: cleanName(file.originalname, type) });
  }

  const existing = (await listFiles(milestone.id)).length;
  if (existing + accepted.length > MAX_FILES_PER_MILESTONE) return fail(req, res, 400, req.t('files.error.count', LIMITS));
  const incomingBytes = accepted.reduce((total, file) => total + file.buffer.length, 0);
  if ((await usedBytes(req.session.user.id)) + incomingBytes > ACCOUNT_QUOTA_BYTES) {
    return fail(req, res, 413, req.t('files.error.quota', LIMITS));
  }

  for (const file of accepted) {
    const key = newStorageKey();
    const { mime } = typeInfo(file.type);
    await storage.put(key, file.buffer, mime);
    // The same limits are checked again in the INSERT, so two uploads at once cannot both slip past them.
    const row = await queryOne(
      `INSERT INTO files (milestone_id, storage_key, name, mime, size, sha256)
       SELECT $1::int, $2::text, $3::text, $4::text, $5::bigint, $6::text
        WHERE EXISTS (SELECT 1 FROM milestones WHERE id = $1::int AND status IN ('draft', 'sent', 'viewed', 'feedback'))
          AND (SELECT COUNT(*) FROM files WHERE milestone_id = $1::int) < $7::int
          AND (SELECT COALESCE(SUM(f.size), 0) FROM files f
                 JOIN milestones m ON m.id = f.milestone_id
                 JOIN projects p ON p.id = m.project_id
                WHERE p.user_id = $8::int) + $5::bigint <= $9::bigint
       RETURNING id`,
      [milestone.id, key, file.name, mime, file.buffer.length, sha256(file.buffer), MAX_FILES_PER_MILESTONE, req.session.user.id, ACCOUNT_QUOTA_BYTES],
    );
    if (!row) {
      await storage.removeQuietly([key]);
      return fail(req, res, 409, req.t('files.error.limits'));
    }
  }

  await touchMilestone(milestone.id);
  if (wantsJson(req)) return res.json({ ok: true });
  res.redirect(`/milestones/${milestone.id}#files`);
});

router.post('/milestones/:id/files/:fileId/delete', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  if (!milestone) return fail(req, res, 404, req.t('error.notFound'));
  if (milestone.project_status !== 'active') return fail(req, res, 409, req.t('project.closed.error'));
  if (isLocked(milestone)) return fail(req, res, 409, req.t('milestone.locked.error'));

  const deleted = await query(
    `DELETE FROM files
      WHERE id = $1 AND milestone_id = $2
        AND EXISTS (SELECT 1 FROM milestones WHERE id = $2 AND status IN ('draft', 'sent', 'viewed', 'feedback'))
      RETURNING storage_key`,
    [toId(req.params.fileId), milestone.id],
  );
  await storage.removeQuietly(deleted.map((row) => row.storage_key));
  await touchMilestone(milestone.id);
  res.redirect(`/milestones/${milestone.id}#files`);
});

router.get('/milestones/:id/files/:fileId', async (req, res) => {
  const milestone = await findMilestoneForUser(req.session.user.id, req.params.id);
  const file = milestone && (await findFile(milestone.id, req.params.fileId));
  if (!file) return res.status(404).render('error', { message: req.t('error.notFound') });
  if (!storage.enabled) return res.status(503).render('error', { message: req.t('files.unavailable') });
  await sendFile(res, file);
});

export default router;
