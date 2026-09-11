#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ApiError } from "./lib/api.mjs";
import { credentialIdForBatch, parseArgs, readJson, sha256 } from "./lib/common.mjs";
import { calculateBatchIntegrityDigest, calculateSemanticReviewHash, PROMPT_CONTRACT_VERSION, validatePromptBatch, validateSemanticReview } from "./lib/prompts.mjs";
import { createPromptFixture, createTestSemanticReview, createTestImageReview } from "./lib/test-fixtures.mjs";
import { acquireStateLock, getTask, initializeTasks, listTasks, openState, updateTask } from "./lib/state.mjs";
import { loadArtifactTool } from "./lib/workbook.mjs";
import { executeBatch } from "./workflow.mjs";

// Only local mock HTTP and dedicated temporary files are used. The MP4 bytes
// satisfy transport validation; this suite does not assert visual/content QA.
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(144, 3)]);
const settings = { model: "seedance2.5", duration: 30, ratio: "9:16", resolution: "720p", camera_movement: "auto" };
const { options: cliOptions } = parseArgs(["test", ...process.argv.slice(2)]);
const nodeModules = path.resolve(String(cliOptions["node-modules"]));
const tests = [];
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-workflow-regressions-"));
const originalFetch = globalThis.fetch;
let server;
let active;
let baseUrl;
let forbiddenNetworkCalls = 0;

