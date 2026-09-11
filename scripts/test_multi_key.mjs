#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiError } from "./lib/api.mjs";
import { credentialIdForBatch, errorMessage, requireVintedKeys } from "./lib/common.mjs";
import {
  ensureCredentialCadence,
  ensureSubmissionCadence,
  getCredentialCadence,
  getTask,
  initializeTasks,
  openState,
  recordSubmissionCadence,
  resetFailedTasks,
  updateTask,
} from "./lib/state.mjs";
import { createSubmissionCoordinator, MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS } from "./workflow.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-multi-key-"));
const inputs = { image_ids: [], image_urls: [] };
const settings = { model: "seedance2.5", duration: 30, ratio: "9:16", resolution: "720p", camera_movement: "auto" };

function manifestFor(stateFile, batchId, count) {
  return {
    batch_id: batchId,
    settings,
    tasks: Array.from({ length: count }, (_, index) => ({
      task_key: `task-${index + 1}`,
      product_id: "p1",
      product_name: "Product",
      variant_no: index + 1,
      creative_signature: `sig-${index + 1}`,
      claim_ids: ["claim-1"],
      prompt_en: `prompt-${index + 1}`,
      images: [],
      output_file: path.join(tmp, `video-${index + 1}.mp4`),
    })),
    state_db: stateFile,
  };
}

const makeWorker = (batchId, key, slot) => ({
  credentialId: credentialIdForBatch(batchId, key),
  slot,
  rateLimited: false,
  rateLimitUntil: 0,
});

