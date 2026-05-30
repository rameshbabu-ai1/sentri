/**
 * @module runner/browserPool
 * @description Warm Playwright browser-context pool for test execution.
 */

import { DEFAULT_PARALLEL_WORKERS, launchBrowser, resolveBrowser } from "./config.js";
import {
  browserPoolAcquiresTotal,
  browserPoolInUse,
  browserPoolSize,
} from "../utils/metrics.js";

function parsePoolSize() {
  const raw = process.env.BROWSER_POOL_SIZE || process.env.MAX_WORKERS;
  const parsed = Number.parseInt(raw, 10);
  return Math.max(1, Math.min(50, Number.isFinite(parsed) ? parsed : DEFAULT_PARALLEL_WORKERS));
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function stripPerTestOptions(contextOptions = {}) {
  const { recordVideo: _recordVideo, ...poolableOptions } = contextOptions;
  return poolableOptions;
}

/**
 * @typedef {Object} BrowserPoolLease
 * @property {Object} context - Checked-out Playwright BrowserContext.
 * @property {Object} page - Fresh page created inside the context.
 * @property {Function} release - Idempotent function returning the context to the pool.
 */

/**
 * Maintains a bounded FIFO pool of reusable Playwright contexts.
 */
export class BrowserPool {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.size]
   * @param {Function} [opts.launcher]
   */
  constructor(opts = {}) {
    this.size = Math.max(1, Number.parseInt(opts.size, 10) || parsePoolSize());
    this.launcher = opts.launcher || launchBrowser;
    this.buckets = new Map();
    this.draining = false;
  }

  _bucketKey({ browserType, contextOptions = {}, viewport, locale, timezone } = {}) {
    const { name } = resolveBrowser(browserType);
    const merged = {
      ...stripPerTestOptions(contextOptions),
      ...(viewport ? { viewport } : {}),
      ...(locale ? { locale } : {}),
      ...(timezone ? { timezoneId: timezone } : {}),
    };
    return `${name}:${stableStringify(merged)}`;
  }

  _getBucket(args) {
    const { name } = resolveBrowser(args?.browserType);
    const key = this._bucketKey(args);
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        key,
        type: name,
        browser: null,
        options: stripPerTestOptions(args?.contextOptions || {}),
        idle: [],
        inUse: 0,
        total: 0,
        waiters: [],
      });
      browserPoolSize.set({ type: name }, this.size);
      browserPoolInUse.set({ type: name }, 0);
    }
    return this.buckets.get(key);
  }

  async _ensureBrowser(bucket) {
    if (bucket.browser && (!bucket.browser.isConnected || bucket.browser.isConnected())) return bucket.browser;
    bucket.browser = await this.launcher({ browser: bucket.type });
    return bucket.browser;
  }

  async _createContext(bucket) {
    const browser = await this._ensureBrowser(bucket);
    const context = await browser.newContext(bucket.options);
    bucket.total += 1;
    browserPoolAcquiresTotal.inc({ type: bucket.type, outcome: "miss" });
    return context;
  }

  async _checkout(bucket, context, queued = false) {
    bucket.inUse += 1;
    browserPoolInUse.set({ type: bucket.type }, bucket.inUse);
    if (!queued && bucket.total > 0) browserPoolAcquiresTotal.inc({ type: bucket.type, outcome: "hit" });
    const page = await context.newPage();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await this._release(bucket, context, page);
    };
    context.__sentriPoolRelease = release;
    context.__sentriPooled = true;
    return { context, page, release };
  }

  /**
   * Acquire a warm context, waiting FIFO when all slots for the profile are busy.
   *
   * @param {Object} [args]
   * @param {string} [args.browserType]
   * @param {Object} [args.contextOptions]
   * @param {Object} [args.viewport]
   * @param {string} [args.locale]
   * @param {string} [args.timezone]
   * @returns {Promise<BrowserPoolLease>}
   */
  async acquire(args = {}) {
    if (this.draining) throw new Error("Browser pool is draining");
    const bucket = this._getBucket(args);
    if (bucket.idle.length > 0) {
      return this._checkout(bucket, bucket.idle.shift());
    }
    if (bucket.total < this.size) {
      const context = await this._createContext(bucket);
      return this._checkout(bucket, context, true);
    }
    browserPoolAcquiresTotal.inc({ type: bucket.type, outcome: "queue" });
    return new Promise((resolve, reject) => {
      bucket.waiters.push({ resolve, reject });
    });
  }

  async _release(bucket, context, page) {
    try { await page?.close?.(); } catch { /* best-effort */ }
    try {
      const pages = typeof context.pages === "function" ? context.pages() : [];
      for (const extra of pages) await extra.close?.().catch(() => {});
    } catch { /* best-effort */ }
    try { await context.clearCookies?.(); } catch { /* best-effort */ }
    try { await context.clearPermissions?.(); } catch { /* best-effort */ }
    bucket.inUse = Math.max(0, bucket.inUse - 1);
    browserPoolInUse.set({ type: bucket.type }, bucket.inUse);

    if (this.draining) {
      await context.close?.().catch(() => {});
      bucket.total = Math.max(0, bucket.total - 1);
      return;
    }
    const waiter = bucket.waiters.shift();
    if (waiter) {
      try { waiter.resolve(await this._checkout(bucket, context, true)); }
      catch (err) { waiter.reject(err); }
      return;
    }
    bucket.idle.push(context);
  }

  /**
   * Close all idle and checked-out contexts/browsers and reject queued waiters.
   *
   * @returns {Promise<void>}
   */
  async drainAndClose() {
    this.draining = true;
    const closes = [];
    for (const bucket of this.buckets.values()) {
      while (bucket.waiters.length > 0) bucket.waiters.shift().reject(new Error("Browser pool drained"));
      while (bucket.idle.length > 0) closes.push(bucket.idle.shift().close?.().catch(() => {}));
      if (bucket.browser) closes.push(bucket.browser.close?.().catch(() => {}));
      bucket.inUse = 0;
      bucket.total = 0;
      browserPoolInUse.set({ type: bucket.type }, 0);
    }
    await Promise.allSettled(closes);
    this.buckets.clear();
    this.draining = false;
  }

  /**
   * Return low-cardinality pool stats for telemetry and tests.
   *
   * @returns {Array<{key: string, type: string, size: number, inUse: number, idle: number, queued: number}>}
   */
  getStats() {
    return [...this.buckets.values()].map((bucket) => ({
      key: bucket.key,
      type: bucket.type,
      size: this.size,
      inUse: bucket.inUse,
      idle: bucket.idle.length,
      queued: bucket.waiters.length,
    }));
  }
}

export const browserPool = new BrowserPool();
