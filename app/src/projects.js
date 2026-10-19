import { query, queryOne } from './db.js';

export const PROJECT_STATUSES = ['active', 'completed', 'abandoned'];
export const ABANDON_REASONS = ['client_stopped', 'unforeseen', 'other'];
export const OPEN_MILESTONE_STATUSES = ['draft', 'sent', 'viewed', 'feedback'];
export const CLOSED_MILESTONE_STATUSES = ['not_done', 'cancelled'];
export const NOTES_MAX_LENGTH = 10000;
export const REASON_MAX_LENGTH = 500;
export const REMIND_AFTER_HOURS = 24;

const DAY = 24 * 60 * 60 * 1000;

export function isOpen(project) {
  return project.status === 'active';
}

// A milestone the client can still decide on: its project is active and it waits on them.
export function isClosedForClient(milestone) {
  return CLOSED_MILESTONE_STATUSES.includes(milestone.status) || (milestone.project_status !== 'active' && milestone.status !== 'approved');
}

// The milestones of the given projects, with what the next-step guidance needs to know about each.
export function milestonesWithProgress(projectIds) {
  if (projectIds.length === 0) return Promise.resolve([]);
  return query(
    `SELECT m.*,
            (SELECT COUNT(*) FROM files f WHERE f.milestone_id = m.id)::int AS file_count,
            (SELECT COUNT(*) FROM deliverables d WHERE d.milestone_id = m.id)::int AS deliverable_count,
            (SELECT MAX(e.created_at) FROM review_events e WHERE e.milestone_id = m.id AND e.type = 'sent') AS sent_at,
            (SELECT MAX(e.created_at) FROM review_events e WHERE e.milestone_id = m.id AND e.type IN ('sent', 'reminded')) AS last_contact_at
       FROM milestones m
      WHERE m.project_id = ANY($1::int[])
      ORDER BY m.id`,
    [projectIds],
  );
}

// Splits a project's milestones: the current one (the first not yet approved), the ones after it,
// and the finished or archived ones (approved, not done, cancelled).
export function arrangeMilestones(milestones) {
  const open = milestones.filter((m) => OPEN_MILESTONE_STATUSES.includes(m.status));
  return {
    current: open[0] ?? null,
    upcoming: open.slice(1),
    archived: milestones.filter((m) => !OPEN_MILESTONE_STATUSES.includes(m.status)),
    approved: milestones.filter((m) => m.status === 'approved').length,
    total: milestones.length,
  };
}

export function daysSince(date, now = new Date()) {
  return Math.max(0, Math.floor((now - new Date(date)) / DAY));
}

export function canRemind(milestone, now = new Date()) {
  if (milestone.status !== 'sent' && milestone.status !== 'viewed') return false;
  if (!milestone.last_contact_at) return true;
  return now - new Date(milestone.last_contact_at) >= REMIND_AFTER_HOURS * 60 * 60 * 1000;
}

// What the developer should do next on a project. Each step names one action:
// { key, vars, action: { label, href, method?, modal? }, priority } — a lower priority is more urgent.
export function nextStep(project, milestones, now = new Date()) {
  const { current, approved } = arrangeMilestones(milestones);
  const base = `/projects/${project.id}`;

  if (project.status === 'completed' || project.status === 'abandoned') {
    return {
      key: `next.${project.status}`,
      vars: { date: project.closed_at },
      action: { label: 'project.reopen', href: `${base}/reopen`, modal: true },
      priority: 9,
    };
  }
  if (!current) {
    if (approved > 0) {
      return {
        key: 'next.finish',
        vars: {},
        action: { label: 'next.finish.action', href: `${base}/complete`, modal: true },
        secondary: { label: 'next.newMilestone', href: `${base}/milestones/new` },
        priority: 5,
      };
    }
    return {
      key: milestones.length === 0 ? 'next.firstMilestone' : 'next.newMilestone.text',
      vars: {},
      action: { label: milestones.length === 0 ? 'next.firstMilestone.action' : 'next.newMilestone', href: `${base}/milestones/new` },
      priority: 4,
    };
  }

  const milestone = `/milestones/${current.id}`;
  const vars = { title: current.title, client: project.client_name, project: project.name };
  if (current.status === 'feedback') {
    return { key: 'next.feedback', vars, action: { label: 'next.feedback.action', href: milestone }, milestone: current, priority: 1 };
  }
  if (current.status === 'sent' || current.status === 'viewed') {
    const days = daysSince(current.sent_at ?? current.updated_at, now);
    return {
      key: days === 0 ? 'next.waiting.today' : days === 1 ? 'next.waiting.oneDay' : 'next.waiting.days',
      vars: { ...vars, days },
      action: canRemind(current, now)
        ? { label: 'next.remind.action', href: `${milestone}/remind`, method: 'post' }
        : { label: 'next.waiting.action', href: `${milestone}#share` },
      note: canRemind(current, now) ? null : 'next.remind.recent',
      milestone: current,
      days,
      priority: 2,
    };
  }
  if (current.file_count + current.deliverable_count === 0) {
    return { key: 'next.addFiles', vars, action: { label: 'next.addFiles.action', href: `${milestone}#files` }, milestone: current, priority: 3 };
  }
  return { key: 'next.send', vars, action: { label: 'next.send.action', href: `${milestone}#share`, positive: true }, milestone: current, priority: 3 };
}