function freshServerState() {
  return { posts: [], uploads: 0, preflight: 0, downloads: 0, polls: 0, jobs: new Map(), createMode: "normal", balanceStatus: 200, pollAuthStatus: 200, failNextJob: false,
    rejectCreateAuth: null, rateLimitCreateAuth: null, rateLimitRemaining: 0, retryAfterSeconds: 0, pollDelayMs: 0, activePolls: 0, maxActivePolls: 0 };
}
function send(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length });
  response.end(body);
}
async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function test(name, fn) {
  await fn();
  tests.push(name);
}
function withState(manifest, fn) {
  const db = openState(manifest.state_db);
  try { return fn(db); } finally { db.close(); }
}
function row(manifest) { return withState(manifest, (db) => getTask(db, manifest.tasks[0].task_key)); }
function elapsedBetweenExecutions(manifest) {
  // Backdate test-only state; test_e2e.mjs covers the real 31-second wall clock.
  withState(manifest, (db) => {
    const prior = new Date(Date.now() - 32_000).toISOString();
    db.prepare("UPDATE events SET created_at = ? WHERE event_type = 'submission_started'").run(prior);
    db.prepare("UPDATE credential_cadence SET last_submission_started_at = ?, last_submission_response_at = ?").run(prior, prior);
    db.prepare("UPDATE submission_cadence SET last_submission_started_at = ?, last_submission_response_at = ?, cooldown_until = NULL WHERE id = 1").run(prior, prior);
  });
}
async function fixture(name, { localImage = true } = {}) {
  const directory = path.join(tmp, name);
  await fs.mkdir(directory, { recursive: true });
  const imageFile = path.join(directory, "product.png");
  if (localImage) await fs.writeFile(imageFile, Buffer.from("approved-local-image"));
  const images = localImage ? [{ type: "local", value: imageFile, sha256: sha256(await fs.readFile(imageFile)) }] : [{ type: "url", value: "https://example.test/tray.png" }];
  const product = { product_id: name, product_name: "Desk Tray", product_info: "A desk tray for small desk items.", claims: [{ id: "C01", text: "Keeps desk items together" }], images, video_count: 1, workbook_row: 2, source_product_id: name };
  const slot = { task_key: `${name}::V001`, product_id: name, variant_no: 1, allowed_claim_ids: ["C01"], diversity_assignment: { persona: "renter", room: "home-office", hook: "confession", demo: "real-use", proof: "visible-mechanism", cta: "low-pressure" } };
  const draft = { schema_version: "1.0", batch_id: `batch-${name}`, products: [product], task_slots: [slot] };
  const promptBatch = { schema_version: "1.0", batch_id: draft.batch_id, tasks: [createPromptFixture(draft, slot)] };
  const review = createTestSemanticReview(draft, promptBatch);
  assert.deepEqual(validatePromptBatch(draft, promptBatch), [], `${name}: fixture structure must pass the current contract`);
  assert.deepEqual(validateSemanticReview(draft, promptBatch, review, { allowTestFixture: true }), [], `${name}: fixture review must pass only with explicit test permission`);
  const reviewFile = path.join(directory, "review.TEST_FIXTURE_ONLY.json");
  const reportFile = path.join(directory, "prompt-validation.json");
  const reviewHash = calculateSemanticReviewHash(review);
  const report = { schema_version: "1.0", batch_id: draft.batch_id, prompt_contract_version: PROMPT_CONTRACT_VERSION, prompt_batch_sha256: sha256(JSON.stringify(promptBatch)), semantic_review_sha256: reviewHash, structure_ok: true, semantic_ok: true, ok: true, errors: [] };
  await fs.writeFile(reviewFile, JSON.stringify(review));
  await fs.writeFile(reportFile, JSON.stringify(report));
  const input = path.join(directory, "products.xlsx");
  const { Workbook, SpreadsheetFile } = loadArtifactTool(nodeModules);
  const book = Workbook.create();
  book.worksheets.add("Products").getRange("A1:F2").values = [
    ["product_id", "product_name", "product_images", "product_info", "selling_points", "video_count"],
    [name, product.product_name, localImage ? imageFile : images[0].value, product.product_info, product.claims[0].text, 1],
  ];
  await (await SpreadsheetFile.exportXlsx(book)).save(input);
  const manifest = { ...draft, stage: "ready", input_workbook: input, product_sheet: "Products", header_row: 1, field_columns: { product_id: 0, product_name: 1, product_images: 2, product_info: 3, selling_points: 4, video_count: 5 }, batch_dir: directory, invalid_rows: [], settings, state_db: path.join(directory, "state.sqlite"), prompt_batch: promptBatch,
    tasks: [{ ...slot, ...promptBatch.tasks[0], product_name: product.product_name, product_info: product.product_info, claims: product.claims, images, output_file: path.join(directory, name, "video-01.mp4") }],
    reference_image_review: createTestImageReview(draft),
    prompt_review: { file: reviewFile, sha256: reviewHash, test_fixture: true }, prompt_validation: { ...report, report_file: reportFile },
  };
  manifest.integrity_digest = calculateBatchIntegrityDigest(manifest);
  const manifestFile = path.join(directory, "batch.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  withState(manifest, (db) => initializeTasks(db, manifest));
  return { manifest, manifestFile, imageFile };
}
async function expandFixture(item, count) {
  const original = item.manifest;
  const product = { ...original.products[0], video_count: count };
  const assignments = [
    { persona: "renter", room: "home-office", hook: "confession", demo: "real-use", proof: "visible-mechanism", cta: "low-pressure" },
    { persona: "busy-parent", room: "living-room", hook: "problem-first", demo: "side-by-side", proof: "lived-result", cta: "save-time" },
    { persona: "remote-worker", room: "dining-area", hook: "surprise", demo: "hands-on", proof: "close-up", cta: "recommendation" },
  ];
  const slots = Array.from({ length: count }, (_, index) => ({
    task_key: `${product.product_id}::V${String(index + 1).padStart(3, "0")}`,
    product_id: product.product_id,
    variant_no: index + 1,
    allowed_claim_ids: ["C01"],
    diversity_assignment: assignments[index % assignments.length],
  }));
  const draft = { schema_version: "1.0", batch_id: original.batch_id, products: [product], task_slots: slots };
  const promptBatch = { schema_version: "1.0", batch_id: draft.batch_id, tasks: slots.map((slot, index) => createPromptFixture(draft, slot, index)) };
  const review = createTestSemanticReview(draft, promptBatch);
  assert.deepEqual(validatePromptBatch(draft, promptBatch), []);
  assert.deepEqual(validateSemanticReview(draft, promptBatch, review, { allowTestFixture: true }), []);
  const reviewHash = calculateSemanticReviewHash(review);
  const report = { schema_version: "1.0", batch_id: draft.batch_id, prompt_contract_version: PROMPT_CONTRACT_VERSION,
    prompt_batch_sha256: sha256(JSON.stringify(promptBatch)), semantic_review_sha256: reviewHash,
    structure_ok: true, semantic_ok: true, ok: true, errors: [] };
  await fs.writeFile(original.prompt_review.file, JSON.stringify(review));
  await fs.writeFile(original.prompt_validation.report_file, JSON.stringify(report));
  const tasks = slots.map((slot, index) => ({
    ...slot,
    ...promptBatch.tasks[index],
    product_name: product.product_name,
    product_info: product.product_info,
    claims: product.claims,
    images: product.images,
    output_file: path.join(original.batch_dir, product.product_id, `video-${String(index + 1).padStart(2, "0")}.mp4`),
  }));
  const manifest = {
    ...original,
    products: [product],
    task_slots: slots,
    prompt_batch: promptBatch,
    tasks,
    reference_image_review: createTestImageReview(draft),
    prompt_review: { file: original.prompt_review.file, sha256: reviewHash, test_fixture: true },
    prompt_validation: { ...report, report_file: original.prompt_validation.report_file },
  };
  manifest.integrity_digest = calculateBatchIntegrityDigest(manifest);
  for (const suffix of ["", "-wal", "-shm"]) await fs.rm(`${manifest.state_db}${suffix}`, { force: true });
  await fs.writeFile(item.manifestFile, JSON.stringify(manifest));
  withState(manifest, (db) => initializeTasks(db, manifest));
  item.manifest = manifest;
  return item;
}
async function run(item, { retryFailed = false, replacementApproval = true, overrides = {} } = {}) {
  const logs = [];
  const oldWrite = process.stdout.write;
  const oldExitCode = process.exitCode;
  process.stdout.write = (chunk) => { logs.push(String(chunk)); return true; };
  try {
    const executeOptions = { "node-modules": nodeModules, "skip-key-check": true, "base-url": baseUrl, "poll-ms": 1, "max-retries": 0, "timeout-ms": 1000, "test-submission-interval-ms": 1, ...overrides };
    if (retryFailed && replacementApproval) executeOptions.approve = item.manifest.integrity_digest || item.manifest.approval_digest;
    await executeBatch(item.manifestFile, item.manifest, executeOptions, { retryFailed });
    return { result: JSON.parse(logs.join("").trim().split(/\r?\n/).at(-1)), logs: logs.join(""), exitCode: process.exitCode || 0 };
  } finally { process.stdout.write = oldWrite; process.exitCode = oldExitCode; }
}

try {
  // A regression in endpoint validation must never make this test reach a
  // production host, even when the test intentionally supplies such a base URL.
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') { forbiddenNetworkCalls += 1; throw new Error("TEST blocked non-loopback network request"); }
    return originalFetch(input, init);
  };
  active = freshServerState();
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/ready") { active.preflight += 1; return send(response, 200, { status: "ready" }); }
      if (url.pathname === "/v1/catalog") return send(response, 200, { models: [{ id: "seedance2.5", durations: [30], resolutions: ["720p"] }], ratios: ["9:16"] });
      if (url.pathname === "/v1/balance") return active.balanceStatus === 200 ? send(response, 200, { balance: 100 }) : send(response, active.balanceStatus, { code: active.balanceStatus === 402 ? "insufficient_balance" : "invalid_api_key", message: "mock authorization blocker" });
      if (url.pathname === "/v1/files") { active.uploads += 1; await requestBody(request); return send(response, 201, { image_id: `image-${active.uploads}`, expires_at: "2099-01-01T00:00:00Z" }); }
      if (url.pathname === "/v1/videos" && request.method === "POST") {
        const key = request.headers["idempotency-key"];
        const auth = request.headers.authorization;
        const body = await requestBody(request);
        active.posts.push({ key, auth, startedAt: Date.now(), body });
        if (active.rejectCreateAuth === auth) return send(response, 401, { code: "invalid_api_key", message: "mock key rejected before acceptance" });
        if (active.rateLimitCreateAuth === auth && active.rateLimitRemaining > 0) {
          active.rateLimitRemaining -= 1;
          response.setHeader("Retry-After", String(active.retryAfterSeconds));
          return send(response, 429, { code: "rate_limited", message: "mock single-key cooldown" });
        }
        if (active.createMode === "reject-422") return send(response, 422, { code: "image_expired", message: "mock input rejection after uncertain earlier acceptance" });
        const existing = active.jobs.get(key);
        if (existing) return send(response, 409, { existing_id: existing.id, status: "queued" });
        const job = { id: `job-${active.jobs.size + 1}`, failed: active.failNextJob };
        active.failNextJob = false;
        active.jobs.set(key, job);
        if (active.createMode === "lose-response") { active.createMode = "normal"; return request.socket.destroy(); }
        return send(response, 202, { id: job.id, status: "queued" });
      }
      if (url.pathname.startsWith("/v1/videos/")) {
        active.polls += 1;
        active.activePolls += 1;
        active.maxActivePolls = Math.max(active.maxActivePolls, active.activePolls);
        if (active.pollDelayMs) await new Promise((resolve) => setTimeout(resolve, active.pollDelayMs));
        active.activePolls -= 1;
        if (active.pollAuthStatus !== 200) return send(response, active.pollAuthStatus, { code: "invalid_api_key", message: "mock expired credential" });
        const id = url.pathname.split("/")[3];
        const job = [...active.jobs.values()].find((entry) => entry.id === id);
        if (job?.failed) return send(response, 200, { id, status: "failed", error: { code: "network_error", message: "provider terminal error with a transport-like code" } });
        return send(response, 200, { id, status: "succeeded", signed_url: "/media/video.mp4" });
      }
      if (url.pathname === "/media/video.mp4") { active.downloads += 1; response.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length }); return response.end(mp4); }
      return send(response, 404, { message: "unknown mock route" });
    } catch (error) { response.destroy(error); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await test("one-key-waits-for-full-lifecycle-before-next-task", async () => {
    const item = await expandFixture(await fixture("single-serial"), 3);
    active = freshServerState();
    active.pollDelayMs = 100;
    const execution = await run(item);
    assert.equal(execution.result.stage, "completed");
    assert.equal(execution.result.parallel_generation, false);
    assert.deepEqual(execution.result.credentials, { configured: 1, available: 1, disabled: 0 });
    assert.equal(active.posts.length, 3);
    assert.deepEqual(new Set(active.posts.map((call) => call.auth)), new Set(["Bearer sk-test-only-1"]));
    assert.equal(active.maxActivePolls, 1, "one key must never overlap video lifecycles");
    const rows = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    assert.equal(new Set(rows.map((task) => task.credential_id)).size, 1);
    assert(rows.every((task) => task.credential_slot === "key-1"));

    const { FileBlob, SpreadsheetFile } = loadArtifactTool(nodeModules);
    const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(item.manifest.input_workbook));
    const taskValues = workbook.worksheets.getItem("AI视频任务").getUsedRange(true).values;
    const workbookText = JSON.stringify(taskValues);
    assert(taskValues[0].includes("api_key_slot"));
    assert(workbookText.includes("key-1"));
    const issuesText = await fs.readFile(execution.result.issues_file, "utf8");
    const manifestText = await fs.readFile(item.manifestFile, "utf8");
    const stateBytes = await fs.readFile(item.manifest.state_db);
    for (const output of [execution.logs, issuesText, manifestText, workbookText]) {
      assert.equal(output.includes("sk-test-only-1"), false);
    }
    assert.equal(stateBytes.includes(Buffer.from("sk-test-only-1")), false);
  });

  await test("three-keys-run-three-lifecycles-concurrently", async () => {
    const item = await expandFixture(await fixture("three-workers"), 3);
    active = freshServerState();
    active.pollDelayMs = 150;
    const execution = await run(item, { overrides: { "test-key-count": 3 } });
    assert.equal(execution.result.stage, "completed");
    assert.equal(execution.result.parallel_generation, true);
    assert.deepEqual(execution.result.credentials, { configured: 3, available: 3, disabled: 0 });
    assert.equal(active.posts.length, 3);
    assert(active.maxActivePolls >= 3, "three credential workers must overlap their independent lifecycles");
    assert.equal(new Set(active.posts.slice(0, 3).map((call) => call.auth)).size, 3);
    const rows = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    assert.equal(new Set(rows.map((task) => task.credential_slot)).size, 3);
  });

  await test("definite-key-rejection-isolated-and-task-reassigned", async () => {
    const item = await expandFixture(await fixture("credential-isolation"), 2);
    active = freshServerState();
    active.rejectCreateAuth = "Bearer sk-test-only-1";
    const execution = await run(item, { overrides: { "test-key-count": 2 } });
    assert.equal(execution.result.stage, "completed");
    assert.deepEqual(execution.result.credentials, { configured: 2, available: 1, disabled: 1 });
    assert.equal(active.posts.length, 3);
    assert.equal(active.posts.filter((post) => post.auth === "Bearer sk-test-only-1").length, 1);
    assert.equal(active.posts.filter((post) => post.auth === "Bearer sk-test-only-2").length, 2);
    const rows = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    assert(rows.every((task) => task.status === "downloaded"));
    assert(rows.every((task) => task.credential_slot === "key-2"));
    assert.deepEqual(execution.result.issues, []);
  });

  await test("single-key-429-retries-before-next-task", async () => {
    const item = await expandFixture(await fixture("single-key-429"), 2);
    active = freshServerState();
    active.rateLimitCreateAuth = "Bearer sk-test-only-1";
    active.rateLimitRemaining = 1;
    const before = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    const firstKey = before[0].idempotency_key;
    const secondKey = before[1].idempotency_key;
    const execution = await run(item, { overrides: { "max-retries": 1 } });
    assert.equal(execution.result.stage, "completed");
    assert.deepEqual(active.posts.map((call) => call.key), [firstKey, firstKey, secondKey]);
    const rows = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    assert.equal(rows.find((task) => task.variant_no === 1).attempts, 2);
    assert.equal(rows.find((task) => task.variant_no === 2).attempts, 1);
  });

  await test("missing-original-key-blocks-only-pinned-job", async () => {
    const item = await fixture("missing-original-key");
    active = freshServerState();
    withState(item.manifest, (db) => updateTask(db, item.manifest.tasks[0].task_key, {
      status: "running",
      job_id: "known-paid-job",
      attempts: 1,
      credential_id: credentialIdForBatch(item.manifest.batch_id, "sk-old-secondary"),
      credential_slot: "key-2",
    }));
    const execution = await run(item);
    assert.equal(execution.result.stage, "blocked");
    const pinned = row(item.manifest);
    assert.equal(pinned.credential_id, credentialIdForBatch(item.manifest.batch_id, "sk-old-secondary"));
    assert.equal(pinned.credential_slot, "key-2");
    assert.equal(pinned.error_code, "credential_missing");
    assert.equal(active.posts.length, 0);
    assert.equal(active.preflight, 0);
  });

  const uncertain = await fixture("uncertain", { localImage: true });
  await test("lost-create-response-resumes-same-idempotency-key-and-frozen-images", async () => {
    active = freshServerState(); active.createMode = "lose-response";
    const first = await run(uncertain);
    assert.equal(first.result.stage, "in_progress");
    assert.equal(first.result.parallel_generation, false, "one credential must keep an uncertain lifecycle isolated");
    const pending = row(uncertain.manifest);
    assert.equal(pending.status, "submission_unknown"); assert.equal(pending.job_id, null);
    assert.equal(active.jobs.size, 1); assert.equal(active.uploads, 1);
    const originalKey = pending.idempotency_key;
    const originalBody = structuredClone(active.posts[0].body);
    assert(pending.submission_images_json);
    await fs.writeFile(uncertain.imageFile, Buffer.from("changed-after-the-original-request-was-sent"));
    uncertain.manifest = await readJson(uncertain.manifestFile);
    elapsedBetweenExecutions(uncertain.manifest);
    const second = await run(uncertain, { retryFailed: true });
    assert.equal(second.result.stage, "completed");
    assert.equal(active.jobs.size, 1, "a retry request must not create a second paid job");
    assert.equal(active.posts.length, 2); assert(active.posts.every((call) => call.key === originalKey));
    assert.deepEqual(active.posts[1].body, originalBody, "recovery must keep original image IDs and payload even if the local source changed");
    assert.equal(active.uploads, 1); assert.equal(row(uncertain.manifest).retry_generation, 0);
  });
  await test("missing-or-mutated-output-resumes-original-job-and-resets-qa", async () => {
    const manifest = uncertain.manifest;
    const output = manifest.tasks[0].output_file;
    const beforePosts = active.posts.length;
    withState(manifest, (db) => updateTask(db, manifest.tasks[0].task_key, { qa_status: "passed", qa_report_file: "prior-report.json", qa_checked_at: "2026-09-05" }));
    await fs.unlink(output);
    const recovered = await run(uncertain);
    assert.equal(recovered.result.stage, "completed"); assert.equal(active.posts.length, beforePosts); assert.equal(row(manifest).qa_status, "pending");
    const altered = Buffer.from(mp4); altered[altered.length - 1] = 99;
    await fs.writeFile(output, altered);
    withState(manifest, (db) => updateTask(db, manifest.tasks[0].task_key, { qa_status: "passed", qa_report_file: "prior-report.json" }));
    await run(uncertain);
    assert.deepEqual(await fs.readFile(output), mp4); assert.equal(row(manifest).qa_status, "pending"); assert.equal(row(manifest).qa_report_file, null);
    const preserved = (await fs.readdir(path.dirname(output))).find((name) => name.includes(".unverified-"));
    assert(preserved); assert.deepEqual(await fs.readFile(path.join(path.dirname(output), preserved)), altered);
    assert.equal(active.posts.length, beforePosts);
    const downloads = active.downloads; await run(uncertain); assert.equal(active.downloads, downloads);
  });
  await test("provider-terminal-failure-alone-authorizes-explicit-new-generation", async () => {
    const item = await fixture("terminal"); active = freshServerState(); active.failNextJob = true;
    await run(item);
    const failed = row(item.manifest);
    assert.equal(failed.status, "failed"); assert.equal(failed.failure_kind, "provider_terminal"); assert.equal(failed.error_code, "network_error");
    await run(item); assert.equal(active.posts.length, 1, "ordinary resume must not replace a terminally failed paid job");
    await assert.rejects(() => run(item, { retryFailed: true, replacementApproval: false }), /new paid replacement requires the exact integrity digest/i);
    assert.equal(active.posts.length, 1, "a paid replacement must remain separately confirmed");
    elapsedBetweenExecutions(item.manifest);
    await run(item, { retryFailed: true });
    assert.equal(active.jobs.size, 2); assert.equal(active.posts.length, 2);
    assert.notEqual(active.posts[0].key, active.posts[1].key); assert.equal(row(item.manifest).retry_generation, 1); assert.equal(row(item.manifest).status, "downloaded");
  });
  for (const status of [401, 402, 403]) await test(`preflight-${status}-recovers-without-new-idempotency-key`, async () => {
    const item = await fixture(`preflight-${status}`); active = freshServerState(); active.balanceStatus = status;
    const key = row(item.manifest).idempotency_key;
    await run(item); assert.equal(row(item.manifest).status, "blocked"); assert.equal(active.posts.length, 0);
    active.balanceStatus = 200;
    await run(item); assert.equal(row(item.manifest).status, "downloaded"); assert.equal(active.posts.length, 1); assert.equal(active.posts[0].key, key);
  });
  await test("existing-job-credential-recovery-remains-get-only", async () => {
    const item = await fixture("existing-auth"); active = freshServerState(); active.pollAuthStatus = 401;
    withState(item.manifest, (db) => updateTask(db, item.manifest.tasks[0].task_key, { status: "running", job_id: "known-paid-job", attempts: 1 }));
    await run(item); assert.equal(row(item.manifest).status, "blocked"); assert.equal(row(item.manifest).job_id, "known-paid-job");
    active.pollAuthStatus = 200;
    await run(item); assert.equal(row(item.manifest).status, "downloaded"); assert.equal(row(item.manifest).credential_slot, "key-1"); assert.equal(active.posts.length, 0); assert.equal(active.preflight, 0);
  });
  await test("frozen-task-image-edit-or-task-removal-is-transactionally-rejected", async () => {
    const item = await fixture("immutable"); active = freshServerState();
    const before = row(item.manifest);
    const changed = structuredClone(item.manifest); changed.tasks[0].images = [{ type: "url", value: "https://example.test/different.png" }];
    withState(item.manifest, (db) => {
      assert.throws(() => initializeTasks(db, changed), /Immutable task request changed/);
      assert.throws(() => initializeTasks(db, { ...item.manifest, tasks: [] }), /Existing task removed/);
      assert.deepEqual(getTask(db, before.task_key), before);
    });
    assert.equal(active.posts.length, 0);
  });
  for (const verdict of ["face_present", "uncertain", "missing"]) await test(`image-${verdict}-is-reported-without-upload`, async () => {
    const item = await fixture(`image-${verdict}`); active = freshServerState();
    if (verdict === "missing") delete item.manifest.reference_image_review;
    else item.manifest.reference_image_review.images[0].verdict = verdict;
    item.manifest.integrity_digest = calculateBatchIntegrityDigest(item.manifest);
    const result = await run(item);
    assert.equal(row(item.manifest).status, "failed");
    assert.equal(active.uploads, 0); assert.equal(active.posts.length, 0);
    assert.equal(result.result.issues[0].failure_kind, "input_preflight");
    assert(result.result.issues[0].error.length > 10);
    assert.deepEqual((await readJson(result.result.issues_file)).issues, result.result.issues);
    await run(item); assert.equal(active.posts.length, 0);
  });
  await test("image-review-edit-invalidates-batch-integrity", async () => {
    const item = await fixture("image-review-tamper"); active = freshServerState();
    item.manifest.reference_image_review.images[0].verdict = "face_present";
    await assert.rejects(() => run(item), /Batch changed after preparation/);
    assert.equal(active.uploads, 0); assert.equal(active.posts.length, 0);
  });
  await test("approved-local-image-mutation-blocks-before-upload-or-create", async () => {
    const item = await fixture("image-changed", { localImage: true }); active = freshServerState();
    await fs.writeFile(item.imageFile, Buffer.from("changed-before-any-request"));
    await run(item);
    assert.equal(row(item.manifest).status, "failed"); assert.equal(row(item.manifest).failure_kind, "input_preflight"); assert.equal(row(item.manifest).error_code, "approval_image_changed");
    assert.equal(active.uploads, 0); assert.equal(active.posts.length, 0);
  });
  await test("integrity-blocked-fresh-task-does-not-prevent-uncertain-create-recovery", async () => {
    const item = await expandFixture(await fixture("mixed-uncertain-recovery"), 2);
    active = freshServerState();
    const before = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    withState(item.manifest, (db) => updateTask(db, before[0].task_key, {
      status: "submission_unknown",
      attempts: 1,
      submission_images_json: JSON.stringify({ image_ids: ["frozen-image"], image_urls: [] }),
    }));
    item.manifest.prompt_validation.prompt_contract_version = "legacy-contract";
    item.manifest.integrity_digest = calculateBatchIntegrityDigest(item.manifest);
    const execution = await run(item);
    const rows = withState(item.manifest, (db) => listTasks(db, item.manifest.batch_id));
    assert.equal(execution.result.stage, "blocked");
    assert.equal(rows[0].status, "downloaded");
    assert.equal(rows[1].status, "blocked");
    assert.equal(rows[1].error_code, "batch_integrity_blocked");
    assert.equal(active.posts.length, 1);
    assert.equal(active.uploads, 0);
  });

  await test("legacy-contract-existing-job-resumes-but-new-submission-is-rejected", async () => {
    const item = await fixture("legacy"); active = freshServerState();
    delete item.manifest.prompt_batch; delete item.manifest.prompt_review; delete item.manifest.task_slots;
    item.manifest.prompt_validation.prompt_contract_version = "legacy-contract";
    item.manifest.integrity_digest = calculateBatchIntegrityDigest(item.manifest);
    const rejected = await run(item);
    assert.equal(rejected.result.stage, "blocked");
    assert.equal(rejected.exitCode, 3);
    assert.equal(row(item.manifest).error_code, "batch_integrity_blocked");
    assert.equal(active.posts.length, 0);
    withState(item.manifest, (db) => updateTask(db, item.manifest.tasks[0].task_key, { status: "running", job_id: "legacy-paid-job", attempts: 1 }));
    await run(item); assert.equal(row(item.manifest).status, "downloaded"); assert.equal(active.posts.length, 0); assert.equal(active.preflight, 0);
  });
  await test("test-review-cannot-run-against-a-production-endpoint", async () => {
    const item = await fixture("test-boundary"); active = freshServerState();
    await assert.rejects(() => run(item, { overrides: { "base-url": "https://vinted.cam" } }), /Test fixture reviews cannot be used for production/);
    await assert.rejects(() => run(item, { overrides: { "base-url": "http://example.test" } }), /Test fixture reviews cannot be used for production/);
    assert.equal(active.posts.length, 0); assert.equal(forbiddenNetworkCalls, 0, "execution must reject test reviews before attempting any non-loopback request");
    const tampered = structuredClone(item.manifest); tampered.tasks[0].prompt_en += "\nChanged after validation.";
    await assert.rejects(() => run({ ...item, manifest: tampered }), /Batch changed after preparation/);
  });
  await test("uncertain-submission-later-422-does-not-rotate-idempotency-key", async () => {
    const item = await fixture("uncertain-rejection"); active = freshServerState(); active.createMode = "lose-response";
    await run(item); assert.equal(row(item.manifest).status, "submission_unknown");
    const key = row(item.manifest).idempotency_key;
    active.createMode = "reject-422";
    elapsedBetweenExecutions(item.manifest);
    await run(item); assert.equal(row(item.manifest).status, "submission_unknown");
    elapsedBetweenExecutions(item.manifest);
    await run(item, { retryFailed: true });
    assert.equal(row(item.manifest).status, "submission_unknown");
    assert.equal(row(item.manifest).idempotency_key, key); assert.equal(row(item.manifest).retry_generation, 0);
    assert.equal(active.jobs.size, 1); assert(active.posts.every((post) => post.key === key));
    active.createMode = "normal"; elapsedBetweenExecutions(item.manifest);
    await run(item); assert.equal(row(item.manifest).status, "downloaded"); assert.equal(active.jobs.size, 1);
  });
  await test("execution-lock-prevents-overlapping-execute-and-releases-after-success", async () => {
    const item = await fixture("locked"); active = freshServerState();
    const release = acquireStateLock(item.manifest.state_db);
    try { await assert.rejects(() => run(item), /Another workflow process/); assert.equal(active.posts.length, 0); }
    finally { release(); }
    await run(item); assert.equal(active.posts.length, 1);
    await assert.rejects(() => fs.stat(`${item.manifest.state_db}.lock`), (error) => error.code === "ENOENT");
    await run(item); assert.equal(active.posts.length, 1);
  });
  console.log(JSON.stringify({ ok: true, tests, non_loopback_requests: forbiddenNetworkCalls }));
} finally {
  globalThis.fetch = originalFetch;
  if (server) { server.close(); await once(server, "close"); }
  await fs.rm(tmp, { recursive: true, force: true });
}
