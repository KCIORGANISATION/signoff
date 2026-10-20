import { query, queryOne } from './db.js';
import { cleanText } from './projects.js';

// The working frame of a project (what is included, revisions, validation delay),
// the revision counter of each milestone, and paid supplements for out-of-scope requests.

export const FRAME_INCLUDED_MAX_LENGTH = 2000;
export const MAX_REVISIONS = 10;
export const MAX_VALIDATION_DAYS = 30;
export const SUPPLEMENT_LIMITS = { title: 120, description: 2000 };
export const COMMENT_MAX_LENGTH = 1000;

// Without any version, a project works as before: unlimited revisions, no deadline.
export const NO_FRAME = { id: null, version: 0, included: '', revisions: null, validation_days: null };

// Reads the three frame fields of the project form. revisions: "unlimited" or 0–10;
// validation_days: "none" or 1–30. Anything else is an error, never a silent default.
export function readFrameForm(body) {
  const included = cleanText(body.frame_included, FRAME_INCLUDED_MAX_LENGTH);
  const revisions = parseChoice(body.frame_revisions, 'unlimited', 0, MAX_REVISIONS);
  const days = parseChoice(body.frame_days, 'none', 1, MAX_VALIDATION_DAYS);
  const values = {
    included: included === false ? String(body.frame_included ?? '') : included ?? '',
    revisions: revisions === false ? null : revisions,
    validation_days: days === false ? null : days,
  };
  let error = null;
  if (included === false) error = 'frame.error.included';
  else if (revisions === false || days === false) error = 'frame.error.choice';
  return { values, error };
}

function parseChoice(value, none, min, max) {
  if (value === undefined || value === '' || value === none) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : false;
}

export function sameFrame(a, b) {
  return a.included === b.included && a.revisions === b.revisions && a.validation_days === b.validation_days;
}

export function isDefaultFrame(frame) {
  return sameFrame(frame, NO_FRAME);
}

export async function currentFrame(projectId) {
  return (await queryOne('SELECT * FROM project_frames WHERE project_id = $1 ORDER BY version DESC LIMIT 1', [projectId])) ?? NO_FRAME;
}

// Saves the frame from the project form. A project that never had a frame only gets one when
// something differs from the defaults; after that, every change is a new version.
// Returns the new version, or null when nothing changed.
export async function saveFrame(projectId, values) {
  const current = await currentFrame(projectId);
  if (sameFrame(current, values)) return null;
  return queryOne(
    `INSERT INTO project_frames (project_id, version, included, revisions, validation_days)
     SELECT $1, COALESCE(MAX(version), 0) + 1, $2, $3, $4 FROM project_frames WHERE project_id = $1
     RETURNING *`,
    [projectId, values.included, values.revisions, values.validation_days],
  );
}

export function frameSnapshot(frame) {
  return { version: frame.version, included: frame.included, revisions: frame.revisions, validation_days: frame.validation_days };
}

// Every version of the frame, newest first, each with its acceptance if any.
export function frameHistory(projectId) {
  return query(
    `SELECT f.*, a.created_at AS accepted_at, a.ip AS accepted_ip, a.user_agent AS accepted_user_agent, a.snapshot AS accepted_snapshot
       FROM project_frames f LEFT JOIN frame_acceptances a ON a.frame_id = f.id
      WHERE f.project_id = $1
      ORDER BY f.version DESC`,
    [projectId],
  );
}

// What the client has to do about the frame: nothing (no frame, or the current version is accepted),
// or accept the current version.
export async function frameStatus(projectId) {
  const frame = await currentFrame(projectId);
  if (!frame.id) return { frame, accepted: null, needsAcceptance: false };
  const accepted = await queryOne('SELECT * FROM frame_acceptances WHERE frame_id = $1', [frame.id]);
  return { frame, accepted, needsAcceptance: !accepted };
}

// Records the client's acceptance of the current version. A second click records nothing more.
export function acceptFrame(frame, { projectId, milestoneId, ip, userAgent }) {
  return queryOne(
    `INSERT INTO frame_acceptances (frame_id, project_id, milestone_id, snapshot, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (frame_id) DO NOTHING
     RETURNING *`,
    [frame.id, projectId, milestoneId, JSON.stringify(frameSnapshot(frame)), ip, userAgent],
  );
}

