-- B1.1 — Per-test result flush + crash recovery (AUDIT-ROADMAP Bundle 1).
--
-- Replaces the in-memory `run.results[]` accumulation pattern in
-- `testRunner.js` with an append-only table. Each completed test writes
-- one row immediately on its execution `finally` so a SIGKILL / OOM /
-- container kill mid-run preserves every result collected up to that
-- point. `runRepo.getById()` reconstructs `run.results[]` from this
-- table on read (mirrors the `run_logs` pattern from ENH-008).
--
-- The UNIQUE(runId, testId) constraint guarantees the resume endpoint
-- (`POST /api/v1/runs/:id/resume`) can use a single SELECT to discover
-- which tests have already completed and re-enqueue only the missing
-- ones. Data-driven tests (CAP-001 iterations) are NOT covered by this
-- constraint — they store one row per iteration via the iterationIndex
-- suffix in testId, which keeps the constraint shape simple.
--
-- Rollback: DROP TABLE run_test_results; — callers fall back to the
-- legacy in-memory `run.results[]` path that `testRunner.js` still
-- populates (B1 keeps both paths until B1.4 follow-up removes the
-- in-memory shadow).

CREATE TABLE IF NOT EXISTS run_test_results (
  id TEXT PRIMARY KEY,
  runId TEXT NOT NULL,
  testId TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  errorCategory TEXT,
  duration INTEGER,
  retryCount INTEGER DEFAULT 0,
  artifacts TEXT,
  healingEvents TEXT,
  iterationIndex INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  UNIQUE(runId, testId, iterationIndex)
);

CREATE INDEX IF NOT EXISTS idx_rtr_runId ON run_test_results(runId);
CREATE INDEX IF NOT EXISTS idx_rtr_runId_status ON run_test_results(runId, status);

INSERT OR IGNORE INTO counters(name, value) VALUES ('run_test_result', 0);
