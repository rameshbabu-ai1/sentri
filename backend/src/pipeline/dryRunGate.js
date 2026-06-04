/**
 * @module pipeline/dryRunGate
 * @description One-shot pre-approval test execution (AUDIT-ROADMAP Bundle 6, QAL-001).
 *
 * When `project.dryRunGate === 1`, every generated test is executed
 * once via `browserPool.acquire()` BEFORE entering the review queue.
 * The outcome lands on `tests.dryRunStatus` / `dryRunError` /
 * `dryRunDurationMs` (migration 073) and gates `AUTO-003b` auto-approval
 * (a dry-run failure is NEVER auto-approved per
 * `docs/roadmap/AUDIT-ROADMAP.md:743-744`).
 *
 * Three terminal outcomes per test:
 *   • { status: "passed",  durationMs }
 *   • { status: "failed",  error, durationMs }
 *   • { status: "trivial", durationMs } — passed in
 *     < DRY_RUN_TRIVIAL_THRESHOLD_MS with zero network requests; the
 *     test almost certainly didn't exercise the SUT.
 *
 * Cost & isolation: each dry-run uses one bounded `browserPool` lease,
 * so peak parallelism is bounded by the pool size regardless of batch
 * size. Per-lease `clearCookies` + per-context teardown keep each
 * dry-run isolated from the next.
 */

import vm from "node:vm";
import { browserPool } from "../runner/browserPool.js";
import { throwIfAborted } from "../utils/abortHelper.js";
import { formatLogLine } from "../utils/logFormatter.js";
import { getSelfHealingHelperCode } from "../selfHealing.js";
// AUDIT-ROADMAP B6 — reuse the real runner's code-preprocessing transforms
// so the dry-run sandbox sees the SAME shape `codeExecutor.js` executes.
// Generated tests carry `import { test, expect } from '@playwright/test'`
// + a `test('…', async ({ page }) => { … })` wrapper; a static `import`
// is a SyntaxError inside the async IIFE (vm runs in script mode, not
// module mode), so we must extract the bare body + strip imports before
// wrapping. Mirrors `codeExecutor.js`'s extract → strip → patch chain.
import { extractTestBody, stripPlaywrightImports, patchNetworkIdle } from "../runner/codeParsing.js";

/**
 * Threshold below which a passing dry-run is flagged as `trivial`.
 * Tests that pass under this wall-clock AND make zero network requests
 * almost certainly didn't exercise the SUT. Spec:
 * `docs/roadmap/AUDIT-ROADMAP.md:739-741`.
 */