// The three steps of the first-launch guide, and which one comes next.
export async function onboarding(userId) {
  const row = await queryOne(
    `SELECT
       (SELECT id FROM projects WHERE user_id = $1 ORDER BY (status = 'active') DESC, id DESC LIMIT 1) AS project_id,
       (SELECT m.id FROM milestones m JOIN projects p ON p.id = m.project_id
         WHERE p.user_id = $1 AND m.status = 'draft' AND p.status = 'active' ORDER BY m.id LIMIT 1) AS draft_id,
       EXISTS (SELECT 1 FROM milestones m JOIN projects p ON p.id = m.project_id WHERE p.user_id = $1) AS has_milestone,
       EXISTS (SELECT 1 FROM review_events e JOIN milestones m ON m.id = e.milestone_id JOIN projects p ON p.id = m.project_id
                WHERE p.user_id = $1 AND e.type = 'sent') AS has_sent`,
    [userId],
  );
  const done = [Boolean(row.project_id), row.has_milestone, row.has_sent];
  const steps = [
    { key: 'project', href: '/projects/new' },
    { key: 'milestone', href: row.project_id ? `/projects/${row.project_id}/milestones/new` : null },
    { key: 'send', href: row.draft_id ? `/milestones/${row.draft_id}#share` : null },
  ].map((step, index) => ({ ...step, done: done[index] }));
  const currentIndex = steps.findIndex((step) => !step.done);
  return { steps, currentIndex, complete: currentIndex === -1 };
}

export function listProjectEvents(projectId) {
  return query('SELECT * FROM project_events WHERE project_id = $1 ORDER BY id DESC', [projectId]);
}

export function addProjectEvent(projectId, type, fields = {}) {
  return queryOne(
    `INSERT INTO project_events (project_id, type, from_status, to_status, reason, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [projectId, type, fields.from ?? null, fields.to, fields.reason ?? null, fields.note ?? null],
  );
}

// Closes an active project in one statement, so it cannot half-happen:
// the project changes state, its open milestones become not_done (completed) or cancelled (abandoned),
// and the journal records both. Approved milestones are never touched: they stay locked.
// Returns the journal row, or null if the project was no longer active.
export function closeProject(projectId, status, { reason = null, note = null } = {}) {
  const milestoneStatus = status === 'completed' ? 'not_done' : 'cancelled';
  return queryOne(
    `WITH p AS (
       UPDATE projects SET status = $2, closed_at = now()
        WHERE id = $1 AND status = 'active'
        RETURNING id
     ), m AS (
       UPDATE milestones SET status_before_close = status, status = $3, updated_at = now()
        WHERE project_id IN (SELECT id FROM p) AND status <> 'approved'
        RETURNING id, title, status_before_close, status
     )
     INSERT INTO project_events (project_id, type, from_status, to_status, reason, note, milestones)
     SELECT p.id, $2, 'active', $2, $4, $5,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'from', status_before_close, 'to', status) ORDER BY id), '[]'::jsonb) FROM m)
       FROM p
     RETURNING *`,
    [projectId, status, milestoneStatus, reason, note],
  );
}

// Puts a completed or abandoned project back to active, and its milestones back to their status before closing.
export function reopenProject(projectId, fromStatus, note) {
  return queryOne(
    `WITH p AS (
       UPDATE projects SET status = 'active', closed_at = NULL
        WHERE id = $1 AND status = $2
        RETURNING id
     ), m AS (
       UPDATE milestones SET status = status_before_close, status_before_close = NULL, updated_at = now()
        WHERE project_id IN (SELECT id FROM p) AND status_before_close IS NOT NULL AND status IN ('not_done', 'cancelled')
        RETURNING id, title, status
     )
     INSERT INTO project_events (project_id, type, from_status, to_status, note, milestones)
     SELECT p.id, 'reopened', $2, 'active', $3,
            (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'to', status) ORDER BY id), '[]'::jsonb) FROM m)
       FROM p
     RETURNING *`,
    [projectId, fromStatus, note],
  );
}

export async function readNotes(projectId) {
  const row = await queryOne('SELECT body, updated_at FROM project_notes WHERE project_id = $1', [projectId]);
  return row ?? { body: '', updated_at: null };
}

export function saveNotes(projectId, body) {
  return queryOne(
    `INSERT INTO project_notes (project_id, body, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (project_id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()
     RETURNING updated_at`,
    [projectId, body],
  );
}

// Free text from a form: trimmed, Windows line breaks counted once, null when empty.
export function cleanText(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (text.length > max) return false;
  return text || null;
}
