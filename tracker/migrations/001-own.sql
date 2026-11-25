-- 25 Nov 2026: tell the owner's own visits from everyone else's. Run once on a database made before this:
--   npx wrangler d1 execute pocketscore-usage --remote --file=migrations/001-own.sql
ALTER TABLE sessions ADD COLUMN own INTEGER NOT NULL DEFAULT 0;
