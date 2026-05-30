-- B1.1 — Run checkpoint / crash-recovery columns (AUDIT-ROADMAP Bundle 1).
--
-- `failureReason` distinguishes ordinary test failures from process-level
-- terminations. On server startup, any run still flagged `status =
-- 'running'` with no `run_test_results` flush in the last
-- `CHECKPOINT_STALE_MS` window is transitioned to
-- `status = 'failed', failureReason = 'process_crash'` so the UI does
-- not show phantom in-flight runs.
--
-- `reviewRejectedTests` is added here (despite belonging conceptually
-- to Bundle 3) because the AUDIT-ROADMAP doc lists it under both B1's
-- and B3's migration stub. Keeping it on B1's migration avoids a
-- conflict when B3 lands later — B3 will only add `reviewerCollapsed`.
--
-- Convention: `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite.
-- The migration runner (`migrate.js`) tolerates "duplicate column name"
-- errors so re-running this file is safe on already-migrated DBs.

ALTER TABLE runs ADD COLUMN failureReason TEXT;
ALTER TABLE runs ADD COLUMN reviewRejectedTests TEXT DEFAULT '[]';
