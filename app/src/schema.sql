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
