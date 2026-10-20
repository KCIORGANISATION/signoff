import { query } from './db.js';
import { frameHistory } from './scope.js';
import { listProjectEvents } from './projects.js';

const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

// Everything the proof file of a project shows, read from the records Signoff keeps:
// frame versions and their acceptances, milestones and their history (sending, decisions,
// feedback, reminders), files with their SHA-256 fingerprints, supplements, and state changes.
// For an approved milestone the files are those frozen in the approval record.
export async function proofData(project, user) {
  const [frames, milestones, events, files, supplements, journal] = await Promise.all([
    frameHistory(project.id),
    query('SELECT * FROM milestones WHERE project_id = $1 ORDER BY id', [project.id]),
    query(
      `SELECT e.* FROM review_events e JOIN milestones m ON m.id = e.milestone_id
        WHERE m.project_id = $1 ORDER BY e.id`,
      [project.id],
    ),
    query(
      `SELECT f.milestone_id, f.name, f.size, f.sha256, f.created_at FROM files f JOIN milestones m ON m.id = f.milestone_id
        WHERE m.project_id = $1 ORDER BY f.id`,
      [project.id],
    ),
    query('SELECT * FROM supplements WHERE project_id = $1 ORDER BY id', [project.id]),
    listProjectEvents(project.id),
  ]);

  const items = milestones.map((m) => {
    const own = events.filter((e) => e.milestone_id === m.id).map((e) => ({ ...e, snapshot: parse(e.snapshot) }));
    const approval = own.findLast((e) => e.type === 'approved');
    return {
      ...m,
      events: own,
      approval,
      files: approval?.snapshot?.files ?? files.filter((f) => f.milestone_id === m.id),
      frozenFiles: Boolean(approval?.snapshot?.files),
      reference: approval ? `SO-${m.id}-${approval.id}` : null,
    };
  });

  return {
    project,
    provider: user.name,
    generatedAt: new Date(),
    frames: frames.map((f) => ({ ...f, accepted_snapshot: parse(f.accepted_snapshot) })),
    milestones: items,
    supplements,
    journal: journal.slice().reverse(),
    titleOf: Object.fromEntries(milestones.map((m) => [m.id, m.title])),
  };
}
