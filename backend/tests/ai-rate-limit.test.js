/**
 * @module tests/ai-rate-limit
 * @description Unit coverage for the MNT-015 per-workspace AI limiter.
 */

import assert from "node:assert/strict";
import { aiRateLimit } from "../src/middleware/aiRateLimit.js";

function createReq({ workspaceId = `ws-${Math.random()}`, method = "POST", role = "qa_lead" } = {}) {
  return { workspaceId, method, userRole: role, path: "/chat" };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function invoke(mw, req) {
  const res = createRes();
  let nextCalled = false;
  let nextErr = null;
  await mw(req, res, (err) => { nextCalled = true; nextErr = err || null; });
  return { res, nextCalled, nextErr };
}

async function main() {
  let passed = 0;
  let failed = 0;
  async function run(name, fn) {
    try { await fn(); passed++; console.log(`  ✅  ${name}`); }
    catch (err) { failed++; console.log(`  ❌  ${name}\n      ${err.stack || err.message}`); }
  }

  await run("cost-weighted requests trip the AI cap", async () => {
    const mw = aiRateLimit({ aiCap: 15, regularCap: 300, windowSec: 60, costFn: () => 10 });
    const workspaceId = `ws-cost-${Date.now()}`;
    let out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.nextCalled, true);
    assert.equal(out.nextErr, null);
    out = await invoke(mw, createReq({ workspaceId }));
    assert.equal(out.res.statusCode, 429);
    assert.equal(out.res.headers["retry-after"], "60");
  });

  await run("sibling workspaces use isolated buckets", async () => {
    const mw = aiRateLimit({ aiCap: 10, regularCap: 300, windowSec: 60, costFn: () => 10 });
    const a = `ws-a-${Date.now()}`;
    const b = `ws-b-${Date.now()}`;
    assert.equal((await invoke(mw, createReq({ workspaceId: a }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId: a }))).res.statusCode, 429);
    assert.equal((await invoke(mw, createReq({ workspaceId: b }))).nextCalled, true);
  });

  await run("regular cost uses the regular cap", async () => {
    const mw = aiRateLimit({ aiCap: 10, regularCap: 2, windowSec: 60, costFn: () => 1 });
    const workspaceId = `ws-regular-${Date.now()}`;
    assert.equal((await invoke(mw, createReq({ workspaceId }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId }))).nextCalled, true);
    assert.equal((await invoke(mw, createReq({ workspaceId }))).res.statusCode, 429);
  });

  await run("bypasses requests without workspace scope", async () => {
    const mw = aiRateLimit({ aiCap: 1, regularCap: 1, costFn: () => 10 });
    const out = await invoke(mw, { method: "POST", path: "/health" });
    assert.equal(out.nextCalled, true);
    assert.equal(out.res.statusCode, 200);
  });

  if (failed) process.exit(1);
  console.log(`ai-rate-limit.test.js: ${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