try {
  assert.equal(MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS, 31_000);
  const envFile = path.join(tmp, ".env");

  await fs.writeFile(envFile, "VINTED_API_KEY=sk-primary-123\n", "utf8");
  assert.deepEqual((await requireVintedKeys(envFile)).map(({ name, slot }) => ({ name, slot })), [
    { name: "VINTED_API_KEY", slot: "key-1" },
  ]);
  await fs.writeFile(envFile, [
    "VINTED_API_KEY=sk-primary-123",
    "VINTED_API_KEY_7=sk-seventh-789",
    "VINTED_API_KEY_3=sk-third-456",
    "",
  ].join("\n"), "utf8");
  assert.deepEqual((await requireVintedKeys(envFile)).map(({ name, slot }) => ({ name, slot })), [
    { name: "VINTED_API_KEY", slot: "key-1" },
    { name: "VINTED_API_KEY_3", slot: "key-3" },
    { name: "VINTED_API_KEY_7", slot: "key-7" },
  ]);
  await fs.writeFile(envFile, "VINTED_API_KEY=sk-primary-123\nVINTED_API_KEY_2=sk-primary-123\n", "utf8");
  await assert.rejects(() => requireVintedKeys(envFile), /Duplicate API key/);
  await fs.writeFile(envFile, "VINTED_API_KEY=sk-primary-123\nVINTED_API_KEY_1=sk-second-456\n", "utf8");
  await assert.rejects(() => requireVintedKeys(envFile), /Invalid numbered API key/);
  await fs.writeFile(envFile, "VINTED_API_KEY=sk-replace-locally\n", "utf8");
  await assert.rejects(() => requireVintedKeys(envFile), /placeholder/);
  await fs.writeFile(envFile, "VINTED_API_KEY=invalid\n", "utf8");
  await assert.rejects(() => requireVintedKeys(envFile), /malformed/);
  await fs.writeFile(envFile, "SOMETHING_ELSE=value\n", "utf8");
  await assert.rejects(() => requireVintedKeys(envFile), /VINTED_API_KEY is missing/);

  const cadenceFile = path.join(tmp, "cadence.sqlite");
  const manifest = manifestFor(cadenceFile, "cadence-batch", 3);
  let db = openState(cadenceFile);
  initializeTasks(db, manifest);
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const starts = [];
  const worker1 = makeWorker(manifest.batch_id, "sk-primary-123", "key-1");
  const worker2 = makeWorker(manifest.batch_id, "sk-second-456", "key-2");
  const client = {
    maxRetries: 0,
    rateLimited: false,
    rateLimitUntil: 0,
    async createVideoOnce(task) {
      starts.push({ task: task.task_key, at: now });
      return { id: `job-${task.task_key}`, status: "queued" };
    },
  };
  let submit1 = createSubmissionCoordinator(db, worker1, () => null, {
    sleepFn: async (ms) => { now += ms; },
    nowFn: () => now,
  });
  const submit2 = createSubmissionCoordinator(db, worker2, () => null, {
    sleepFn: async (ms) => { now += ms; },
    nowFn: () => now,
  });
  await submit1(getTask(db, "task-1"), inputs, client);
  await submit2(getTask(db, "task-2"), inputs, client);
  assert.equal(starts[0].at, starts[1].at, "different keys may submit at the same time");
  db.close();

  now += 1_000;
  db = openState(cadenceFile);
  submit1 = createSubmissionCoordinator(db, worker1, () => null, {
    sleepFn: async (ms) => { now += ms; },
    nowFn: () => now,
  });
  await submit1(getTask(db, "task-3"), inputs, client);
  assert.equal(starts[2].at - starts[0].at, 31_000, "same-key cadence must survive restart");
  assert.equal(getCredentialCadence(db, worker1.credentialId).last_submission_started_at, new Date(starts[2].at).toISOString());
  db.close();

  const migrationFile = path.join(tmp, "migration.sqlite");
  db = openState(migrationFile);
  recordSubmissionCadence(db, "last_submission_started_at", "2026-09-07T00:00:00.000Z");
  recordSubmissionCadence(db, "last_submission_response_at", "2026-09-07T00:00:01.000Z");
  const global = ensureSubmissionCadence(db);
  const migratedWorker = makeWorker("migration-batch", "sk-primary-123", "key-1");
  const migrated = ensureCredentialCadence(db, migratedWorker.credentialId, global);
  assert.equal(migrated.last_submission_started_at, global.last_submission_started_at);
  assert.equal(migrated.last_submission_response_at, global.last_submission_response_at);
  db.close();

  const throttleFile = path.join(tmp, "throttle.sqlite");
  const throttleManifest = manifestFor(throttleFile, "throttle-batch", 2);
  db = openState(throttleFile);
  initializeTasks(db, throttleManifest);
  now = Date.parse("2032-01-01T00:00:00.000Z");
  const throttled = makeWorker(throttleManifest.batch_id, "sk-one-123", "key-1");
  const healthy = makeWorker(throttleManifest.batch_id, "sk-two-456", "key-2");
  const throttleClient = {
    maxRetries: 1,
    rateLimited: false,
    rateLimitUntil: 0,
    async createVideoOnce() {
      this.rateLimited = true;
      this.rateLimitUntil = now + 5_000;
      throw new ApiError("slow down", { status: 429, code: "rate_limited" });
    },
  };
  await assert.rejects(
    () => createSubmissionCoordinator(db, throttled, () => null, { sleepFn: async () => {}, nowFn: () => now })(getTask(db, "task-1"), inputs, throttleClient),
    (error) => error.retryQueued === true,
  );
  const healthyStarts = [];
  const healthyClient = { maxRetries: 0, rateLimited: false, rateLimitUntil: 0, async createVideoOnce() { healthyStarts.push(now); return { id: "job-healthy" }; } };
  await createSubmissionCoordinator(db, healthy, () => null, { sleepFn: async () => {}, nowFn: () => now })(getTask(db, "task-2"), inputs, healthyClient);
  assert.deepEqual(healthyStarts, [now], "one key's 429 must not cool another key");
  db.close();

  const secret = "sk-secret-never-persisted";
  const secretId = credentialIdForBatch("secret-batch", secret);
  const secretFile = path.join(tmp, "secret.sqlite");
  db = openState(secretFile);
  const secretManifest = manifestFor(secretFile, "secret-batch", 1);
  initializeTasks(db, secretManifest);
  updateTask(db, "task-1", { credential_id: secretId, credential_slot: "key-9" }, "credential_claimed");
  updateTask(db, "task-1", { status: "failed", error_code: "generation_failed", failure_kind: "provider_terminal" });
  assert.equal(resetFailedTasks(db, "secret-batch"), 1);
  assert.equal(getTask(db, "task-1").credential_id, null);
  db.close();
  const sqliteBytes = await fs.readFile(secretFile);
  assert.equal(sqliteBytes.includes(Buffer.from(secret)), false);
  assert.equal(errorMessage(new Error("request used sk-secret.part_123")).includes("sk-secret"), false);

  console.log(JSON.stringify({
    ok: true,
    tests: [
      "single-and-numbered-key-config",
      "numeric-sort-and-gaps",
      "duplicate-placeholder-and-format-validation",
      "per-key-31-second-cadence-across-restart",
      "different-key-simultaneous-submit",
      "global-to-primary-cadence-migration",
      "429-isolated-per-key",
      "raw-key-never-persisted",
    ],
  }));
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
