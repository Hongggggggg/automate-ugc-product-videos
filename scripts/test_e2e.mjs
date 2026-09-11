#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { promisify } from "node:util";
import { parseArgs, readJson } from "./lib/common.mjs";
import { isValidMp4 } from "./lib/api.mjs";
import { initializeTasks, listTasks, openState, updateTask } from "./lib/state.mjs";
import { loadArtifactTool } from "./lib/workbook.mjs";
import { PROMPT_CONTRACT_VERSION } from "./lib/prompts.mjs";
import { createPromptFixture, createTestSemanticReview, createTestImageReview } from "./lib/test-fixtures.mjs";

const execFileAsync = promisify(execFile);
const workflow = path.join(path.dirname(fileURLToPath(import.meta.url)), "workflow.mjs");
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(144, 3)]);

function cli(args) {
  return execFileAsync(process.execPath, [workflow, ...args], { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
}

function lastJson(stdout) {
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
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

async function main() {
  const { options } = parseArgs(["test", ...process.argv.slice(2)]);
  const nodeModules = path.resolve(String(options["node-modules"]));
  const python = path.resolve(String(options.python));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-skill-e2e-"));
  let server;
  try {
    const { SpreadsheetFile, Workbook } = loadArtifactTool(nodeModules);
    const referenceImage = path.join(tmp, "reference.png");
    await fs.writeFile(referenceImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("Products");
    sheet.getRange("A1:F2").values = [
      ["product_id", "product_name", "product_images", "product_info", "selling_points", "video_count"],
      ["DEMO", "Desk Tray", referenceImage, "A small tray intended for desk items.", "Keeps desk items together", 2],
    ];
    const input = path.join(tmp, "input.xlsx");
    await (await SpreadsheetFile.exportXlsx(workbook)).save(input);

    const prepareArgs = ["prepare", "--input", input, "--node-modules", nodeModules, "--python", python, "--skip-key-check", "--output-root", path.join(tmp, "batch")];
    const draftSummary = lastJson((await cli(prepareArgs)).stdout);
    assert.equal(draftSummary.stage, "draft");
    const draft = await readJson(draftSummary.draft);
    assert.equal(draft.task_slots.length, 2);
    const tasks = draft.task_slots.map((slot, index) => createPromptFixture(draft, slot, index));
    const promptBatch = { schema_version: "1.0", batch_id: draft.batch_id, tasks };
    const promptFile = path.join(tmp, "prompts.json");
    await fs.writeFile(promptFile, `${JSON.stringify(promptBatch, null, 2)}\n`, "utf8");
    const reviewFile = path.join(tmp, "review.TEST_FIXTURE_ONLY.json");
    await fs.writeFile(reviewFile, JSON.stringify(createTestSemanticReview(draft, promptBatch)), "utf8");
    const validation = lastJson((await cli(["validate-prompts", "--draft", draftSummary.draft, "--prompts", promptFile, "--review", reviewFile, "--allow-test-review"])).stdout);
    assert.equal(validation.ok, true);
    const validationReport = await readJson(validation.validation_report);
    assert.equal(validationReport.ok, true);
    assert.equal(validationReport.errors.length, 0);
    const imageReviewFile = path.join(tmp, "image-review.TEST_FIXTURE_ONLY.json");
    await fs.writeFile(imageReviewFile, JSON.stringify(createTestImageReview(draft)));
    const finalized = lastJson((await cli(["prepare", "--input", input, "--draft", draftSummary.draft, "--prompts", promptFile, "--review", reviewFile, "--image-review", imageReviewFile, "--allow-test-review", "--node-modules", nodeModules, "--python", python, "--skip-key-check"])).stdout);
    const manifest = await readJson(finalized.manifest);
    assert.equal(manifest.prompt_validation.ok, true);
    assert.equal(manifest.prompt_validation.prompt_contract_version, PROMPT_CONTRACT_VERSION);

    const calls = { create: 0, upload: 0, download: 0, signedUrl: 0, preflight: 0, keys: [], bodies: [], createTimes: [], polls: new Map() };
    let allowResumedJobToComplete = false;
    let firstCreatedJobCompleted = false;
    let firstCreatedJobDownloaded = false;
    let secondCreatedAfterFirstDownload = false;
    let failPreflight = false;
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/ready") {
        calls.preflight += 1;
        if (failPreflight) return send(response, 503, { error: "mock preflight unavailable" });
        return send(response, 200, { ready: true });
      }
      if (url.pathname === "/v1/catalog") return send(response, 200, { models: [{ id: "seedance2.5", durations: [30], ratios: ["9:16"], resolutions: ["720p"] }] });
      if (url.pathname === "/v1/balance") return send(response, 200, { balance: 50 });
      if (url.pathname === "/v1/files" && request.method === "POST") {
        await requestBody(request);
        calls.upload += 1;
        return send(response, 201, { image_id: `image-${calls.upload}`, expires_at: "2099-01-01T00:00:00Z" });
      }
      if (url.pathname === "/v1/videos" && request.method === "POST") {
        calls.bodies.push(await requestBody(request));
        calls.create += 1;
        if (calls.create === 2) secondCreatedAfterFirstDownload = firstCreatedJobCompleted && firstCreatedJobDownloaded;
        calls.keys.push(request.headers["idempotency-key"]);
        calls.createTimes.push(Date.now());
        return send(response, 202, { id: `job-created-${calls.create}`, status: "queued" });
      }
      if (url.pathname === "/v1/videos/job-resumed/signed_url") {
        calls.signedUrl += 1;
        return send(response, 200, { url: "/media/job-resumed.mp4" });
      }
      const job = url.pathname.match(/^\/v1\/videos\/(.+)$/)?.[1];
      if (job) {
        if (job === "job-resumed" && !allowResumedJobToComplete) return send(response, 200, { id: job, status: "running" });
        const observed = (calls.polls.get(job) || 0) + 1;
        calls.polls.set(job, observed);
        if (job !== "job-resumed" && observed === 1) return send(response, 200, { id: job, status: "running" });
        if (job === "job-created-1") firstCreatedJobCompleted = true;
        return send(response, 200, job === "job-resumed" ? { id: job, status: "completed" } : { id: job, status: "completed", signed_url: `/media/${job}.mp4` });
      }
      if (/^\/media\/.+\.mp4$/.test(url.pathname)) {
        calls.download += 1;
        if (url.pathname === "/media/job-created-1.mp4") firstCreatedJobDownloaded = true;
        response.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length });
        return response.end(mp4);
      }
      send(response, 404, { error: "not found" });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const executeArgs = ["execute", "--manifest", finalized.manifest, "--node-modules", nodeModules, "--skip-key-check", "--base-url", baseUrl, "--poll-ms", "50", "--max-poll-ms", "35000", "--max-retries", "0"];
    const firstRun = lastJson((await cli(executeArgs)).stdout);
    assert.equal(firstRun.stage, "completed");
    assert.deepEqual(firstRun.counts, { downloaded: 2 });
    assert.deepEqual(firstRun.credentials, { configured: 1, available: 1, disabled: 0 });
    assert.equal(firstRun.parallel_generation, false);
    assert.equal(firstRun.submission_interval_ms, 31_000);
    assert.equal(calls.preflight, 1);
    assert.equal(calls.create, 2);
    assert.equal(calls.upload, 2, "each fresh task must upload the same validated local reference again");
    assert.deepEqual(calls.bodies.map((body) => body.image_ids), [["image-1"], ["image-2"]], "fresh tasks must submit distinct newly uploaded image IDs");
    assert.equal(secondCreatedAfterFirstDownload, true, "the second create must wait for the first job to complete and download");
    const submissionIntervalMs = calls.createTimes[1] - calls.createTimes[0];
    assert(submissionIntervalMs >= 31_000, `video submission starts must be at least 31 seconds apart (observed ${submissionIntervalMs} ms)`);
    assert.equal(calls.download, 2);
    assert.equal(calls.signedUrl, 0);
    const secondRun = lastJson((await cli(executeArgs)).stdout);
    assert.equal(secondRun.stage, "completed");
    assert.equal(calls.preflight, 1, "GET-only resume must not rerun paid-submission preflight");
    assert.equal(calls.create, 2, "a completed rerun must not create paid jobs");
    assert.equal(calls.download, 2, "a completed rerun must not redownload valid MP4s");
    assert.equal(calls.signedUrl, 0);
    allowResumedJobToComplete = true;
    // A fresh-submission gate may fail in a mixed batch. Known paid jobs must
    // still drain with GET only; no original-key recovery POST is allowed here.
    for (const gate of ["outdated_review", "unavailable_preflight"]) {
      const mixed = structuredClone(manifest);
      mixed.state_db = path.join(tmp, gate + ".sqlite");
      const mixedPath = path.join(tmp, gate + ".manifest.json");
      if (gate === "outdated_review") mixed.prompt_validation.prompt_contract_version = "old-contract";
      const mixedDb = openState(mixed.state_db);
      initializeTasks(mixedDb, mixed);
      const mixedRows = listTasks(mixedDb, mixed.batch_id);
      updateTask(mixedDb, mixedRows[0].task_key, { status: "running", job_id: "job-resumed", attempts: 1 });
      mixedDb.close();
      await fs.writeFile(mixedPath, JSON.stringify(mixed));
      failPreflight = gate === "unavailable_preflight";
      const blockedArgs = [...executeArgs];
      blockedArgs[blockedArgs.indexOf("--manifest") + 1] = mixedPath;
      let blockedRun;
      try { await cli(blockedArgs); assert.fail("new submissions must remain blocked"); }
      catch (error) {
        assert.equal(error.code, 3);
        blockedRun = lastJson(error.stdout);
      }
      assert.deepEqual(blockedRun.counts, { downloaded: 1, blocked: 1 });
      assert.equal(calls.create, 2, "gate failures must never allow any POST");
    }
    failPreflight = false;
    assert.equal(calls.signedUrl, 2, "both mixed-batch recoveries must query the existing job URL");
    for (const task of manifest.tasks) assert.equal(await isValidMp4(task.output_file), true);
    const thirdRun = lastJson((await cli(executeArgs)).stdout);
    assert.equal(thirdRun.stage, "completed");
    assert.equal(calls.create, 2, "a completed rerun must not create paid jobs");
    assert.equal(calls.download, 2, "a completed rerun must not redownload valid MP4s");
    process.stdout.write(`${JSON.stringify({ ok: true, submission_interval_ms: submissionIntervalMs, tests: ["prepare-draft", "validate-all-prompts", "Chinese-prompt-contract", "whole-batch-integrity-digest", "single-key-full-lifecycle-serial", "GET-only-resume-skips-submission-preflight", "same-key-submissions-at-least-31-seconds-apart", "signed-url-endpoint", "exact-N-downloads", "rerun-no-new-charge", "rerun-no-redownload"] })}\n`);
  } finally {
    if (server) {
      server.close();
      await once(server, "close");
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
