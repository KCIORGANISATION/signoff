CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  client_name  TEXT NOT NULL,
  client_email TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'EUR',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- status: draft, sent, viewed, feedback, approved
CREATE TABLE IF NOT EXISTS milestones (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount      NUMERIC(12, 2),
  status      TEXT NOT NULL DEFAULT 'draft',
  token       TEXT NOT NULL UNIQUE,
  approved_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- kind: url, note
CREATE TABLE IF NOT EXISTS deliverables (
  id           SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  url          TEXT,
  body         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only log of everything that happens on a milestone.
-- type: sent, viewed, feedback, approved
-- The app only ever inserts rows here, never updates them.
CREATE TABLE IF NOT EXISTS review_events (
  id           SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  client_name  TEXT,
  message      TEXT,
  ip           TEXT,
  user_agent   TEXT,
  snapshot     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per "forgot password" request. Only a hash of the emailed token is stored.
CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Language of the emails sent to the developer.
ALTER TABLE users ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'en';

CREATE INDEX IF NOT EXISTS projects_user_idx ON projects(user_id);
CREATE INDEX IF NOT EXISTS milestones_project_idx ON milestones(project_id);
CREATE INDEX IF NOT EXISTS deliverables_milestone_idx ON deliverables(milestone_id);
CREATE INDEX IF NOT EXISTS review_events_milestone_idx ON review_events(milestone_id);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);

-- Payment link and transfer instructions, shown to the client only once the milestone is approved.
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS payment_link TEXT;
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS payment_note TEXT;

-- Proof of approval cannot be changed. The database itself refuses:
-- any change to the review_events log, and deleting a row while its milestone still exists
-- (deleting a milestone, project or account still removes its log);
-- any change to the title, description, amount or deliverables of an approved milestone.
CREATE OR REPLACE FUNCTION signoff_review_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM milestones WHERE id = OLD.milestone_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'review_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER review_events_append_only
  BEFORE UPDATE OR DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION signoff_review_events_append_only();

CREATE OR REPLACE FUNCTION signoff_milestone_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
  ) THEN
    RAISE EXCEPTION 'milestone % is approved and locked', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER milestones_locked
  BEFORE UPDATE ON milestones
  FOR EACH ROW EXECUTE FUNCTION signoff_milestone_locked();

CREATE OR REPLACE FUNCTION signoff_deliverables_locked() RETURNS trigger AS $$
DECLARE
  target INTEGER := CASE WHEN TG_OP = 'DELETE' THEN OLD.milestone_id ELSE NEW.milestone_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM milestones WHERE id = target AND status = 'approved')
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM milestones WHERE id = OLD.milestone_id AND status = 'approved')) THEN
    RAISE EXCEPTION 'deliverables of approved milestone % are locked', target;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER deliverables_locked
  BEFORE INSERT OR UPDATE OR DELETE ON deliverables
  FOR EACH ROW EXECUTE FUNCTION signoff_deliverables_locked();

