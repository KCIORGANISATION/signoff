import { query } from './db.js';
import { STATUSES } from './models.js';
import { PROJECT_STATUSES, ABANDON_REASONS } from './projects.js';

// Every figure here comes from what Signoff records: projects, milestones, the amounts the
// developer typed on them, and the client's answers. Signoff knows nothing of payments received
// or expenses, so no figure is called revenue. Amounts in different currencies are never added up.

export const PERIODS = ['30d', '12m', 'all'];
const DAY = 24 * 60 * 60 * 1000;

export function periodStart(period, now = new Date()) {
  if (period === '30d') return new Date(now.getTime() - 30 * DAY);
  if (period === '12m') {
    const start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - 1);
    return start;
  }
  return null;
}

// All the rows the statistics need, for one account.
export async function loadStatsData(userId) {
  const [projects, milestones, events, projectEvents] = await Promise.all([
    query('SELECT id, name, client_name, client_email, status, created_at FROM projects WHERE user_id = $1 ORDER BY id', [userId]),
    query(
      `SELECT m.id, m.project_id, m.status, m.amount, m.created_at, m.approved_at, p.currency
         FROM milestones m JOIN projects p ON p.id = m.project_id
        WHERE p.user_id = $1 ORDER BY m.id`,
      [userId],
    ),
    query(
      `SELECT e.milestone_id, e.type, e.created_at
         FROM review_events e JOIN milestones m ON m.id = e.milestone_id JOIN projects p ON p.id = m.project_id
        WHERE p.user_id = $1 AND e.type IN ('sent', 'feedback', 'approved') ORDER BY e.id`,
      [userId],
    ),
    query(
      `SELECT e.project_id, e.type, e.reason, e.created_at
         FROM project_events e JOIN projects p ON p.id = e.project_id
        WHERE p.user_id = $1 AND e.type = 'abandoned' ORDER BY e.id`,
      [userId],
    ),
  ]);
  return { projects, milestones, events, projectEvents };
}

// Amounts are added in cents, so 0.1 + 0.2 stays 0.30.
const cents = (amount) => Math.round(Number(amount) * 100);
const mean = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const count = (items, test) => items.filter(test).length;