const DRY_RUN_TRIVIAL_THRESHOLD_MS = (() => {
  const v = Number.parseInt(process.env.DRY_RUN_TRIVIAL_THRESHOLD_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

/**
 * Hard ceiling on one dry-run's wall-clock. A test that hangs past
 * this is force-released back to the pool and recorded as failed.
 */
const DRY_RUN_TIMEOUT_MS = (() => {
  const v = Number.parseInt(process.env.DRY_RUN_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
})();

const ERROR_MAX_CHARS = 2_000;

/**
 * Execute a single test once in a clean browser context.
 *
 * @param {Object} test
 * @param {Object} project
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.poolOverride] — DI hook for tests.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Object>} `{ status: 'passed'|'failed'|'trivial', error, durationMs }`.
 */
export async function dryRunTest(test, project, opts = {}) {
  const signal = opts.signal;
  const pool = opts.poolOverride || browserPool;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DRY_RUN_TIMEOUT_MS;
  const startedAt = Date.now();

  if (!test || typeof test.playwrightCode !== "string" || test.playwrightCode.trim().length === 0) {
    return {
      status: "failed",
      error: "dry_run_no_code",
      durationMs: Date.now() - startedAt,
    };
  }

  throwIfAborted(signal);

  let lease = null;
  let networkRequests = 0;
  let timeoutHandle = null;
  let timedOut = false;
  try {
    lease = await pool.acquire({});
    const { context, page } = lease;

    if (page && typeof page.on === "function") {
      page.on("request", () => { networkRequests += 1; });
    }

    // Initial navigation — defence-in-depth when the generated test
    // skips `page.goto`. `domcontentloaded` matches the codebase
    // convention (NEVER `networkidle`).
    if (project?.url && page && typeof page.goto === "function") {
      try {
        await page.goto(project.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch {
        // Initial-goto failure is not fatal — the embedded page.goto
        // in the test body may still succeed against a different URL.
      }
    }

    // Reset the request counter AFTER the gate's own initial navigation.
    // The `page.goto(project.url)` above fires the document request (plus
    // every sub-resource) which would otherwise pin `networkRequests` ≥ 1
    // before the test code runs — making the `networkRequests === 0`
    // trivial-detection check below impossible to satisfy on any project
    // with a URL configured (i.e. virtually all of them). Only requests
    // triggered by the test BODY should count toward "did this test
    // exercise the SUT?". Spec: `docs/roadmap/AUDIT-ROADMAP.md:739-741`.
    networkRequests = 0;

    // Preprocess exactly like `codeExecutor.js` before vm compilation:
    //   1. extractTestBody — pull the inner statements out of the
    //      `test('…', async ({ page }) => { … })` wrapper so the static
    //      `import` line + the `test(…)` call (neither legal inside an
    //      async IIFE in vm script mode) never reach the compiler.
    //   2. stripPlaywrightImports — defence-in-depth for the
    //      no-wrapper fallback path (bare-script tests with a top-level
    //      `import`/`require` and no `test()` call).
    //   3. patchNetworkIdle — rewrite `networkidle` waits to
    //      `domcontentloaded` so the dry-run doesn't hang 30 s on SPAs
    //      that never go idle (same rationale as the real runner).
    // When `extractTestBody` returns null (raw script, novel codegen),
    // fall back to the import-stripped full code so the test still runs
    // rather than failing the gate on a parse error we could have avoided.
    const extractedBody = extractTestBody(test.playwrightCode);
    const preparedCode = patchNetworkIdle(
      extractedBody !== null
        ? extractedBody
        : stripPlaywrightImports(test.playwrightCode),
    );

    const helperCode = getSelfHealingHelperCode();
    const wrapped = `(async () => {\n${helperCode}\n${preparedCode}\n})()`;

    // Minimal Playwright surface — `expect` is the only thing
    // generated tests reach for that isn't on the `page` object.
    // Wrapped in a try/catch so a missing optional dep on a slim
    // build degrades to no-`expect` (the test will throw a
    // ReferenceError on first assertion, captured as a normal
    // dry-run failure).
    let pwExpect;
    try { pwExpect = (await import("@playwright/test")).expect; } catch { pwExpect = undefined; }

    const sandbox = {
      page,
      context,
      expect: pwExpect,
      console: { log: () => {}, warn: () => {}, error: () => {} },
      setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(sandbox);

    const execPromise = (async () => {
      const script = new vm.Script(wrapped, { filename: `dry-run-${test.id || "unknown"}.js` });
      return script.runInContext(sandbox, { timeout: timeoutMs });
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`dry_run_timeout_${timeoutMs}ms`));
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    await Promise.race([execPromise, timeoutPromise]);

    const durationMs = Date.now() - startedAt;
    if (durationMs < DRY_RUN_TRIVIAL_THRESHOLD_MS && networkRequests === 0) {
      return { status: "trivial", durationMs };
    }
    return { status: "passed", durationMs };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = String(err?.message || err || "dry_run_unknown_error");
    console.warn(formatLogLine(
      "warn",
      null,
      `[dryRunGate] test ${test?.id || "?"} ${timedOut ? "timed out" : "failed"} (${durationMs}ms): ${message.slice(0, 200)}`,
    ));
    return {
      status: "failed",
      error: message.slice(0, ERROR_MAX_CHARS),
      durationMs,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (lease) {
      try { await lease.release(); } catch { /* best-effort */ }
    }
  }
}

/**
 * Run the dry-run gate over an array of validated tests, sequentially.
 * `browserPool` already bounds concurrency by lease count; serialising
 * here keeps the persistence ordering deterministic (Review Queue
 * badge order matches the array).
 *
 * @param {Object[]} tests
 * @param {Object} project
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Object[]>} One `{ status, error, durationMs }` per test, aligned by index.
 */
export async function dryRunBatch(tests, project, opts = {}) {
  if (!Array.isArray(tests) || tests.length === 0) return [];
  const results = [];
  for (const t of tests) {
    if (opts.signal?.aborted) {
      // Trailing tests after abort report `failed: aborted` so the
      // Review Queue chip is honest. The original `aborted` shape
      // is also visible in the durationMs=0 marker.
      results.push({ status: "failed", error: "aborted", durationMs: 0 });
      continue;
    }
    // Per-test isolation: one test's throw never aborts the batch.
    // The pool-bounded sequential loop preserves the persistence
    // ordering downstream.
    // eslint-disable-next-line no-await-in-loop
    const r = await dryRunTest(t, project, opts);
    results.push(r);
  }
  return results;
}

export const DRY_RUN_DEFAULTS = Object.freeze({
  trivialThresholdMs: DRY_RUN_TRIVIAL_THRESHOLD_MS,
  timeoutMs: DRY_RUN_TIMEOUT_MS,
  errorMaxChars: ERROR_MAX_CHARS,
});
