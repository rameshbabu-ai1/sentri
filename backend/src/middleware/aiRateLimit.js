/**
 * @module middleware/aiRateLimit
 * @description Per-workspace, cost-weighted limiter for AI-heavy routes.
 */

import { incrWithExpiry } from "../utils/redisClient.js";
import { aiRateLimitedTotal } from "../utils/metrics.js";

function parsePositiveEnv(name, fallback, min = 1, max = 10000) {
  const value = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Return the default AI-route cost for a request.
 *
 * @param {Object} req
 * @returns {number}
 */
export function defaultAiCost(req) {
  if (req.method === "POST") return 10;
  return 1;
}

/**
 * Build middleware that enforces a per-workspace AI-rate budget.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.costFn]
 * @param {number} [opts.windowSec]
 * @param {number} [opts.aiCap]
 * @param {number} [opts.regularCap]
 * @returns {Function}
 */
export function aiRateLimit(opts = {}) {
  const costFn = opts.costFn || defaultAiCost;
  const windowSec = opts.windowSec || parsePositiveEnv("AI_RATE_LIMIT_WINDOW_SEC", 60, 1, 3600);
  const aiCap = opts.aiCap || parsePositiveEnv("AI_RATE_LIMIT_PER_MIN", 300, 1, 100000);
  const regularCap = opts.regularCap || parsePositiveEnv("AI_RATE_LIMIT_REGULAR_PER_MIN", 300, 1, 100000);

  return async function sentriAiRateLimit(req, res, next) {
    try {
      const workspaceId = req.workspaceId || req.user?.workspaceId;
      if (!workspaceId) return next();
      const cost = Math.max(1, Number.parseInt(costFn(req), 10) || 1);
      const cap = cost > 1 ? aiCap : regularCap;
      const key = `${workspaceId}:ai`;
      const { value, ttl } = await incrWithExpiry(key, cost, windowSec);
      if (value > cap) {
        const role = req.workspaceRole || req.userRole || req.user?.role || "unknown";
        aiRateLimitedTotal.inc({ workspace_role: role });
        res.setHeader("Retry-After", String(ttl));
        return res.status(429).json({ error: "AI rate limit exceeded. Please wait before trying again." });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
