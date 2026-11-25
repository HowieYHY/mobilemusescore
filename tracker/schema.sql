-- One row per visit (a "session"): the app sends its running totals, the Worker keeps the biggest.
-- Nothing here names a person: `id` is a random number the app made for this install, and no IP
-- address, score name or file is stored.
CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,   -- random per visit
  id      TEXT NOT NULL,      -- random per install (kept on the device)
  started INTEGER NOT NULL,   -- ms, the Worker's clock
  last    INTEGER NOT NULL,   -- ms of the latest ping
  secs    INTEGER NOT NULL,   -- seconds the app was in front
  play    INTEGER NOT NULL,   -- seconds music was playing
  v       TEXT NOT NULL,      -- app version
  mode    TEXT NOT NULL,      -- 'app' (installed) or 'tab' (browser)
  own     INTEGER NOT NULL DEFAULT 0  -- 1 when the visit carried the owner's key (see migrations/)
);
CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started);
CREATE INDEX IF NOT EXISTS sessions_id ON sessions (id);
