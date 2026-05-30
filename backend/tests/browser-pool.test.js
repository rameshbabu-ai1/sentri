/**
 * @module tests/browser-pool
 * @description Unit coverage for the MNT-015 warm BrowserPool.
 */

import assert from "node:assert/strict";
import { BrowserPool } from "../src/runner/browserPool.js";

function createFakeLauncher() {
  let launches = 0;
  const contexts = [];
  return {
    get launches() { return launches; },
    contexts,
    async launch() {
      launches += 1;
      return {
        isConnected: () => true,
        async newContext(options) {
          const pages = [];
          const context = {
            options,
            closed: false,
            clearedCookies: 0,
            clearedPermissions: 0,
            pages: () => pages,
            async newPage() {
              const page = { closed: false, async close() { this.closed = true; } };
              pages.push(page);
              return page;
            },
            async clearCookies() { this.clearedCookies += 1; },
            async clearPermissions() { this.clearedPermissions += 1; },
            async close() { this.closed = true; },
          };
          contexts.push(context);
          return context;
        },
        async close() { this.closed = true; },
      };
    },
  };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); passed++; console.log(`  ✅  ${name}`); }
    catch (err) { failed++; console.log(`  ❌  ${name}\n      ${err.stack || err.message}`); }
  }

  await run("reuses released contexts and launches once", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 2, launcher: fake.launch });
    const first = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US" } });
    await first.release();
    const second = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US" } });
    assert.equal(fake.launches, 1);
    assert.equal(fake.contexts.length, 1);
    assert.equal(second.context, first.context);
    assert.equal(second.context.clearedCookies, 1);
    await second.release();
    await pool.drainAndClose();
  });

  await run("waits FIFO when pool is full", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    const first = await pool.acquire({ browserType: "chromium" });
    const order = [];
    const secondPromise = pool.acquire({ browserType: "chromium" }).then((lease) => { order.push("second"); return lease; });
    const thirdPromise = pool.acquire({ browserType: "chromium" }).then((lease) => { order.push("third"); return lease; });
    assert.equal(pool.getStats()[0].queued, 2);
    await first.release();
    const second = await secondPromise;
    assert.deepEqual(order, ["second"]);
    await second.release();
    const third = await thirdPromise;
    assert.deepEqual(order, ["second", "third"]);
    await third.release();
    await pool.drainAndClose();
  });

  await run("separates locale and viewport cache keys", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 2, launcher: fake.launch });
    const en = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "en-US", viewport: { width: 800, height: 600 } } });
    const it = await pool.acquire({ browserType: "chromium", contextOptions: { locale: "it-IT", viewport: { width: 800, height: 600 } } });
    assert.notEqual(en.context, it.context);
    assert.equal(pool.getStats().length, 2);
    await en.release();
    await it.release();
    await pool.drainAndClose();
  });

  await run("drain closes idle contexts", async () => {
    const fake = createFakeLauncher();
    const pool = new BrowserPool({ size: 1, launcher: fake.launch });
    const lease = await pool.acquire({ browserType: "chromium" });
    const context = lease.context;
    await lease.release();
    await pool.drainAndClose();
    assert.equal(context.closed, true);
    assert.equal(pool.getStats().length, 0);
  });

  if (failed) process.exit(1);
  console.log(`browser-pool.test.js: ${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
