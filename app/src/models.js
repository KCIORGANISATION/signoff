import crypto from 'node:crypto';
import { query, queryOne } from './db.js';

export const STATUSES = ['draft', 'sent', 'viewed', 'feedback', 'approved', 'not_done', 'cancelled'];
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD'];
export const LINK_LIFETIME_DAYS = 7;

export function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Route params are strings; anything that is not a whole number cannot match a row.
export function toId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function findProjectForUser(userId, projectId) {
  const id = toId(projectId);
  if (!id) return null;
  return queryOne('SELECT * FROM projects WHERE id = $1 AND user_id = $2', [id, userId]);
}

export async function findMilestoneForUser(userId, milestoneId) {
  const id = toId(milestoneId);
  if (!id) return null;
  return queryOne(
    `SELECT m.*, p.name AS project_name, p.client_name, p.client_email, p.currency, p.status AS project_status
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
      WHERE m.id = $1 AND p.user_id = $2`,
    [id, userId],
  );
}

export function findMilestoneByToken(token) {
  return queryOne(
    `SELECT m.*, p.name AS project_name, p.client_name, p.client_email, p.currency, p.status AS project_status,
            u.name AS dev_name, u.email AS dev_email, u.lang AS dev_lang
       FROM milestones m
       JOIN projects p ON p.id = m.project_id
       JOIN users u ON u.id = p.user_id
      WHERE m.token = $1`,
    [token],
  );
}

export function listDeliverables(milestoneId) {
  return query('SELECT * FROM deliverables WHERE milestone_id = $1 ORDER BY id', [milestoneId]);
}

export function listEvents(milestoneId) {
  return query('SELECT * FROM review_events WHERE milestone_id = $1 ORDER BY id DESC', [milestoneId]);
}

export function latestApproval(milestoneId) {
  return queryOne(
    `SELECT * FROM review_events WHERE milestone_id = $1 AND type = 'approved' ORDER BY id DESC LIMIT 1`,
    [milestoneId],
  );
}

export function addEvent(milestoneId, type, fields = {}) {
  return queryOne(
    `INSERT INTO review_events (milestone_id, type, client_name, message, ip, user_agent, snapshot, files, round, round_limit, over_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      milestoneId,
      type,
      fields.clientName ?? null,
      fields.message ?? null,
      fields.ip ?? null,
      fields.userAgent ?? null,
      fields.snapshot ? JSON.stringify(fields.snapshot) : null,
      fields.files ? JSON.stringify(fields.files) : null,
      fields.round ?? null,
      fields.roundLimit ?? null,
      fields.overLimit ?? false,
    ],
  );
}

// Where the milestone sits in its project: "Milestone 2 of 4".
export async function milestonePosition(milestone) {
  const row = await queryOne(
    `SELECT COUNT(*) FILTER (WHERE id <= $2)::int AS position, COUNT(*)::int AS total
       FROM milestones WHERE project_id = $1`,
    [milestone.project_id, milestone.id],
  );
  return row;
}

// What the client sees in the history panel: when this milestone was sent,
// and the earlier milestones of the project they already approved.
export async function clientHistory(milestone) {
  const [sent, approved] = await Promise.all([
    query(`SELECT created_at FROM review_events WHERE milestone_id = $1 AND type = 'sent' ORDER BY id`, [milestone.id]),
    query(
      `SELECT id, title, approved_at FROM milestones
        WHERE project_id = $1 AND id <> $2 AND status = 'approved'
        ORDER BY approved_at DESC LIMIT 5`,
      [milestone.project_id, milestone.id],
    ),
  ]);
  return {
    sentAt: sent.length > 0 ? sent[sent.length - 1].created_at : null,
    sent: sent.map((row) => row.created_at),
    approved,
  };
}

export function touchMilestone(milestoneId) {
  return query('UPDATE milestones SET updated_at = now() WHERE id = $1', [milestoneId]);
}

export function isLocked(milestone) {
  return milestone.status === 'approved';
}

export function isExpired(milestone) {
  return milestone.expires_at !== null && new Date(milestone.expires_at) < new Date();
}

// A frozen copy of what the client sees at the moment they approve.
export function buildSnapshot(milestone, deliverables, files = []) {
  return {
    provider: milestone.dev_name,
    project: milestone.project_name,
    client: milestone.client_name,
    currency: milestone.currency,
    title: milestone.title,
    description: milestone.description,
    amount: milestone.amount,
    deliverables: deliverables.map(({ kind, label, url, body }) => ({ kind, label, url, body })),
    files: files.map(({ name, mime, size, sha256 }) => ({ name, mime, size: Number(size), sha256 })),
  };
}

// Everything the certificate page needs, taken only from the approval record.
export function certificateData(milestone, approval) {
  const snapshot = typeof approval.snapshot === 'string' ? JSON.parse(approval.snapshot) : approval.snapshot;
  return {
    reference: `SO-${milestone.id}-${approval.id}`,
    approvedAt: approval.created_at,
    clientName: approval.client_name,
    ip: approval.ip,
    userAgent: approval.user_agent,
    snapshot,
  };
}
