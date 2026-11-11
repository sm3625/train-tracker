-- Links that show one saved trip to anyone who has them (POST /v1/me/trips/:id/share). The token is the link's secret:
-- 128 random bits. One per trip, reused when it's shared again; it goes when the trip does.
CREATE TABLE IF NOT EXISTS trip_shares (
  token      TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trip_shares_trip ON trip_shares (trip_id);
CREATE INDEX IF NOT EXISTS trip_shares_user ON trip_shares (user_id);
