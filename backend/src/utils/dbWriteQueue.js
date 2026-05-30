/**
 * @module utils/dbWriteQueue
 * @description B1.2 (AUDIT-ROADMAP Bundle 1) — write-batching queue for
 * the hottest SQLite write paths.
 *
 * ## Why
 *
 * Under `parallelWorkers > 1`, SQLite WAL serialises writers. Three call
 * sites dominate the contention: `healingRepo.set()`,
 * `runTestResultRepo.append()` (B1.1), and `runLogRepo.appendLog()`.
 * Wrapping consecutive writes in a single transaction collapses N
 * `BEGIN/COMMIT` round-trips into one, lifting effective throughput on
 * `parallelWorkers = 10` from ~60% of capacity back to near-100%.
 *
 * ## Behaviour
 *
 * - **SQLite**: writes enqueued via {@link enqueue} are buffered until
 *   either `DB_WRITE_BATCH_SIZE` is reached or `DB_WRITE_FLUSH_MS`
 *   elapses, then drained inside a single `db.transaction()`.
 * - **PostgreSQL**: the queue is a passthrough — calls execute
 *   synchronously. Postgres handles concurrent writers natively; the
 *   batching machinery would add latency without throughput benefit.
 * - **High priority**: callers can pass `{ priority: "high" }` to bypass
 *   the batch and execute immediately under a synchronous transaction.
 *   Reserved for write paths whose durability matters more than
 *   throughput (e.g. healing circuit-breaker trip, B7-4).
 * - **Graceful shutdown**: {@link drain} flushes all pending writes
 *   synchronously. The shutdown sequence in `index.js` calls it before
 *   `closeDatabase()`.
 *
 * ## Failure model
 *
 * Each queued closure is wrapped in `try/catch` inside the flush
 * transaction. A throwing closure rolls back the *batch* — but rather
 * than discarding every queued write, the queue replays the surviving
 * closures one-by-one after the rollback. This trades a small latency
 * hit on poison-pill writes for "one bad write never silently drops 49
 * others".
 *
 * ## Metrics
 *
 * - `app_db_write_queue_depth` (Gauge) — current queue size
 * - `app_db_write_batch_duration_seconds` (Histogram) — flush wall-clock
 * - `app_db_write_batch_size` (Histogram) — operations per flush
 *
 * @example
 * import { enqueue, drain } from "./utils/dbWriteQueue.js";
 * enqueue(() => db.prepare("INSERT INTO …").run(…));
 * // …later, at shutdown:
 * drain();
 */

import { getDatabase, getDatabaseDialect } from "../database/sqlite.js";
import { formatLogLine } from "./logFormatter.js";
import {
  dbWriteQueueDepth,
  dbWriteBatchDurationSeconds,
  dbWriteBatchSize,
} from "./metrics.js";

const BATCH_SIZE = Number(process.env.DB_WRITE_BATCH_SIZE) || 50;
const FLUSH_MS = Number(process.env.DB_WRITE_FLUSH_MS) || 100;

/** @typedef {() => void} WriteFn */

/** @type {WriteFn[]} */
const _queue = [];
let _flushScheduled = false;
let _flushTimer = null;

function updateDepthGauge() {
  try { dbWriteQueueDepth.set(_queue.length); } catch { /* best-effort */ }
}

/**
 * Drain the queue inside a single transaction. Called by the flush
 * scheduler and synchronously by {@link drain}.
 *
 * @returns {number} ops flushed
 */
function flushNow() {
  if (_flushTimer) {
    clearTimeout(_flushTimer);
    _flushTimer = null;
  }
  _flushScheduled = false;
  if (_queue.length === 0) {
    updateDepthGauge();
    return 0;
  }

  const batch = _queue.splice(0, _queue.length);
  updateDepthGauge();
  const start = Date.now();
  const db = getDatabase();

  try {
    db.transaction(() => {
      for (const fn of batch) fn();
    })();
  } catch (err) {
    // One poison pill must not drop the rest. Replay survivors
    // individually outside the failed transaction.
    console.warn(formatLogLine(
      "warn",
      null,
      `[dbWriteQueue] batch of ${batch.length} rolled back: ${err?.message || err} — replaying individually`,
    ));
    for (const fn of batch) {
      try {
        db.transaction(() => fn())();
      } catch (replayErr) {
        console.warn(formatLogLine(
          "warn",
          null,
          `[dbWriteQueue] dropped one write on replay: ${replayErr?.message || replayErr}`,
        ));
      }
    }
  }

  try {
    const seconds = (Date.now() - start) / 1000;
    dbWriteBatchDurationSeconds.observe(seconds);
    dbWriteBatchSize.observe(batch.length);
  } catch { /* best-effort */ }

  return batch.length;
}

/**
 * Enqueue a write closure for batched execution.
 *
 * On PostgreSQL or when `opts.priority === "high"`, executes
 * synchronously inside its own transaction.
 *
 * @param {WriteFn} fn      - Closure that runs one or more `db.prepare(…).run(…)` calls.
 * @param {Object}  [opts]
 * @param {"normal"|"high"} [opts.priority="normal"]
 * @returns {void}
 */
export function enqueue(fn, opts = {}) {
  if (typeof fn !== "function") return;

  const dialect = getDatabaseDialect();
  if (dialect === "postgres" || opts.priority === "high") {
    // Passthrough — Postgres handles concurrent writers natively, and
    // high-priority writes must be durable before this call returns.
    try {
      const db = getDatabase();
      db.transaction(() => fn())();
    } catch (err) {
      console.warn(formatLogLine(
        "warn",
        null,
        `[dbWriteQueue] direct write failed: ${err?.message || err}`,
      ));
    }
    return;
  }

  _queue.push(fn);
  updateDepthGauge();

  if (_queue.length >= BATCH_SIZE) {
    flushNow();
    return;
  }

  if (!_flushScheduled) {
    _flushScheduled = true;
    _flushTimer = setTimeout(() => {
      flushNow();
    }, FLUSH_MS);
    // Allow process exit even if the queue is empty / idle.
    if (_flushTimer.unref) _flushTimer.unref();
  }
}

/**
 * Synchronously flush all pending writes. Called from graceful shutdown
 * in `index.js` and from tests that need to assert post-flush state.
 *
 * Safe to call repeatedly — no-op when the queue is empty.
 *
 * @returns {number} total ops flushed across all drain iterations
 */
export function drain() {
  let total = 0;
  // Loop in case enqueue() races with drain() on a hot path; a single
  // flushNow call processes the snapshot it captured, so re-check.
  while (_queue.length > 0) {
    total += flushNow();
  }
  return total;
}

/**
 * Current queue depth — used by tests.
 *
 * @returns {number}
 */
export function depth() {
  return _queue.length;
}