// --- Revisions ---------------------------------------------------------------

// Where the milestone stands: rounds of feedback used, and the limit of the current frame.
export async function revisionCount(milestoneId, frame) {
  const row = await queryOne(`SELECT COUNT(*)::int AS used FROM review_events WHERE milestone_id = $1 AND type = 'feedback'`, [milestoneId]);
  const limit = frame.revisions;
  return { used: row.used, limit, limited: limit !== null, reached: limit !== null && row.used >= limit };
}

// --- Out of scope and supplements --------------------------------------------

// What the developer decided about each feedback of a milestone: marked out of scope,
// accepted beyond the limit, and the supplements proposed for it.
export async function feedbackDecisions(milestoneId) {
  const [events, supplements] = await Promise.all([
    query(
      `SELECT type, snapshot, created_at FROM review_events
        WHERE milestone_id = $1 AND type IN ('out_of_scope', 'revision_accepted') ORDER BY id`,
      [milestoneId],
    ),
    query('SELECT * FROM supplements WHERE milestone_id = $1 ORDER BY id', [milestoneId]),
  ]);
  const byFeedback = new Map();
  const entry = (id) => {
    if (!byFeedback.has(id)) byFeedback.set(id, { outOfScope: null, acceptedAnyway: null, supplements: [] });
    return byFeedback.get(id);
  };
  for (const e of events) {
    const snapshot = typeof e.snapshot === 'string' ? JSON.parse(e.snapshot) : e.snapshot;
    const id = snapshot?.feedback_id;
    if (!id) continue;
    if (e.type === 'out_of_scope') entry(id).outOfScope = e.created_at;
    else entry(id).acceptedAnyway = e.created_at;
  }
  for (const s of supplements) if (s.feedback_id) entry(s.feedback_id).supplements.push(s);
  return { byFeedback, supplements };
}

export function listSupplements(milestoneId) {
  return query('SELECT * FROM supplements WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
}

export function readSupplementForm(body) {
  const amountText = String(body.amount ?? '').trim().replace(',', '.');
  const description = cleanText(body.description, SUPPLEMENT_LIMITS.description);
  const values = {
    title: String(body.title ?? '').trim().replace(/\s+/g, ' '),
    description: description === false ? String(body.description ?? '') : description ?? '',
    amount: amountText,
  };
  let error = null;
  if (!values.title || !/^\d{1,10}(\.\d{1,2})?$/.test(values.amount) || Number(values.amount) <= 0) error = 'supplement.error.fields';
  else if (values.title.length > SUPPLEMENT_LIMITS.title || description === false) error = 'supplement.error.length';
  return { values, error };
}

// The client accepts: the supplement is decided and a new draft milestone is created with its
// title, description and amount, linked back to it, all in one statement.
export function acceptSupplement(supplementId, { comment, ip, userAgent, token }) {
  return queryOne(
    `WITH s AS (
       -- The row lock makes a second, simultaneous click wait, then find it decided.
       SELECT * FROM supplements WHERE id = $1 AND status = 'proposed' FOR UPDATE
     ), m AS (
       INSERT INTO milestones (project_id, title, description, amount, token)
       SELECT project_id, title, description, amount, $5 FROM s
       RETURNING id
     )
     UPDATE supplements
        SET status = 'accepted', decided_at = now(), client_comment = $2, ip = $3, user_agent = $4,
            milestone_created_id = (SELECT id FROM m)
      WHERE id = (SELECT id FROM s)
     RETURNING *`,
    [supplementId, comment, ip, userAgent, token],
  );
}

export function declineSupplement(supplementId, { comment, ip, userAgent }) {
  return queryOne(
    `UPDATE supplements SET status = 'declined', decided_at = now(), client_comment = $2, ip = $3, user_agent = $4
      WHERE id = $1 AND status = 'proposed'
      RETURNING *`,
    [supplementId, comment, ip, userAgent],
  );
}
