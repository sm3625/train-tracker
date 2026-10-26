-- Feedback people send from the site or the apps. Anyone can send it; user_id is set when they were signed in.
-- Read it with: npx wrangler d1 execute trackside-accounts --remote --command "SELECT * FROM feedback ORDER BY created_at DESC"
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                          -- null when sent signed out
  kind        TEXT NOT NULL,                 -- 'idea', 'problem' or 'other'
  message     TEXT NOT NULL,
  contact     TEXT,                          -- an email to reply to, if they gave one
  page        TEXT,                          -- 'web', 'ios' or 'android', and the version
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_created ON feedback (created_at);