-- Files attached to a milestone. The content lives in storage (Cloudflare R2, or a local
-- folder in development) under a random key; only the cleaned name is kept for display.
CREATE TABLE IF NOT EXISTS files (
  id           SERIAL PRIMARY KEY,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  storage_key  TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         BIGINT NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_milestone_idx ON files(milestone_id);

-- Files of an approved milestone are frozen, like its deliverables.
CREATE OR REPLACE TRIGGER files_locked
  BEFORE INSERT OR UPDATE OR DELETE ON files
  FOR EACH ROW EXECUTE FUNCTION signoff_deliverables_locked();

-- With a feedback, the files of the milestone in the order the client saw them,
-- so "/fichier2" keeps pointing at the right file even if files change later.
ALTER TABLE review_events ADD COLUMN IF NOT EXISTS files JSONB;

-- Project states: active, completed, abandoned. Existing projects stay active.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

-- Closing a project sets its open milestones to not_done (completed) or cancelled (abandoned).
-- Their status at that moment is kept, so reopening the project puts them back as they were.
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS status_before_close TEXT;

-- Append-only journal of a project's state changes.
-- type: created, completed, abandoned, reopened
-- reason (abandoned): client_stopped, unforeseen, other
-- milestones: the milestones a closing changed, as [{ id, title, from, to }]
CREATE TABLE IF NOT EXISTS project_events (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  note        TEXT,
  milestones  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_events_project_idx ON project_events(project_id);

CREATE OR REPLACE FUNCTION signoff_project_events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'project_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER project_events_append_only
  BEFORE UPDATE OR DELETE ON project_events
  FOR EACH ROW EXECUTE FUNCTION signoff_project_events_append_only();

-- The developer's private notes on a project. Kept in their own table, which no client page reads.
CREATE TABLE IF NOT EXISTS project_notes (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- First and last name of the developer, for the greeting. Accounts created before this
-- change have none: the app asks for them on the next visit.
-- activity: web_dev, video, design, illustration, writing, photography, other (with activity_other)
-- delivers: files, links, both. Both answers are optional (the sign-up questionnaire can be skipped).
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_other TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS delivers TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS questionnaire_at TIMESTAMPTZ;

-- Phase 5, Lot 3 -------------------------------------------------------------

-- The working frame of a project: what is included, how many feedback rounds each milestone
-- includes (NULL: unlimited) and how many days the client has to decide (NULL: no deadline).
-- Each change is a new version; old versions stay. A project without any version (created
-- before frames existed, or left at the defaults) works as before: unlimited, no deadline,
-- nothing for the client to accept.
CREATE TABLE IF NOT EXISTS project_frames (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  included        TEXT NOT NULL DEFAULT '',
  revisions       INTEGER,
  validation_days INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

-- The client's acceptance of one frame version, with a frozen copy of what they accepted.
CREATE TABLE IF NOT EXISTS frame_acceptances (
  id           SERIAL PRIMARY KEY,
  frame_id     INTEGER NOT NULL REFERENCES project_frames(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  snapshot     JSONB NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (frame_id)
);
CREATE INDEX IF NOT EXISTS frame_acceptances_project_idx ON frame_acceptances(project_id);

-- Frame versions and acceptances are never changed (deleting the project still removes them).
-- A milestone deleted later only loses its link to the acceptance.
CREATE OR REPLACE FUNCTION signoff_frames_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'frame_acceptances' THEN
    IF NEW.milestone_id IS NULL AND NEW.frame_id = OLD.frame_id AND NEW.snapshot = OLD.snapshot AND NEW.created_at = OLD.created_at THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER project_frames_append_only
  BEFORE UPDATE OR DELETE ON project_frames
  FOR EACH ROW EXECUTE FUNCTION signoff_frames_append_only();

CREATE OR REPLACE TRIGGER frame_acceptances_append_only
  BEFORE UPDATE OR DELETE ON frame_acceptances
  FOR EACH ROW EXECUTE FUNCTION signoff_frames_append_only();

-- Feedback rounds: each feedback records its round number, the limit of the frame at that
-- moment, and whether it went beyond the included revisions.
-- Milestone history also gets these event types, all written by the app:
--   out_of_scope (the developer marked a feedback as out of scope; snapshot.feedback_id),
--   revision_accepted (the developer accepted a feedback beyond the limit; snapshot.feedback_id),
--   supplement_proposed / supplement_accepted / supplement_declined (snapshot.supplement_id),
--   deadline_reminder / deadline_passed (snapshot.key, unique per deadline and kind).
ALTER TABLE review_events ADD COLUMN IF NOT EXISTS round INTEGER;
ALTER TABLE review_events ADD COLUMN IF NOT EXISTS round_limit INTEGER;
ALTER TABLE review_events ADD COLUMN IF NOT EXISTS over_limit BOOLEAN NOT NULL DEFAULT false;

-- Makes the deadline check idempotent: the same reminder can only ever be recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS review_events_deadline_once
  ON review_events (milestone_id, type, (snapshot->>'key'))
  WHERE type IN ('deadline_reminder', 'deadline_passed');

-- When the client should decide by: the last sending plus the frame's validation days.
-- NULL without a deadline. Nothing is ever approved automatically when it passes.
ALTER TABLE milestones ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;

-- A paid supplement proposed to the client for an out-of-scope request.
-- status: proposed, accepted (a new milestone is created: milestone_created_id), declined.
CREATE TABLE IF NOT EXISTS supplements (
  id                   SERIAL PRIMARY KEY,
  project_id           INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id         INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  feedback_id          INTEGER REFERENCES review_events(id) ON DELETE SET NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  amount               NUMERIC(12, 2) NOT NULL,
  currency             TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'proposed',
  client_comment       TEXT,
  decided_at           TIMESTAMPTZ,
  ip                   TEXT,
  user_agent           TEXT,
  milestone_created_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supplements_milestone_idx ON supplements(milestone_id);
CREATE INDEX IF NOT EXISTS supplements_project_idx ON supplements(project_id);

-- A decided supplement is a record: only the links to deleted rows may still be cleared.
CREATE OR REPLACE FUNCTION signoff_supplement_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'proposed' AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.client_comment IS DISTINCT FROM OLD.client_comment
    OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
  ) THEN
    RAISE EXCEPTION 'supplement % is decided and locked', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER supplements_locked
  BEFORE UPDATE ON supplements
  FOR EACH ROW EXECUTE FUNCTION signoff_supplement_locked();
