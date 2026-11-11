-- The delay recorder (src/delays.js; docs/delay-history-plan.md). Public timetable data only: nothing about riders.

-- One row per finished trip, written once when it leaves its feed. Kept 90 days.
CREATE TABLE IF NOT EXISTS runs (
  provider      TEXT NOT NULL,
  train_num     TEXT NOT NULL,
  service_date  TEXT NOT NULL,                 -- YYYY-MM-DD, as trips use it
  day_type      TEXT NOT NULL,                 -- 'wkd', 'sat' or 'sun'
  cancelled     INTEGER NOT NULL DEFAULT 0,
  stops         TEXT NOT NULL,                 -- JSON: [[code, scheduled departure ms, arrival delay min, departure delay min, 'r' reported | 'e' estimated], …]
  recorded_at   INTEGER NOT NULL,
  PRIMARY KEY (provider, train_num, service_date)
);
CREATE INDEX IF NOT EXISTS runs_date ON runs (service_date);

-- The recorder's own bookkeeping, one row per source (a railroad id from agencies.js, or 'amtraker'): when it was
-- last read, whether anything was running, and the trips under way. Kept in D1 rather than Cloudflare's cache
-- because scheduled runs don't always land in the same data centre, and the cache is per data centre.
CREATE TABLE IF NOT EXISTS recorder_state (
  source   TEXT PRIMARY KEY,
  read_at  INTEGER NOT NULL,
  idle     INTEGER NOT NULL DEFAULT 0,
  state    TEXT NOT NULL                       -- JSON: { trips: { key: trip } }
);
