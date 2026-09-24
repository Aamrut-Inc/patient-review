-- One row per patient: the current review state (flags, comments, version history) as JSON.
CREATE TABLE patient_state (
  patient_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Append-only audit trail of every change, for the engineering team.
CREATE TABLE review_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  op         TEXT NOT NULL,
  payload    TEXT NOT NULL,
  email      TEXT NOT NULL,
  at         TEXT NOT NULL
);
CREATE INDEX review_events_patient ON review_events (patient_id, at);
