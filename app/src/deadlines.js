import { query } from './db.js';
import { formatters } from './format.js';
import { emailDeadlinePassed, emailDeadlineReminder } from './email.js';
import { termFor } from './vocabulary.js';

// Validation deadlines. When a milestone is sent under a frame with a validation delay,
// due_at = sending + delay. The client is reminded halfway and the day before (one email if
// both fall at once or the delay is short); once it passes, the history says so and the
// developer is told. Nothing is ever approved automatically: the milestone keeps waiting
// for the client's own decision.
//
// checkDeadlines is idempotent: each reminder is a review_events row that a unique index
// allows only once, and an email goes out only for a row this call inserted. It runs from
// the protected /cron/deadlines route and when the pages concerned are opened.

const DAY = 24 * 60 * 60 * 1000;

// The moments that matter for one deadline. The "day before" reminder is dropped when it would
// not come after the halfway one (a delay of one or two days).
export function deadlineSchedule(sentAt, dueAt) {
  const sent = new Date(sentAt).getTime();
  const due = new Date(dueAt).getTime();
  const half = new Date(sent + (due - sent) / 2);
  const eve = new Date(due - DAY);
  const reminders = [{ kind: 'half', at: half }];
  if (eve > half) reminders.push({ kind: 'eve', at: eve });
  return { reminders, due: new Date(due) };
}

export function isOverdue(milestone, now = new Date()) {
  return Boolean(milestone.due_at) && (milestone.status === 'sent' || milestone.status === 'viewed') && new Date(milestone.due_at) <= now;
}

function record(milestoneId, type, dueAt, kind) {
  const key = `${new Date(dueAt).toISOString()}:${kind}`;
  return query(
    `INSERT INTO review_events (milestone_id, type, snapshot)
     VALUES ($1, $2, $3)
     ON CONFLICT (milestone_id, type, (snapshot->>'key')) WHERE type IN ('deadline_reminder', 'deadline_passed') DO NOTHING
     RETURNING id`,
    [milestoneId, type, JSON.stringify({ key, kind, due_at: new Date(dueAt).toISOString() })],
  );
}

// filter: { milestoneIds } or { userId } to check only what a page shows; nothing checks everything.
export async function checkDeadlines({ baseUrl, now = new Date(), milestoneIds = null, userId = null } = {}) {
  const conditions = [`m.status IN ('sent', 'viewed')`, 'm.due_at IS NOT NULL', `p.status = 'active'`];
  const params = [];
  if (milestoneIds) {
    params.push(milestoneIds);
    conditions.push(`m.id = ANY($${params.length}::int[])`);
  }
  if (userId) {
    params.push(userId);
    conditions.push(`p.user_id = $${params.length}`);
  }
  const rows = await query(
    `SELECT m.id, m.title, m.token, m.due_at,
            (SELECT MAX(e.created_at) FROM review_events e WHERE e.milestone_id = m.id AND e.type = 'sent') AS sent_at,
            p.name AS project_name, p.client_name, p.client_email,
            u.name AS dev_name, u.email AS dev_email, u.lang AS dev_lang, u.activity AS dev_activity
       FROM milestones m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.id`,
    params,
  );

  const done = { reminders: 0, overdue: 0 };
  for (const m of rows) {
    if (!m.sent_at) continue;
    const { reminders, due } = deadlineSchedule(m.sent_at, m.due_at);
    const date = formatters(m.dev_lang).date(due);

    if (due <= now) {
      const inserted = await record(m.id, 'deadline_passed', due, 'passed');
      if (inserted.length > 0) {
        done.overdue += 1;
        await emailDeadlinePassed({
          to: m.dev_email,
          lang: m.dev_lang,
          term: termFor(m.dev_activity),
          clientName: m.client_name,
          title: m.title,
          projectName: m.project_name,
          date,
          link: `${baseUrl}/milestones/${m.id}`,
        });
      }
      continue;
    }

    // Every reminder already due is recorded; the client gets a single email for them.
    let sent = false;
    for (const reminder of reminders.filter((r) => r.at <= now)) {
      const inserted = await record(m.id, 'deadline_reminder', due, reminder.kind);
      sent ||= inserted.length > 0;
    }
    if (sent) {
      done.reminders += 1;
      await emailDeadlineReminder({
        to: m.client_email,
        lang: m.dev_lang,
        term: termFor(m.dev_activity),
        devName: m.dev_name,
        clientName: m.client_name,
        title: m.title,
        projectName: m.project_name,
        date,
        link: `${baseUrl}/r/${m.token}`,
      });
    }
  }
  return done;
}