function totalsByCurrency(milestones, groups) {
  const byCurrency = new Map();
  for (const m of milestones) {
    if (m.amount === null || m.amount === undefined) continue;
    const group = Object.keys(groups).find((name) => groups[name](m));
    if (!group) continue;
    const row = byCurrency.get(m.currency) ?? Object.fromEntries([['currency', m.currency], ...Object.keys(groups).map((g) => [g, 0])]);
    row[group] += cents(m.amount);
    byCurrency.set(m.currency, row);
  }
  return [...byCurrency.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

export function computeStats(data, { since = null, now = new Date() } = {}) {
  const inPeriod = (date) => date !== null && date !== undefined && (!since || new Date(date) >= since) && new Date(date) <= now;
  const eventsOf = new Map();
  for (const e of data.events) {
    if (!eventsOf.has(e.milestone_id)) eventsOf.set(e.milestone_id, []);
    eventsOf.get(e.milestone_id).push(e);
  }

  // Projects started in the period.
  const projects = data.projects.filter((p) => inPeriod(p.created_at));
  const byStatus = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, count(projects, (p) => p.status === s)]));
  const lastAbandon = new Map();
  for (const e of data.projectEvents) lastAbandon.set(e.project_id, e);
  const reasons = Object.fromEntries(ABANDON_REASONS.map((r) => [r, 0]));
  for (const p of projects) {
    if (p.status !== 'abandoned') continue;
    const reason = lastAbandon.get(p.id)?.reason;
    if (reason in reasons) reasons[reason] += 1;
  }

  // Milestones created in the period.
  const milestones = data.milestones.filter((m) => inPeriod(m.created_at));
  const milestoneCounts = {
    total: milestones.length,
    approved: count(milestones, (m) => m.status === 'approved'),
    waiting: count(milestones, (m) => m.status === 'sent' || m.status === 'viewed'),
    feedback: count(milestones, (m) => m.status === 'feedback'),
  };

  // Progress of the projects in progress today, whatever the period.
  const progress = data.projects
    .filter((p) => p.status === 'active')
    .map((p) => data.milestones.filter((m) => m.project_id === p.id))
    .filter((own) => own.length > 0)
    .map((own) => count(own, (m) => m.status === 'approved') / own.length);

  const amounts = totalsByCurrency(data.milestones, {
    approved: (m) => m.status === 'approved' && inPeriod(m.approved_at),
    pending: (m) => ['draft', 'sent', 'viewed', 'feedback'].includes(m.status) && inPeriod(m.created_at),
    cancelled: (m) => (m.status === 'cancelled' || m.status === 'not_done') && inPeriod(m.created_at),
  });

  // Speed: from the first sending to the approval, and feedback rounds, for milestones approved in the period.
  const approvedNow = data.milestones.filter((m) => m.status === 'approved' && inPeriod(m.approved_at));
  const delays = [];
  const rounds = [];
  for (const m of approvedNow) {
    const own = eventsOf.get(m.id) ?? [];
    const firstSent = own.find((e) => e.type === 'sent');
    if (firstSent) delays.push(new Date(m.approved_at) - new Date(firstSent.created_at));
    rounds.push(count(own, (e) => e.type === 'feedback'));
  }

  // Per client (grouped by email): projects started, client answers and their delay, in the period.
  const clients = new Map();
  for (const p of data.projects) {
    const key = p.client_email.trim().toLowerCase();
    const client = clients.get(key) ?? { email: p.client_email, name: p.client_name, projects: 0, feedback: 0, delays: [] };
    client.name = p.client_name;
    client.email = p.client_email.trim();
    if (inPeriod(p.created_at)) client.projects += 1;
    for (const m of data.milestones.filter((x) => x.project_id === p.id)) {
      const own = eventsOf.get(m.id) ?? [];
      own.forEach((e, i) => {
        if (e.type === 'feedback' && inPeriod(e.created_at)) client.feedback += 1;
        if (e.type !== 'sent' || !inPeriod(e.created_at)) return;
        const answer = own.slice(i + 1).find((next) => next.type === 'feedback' || next.type === 'approved');
        if (answer) client.delays.push(new Date(answer.created_at) - new Date(e.created_at));
      });
    }
    clients.set(key, client);
  }
  const clientRows = [...clients.values()]
    .filter((c) => c.projects > 0 || c.feedback > 0 || c.delays.length > 0)
    .map(({ delays: list, ...c }) => ({ ...c, responseMs: mean(list) }))
    .sort((a, b) => b.projects - a.projects || a.name.localeCompare(b.name));

  return {
    empty: data.projects.length === 0,
    projects: { total: projects.length, byStatus, abandonRate: projects.length ? byStatus.abandoned / projects.length : null, reasons },
    milestones: { ...milestoneCounts, averageProgress: mean(progress) },
    amounts,
    speed: { approvalMs: mean(delays), feedbackRounds: mean(rounds), approvedCount: approvedNow.length },
    clients: clientRows,
  };
}

// The last twelve months, oldest first, as "2026-10" keys (UTC).
export function lastMonths(now = new Date(), months = 12) {
  const keys = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

// The three charts of the home tab.
export function computeHome(data, now = new Date()) {
  const projects = Object.fromEntries(PROJECT_STATUSES.map((s) => [s, count(data.projects, (p) => p.status === s)]));
  const milestones = Object.fromEntries(
    STATUSES.map((s) => [s, count(data.milestones, (m) => m.status === s)]).filter(([, n]) => n > 0),
  );

  const months = lastMonths(now);
  const byCurrency = new Map();
  for (const m of data.milestones) {
    if (m.status !== 'approved' || m.amount === null || !m.approved_at) continue;
    const key = new Date(m.approved_at).toISOString().slice(0, 7);
    if (!months.includes(key)) continue;
    const row = byCurrency.get(m.currency) ?? { currency: m.currency, total: 0, months: Object.fromEntries(months.map((k) => [k, 0])) };
    row.months[key] += cents(m.amount);
    row.total += cents(m.amount);
    byCurrency.set(m.currency, row);
  }
  const amounts = [...byCurrency.values()].sort((a, b) => b.total - a.total || a.currency.localeCompare(b.currency));

  return {
    projects: data.projects.length > 0 ? projects : null,
    milestones: Object.keys(milestones).length > 0 ? milestones : null,
    amounts: amounts.length > 0 ? { months, currencies: amounts } : null,
  };
}
