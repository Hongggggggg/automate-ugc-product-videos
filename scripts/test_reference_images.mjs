#!/usr/bin/env node
// All image verdicts are synthetic fixtures. No actual vision accuracy is asserted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { sha256 } from "./lib/common.mjs";
import { checkReferenceImages } from "./lib/reference-images.mjs";
import { VintedClient } from "./lib/api.mjs";
import { getTask, initializeTasks, listTasks, openState, updateTask } from "./lib/state.mjs";
import { processTask, taskOutcome } from "./workflow.mjs";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-image-gate-"));
const batchId = "image-gate-fixture";
const tests = [];
let db, server;
try {
  const makeImage = async (name, value) => {
    const file = path.join(tmp, name + ".png");
    await fs.writeFile(file, value);
    return { type: "file", value: file, sha256: sha256(value) };
  };
  const clear = await makeImage("clear", "TEST synthetic no-face fixture");
  const face = await makeImage("face", "TEST synthetic face fixture");
  const record = (image, verdict) => ({ sha256: image.sha256, verdict, reviewer: "TEST_FIXTURE_ONLY", reviewed_at: new Date().toISOString(), evidence: "Synthetic visual review record for a controlled test; not actual face detection." });
  const review = { schema_version: "1.0", batch_id: batchId, test_fixture: true, images: [record(clear, "no_face"), record(face, "face_present")] };
  const testOptions = { allowTestFixture: true };
  const rejected = async (images, supplied, code) => assert.rejects(() => checkReferenceImages(images, supplied, batchId, testOptions), error => error.code === code);
  const checked = await checkReferenceImages([clear], review, batchId, testOptions);
  assert.equal(sha256(checked[0].bytes), clear.sha256);
  await rejected([clear, face], review, "reference_face_present");
  await rejected([clear], null, "image_review_missing");
  await rejected([clear], { ...review, batch_id: "wrong" }, "image_review_missing");
  await rejected([clear], { ...review, images: [record(clear, "uncertain")] }, "reference_face_uncertain");
  await rejected([clear], { ...review, images: [record(clear, "no_face"), record(clear, "no_face")] }, "image_review_missing");
  await rejected([{ type: "url", value: "https://example.test/product.png" }], review, "image_local_snapshot_required");
  await assert.rejects(() => checkReferenceImages([clear], review, batchId), e => e.code === "image_review_test_fixture");
  tests.push("hash-bound-local-review", "face-anywhere-in-reference-set", "missing-stale-uncertain-duplicate-review-denied", "remote-reference-denied", "test-review-production-denied");

  await fs.writeFile(clear.value, "changed after review");
  await rejected([clear], review, "approval_image_changed");
  await fs.writeFile(clear.value, checked[0].bytes);
  const unreadable = { ...clear, value: path.join(tmp, "missing.png") };
  await rejected([unreadable], review, "reference_image_unreadable");
  tests.push("changed-and-unreadable-files-denied");

  const uploads = [], posts = [], queries = [];
  const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from("ftypisom"), Buffer.alloc(144, 3)]);
  const send = (res, value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  server = http.createServer(async (req, res) => {
    if (req.url === "/v1/files") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      uploads.push(JSON.parse(Buffer.concat(chunks)));
      return send(res, { image_id: `image-${uploads.length}` });
    }
    if (req.method === "POST" && req.url === "/v1/videos") {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      posts.push(JSON.parse(Buffer.concat(chunks)));
      return send(res, { id: `job-${posts.length}`, status: "queued" });
    }
    if (req.url.startsWith("/v1/videos/")) {
      queries.push(req.url);
      if (req.url.endsWith("/job-1")) return send(res, { status: "failed", error: { code: "face_rejected", message: "Provider fixture failure", request_id: "req-mock-1" } });
      return send(res, { status: "succeeded", signed_url: "/media.mp4" });
    }
    if (req.url === "/media.mp4") { res.writeHead(200, { "content-length": mp4.length }); return res.end(mp4); }
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const client = new VintedClient({ apiKey: "sk-test-only", baseUrl: `http://127.0.0.1:${server.address().port}`, maxRetries: 0, pollMs: 1, isolateRequests: true });
  const tasks = ["a-image-rejected", "b-provider-failed", "c-success"].map((id, i) => ({
    task_key: id + "::V001", product_id: id, product_name: id, variant_no: 1, creative_signature: "test", claim_ids: ["C01"], prompt_en: "TEST ONLY",
    images: i === 0 ? [clear, face] : [clear], output_file: path.join(tmp, id + ".mp4")
  }));
  db = openState(path.join(tmp, "state.sqlite"));
  initializeTasks(db, { batch_id: batchId, tasks });
  const settled = [];
  for (const row of listTasks(db, batchId)) {
    await processTask(db, client, row.task_key, null, { referenceImageReview: review, allowTestImageReview: true, forceFreshUploads: true });
    settled.push({ ...taskOutcome(getTask(db, row.task_key)), uploads: uploads.length, posts: posts.length });
  }
  assert.deepEqual(settled.map(row => row.status), ["failed", "failed", "downloaded"]);
  assert.equal(settled[0].uploads, 0); assert.equal(settled[0].posts, 0);
  assert.equal(settled[0].failure_kind, "input_preflight");
  assert.equal(settled[1].failure_kind, "provider_terminal");
  assert.equal(settled[1].error_code, "face_rejected");
  assert.match(settled[1].error, /Provider fixture failure/); assert.match(settled[1].error, /req-mock-1/);
  assert.equal(uploads.length, 2); assert.equal(posts.length, 2);
  assert(uploads.every(item => sha256(Buffer.from(item.image_b64, "base64")) === clear.sha256));
  assert.deepEqual(await fs.readFile(tasks[2].output_file), mp4);
  await processTask(db, client, tasks[1].task_key);
  assert.equal(posts.length, 2, "normal execution never retries the terminal failure");
  tests.push("whole-set-checked-before-first-upload", "image-rejection-and-provider-failure-continue-to-success", "provider-code-reason-request-id-preserved", "failed-task-not-auto-retried");

  // Legacy already-paid work never needs a new reference upload or new face check.
  const paid = getTask(db, tasks[2].task_key);
  await fs.unlink(paid.output_file);
  await fs.unlink(clear.value);
  await processTask(db, client, paid.task_key);
  assert.equal(getTask(db, paid.task_key).status, "downloaded");
  assert.equal(posts.length, 2); assert.equal(uploads.length, 2);
  tests.push("already-paid-recovery-get-only");

  const legacy = { ...tasks[1], task_key: "d-legacy::V001", product_id: "d-legacy", output_file: path.join(tmp, "legacy.mp4") };
  initializeTasks(db, { batch_id: batchId, tasks: [...tasks, legacy] });
  updateTask(db, legacy.task_key, { attempts: 1, status: "submission_unknown" });
  await processTask(db, client, legacy.task_key);
  assert.equal(getTask(db, legacy.task_key).status, "submission_unknown");
  assert.equal(getTask(db, legacy.task_key).failure_kind, null);
  assert.equal(uploads.length, 2); assert.equal(posts.length, 2);
  tests.push("uncertain-legacy-missing-input-keeps-recovery-state");

  for (const payload of [
    {status:"failed",failure_reason:"top-level failure reason",code:"provider_code"},
    {status:"failed",error:{code:"no_reason"}},
    {status:"failed",failure_reason:{unexpected:"shape"}},
    {status:"failed",error:"string failure reason"}
  ]) {
    client.getVideo = async () => payload;
    await assert.rejects(() => client.pollVideo("fixture"), error => {
      assert(error.terminalJobFailure); assert(!error.message.includes("[object Object]"));
      if(typeof payload.failure_reason === "string") assert.equal(error.message, payload.failure_reason);
      if(payload.error?.code === "no_reason" || typeof payload.failure_reason === "object") assert.match(error.message, /供应商未提供具体失败原因/);
      if(typeof payload.error === "string") assert.equal(error.message, payload.error);
      return true;
    });
  }
  tests.push("provider-failure-reason-shapes");
  console.log(JSON.stringify({ ok: true, count: tests.length, tests }));
} finally {
  db?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const resolved = path.resolve(tmp), allowed = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(allowed) || !path.basename(resolved).startsWith("ugc-image-gate-")) throw new Error("Unsafe test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
