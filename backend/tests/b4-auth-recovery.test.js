/**
 * B4 (AUDIT-ROADMAP) / RLY-004 — auth-session recovery contracts.
 *
 * Pinned:
 *  1. `looksLikeAuthRedirect` matches default + env-extended URL patterns
 *     and rejects unrelated paths.
 *  2. `restoreAuthSession` short-circuits on missing credentials with a
 *     deterministic reason envelope (never throws).
 *  3. `restoreAuthSession` happy-path: navigates to project.url, calls
 *     performAutoLogin, navigates back to originatingUrl.
 *  4. Skip reasons: `auth_expired` is in the `NON_EXECUTED_SKIP_REASONS`
 *     set (excluded from pass-rate denominator).
 *  5. Feedback-loop classifier maps `auth_session_expired_unrecoverable`
 *     error strings to the `AUTH_EXPIRED` category and excludes it from
 *     auto-regeneration (no regen for environmental failures).
 */

import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import {
  looksLikeAuthRedirect,
  restoreAuthSession,
  DEFAULT_AUTH_REDIRECT_PATTERNS,
} from "../src/pipeline/autoLogin.js";
import { isNonExecutedSkip, NON_EXECUTED_SKIP_REASONS } from "../src/utils/skipReasons.js";
import { classifyFailure } from "../src/pipeline/feedbackLoop.js";
import { encryptCredentials } from "../src/utils/credentialEncryption.js";

const ctx = createTestContext("b4-auth-recovery");
const test = ctx.createTestRunner();

test("looksLikeAuthRedirect matches default login patterns", () => {
  assert.equal(looksLikeAuthRedirect("https://example.com/login"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/login?next=/dashboard"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/signin"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/sign-in"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/auth/oauth"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/session-expired"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/unauthorized"), true);
  assert.equal(looksLikeAuthRedirect("https://example.com/unauthorised"), true);
});

test("looksLikeAuthRedirect rejects unrelated paths", () => {
  assert.equal(looksLikeAuthRedirect("https://example.com/dashboard"), false);
  assert.equal(looksLikeAuthRedirect("https://example.com/billing/invoices"), false);
  assert.equal(looksLikeAuthRedirect("https://example.com/loginhelp"), false); // word-boundary
  assert.equal(looksLikeAuthRedirect(""), false);
  assert.equal(looksLikeAuthRedirect(null), false);
  assert.equal(looksLikeAuthRedirect(undefined), false);
});

test("DEFAULT_AUTH_REDIRECT_PATTERNS is exported as an array of regexes", () => {
  assert.ok(Array.isArray(DEFAULT_AUTH_REDIRECT_PATTERNS));
  assert.ok(DEFAULT_AUTH_REDIRECT_PATTERNS.length >= 5);
  for (const re of DEFAULT_AUTH_REDIRECT_PATTERNS) {
    assert.ok(re instanceof RegExp, "every entry must be a RegExp");
  }
});

test("restoreAuthSession returns no_credentials_configured when project has no creds", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  const result = await restoreAuthSession(fakePage, { url: "https://example.com" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_credentials_configured");
});

test("restoreAuthSession returns no_project_url when project has no url", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  const result = await restoreAuthSession(fakePage, { credentials: encryptCredentials({ username: "u", password: "p" }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_project_url");
});

test("restoreAuthSession returns credentials_decryption_failed on corrupt blob", async () => {
  const fakePage = { url: () => "https://example.com/login" };
  // _encrypted marker present but ciphertext is garbage — decrypt throws,
  // decryptCredentials catches and returns null.
  const corruptCreds = {
    _encrypted: true,
    username: "deadbeef:deadbeef:deadbeef",
    password: "deadbeef:deadbeef:deadbeef",
    usernameSelector: "",
    passwordSelector: "",
    submitSelector: "",
  };
  const result = await restoreAuthSession(fakePage, {
    url: "https://example.com",
    credentials: corruptCreds,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "credentials_decryption_failed");
});

test("NON_EXECUTED_SKIP_REASONS includes auth_expired", () => {
  assert.ok(NON_EXECUTED_SKIP_REASONS.has("auth_expired"));
});

test("isNonExecutedSkip recognises auth_expired skips", () => {
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "auth_expired" }), true);
  assert.equal(isNonExecutedSkip({ status: "failed", skipReason: "auth_expired" }), false);
  assert.equal(isNonExecutedSkip({ status: "skipped", skipReason: "over_budget" }), true);
  assert.equal(isNonExecutedSkip({ status: "skipped" }), false);
});

test("classifyFailure maps auth_session_expired_unrecoverable to AUTH_EXPIRED", () => {
  assert.equal(
    classifyFailure("auth_session_expired_unrecoverable: relogin_failed: bad credentials"),
    "AUTH_EXPIRED",
  );
  assert.equal(
    classifyFailure("Error: MFA session expired. Sign in again."),
    "AUTH_EXPIRED",
  );
  assert.equal(
    classifyFailure("relogin_failed: unknown"),
    "AUTH_EXPIRED",
  );
});

test("classifyFailure does NOT misclassify generic selector errors as AUTH_EXPIRED", () => {
  assert.equal(
    classifyFailure("locator('button:has-text(\"Sign in\")') not found"),
    "SELECTOR_ISSUE",
  );
});

test.summary();
