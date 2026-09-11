#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs, requireOption, sha256, writeJsonAtomic } from "./lib/common.mjs";
import { CONTENT_CHECKS, inspectVideo, validateContentReview } from "./lib/qa.mjs";
import { getTask, initializeTasks, openState, qaCounts, updateTask } from "./lib/state.mjs";
import { buildDraft, loadArtifactTool } from "./lib/workbook.mjs";

const { options } = parseArgs(["test", ...process.argv.slice(2)]);
const ffprobe = requireOption(options, "ffprobe");
const ffmpeg = requireOption(options, "ffmpeg");
const nodeModules = requireOption(options, "node-modules");
const run = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-qa-regressions-"));
const tests = [];
const lastJson = (stdout) => JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
const encode = (args) => run(ffmpeg, ["-v", "error", "-y", ...args], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
const inspect = (file, label) => inspectVideo({ file, outputDir: path.join(tempRoot, label), ffprobe, ffmpeg });
const mustReject = (review, task, report, batchId, pattern) => {
  const errors = validateContentReview(review, task, report, batchId);
  assert(errors.length > 0, "invalid content review must have validation errors");
  if (pattern) assert(errors.some((error) => pattern.test(error)), JSON.stringify(errors));
};

try {
  const fixture = path.join(tempRoot, "technical-fixture.mp4");
  // This pure-color clip is only a technical fixture. Its sine tone is not speech,
  // and it has no human or product: content QA must remain pending or fail.
  await encode(["-f", "lavfi", "-i", "color=c=navy:s=720x1280:r=24:d=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=30", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "8", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-t", "30", "-shortest", "-movflags", "+faststart", fixture]);
  const inspected = await inspect(fixture, "valid-technical");
  const { report } = inspected;
  assert.equal(report.technical.ok, true, JSON.stringify(report.technical));
  for (const name of ["video", "duration", "dimensions", "frame_rate", "audio", "decode", "frames"]) assert.equal(report.technical.checks[name].ok, true, name);
  assert.equal(report.content.status, "pending", "technical checks must never certify a human or product");
  assert.equal(report.artifact_sha256, sha256(await fs.readFile(fixture)));
  assert.equal(report.representative_frames.length, 11);
  assert.equal(report.representative_frames[0].seconds, 0);
  const last = report.representative_frames.at(-1).seconds;
  assert(Math.abs(last - (report.metadata.duration - 1 / report.metadata.fps)) < 0.01);
  for (let index = 1; index < report.representative_frames.length; index += 1) {
    assert(report.representative_frames[index].seconds - report.representative_frames[index - 1].seconds <= 3.001);
  }
  for (const image of [report.contact_sheet, ...report.representative_frames.map((frame) => frame.file)]) {
    const bytes = await fs.readFile(image);
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  }
  assert.equal(JSON.parse(await fs.readFile(inspected.reportFile, "utf8")).content.status, "pending");
  tests.push("30s-720x1280-24fps-audio-and-complete-decode", "first-last-and-three-second-frames-plus-contact", "technical-pass-leaves-content-pending");

  const silent = path.join(tempRoot, "no-audio.mp4");
  await encode(["-i", fixture, "-map", "0:v:0", "-c", "copy", "-an", silent]);
  const silentReport = (await inspect(silent, "silent")).report;
  assert.equal(silentReport.technical.ok, false);
  assert.equal(silentReport.technical.checks.audio.ok, false);
  assert.equal(silentReport.technical.checks.decode.ok, true);
  tests.push("missing-audio-fails-technical-qa");

  const wrong = path.join(tempRoot, "wrong-specs.mp4");
  await encode(["-i", fixture, "-vf", "scale=320:240", "-r", "25", "-t", "2", "-an", "-c:v", "mpeg4", "-q:v", "8", "-threads", "2", wrong]);
  const wrongReport = (await inspect(wrong, "wrong-specs")).report;
  assert.equal(wrongReport.technical.ok, false);
  for (const name of ["duration", "dimensions", "frame_rate"]) assert.equal(wrongReport.technical.checks[name].ok, false);
  tests.push("wrong-duration-dimensions-and-fps-fail");

  const corrupt = path.join(tempRoot, "not-video.mp4");
  await fs.writeFile(corrupt, "This file is not an MP4 video.");
  const corruptReport = (await inspect(corrupt, "bad-file")).report;
  assert.equal(corruptReport.technical.ok, false);
  assert(corruptReport.technical.errors.length > 0);
  assert.equal(corruptReport.representative_frames.length, 0);
  const truncated = path.join(tempRoot, "truncated.mp4");
  const bytes = await fs.readFile(fixture);
  await fs.writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.75)));
  const truncatedReport = (await inspect(truncated, "truncated")).report;
  assert.equal(truncatedReport.technical.ok, false);
  assert.equal(truncatedReport.technical.checks.decode?.ok, false, JSON.stringify(truncatedReport.technical));
  tests.push("bad-container-fails-with-saved-report", "truncated-media-fails-full-decode");

  const task = { task_key: "FIXTURE::V001" };
  const batchId = "qa-fixture-batch";
  const failedReview = {
    schema_version: "1.0", batch_id: batchId,
    tasks: [{ task_key: task.task_key, artifact_sha256: report.artifact_sha256,
      reviewer: "fixture-regression-reviewer", reviewed_at: new Date().toISOString(), verdict: "failed",
      checks: {
        creator_visibility: { ok: false, notes: "At 0s, 3s, and 29.96s the frames are solid navy; no human face or body is present." },
        product_fidelity: { ok: false, notes: "The entire contact sheet is a solid-color technical fixture with no visible product." },
        prop_fidelity: { ok: false, notes: "The sampled frames contain no product or props, so the intended demonstration is absent." },
        dialogue_audio: { ok: false, notes: "The generated audio is a continuous 440Hz sine tone; it contains no spoken dialogue." },
        home_visual_quality: { ok: false, notes: "The solid-color fixture has no maintained home, everyday background items or natural window-lit phone scene." },
        ai_defects: { ok: true, notes: "The fixture is a uniform solid-color encoding with no generated humans or object geometry to deform." },
      },
      evidence_files: [report.contact_sheet, report.representative_frames[0].file],
    }],
  };
  assert.deepEqual(validateContentReview(failedReview, task, report, batchId), []);
  for (const name of CONTENT_CHECKS) {
    const missing = structuredClone(failedReview); delete missing.tasks[0].checks[name];
    mustReject(missing, task, report, batchId, new RegExp(name));
  }
  const hashMismatch = structuredClone(failedReview); hashMismatch.tasks[0].artifact_sha256 = "0".repeat(64);
  mustReject(hashMismatch, task, report, batchId, /different video bytes/);
  const unknownEvidence = structuredClone(failedReview); unknownEvidence.tasks[0].evidence_files = [path.join(tempRoot, "uninspected.png")];
  mustReject(unknownEvidence, task, report, batchId, /unknown inspection evidence/);
  const noEvidence = structuredClone(failedReview); noEvidence.tasks[0].evidence_files = [];
  mustReject(noEvidence, task, report, batchId, /cite inspected/);
  const vague = structuredClone(failedReview); vague.tasks[0].checks.creator_visibility.notes = "bad";
  mustReject(vague, task, report, batchId, /evidence notes/);
  const noFailure = structuredClone(failedReview);
  for (const check of Object.values(noFailure.tasks[0].checks)) check.ok = true;
  mustReject(noFailure, task, report, batchId, /at least one failed/);
  const falsePass = structuredClone(failedReview); falsePass.tasks[0].verdict = "passed";
  mustReject(falsePass, task, report, batchId, /Passed review has a failed/);
  const duplicateReview = structuredClone(failedReview); duplicateReview.tasks.push(structuredClone(duplicateReview.tasks[0]));
  mustReject(duplicateReview, task, report, batchId, /exactly one record/);
  const noReviewer = structuredClone(failedReview); delete noReviewer.tasks[0].reviewer;
  mustReject(noReviewer, task, report, batchId, /identify the reviewer/);
  const malformedTasks = structuredClone(failedReview); malformedTasks.tasks = {};
  mustReject(malformedTasks, task, report, batchId);
  const nullTask = structuredClone(failedReview); nullTask.tasks = [null];
  mustReject(nullTask, task, report, batchId);
  const extraNullTask = structuredClone(failedReview); extraNullTask.tasks.push(null);
  mustReject(extraNullTask, task, report, batchId);
  const malformedEvidence = structuredClone(failedReview); malformedEvidence.tasks[0].evidence_files = {};
  mustReject(malformedEvidence, task, report, batchId);
  tests.push("truthful-failed-content-review-is-valid", "review-binds-sha-known-evidence-reviewer-and-all-checks", "failed-verdict-requires-failing-check-and-specific-notes", "failed-creator-cannot-be-passed", "malformed-task-and-evidence-shapes-return-validation-errors");

  // Exercise the actual QA command against a local downloaded task. It reuses
  // the verified technical report above and never calls a provider API.
  const { Workbook, SpreadsheetFile } = loadArtifactTool(nodeModules);
  const book = Workbook.create();
  book.worksheets.add("Products").getRange("A1:F2").values = [
    ["product_id", "product_name", "product_images", "product_info", "selling_points", "video_count"],
    ["FIXTURE", "Test tray", "https://example.test/tray.png", "A desk tray.", "Keeps desk items together", 1],
  ];
  const input = path.join(tempRoot, "input.xlsx");
  await (await SpreadsheetFile.exportXlsx(book)).save(input);
  const { draft } = await buildDraft({ input, nodeModules, outputRoot: path.join(tempRoot, "batch") });
  const product = draft.products[0];
  const manifestTask = { ...draft.task_slots[0], product_name: product.product_name, images: product.images,
    creative_signature: "qa-test", claim_ids: ["C01"], prompt_en: "Local QA technical fixture", output_file: fixture };
  const manifest = { ...draft, stage: "completed", tasks: [manifestTask], state_db: path.join(tempRoot, "batch-state.sqlite") };
  const manifestPath = path.join(tempRoot, "manifest.json");
  await writeJsonAtomic(manifestPath, manifest);
  let db = openState(manifest.state_db);
  initializeTasks(db, manifest);
  let state = updateTask(db, manifestTask.task_key, { status: "downloaded", job_id: "local-fixture-only", artifact_sha256: report.artifact_sha256, qa_report_file: inspected.reportFile });
  assert.equal(state.qa_status, "pending");
  assert.deepEqual(qaCounts([state]), { pending: 1, passed: 0, failed: 0 });
  db.close();
  const args = [path.join(scriptDir, "workflow.mjs"), "qa", "--manifest", manifestPath, "--node-modules", nodeModules];
  const pendingRun = lastJson((await run(process.execPath, args, { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(pendingRun.qa_complete, false);
  assert.deepEqual(pendingRun.qa_counts, { pending: 1, passed: 0, failed: 0 });
  const actualReview = structuredClone(failedReview);
  actualReview.batch_id = manifest.batch_id;
  actualReview.tasks[0].task_key = manifestTask.task_key;
  const reviewPath = path.join(tempRoot, "failed-review.json");
  await writeJsonAtomic(reviewPath, actualReview);
  let failedRun;
  try { await run(process.execPath, [...args, "--review", reviewPath], { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); assert.fail("failed content must return a nonzero QA result"); }
  catch (error) { assert.equal(error.code, 5); failedRun = lastJson(error.stdout); }
  assert.equal(failedRun.qa_complete, false);
  assert.deepEqual(failedRun.qa_counts, { pending: 0, passed: 0, failed: 1 });
  db = openState(manifest.state_db);
  state = getTask(db, manifestTask.task_key);
  assert.equal(state.status, "downloaded", "content failure must preserve transport completion");
  assert.equal(state.qa_status, "failed");
  assert.equal(state.artifact_sha256, report.artifact_sha256);
  db.close();
  assert.equal(sha256(await fs.readFile(fixture)), report.artifact_sha256, "QA failure must retain original MP4 bytes");
  tests.push("qa-cli-keeps-technical-fixture-pending-until-reviewed", "qa-cli-persists-content-failure-without-losing-downloaded-file");
  console.log(JSON.stringify({ ok: true, tests }));
} finally {
  const resolved = path.resolve(tempRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("ugc-qa-regressions-")) throw new Error("Unsafe test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
}
