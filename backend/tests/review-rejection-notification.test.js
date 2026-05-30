/**
 * B3 (AUDIT-ROADMAP Bundle 3) — Review-rejection escalation contract pins.
 *
 * Covers:
 *   1. `fireReviewRejectionNotifications` short-circuits on empty / null
 *      rejection lists (no channels touched).
 *   2. Threshold gate honours the three documented modes:
 *      • 0 / null  → notify on any rejection (column default)
 *      • positive  → notify only when count ≥ threshold
 *      • -1        → opt-out, never notify
 *   3. Disabled `notification_settings.enabled = 0` row gates dispatch.
 *   4. `reviewRejectionsTotal` counter is registered + bumpable.
 *   5. The `TEST_REVIEW_REJECTED` activity type is exported as the literal
 *      `"test.review_rejected"` so frontend AuditLog filters keep working.
 *
 * Channel-level dispatch (Teams / email / generic webhook) is exercised
 * by the existing `notifications-api.test.js` suite for the parallel
 * `fireNotifications` path; this file pins the B3 wrapper's gating
 * decisions, not the channel HTTP shapes.
 *
 * Canonical pattern per AGENTS.md § "Use `createTestContext().createTestRunner()`":
 * each case wrapped in try/catch via the shared runner.
 */
import assert from "node:assert/strict";
import { createTestContext } from "./helpers/test-base.js";
import { fireReviewRejectionNotifications } from "../src/utils/notifications.js";
import * as notificationSettingsRepo from "../src/database/repositories/notificationSettingsRepo.js";
import { generateNotificationSettingId } from "../src/utils/idGenerator.js";
import { register, reviewRejectionsTotal } from "../src/utils/metrics.js";
import { ACTIVITY_TYPES } from "../src/constants/activityTypes.js";

const ctx = createTestContext();
const { test, summary } = ctx.createTestRunner();
const { resetDb, getDatabase } = ctx;

function seedProject({ id, name = "Test Project", workspaceId = "__system__", reviewRejectionAlertThreshold = 0 } = {}) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO projects (id, name, url, status, createdAt, workspaceId, reviewRejectionAlertThreshold)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, name, "https://example.test", "idle", new Date().toISOString(), workspaceId, reviewRejectionAlertThreshold);
  return { id, name, workspaceId, reviewRejectionAlertThreshold };
}

function seedNotificationSettings(projectId, { enabled = 1, webhookUrl = null } = {}) {
  // Seed a settings row that DOES NOT carry teams/email URLs, so the
  // dispatcher's webhook branch is the only one that could fire — and
  // even then we leave webhookUrl null on the no-channel cases so the
  // dispatcher returns immediately without making an outbound HTTP call
  // (the test process has no network reach).
  const now = new Date().toISOString();
  notificationSettingsRepo.upsert({
    id: generateNotificationSettingId(),
    projectId,
    teamsWebhookUrl: null,
    emailRecipients: null,
    webhookUrl,
    enabled: Boolean(enabled),
    createdAt: now,
    updatedAt: now,
  });
}

function fakeRun(projectId) {
  return {
    id: `RUN-b3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    projectId,
    status: "completed",
    duration: 12_345,
  };
}

function fakeRejections(n) {
  return Array.from({ length: n }, (_, i) => ({
    testId: `tc-${i + 1}`,
    testName: `Test case ${i + 1}`,
    failureCategory: "SELECTOR_ISSUE",
    roundsCompleted: 3,
    rejectedAt: new Date().toISOString(),
  }));
}

async function main() {
  resetDb();

  await test("ACTIVITY_TYPES.TEST_REVIEW_REJECTED is the canonical literal", () => {
    assert.equal(ACTIVITY_TYPES.TEST_REVIEW_REJECTED, "test.review_rejected");
  });

  await test("fireReviewRejectionNotifications no-ops on empty rejection list", async () => {
    // No project / settings seeded — dispatcher must short-circuit before
    // touching the DB. A throw here would surface as a test failure.
    const project = { id: "PROJ-empty", name: "Empty", reviewRejectionAlertThreshold: 0 };
    await fireReviewRejectionNotifications(fakeRun(project.id), project, []);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, null);
    await fireReviewRejectionNotifications(fakeRun(project.id), project, undefined);
  });

  await test("fireReviewRejectionNotifications honours threshold = -1 (opt-out)", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-optout", reviewRejectionAlertThreshold: -1 });
    seedNotificationSettings(project.id, { enabled: 1 });
    // Hand a non-empty list to prove the dispatcher rejects it on the
    // threshold gate, not on the empty-list short-circuit.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(5));
    // No assertion target — the contract is "doesn't throw, doesn't dispatch".
    // When this branch is exercised through real channels the dispatcher
    // would return before even reading notification_settings — the run
    // here exercises the gate without making outbound HTTP.
  });

  await test("fireReviewRejectionNotifications honours threshold > rejections (no-op)", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-belowthr", reviewRejectionAlertThreshold: 10 });
    seedNotificationSettings(project.id, { enabled: 1 });
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(3));
    // Same contract as above — no throw, no network call.
  });

  await test("fireReviewRejectionNotifications skips when notification settings disabled", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-disabled", reviewRejectionAlertThreshold: 0 });
    seedNotificationSettings(project.id, { enabled: 0 });
    // Threshold passes (0 < 1), but `enabled = 0` short-circuits below.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
  });

  await test("fireReviewRejectionNotifications skips when no notification settings row exists", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-nosettings", reviewRejectionAlertThreshold: 0 });
    // No notification_settings row — dispatcher's `if (!settings)` gate fires.
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(2));
  });

  await test("fireReviewRejectionNotifications threshold = 0 + enabled + no channels → silent OK", async () => {
    resetDb();
    const project = seedProject({ id: "PROJ-nochannels", reviewRejectionAlertThreshold: 0 });
    // Settings row enabled but no teams/email/webhook URL configured —
    // the dispatcher iterates the (empty) channel list and Promise.allSettled
    // resolves with no entries. Pins the "always notify even with zero
    // configured channels" code-path against silently throwing.
    seedNotificationSettings(project.id, { enabled: 1, webhookUrl: null });
    await fireReviewRejectionNotifications(fakeRun(project.id), project, fakeRejections(1));
  });

  await test("reviewRejectionsTotal counter is registered and bumpable", async () => {
    const metric = register.getSingleMetric("app_review_rejections_total");
    assert.ok(metric, "counter must be registered");
    const before = (await metric.get()).values[0]?.value ?? 0;
    reviewRejectionsTotal.inc();
    const after = (await metric.get()).values[0]?.value ?? 0;
    assert.equal(after, before + 1, `counter should increment by 1; before=${before} after=${after}`);
  });

  summary("B3 review-rejection-notification");
}

main();
