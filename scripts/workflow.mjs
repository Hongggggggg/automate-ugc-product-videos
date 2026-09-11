#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectVideo, validateContentReview } from "./lib/qa.mjs";
import { credentialIdForBatch, parseArgs, printJson, readJson, requireOption, requireVintedKeys, writeJsonAtomic, errorMessage, nowIso, sanitizeSegment, sha256, sleep, stableStringify } from "./lib/common.mjs";
import { assertWorkbookUnlocked, buildDraft, createBackup, syncWorkbook } from "./lib/workbook.mjs";
import { calculateBatchIntegrityDigest, calculateSemanticReviewHash, PROMPT_CONTRACT_VERSION, validatePromptBatch, validateSemanticReview } from "./lib/prompts.mjs";
import { acquireStateLock, recoverInterruptedTasks, qaCounts, addEvent, ensureCredentialCadence, ensureSubmissionCadence, getCredentialCadence, getTask, getUpload, initializeTasks, listTasks, openState, recordCredentialCadence, resetFailedTasks, saveUpload, statusCounts, updateTask } from "./lib/state.mjs";
import { ApiError, completedVideoUrl, downloadVideo, isValidMp4, sourceHash, VintedClient } from "./lib/api.mjs";
import { runCredentialWorkerPool } from "./lib/scheduler.mjs";
import { checkReferenceImages, referenceImageIssues } from "./lib/reference-images.mjs";

export const MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS = 31_000;

function retryableCreateError(error) {
  return error?.status === 409
    || error?.status === 429
    || error?.status >= 500
    || ["network_error", "timeout", "invalid_json_response", "invalid_create_response"].includes(error?.code);
}

export function createSubmissionCoordinator(db, worker, stopReason = () => null, {
  intervalMs = MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS,
  sleepFn = sleep,
  nowFn = Date.now,
} = {}) {
  let queue = Promise.resolve();
  let fatalError = null;
  const rateLimitRetries = new Map();

  const waitForWindow = async (submissionClient) => {
    while (true) {
      const cadence = ensureCredentialCadence(db, worker.credentialId);
      const latestMs = cadence?.last_submission_started_at ? Date.parse(cadence.last_submission_started_at) : Number.NaN;
      const persistedCooldownMs = cadence?.cooldown_until ? Date.parse(cadence.cooldown_until) : Number.NaN;
      const cadenceUntil = Number.isFinite(latestMs) ? latestMs + intervalMs : 0;
      const remaining = Math.max(
        cadenceUntil,
        Number.isFinite(persistedCooldownMs) ? persistedCooldownMs : 0,
        worker.rateLimitUntil || 0,
        submissionClient.rateLimitUntil || 0,
      ) - nowFn();
      if (remaining <= 0) return;
      await sleepFn(remaining);
      if (fatalError || stopReason()) throw fatalError || stopReason();
    }
  };

  return (task, inputs, submissionClient) => {
    const scheduled = queue.then(async () => {
      if (fatalError || stopReason()) throw fatalError || stopReason();
      let submissionUncertain = task.status === "submission_unknown";
      for (let attempt = 0; attempt <= submissionClient.maxRetries; attempt += 1) {
        await waitForWindow(submissionClient);
        if (fatalError || stopReason()) throw fatalError || stopReason();
        const current = getTask(db, task.task_key);
        const queuedTask = updateTask(db, task.task_key, {
          status: "queued",
          attempts: current.attempts + 1,
          error_code: null,
          error_message: null,
        }, "submission_started");
        recordCredentialCadence(db, worker.credentialId, "last_submission_started_at", new Date(nowFn()).toISOString());
        addEvent(db, task.task_key, "credential_submission_started", { api_key_slot: worker.slot });
        try {
          const created = await submissionClient.createVideoOnce(queuedTask, inputs);
          rateLimitRetries.delete(task.task_key);
          return { task: queuedTask, created };
        } catch (error) {
          const apiError = error instanceof ApiError ? error : new ApiError(errorMessage(error), { code: "local_error" });
          submissionUncertain ||= Boolean(apiError.submissionUncertain);
          apiError.submissionUncertain ||= submissionUncertain;
          worker.rateLimited ||= submissionClient.rateLimited || apiError.status === 429;
          worker.rateLimitUntil = Math.max(worker.rateLimitUntil || 0, submissionClient.rateLimitUntil || 0);
          if (worker.rateLimitUntil > nowFn()) {
            recordCredentialCadence(db, worker.credentialId, "cooldown_until", new Date(worker.rateLimitUntil).toISOString());
          }
          if (apiError.fatal) {
            fatalError = apiError;
            throw apiError;
          }
          if (apiError.status === 429 && !submissionUncertain) {
            const retryCount = (rateLimitRetries.get(task.task_key) || 0) + 1;
            rateLimitRetries.set(task.task_key, retryCount);
            apiError.retryQueued = retryCount <= submissionClient.maxRetries;
            throw apiError;
          }
          if (!retryableCreateError(apiError) || attempt === submissionClient.maxRetries) throw apiError;
        } finally {
          recordCredentialCadence(db, worker.credentialId, "last_submission_response_at", new Date(nowFn()).toISOString());
          addEvent(db, task.task_key, "submission_response_received", { api_key_slot: worker.slot });
        }
      }
      throw new ApiError("Video creation retries exhausted", { code: "create_retries_exhausted", submissionUncertain });
    });
    queue = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  };
}

function help() {
  return `Usage:
  workflow.mjs prepare --input products.xlsx --node-modules PATH --python PATH [--prompts prompts.json] [--image-review image-review.json] [--env-file .env]
  workflow.mjs validate-prompts --draft batch.draft.json --prompts prompts.json [--review prompt-review.json]
  workflow.mjs execute --manifest batch.manifest.json --node-modules PATH [--env-file .env]
    Concurrency equals the number of configured VINTED_API_KEY slots.
    Each Key runs one full task at a time; its POST /v1/videos attempts stay at least 31 seconds apart.
  workflow.mjs qa --manifest batch.manifest.json --node-modules PATH --ffprobe PATH --ffmpeg PATH [--review content-review.json]
  workflow.mjs status --manifest batch.manifest.json --node-modules PATH
  workflow.mjs retry-failed --manifest batch.manifest.json --approve INTEGRITY_DIGEST --node-modules PATH [--env-file .env]
  workflow.mjs retry-content-failed --manifest batch.manifest.json --approve INTEGRITY_DIGEST --node-modules PATH [--env-file .env]
`;
}

function optionPath(options, name, fallback = null) {
  const value = options[name] === true ? null : options[name];
  return value ? path.resolve(String(value)) : fallback;
}

function envPath(options) {
  return optionPath(options, "env-file", path.resolve(".env"));
}

function openLockedState(file) {
  const release = acquireStateLock(file);
  try { return { db: openState(file), release }; }
  catch (error) { release(); throw error; }
}

function assertFixedSettings(settings) {
  const fixed = { model: "seedance2.5", duration: 30, ratio: "9:16", resolution: "720p", camera_movement: "auto", fps_prompt_only: 24 };
  for (const [name, value] of Object.entries(fixed)) {
    if ((settings?.[name] ?? (name === "fps_prompt_only" ? 24 : undefined)) !== value) throw new Error(`Unsupported generation setting ${name}; expected ${value}`);
  }
}

async function ensureKeys(options) {
  if (options["skip-key-check"]) {
    const requestedCount = Number(options["test-key-count"] ?? 1);
    if (!Number.isInteger(requestedCount) || requestedCount < 1) throw new Error("Invalid test API key count");
    return Array.from({ length: requestedCount }, (_, index) => ({
      name: index === 0 ? "VINTED_API_KEY" : `VINTED_API_KEY_${index + 1}`,
      slot: `key-${index + 1}`,
      key: `sk-test-only-${index + 1}`,
    }));
  }
  return requireVintedKeys(envPath(options));
}

async function savePromptFiles(manifest) {
  for (const task of manifest.tasks) {
    const productDir = path.dirname(task.output_file);
    await fs.mkdir(productDir, { recursive: true });
    await fs.writeFile(path.join(productDir, `video-${String(task.variant_no).padStart(2, "0")}.prompt.txt`), `${task.prompt_en}\n`, "utf8");
  }
}

async function validateAndRecordPrompts(draft, promptBatch, promptsPath, { reviewPath = null, allowTestFixture = false } = {}) {
  const review = reviewPath ? await readJson(reviewPath) : null;
  const structureErrors = validatePromptBatch(draft, promptBatch);
  const semanticErrors = validateSemanticReview(draft, promptBatch, review, { allowTestFixture });
  const errors = [...structureErrors, ...semanticErrors];
  const report = {
    schema_version: "1.0", prompt_contract_version: PROMPT_CONTRACT_VERSION,
    batch_id: draft.batch_id, checked_at: nowIso(), prompt_file: path.resolve(promptsPath),
    prompt_batch_sha256: sha256(JSON.stringify(promptBatch)),
    semantic_review_sha256: review ? calculateSemanticReviewHash(review) : null,
    task_count: promptBatch.tasks?.length || 0, structure_ok: structureErrors.length === 0,
    semantic_ok: semanticErrors.length === 0, ok: errors.length === 0, errors,
  };
  const reportPath = path.join(draft.batch_dir, `prompt-validation-${sha256(stableStringify({ promptBatch, review })).slice(0, 16)}.json`);
  await writeJsonAtomic(reportPath, report);
  await writeJsonAtomic(path.join(draft.batch_dir, "prompt-validation.json"), report);
  return { errors, report, reportPath, review };
}

async function commandPrepare(options) {
  const input = requireOption(options, "input");
  const nodeModules = requireOption(options, "node-modules");
  const python = optionPath(options, "python");
  await ensureKeys(options);
  const promptsPath = optionPath(options, "prompts");
  let draft;
  let draftPath = optionPath(options, "draft");
  if (draftPath) {
    draft = await readJson(draftPath);
    if (path.resolve(draft.input_workbook) !== input) throw new Error("--input does not match the draft workbook");
  }
  else {
    const result = await buildDraft({ input, nodeModules, python, outputRoot: optionPath(options, "output-root") });
    draft = result.draft;
    draftPath = result.draftPath;
  }
  assertFixedSettings(draft.settings);
  if (!promptsPath) {
    printJson({
      ok: true,
      stage: "draft",
      batch_id: draft.batch_id,
      draft: draftPath,
      products: draft.products.length,
      videos: draft.task_slots.length,
      invalid_rows: draft.invalid_rows,
      next: "Generate one prompt object for every task_slot using references/prompt-contract.md, save the batch JSON, then rerun prepare with --draft and --prompts.",
    });
    return;
  }
  const promptBatch = await readJson(promptsPath);
  const { errors, report: validationReport, reportPath: validationReportPath, review } = await validateAndRecordPrompts(draft, promptBatch, promptsPath, { reviewPath: optionPath(options, "review"), allowTestFixture: Boolean(options["allow-test-review"]) });
  if (errors.length) {
    printJson({ ok: false, stage: "prompt_validation_failed", batch_id: draft.batch_id, validation_report: validationReportPath, errors });
    process.exitCode = 2;
    return;
  }
  const products = new Map(draft.products.map((product) => [product.product_id, product]));
  const authored = new Map(promptBatch.tasks.map((task) => [task.task_key, task]));
  const tasks = draft.task_slots.map((slot) => {
    const product = products.get(slot.product_id);
    const prompt = authored.get(slot.task_key);
    const productDir = path.join(draft.batch_dir, sanitizeSegment(product.product_id));
    return {
      ...slot,
      creative_plan: prompt.creative_plan,
      fact_bindings: prompt.fact_bindings,
      product_name: product.product_name,
      product_info: product.product_info,
      claims: product.claims,
      images: product.images,
      creative_signature: prompt.creative_signature,
      claim_ids: prompt.claim_ids,
      dialogue_en: prompt.dialogue_en,
      prompt_en: prompt.prompt_en,
      output_file: path.join(productDir, `video-${String(slot.variant_no).padStart(2, "0")}.mp4`),
    };
  });
  const imageReview = options["image-review"] ? await readJson(requireOption(options, "image-review")) : null;
  const imageIssues = await referenceImageIssues(draft.products, imageReview, draft.batch_id, { allowTestFixture: Boolean(options["allow-test-review"]) });
  const manifest = {
    ...(imageReview ? { reference_image_review: imageReview } : {}),
    schema_version: "1.0",
    stage: "ready",
    batch_id: draft.batch_id,
    created_at: draft.created_at,
    prepared_at: nowIso(),
    input_workbook: draft.input_workbook,
    product_sheet: draft.product_sheet,
    header_row: draft.header_row,
    field_columns: draft.field_columns,
    batch_dir: draft.batch_dir,
    settings: draft.settings,
    products: draft.products,
    invalid_rows: draft.invalid_rows,
    tasks,
    task_slots: draft.task_slots,
    prompt_batch: promptBatch,
    prompt_review: { file: optionPath(options, "review"), sha256: calculateSemanticReviewHash(review), test_fixture: review.test_fixture === true },
    state_db: path.join(draft.batch_dir, "batch-state.sqlite"),
    prompt_validation: {
      ok: true,
      prompt_contract_version: validationReport.prompt_contract_version,
      checked_at: validationReport.checked_at,
      prompt_batch_sha256: validationReport.prompt_batch_sha256,
      report_file: validationReportPath,
      structure_ok: true, semantic_ok: true,
    },
  };
  manifest.integrity_digest = calculateBatchIntegrityDigest(manifest);
  const manifestPath = path.join(draft.batch_dir, "batch.manifest.json");
  const { db, release } = openLockedState(manifest.state_db);
  try {
    initializeTasks(db, manifest);
    const prior = await readJson(manifestPath).catch(() => null);
    let priorBackupUsable = false;
    const priorDigest = prior?.integrity_digest || prior?.approval_digest;
    if (prior?.batch_id === manifest.batch_id && priorDigest === manifest.integrity_digest && prior?.backup_file) {
      priorBackupUsable = await fs.access(prior.backup_file).then(() => true).catch(() => false);
    }
    if (priorBackupUsable) {
      manifest.backup_file = prior.backup_file;
    } else {
      await assertWorkbookUnlocked(manifest.input_workbook);
      manifest.backup_file = await createBackup(manifest.input_workbook);
    }
    await savePromptFiles(manifest);
    await writeJsonAtomic(manifestPath, manifest);
    addEvent(db, null, "batch_prepared", { batch_id: manifest.batch_id, integrity_digest: manifest.integrity_digest });
    await syncWorkbook({ manifest, stateRows: listTasks(db, manifest.batch_id), nodeModules, verify: true, createInitialBackup: false });
  } finally {
    db.close(); release();
  }
  printJson({
    ok: true,
    stage: manifest.stage,
    batch_id: manifest.batch_id,
    manifest: manifestPath,
    integrity_digest: manifest.integrity_digest,
    products: manifest.products.length,
    videos: manifest.tasks.length,
    invalid_rows: manifest.invalid_rows,
    prompt_validation: manifest.prompt_validation,
    reference_image_issues: imageIssues,
    samples: manifest.tasks.slice(0, 3).map((task) => ({ task_key: task.task_key, creative_signature: task.creative_signature, prompt: task.prompt_en })),
    next: "Run execute immediately. The validated batch does not require a second user approval.",
  });
}

async function commandValidatePrompts(options) {
  const draft = await readJson(requireOption(options, "draft"));
  const promptsPath = requireOption(options, "prompts");
  const prompts = await readJson(promptsPath);
  const { errors, reportPath, report } = await validateAndRecordPrompts(draft, prompts, promptsPath, { reviewPath: optionPath(options, "review"), allowTestFixture: Boolean(options["allow-test-review"]) });
  printJson({ ok: errors.length === 0, batch_id: draft.batch_id, task_count: prompts.tasks?.length || 0, structure_ok: report.structure_ok, semantic_ok: report.semantic_ok, validation_report: reportPath, errors });
  if (errors.length) process.exitCode = 2;
}

function localMock(options) {
  if (!options["skip-key-check"] || typeof options["base-url"] !== "string") return false;
  try { const url = new URL(options["base-url"]); return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname); } catch { return false; }
}

function storedIntegrityDigest(manifest) {
  return String(manifest.integrity_digest || manifest.approval_digest || "");
}

async function assertBatchIntegrity(manifest, options, { requirePromptReview = true } = {}) {
  const current = calculateBatchIntegrityDigest(manifest);
  if (!storedIntegrityDigest(manifest) || current !== storedIntegrityDigest(manifest)) throw new Error("Batch changed after preparation. Prepare and validate a fresh batch.");
  if ((manifest.prompt_review?.test_fixture || manifest.reference_image_review?.test_fixture) && !localMock(options)) throw new Error("Test fixture reviews cannot be used for production execution");
  if (!requirePromptReview) return;
  assertFixedSettings(manifest.settings);
  const report = await readJson(manifest.prompt_validation?.report_file || "").catch(() => null);
  if (!manifest.prompt_validation?.ok || !report?.ok || report.batch_id !== manifest.batch_id || report.prompt_batch_sha256 !== manifest.prompt_validation.prompt_batch_sha256) throw new Error("A matching successful prompt validation report is required before new paid submissions");
  if (manifest.prompt_validation.prompt_contract_version !== PROMPT_CONTRACT_VERSION || report.prompt_contract_version !== PROMPT_CONTRACT_VERSION) throw new Error("Prompt contract is outdated. Prepare and independently review a fresh batch before new paid submissions; existing jobs can still be resumed.");
  if (!manifest.prompt_batch || !manifest.task_slots || !manifest.prompt_review?.file) throw new Error("Independent semantic review and original prompt inputs are required before new paid submissions");
  const review = await readJson(manifest.prompt_review.file);
  if (calculateSemanticReviewHash(review) !== manifest.prompt_review.sha256 || report.semantic_review_sha256 !== manifest.prompt_review.sha256) throw new Error("Independent semantic review changed after validation");
  if (sha256(JSON.stringify(manifest.prompt_batch)) !== report.prompt_batch_sha256) throw new Error("Prompt batch changed after validation");
  const draft = { batch_id: manifest.batch_id, products: manifest.products, task_slots: manifest.task_slots };
  const errors = [...validatePromptBatch(draft, manifest.prompt_batch), ...validateSemanticReview(draft, manifest.prompt_batch, review, { allowTestFixture: localMock(options) })];
  if (errors.length) throw new Error(`Prompt review no longer passes: ${errors.map((error) => error.message).join("; ")}`);
  const authored = new Map(manifest.prompt_batch.tasks.map((task) => [task.task_key, task]));
  if (authored.size !== manifest.tasks.length) throw new Error("Executable task set does not match the reviewed prompt batch");
  for (const task of manifest.tasks) {
    const prompt = authored.get(task.task_key);
    const product = manifest.products.find((item) => item.product_id === task.product_id);
    if (!prompt || !product || ["prompt_en", "dialogue_en", "creative_signature", "claim_ids", "creative_plan", "fact_bindings"].some((key) => stableStringify(task[key]) !== stableStringify(prompt[key])) || stableStringify(task.images) !== stableStringify(product.images)) throw new Error(`Executable task differs from reviewed inputs: ${task.task_key}`);
  }
}

async function assertReplacementApproval(manifest, options) {
  await assertBatchIntegrity(manifest, options);
  const supplied = options.approve === true ? "" : String(options.approve || "");
  const current = storedIntegrityDigest(manifest);
  if (!supplied || supplied !== current) throw new Error(`A new paid replacement requires the exact integrity digest via --approve. Expected digest: ${current}`);
}

async function imageInputsForTask(db, client, task, { recoverOnly = false, forceFreshUploads = false, checkedImages = [] } = {}) {
  const images = JSON.parse(task.images_json || "[]");
  const imageIds = [];
  const imageUrls = [];
  for (const image of images) {
    if (image.type === "url") {
      imageUrls.push(image.value);
      continue;
    }
    const currentHash = sha256(await fs.readFile(image.value));
    if (image.sha256 && currentHash !== image.sha256) throw new ApiError(`Reviewed local image changed after preparation: ${path.basename(image.value)}`, { code: "approval_image_changed" });
    const hash = sourceHash(image);
    const cached = getUpload(db, hash);
    const valid = cached && (recoverOnly || !cached.expires_at || !Number.isFinite(Date.parse(cached.expires_at)) || Date.parse(cached.expires_at) > Date.now() + 60_000);
    if (valid && !forceFreshUploads) {
      imageIds.push(cached.image_id);
      continue;
    }
    if (recoverOnly) throw new ApiError("Cannot reconstruct the original submitted image IDs. Preserve this task and recover its provider job ID; do not create a replacement.", { code: "submission_payload_missing", fatal: true });
    const checked = checkedImages.find(item => item.image.value === image.value);
    if (!checked) throw new ApiError("Missing checked reference-image bytes", { code: "image_review_missing" });
    const uploaded = await client.uploadImage(image.value, { bytes: checked.bytes });
    saveUpload(db, hash, uploaded.imageId, uploaded.expiresAt);
    imageIds.push(uploaded.imageId);
  }
  if (imageIds.length + imageUrls.length > 9) throw new ApiError("Task contains more than 9 image references", { status: 422, code: "too_many_images" });
  return { image_ids: imageIds, image_urls: imageUrls };
}

async function downloadExistingJob(client, jobId, initialResult, destination, runDownload = (operation) => operation()) {
  let result = initialResult;
  for (let attempt = 0; attempt <= 5; attempt += 1) {
    try {
      let signedUrl = completedVideoUrl(result);
      if (!signedUrl) signedUrl = completedVideoUrl(await client.getSignedUrl(jobId));
      return await runDownload(() => downloadVideo(client, signedUrl, destination));
    } catch (error) {
      const transient = error instanceof ApiError && (error.status >= 500 || ["signed_url_expired", "download_timeout", "download_error", "download_size_mismatch"].includes(error.code));
      if (!transient) throw error;
      if (attempt === 5) throw new ApiError(`Download retries exhausted: ${errorMessage(error)}`, { status: error.status, code: "download_retries_exhausted", requestId: error.requestId });
      await sleep(Math.min(15_000, 1000 * (2 ** attempt)));
      const latest = await client.getVideo(jobId);
      const value = latest?.data && typeof latest.data === "object" ? latest.data : latest;
      const status = String(value?.status || "").toLowerCase();
      result = ["completed", "succeeded", "success", "done"].includes(status) ? value : await client.pollVideo(jobId);
    }
  }
}

export async function processTask(db, client, taskKey, submitNewVideo = null, { onSubmitted = () => {}, runDownload, forceFreshUploads = false, referenceImageReview = null, allowTestImageReview = false } = {}) {
  let task = getTask(db, taskKey);
  let jobId = task.job_id;
  const hadPriorSubmissionAttempt = task.attempts > 0;
  const wasSubmissionUnknown = task.status === "submission_unknown";
  let createStarted = false;
  try {
    if (task.status === "downloaded" && await isValidMp4(task.output_file)) return { task_key: taskKey, status: "downloaded", reused: true };
    if (task.status === "downloaded") task = updateTask(db, taskKey, { status: jobId ? "running" : "failed", error_code: "missing_output", error_message: "Local MP4 is missing or invalid", qa_status: "pending" });
    if (task.status === "failed") return { task_key: taskKey, status: "failed", skipped: true };
    if (!jobId) {
      const checkedImages = hadPriorSubmissionAttempt ? [] : await checkReferenceImages(JSON.parse(task.images_json), referenceImageReview, task.batch_id, { allowTestFixture: allowTestImageReview });
      const inputs = task.submission_images_json ? JSON.parse(task.submission_images_json) : await imageInputsForTask(db, client, task, { recoverOnly: task.attempts > 0, forceFreshUploads, checkedImages });
      task = updateTask(db, taskKey, { submission_images_json: JSON.stringify(inputs) }, "submission_payload_frozen");
      createStarted = true;
      let created;
      if (submitNewVideo) { const submission = await submitNewVideo(task, inputs, client); task = submission.task; created = submission.created; }
      else { task = updateTask(db, taskKey, { status: "queued", attempts: task.attempts + 1, error_code: null, error_message: null }, "submission_started"); created = await client.createVideo(task, inputs); }
      jobId = created.id;
      task = updateTask(db, taskKey, { status: "queued", job_id: jobId }, created.duplicate ? "submission_recovered_from_409" : "submission_accepted");
    }
    onSubmitted(task);
    updateTask(db, taskKey, { status: "running", error_code: null, error_message: null, failure_kind: null }, "polling_started");
    const completed = await client.pollVideo(jobId);
    await downloadExistingJob(client, jobId, completed, task.output_file, runDownload);
    const artifactHash = sha256(await fs.readFile(task.output_file));
    const resetQa = task.artifact_sha256 !== artifactHash;
    updateTask(db, taskKey, { status: "downloaded", error_code: null, error_message: null, failure_kind: null, artifact_sha256: artifactHash,
      ...(resetQa ? { qa_status: "pending", qa_report_file: null, qa_checked_at: null } : {}) }, "download_completed");
    return { task_key: taskKey, status: "downloaded", file: task.output_file, qa_status: resetQa ? "pending" : task.qa_status };
  } catch (error) {
    const apiError = error instanceof ApiError ? error : new ApiError(errorMessage(error), { code: "local_error" });
    if (apiError.retryQueued) {
      updateTask(db, taskKey, {
        status: "queued",
        error_code: apiError.code,
        error_message: errorMessage(apiError),
        failure_kind: null,
      }, "submission_rate_limited");
      throw apiError;
    }
    const definitelyRejected = !apiError.submissionUncertain && [400, 401, 402, 403, 413, 422, 429].includes(apiError.status);
    const rejectedRequest = !jobId && definitelyRejected && !wasSubmissionUnknown;
    const uncertain = !jobId && (apiError.submissionUncertain || wasSubmissionUnknown || ((createStarted || hadPriorSubmissionAttempt) && !rejectedRequest && !apiError.fatal));
    const nextStatus = apiError.fatal ? "blocked" : (jobId ? (apiError.terminalJobFailure ? "failed" : "running") : (uncertain ? "submission_unknown" : "failed"));
    updateTask(db, taskKey, { status: nextStatus, error_code: apiError.code,
      error_message: `${errorMessage(apiError)}${apiError.requestId ? ` [request_id=${apiError.requestId}]` : ""}`,
      failure_kind: apiError.terminalJobFailure ? "provider_terminal" : (rejectedRequest ? "request_rejected" : (!createStarted && !hadPriorSubmissionAttempt && !jobId ? "input_preflight" : null)) }, nextStatus === "failed" ? "task_failed" : "task_waiting_to_resume");
    if (apiError.fatal) throw apiError;
    return { task_key: taskKey, status: nextStatus, error: errorMessage(apiError) };
  }
}

export async function reconcileDownloads(db, batchId) {
  for (const row of listTasks(db, batchId)) {
    if (row.status !== "downloaded") continue;
    const valid = await isValidMp4(row.output_file);
    const hash = valid ? sha256(await fs.readFile(row.output_file)) : null;
    if (!valid || (row.artifact_sha256 && hash !== row.artifact_sha256)) {
      if (await fs.access(row.output_file).then(() => true).catch(() => false)) {
        const quarantine = `${row.output_file}.unverified-${Date.now()}`;
        await fs.rename(row.output_file, quarantine);
        addEvent(db, row.task_key, "unverified_output_preserved", { file: quarantine });
      }
      updateTask(db, row.task_key, { status: row.job_id ? "running" : "failed", error_code: "missing_output", error_message: "Local output missing, invalid, or different from the recorded file; recover the original job", qa_status: "pending", qa_report_file: null, qa_checked_at: null, artifact_sha256: null }, "output_needs_recovery");
    } else if (!row.artifact_sha256) updateTask(db, row.task_key, { artifact_sha256: hash, qa_status: "pending" }, "legacy_output_fingerprinted");
  }
}

async function synchronize(manifest, db, nodeModules, verify = false) {
  await syncWorkbook({ manifest, stateRows: listTasks(db, manifest.batch_id), nodeModules, verify });
}

async function resetContentFailedTasks(db, batchId) {
  const rows = listTasks(db, batchId).filter((row) => row.status === "downloaded" && row.qa_status === "failed");
  for (const row of rows) {
    const output = path.resolve(row.output_file);
    const directory = path.dirname(output);
    const extension = path.extname(output);
    const preserved = path.join(directory, path.basename(output, extension) + ".qa-failed-" + String(row.artifact_sha256 || "unknown").slice(0, 12) + extension);
    if (path.dirname(preserved) !== directory) throw new Error("Refusing to preserve a QA-failed video outside its output directory");
    await fs.access(output);
    await fs.access(preserved).then(
      () => { throw new Error("QA-failed preservation target already exists: " + preserved); },
      (error) => { if (error?.code !== "ENOENT") throw error; },
    );
    await fs.rename(output, preserved);
    const generation = row.retry_generation + 1;
    const key = "ugc-" + sha256(batchId + ":" + row.task_key + ":" + generation).slice(0, 40);
    addEvent(db, row.task_key, "prior_qa_failed_attempt_preserved", {
      job_id: row.job_id,
      artifact_sha256: row.artifact_sha256,
      preserved_file: preserved,
    });
    updateTask(db, row.task_key, {
      status: "ready",
      job_id: null,
      error_code: null,
      error_message: null,
      failure_kind: null,
      attempts: 0,
      retry_generation: generation,
      idempotency_key: key,
      submission_images_json: null,
      credential_id: null,
      credential_slot: null,
      qa_status: "pending",
      qa_report_file: null,
      qa_checked_at: null,
      artifact_sha256: null,
    }, "qa_failed_task_retried");
  }
  return rows.length;
}

export async function executeBatch(manifestPath, manifest, options, { retryFailed = false, retryContentFailed = false } = {}) {
  await assertBatchIntegrity(manifest, options, { requirePromptReview: false });
  const nodeModules = requireOption(options, "node-modules");
  const configuredKeys = await ensureKeys(options);
  if (options["skip-key-check"] && !localMock(options)) throw new Error("--skip-key-check execution is restricted to an explicit loopback mock endpoint");
  let submissionIntervalMs = MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS;
  if (options["test-submission-interval-ms"] !== undefined) {
    if (!localMock(options)) throw new Error("--test-submission-interval-ms is restricted to an explicit loopback mock endpoint");
    submissionIntervalMs = Number(options["test-submission-interval-ms"]);
    if (!Number.isInteger(submissionIntervalMs) || submissionIntervalMs < 0) throw new Error("Invalid test submission interval");
  }
  const clientOptions = {
    baseUrl: typeof options["base-url"] === "string" ? options["base-url"] : undefined,
    pollMs: Number(options["poll-ms"] ?? 4000),
    maxPollMs: Number(options["max-poll-ms"] ?? 0),
    timeoutMs: Number(options["timeout-ms"] ?? 60000),
    maxRetries: Number(options["max-retries"] ?? 5),
  };
  const workers = configuredKeys.map((credential) => ({
    ...credential,
    credentialId: credentialIdForBatch(manifest.batch_id, credential.key),
    disabled: false,
    acceptsFresh: true,
    reserved: false,
    error: null,
    rateLimited: false,
    rateLimitUntil: 0,
  }));
  const primaryWorker = workers[0];
  const { db, release } = openLockedState(manifest.state_db);
  let globalFatal = null;
  const credentialSummary = () => ({
    configured: workers.length,
    available: workers.filter((worker) => worker.acceptsFresh && !worker.disabled).length,
    disabled: workers.filter((worker) => !worker.acceptsFresh || worker.disabled).length,
  });
  const heartbeat = setInterval(() => printJson({
    event: "progress",
    batch_id: manifest.batch_id,
    counts: statusCounts(listTasks(db, manifest.batch_id)),
    credentials: credentialSummary(),
    submission_interval_ms: MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS,
  }), 30000);
  heartbeat.unref();

  const closeClient = async (client) => {
    if (client && typeof client.close === "function") await client.close();
  };
  const useClient = async (worker, operation) => {
    const client = new VintedClient({ ...clientOptions, apiKey: worker.key, isolateRequests: true });
    try {
      return await operation(client);
    } finally {
      worker.rateLimited ||= client.rateLimited;
      worker.rateLimitUntil = Math.max(worker.rateLimitUntil || 0, client.rateLimitUntil || 0);
      await closeClient(client);
    }
  };

  try {
    initializeTasks(db, manifest);
    recoverInterruptedTasks(db, manifest.batch_id);
    await reconcileDownloads(db, manifest.batch_id);
    if (retryFailed) await assertReplacementApproval(manifest, options);
    if (retryFailed) {
      const count = resetFailedTasks(db, manifest.batch_id);
      addEvent(db, null, "retry_failed_requested", { count });
    }
    if (retryContentFailed) await assertReplacementApproval(manifest, options);
    if (retryContentFailed) {
      const count = await resetContentFailedTasks(db, manifest.batch_id);
      addEvent(db, null, "retry_content_failed_requested", { count });
    }

    const globalCadence = ensureSubmissionCadence(db);
    for (const [index, worker] of workers.entries()) {
      ensureCredentialCadence(db, worker.credentialId, index === 0 ? globalCadence : {});
    }

    const fresh = (row) => !row.job_id && row.attempts === 0
      && ["ready", "awaiting_approval", "queued", "running", "blocked"].includes(row.status);
    const active = (row) => ["ready", "awaiting_approval", "queued", "submission_unknown", "running", "blocked"].includes(row.status);
    const workerById = new Map(workers.map((worker) => [worker.credentialId, worker]));

    for (const row of listTasks(db, manifest.batch_id)) {
      if (!active(row)) continue;
      if (fresh(row)) {
        if (row.credential_id || row.credential_slot) {
          updateTask(db, row.task_key, { credential_id: null, credential_slot: null }, "fresh_task_credential_released");
        }
        continue;
      }
      if (!row.credential_id) {
        updateTask(db, row.task_key, {
          credential_id: primaryWorker.credentialId,
          credential_slot: primaryWorker.slot,
        }, "legacy_task_bound_to_primary_credential");
        continue;
      }
      const originalWorker = workerById.get(row.credential_id);
      if (originalWorker && row.credential_slot !== originalWorker.slot) {
        updateTask(db, row.task_key, { credential_slot: originalWorker.slot }, "credential_slot_refreshed");
      }
    }

    const needsNewSubmission = listTasks(db, manifest.batch_id).some(fresh);
    if (needsNewSubmission) {
      try {
        await assertBatchIntegrity(manifest, options);
      } catch (error) {
        globalFatal = new ApiError(errorMessage(error), { code: "batch_integrity_blocked", fatal: true });
      }
    }

    const skipPreflight = Boolean(options["skip-preflight"] && localMock(options));
    if (needsNewSubmission && !globalFatal && !skipPreflight) {
      try {
        await useClient(primaryWorker, (client) => client.preflightCatalog());
      } catch (error) {
        globalFatal = error instanceof ApiError && error.fatal
          ? error
          : new ApiError(errorMessage(error), { code: "preflight_unavailable", fatal: true });
      }
    }

    if (needsNewSubmission && !globalFatal && !skipPreflight) {
      await Promise.all(workers.map(async (worker) => {
        try {
          await useClient(worker, (client) => client.preflightCredential());
        } catch (error) {
          worker.acceptsFresh = false;
          worker.error = error instanceof ApiError
            ? error
            : new ApiError(errorMessage(error), { code: "credential_preflight_unavailable", fatal: true });
          addEvent(db, null, "credential_disabled", {
            api_key_slot: worker.slot,
            code: worker.error.code,
            error: errorMessage(worker.error),
          });
        }
      }));
    }

    if (globalFatal) {
      for (const row of listTasks(db, manifest.batch_id).filter(fresh)) {
        updateTask(db, row.task_key, {
          status: "blocked",
          error_code: globalFatal.code,
          error_message: `New submissions stopped: ${errorMessage(globalFatal)}`,
        }, "preflight_blocked");
      }
      printJson({
        event: "new_submissions_stopped",
        batch_id: manifest.batch_id,
        code: globalFatal.code,
        error: errorMessage(globalFatal),
      });
    }

    for (const worker of workers) {
      worker.submitNewVideo = createSubmissionCoordinator(db, worker, () => null, { intervalMs: submissionIntervalMs });
    }

    let syncTail = Promise.resolve();
    let syncError = null;
    const syncProgress = () => {
      syncTail = syncTail.then(() => synchronize(manifest, db, nodeModules, false)).catch((error) => {
        syncError ||= error;
      });
    };

    const currentRows = listTasks(db, manifest.batch_id);
    const actionable = [
      ...currentRows.filter((row) => row.job_id && ["queued", "running", "blocked"].includes(row.status)),
      ...currentRows.filter((row) => !row.job_id && row.attempts > 0 && ["queued", "submission_unknown", "running", "blocked"].includes(row.status)),
      ...currentRows.filter((row) => !row.job_id && row.attempts === 0 && !globalFatal && fresh(row)),
    ];

    try {
      addEvent(db, null, "credential_worker_pool_started", {
        configured_keys: workers.length,
        submission_interval_ms: MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS,
      });
      const pipelineResult = await runCredentialWorkerPool(actionable, workers, {
        canClaim: (worker, row) => Boolean(row) && !globalFatal && worker.acceptsFresh && !worker.disabled && !worker.reserved,
        process: async (worker, row) => {
          let current = getTask(db, row.task_key);
          if (!current.credential_id) {
            current = updateTask(db, row.task_key, {
              credential_id: worker.credentialId,
              credential_slot: worker.slot,
            }, "credential_claimed");
          } else if (current.credential_id !== worker.credentialId) {
            throw new Error(`Task ${row.task_key} was claimed by the wrong credential worker`);
          }
          const taskClient = new VintedClient({ ...clientOptions, apiKey: worker.key, isolateRequests: true });
          try {
            return await processTask(db, taskClient, row.task_key, worker.submitNewVideo, {
              referenceImageReview: manifest.reference_image_review,
              allowTestImageReview: localMock(options),
              forceFreshUploads: !current.job_id && current.attempts === 0,
              onSubmitted: () => {
                printJson({
                  event: "task_polling",
                  task_key: row.task_key,
                  batch_id: manifest.batch_id,
                  api_key_slot: worker.slot,
                  counts: statusCounts(listTasks(db, manifest.batch_id)),
                });
                syncProgress();
              },
            });
          } finally {
            worker.rateLimited ||= taskClient.rateLimited;
            worker.rateLimitUntil = Math.max(worker.rateLimitUntil || 0, taskClient.rateLimitUntil || 0);
            if (worker.rateLimitUntil > Date.now()) {
              recordCredentialCadence(db, worker.credentialId, "cooldown_until", new Date(worker.rateLimitUntil).toISOString());
            }
            await closeClient(taskClient);
            addEvent(db, row.task_key, "task_connections_closed", { api_key_slot: worker.slot });
          }
        },
        onSettled: (worker, row, outcome) => {
          let settled = getTask(db, row.task_key);
          const reason = outcome.status === "rejected" ? outcome.reason : null;
          const directive = {};
          if (reason?.retryQueued) {
            const cadence = getCredentialCadence(db, worker.credentialId);
            printJson({
              event: "submission_rate_limited",
              task_key: row.task_key,
              batch_id: manifest.batch_id,
              api_key_slot: worker.slot,
              code: reason.code,
              error: errorMessage(reason),
              retry_after: cadence?.cooldown_until || null,
            });
            directive.requeueSameWorker = true;
            directive.row = settled;
            directive.handledError = true;
          } else if (reason && [401, 402, 403].includes(reason.status)) {
            worker.error = reason;
            worker.acceptsFresh = false;
            directive.disableWorker = true;
            directive.handledError = true;
            const safeToReassign = !settled.job_id && !reason.submissionUncertain;
            if (safeToReassign) {
              settled = updateTask(db, row.task_key, {
                status: "ready",
                error_code: null,
                error_message: null,
                failure_kind: null,
                attempts: 0,
                submission_images_json: null,
                credential_id: null,
                credential_slot: null,
              }, "credential_rejected_task_requeued");
              directive.requeueFresh = true;
              directive.row = settled;
            }
            addEvent(db, row.task_key, "credential_disabled", {
              api_key_slot: worker.slot,
              code: reason.code,
              error: errorMessage(reason),
              task_requeued: safeToReassign,
            });
          } else if (reason?.fatal) {
            directive.reserveWorker = true;
            directive.handledError = true;
          }
          if (!directive.requeueSameWorker && !directive.requeueFresh && !directive.disableWorker
            && ["queued", "submission_unknown", "running", "blocked"].includes(settled.status)) {
            directive.reserveWorker = true;
          }
          printJson({
            event: "task_settled",
            ...taskOutcome(settled),
            batch_id: manifest.batch_id,
            counts: statusCounts(listTasks(db, manifest.batch_id)),
          });
          syncProgress();
          return directive;
        },
      });

      const allUnavailable = workers.every((worker) => !worker.acceptsFresh || worker.disabled);
      if (allUnavailable && pipelineResult.unclaimed.some((row) => !row.credential_id)) {
        globalFatal ||= new ApiError("All configured API keys are unavailable", { code: "all_credentials_unavailable", fatal: true });
      }
      for (const row of pipelineResult.unclaimed) {
        const assigned = row.credential_id ? workerById.get(row.credential_id) : null;
        let blocker;
        if (row.credential_id && !assigned) {
          blocker = new ApiError("The API key originally assigned to this submitted task is not configured", { code: "credential_missing", fatal: true });
        } else if (assigned?.disabled) {
          blocker = assigned.error || new ApiError("The assigned API key is unavailable", { code: "credential_unavailable", fatal: true });
        } else if (assigned?.reserved) {
          blocker = new ApiError("The assigned API key is reserved by an unfinished task", { code: "credential_reserved", fatal: true });
        } else {
          blocker = globalFatal || new ApiError("No healthy API key worker is available", { code: "credential_unavailable", fatal: true });
        }
        updateTask(db, row.task_key, {
          status: "blocked",
          error_code: blocker.code,
          error_message: `New submissions stopped: ${errorMessage(blocker)}`,
        }, "submission_blocked");
      }
    } finally {
      await syncTail;
    }
    if (syncError) throw syncError;

    const rows = listTasks(db, manifest.batch_id);
    const counts = statusCounts(rows);
    const credentials = credentialSummary();
    const hasActiveTasks = rows.some((row) => ["ready", "awaiting_approval", "queued", "submission_unknown", "running"].includes(row.status));
    manifest.stage = rows.every((row) => row.status === "downloaded")
      ? "completed"
      : (globalFatal || counts.blocked ? "blocked" : (hasActiveTasks ? "in_progress" : "executed_with_errors"));
    manifest.qa_counts = qaCounts(rows);
    manifest.qa_complete = rows.length > 0 && rows.every((row) => row.qa_status === "passed");
    manifest.updated_at = nowIso();
    await writeJsonAtomic(manifestPath, manifest);
    await synchronize(manifest, db, nodeModules, true);
    const issues = rows.filter((row) => row.status !== "downloaded").map(taskOutcome);
    const issuesFile = path.join(manifest.batch_dir, "task-issues.json");
    await writeJsonAtomic(issuesFile, { batch_id: manifest.batch_id, updated_at: nowIso(), credentials, issues });
    printJson({
      ok: !globalFatal && !counts.failed && !counts.blocked,
      issues,
      issues_file: issuesFile,
      batch_id: manifest.batch_id,
      stage: manifest.stage,
      counts,
      qa_counts: manifest.qa_counts,
      qa_complete: manifest.qa_complete,
      output_directory: manifest.batch_dir,
      credentials,
      parallel_generation: workers.length > 1,
      submission_interval_ms: MIN_NEW_VIDEO_SUBMISSION_INTERVAL_MS,
      rate_limited: workers.some((worker) => worker.rateLimited),
      fatal_error: globalFatal ? errorMessage(globalFatal) : null,
    });
    if (globalFatal) process.exitCode = 3;
    else if (counts.failed || counts.blocked) process.exitCode = 4;
  } finally {
    clearInterval(heartbeat);
    db.close();
    release();
  }
}

async function commandExecute(options, retryFailed = false, retryContentFailed = false) {
  const manifestPath = requireOption(options, "manifest");
  const manifest = await readJson(manifestPath);
  await executeBatch(manifestPath, manifest, options, { retryFailed, retryContentFailed });
}

export function taskOutcome(row) {
  return { task_key: row.task_key, product_id: row.product_id, product_name: row.product_name, variant_no: row.variant_no, status: row.status, api_key_slot: row.credential_slot || null, job_id: row.job_id, error_code: row.error_code, failure_kind: row.failure_kind, error: row.error_message ? errorMessage(row.error_message) : (row.status === "failed" ? "供应商未提供具体失败原因" : null) };
}

async function commandStatus(options) {
  const manifestPath = requireOption(options, "manifest");
  const manifest = await readJson(manifestPath);
  const nodeModules = requireOption(options, "node-modules");
  const { db, release } = openLockedState(manifest.state_db);
  try {
    initializeTasks(db, manifest);
    await reconcileDownloads(db, manifest.batch_id);
    const rows = listTasks(db, manifest.batch_id);
    if (manifest.stage === "completed" && rows.some((row) => row.status !== "downloaded")) manifest.stage = "in_progress";
    manifest.qa_counts = qaCounts(rows); manifest.qa_complete = rows.length > 0 && rows.every((row) => row.qa_status === "passed");
    await writeJsonAtomic(manifestPath, manifest);
    await synchronize(manifest, db, nodeModules, false);
    printJson({ ok: true, batch_id: manifest.batch_id, stage: manifest.stage, integrity_digest: storedIntegrityDigest(manifest), counts: statusCounts(rows), qa_counts: manifest.qa_counts, qa_complete: manifest.qa_complete,
      tasks: rows.map((row) => ({ ...taskOutcome(row), output_file: row.output_file, qa_status: row.qa_status, qa_report_file: row.qa_report_file })) });
  } finally { db.close(); release(); }
}

async function commandQa(options) {
  const manifestPath = requireOption(options, "manifest");
  const manifest = await readJson(manifestPath);
  const nodeModules = requireOption(options, "node-modules");
  const review = options.review ? await readJson(requireOption(options, "review")) : null;
  if (review && (!Array.isArray(review.tasks) || review.tasks.some((item) => !item || typeof item !== "object" || Array.isArray(item)) || review.batch_id !== manifest.batch_id || new Set(review.tasks.map((item) => item.task_key)).size !== review.tasks.length || review.tasks.some((item) => !manifest.tasks.some((task) => task.task_key === item.task_key)))) throw new Error("QA review has an invalid batch or task set");
  const { db, release } = openLockedState(manifest.state_db);
  try {
    initializeTasks(db, manifest);
    await reconcileDownloads(db, manifest.batch_id);
    const downloaded = listTasks(db, manifest.batch_id).filter((row) => row.status === "downloaded");
    if (review && review.tasks.some((item) => !downloaded.some((row) => row.task_key === item.task_key))) throw new Error("QA review refers to an unavailable video; recover the original job first");
    for (const task of downloaded) {
      const hash = sha256(await fs.readFile(task.output_file));
      let report = task.qa_report_file ? await readJson(task.qa_report_file).catch(() => null) : null;
      let reportFile = task.qa_report_file;
      if (!report || report.artifact_sha256 !== hash || options["refresh-technical"]) {
        const result = await inspectVideo({ file: task.output_file, outputDir: path.join(manifest.batch_dir, "qa", sha256(task.task_key).slice(0, 16), hash.slice(0, 16)), ffprobe: optionPath(options, "ffprobe"), ffmpeg: optionPath(options, "ffmpeg"), expected: manifest.settings });
        report = result.report; reportFile = result.reportFile;
      }
      const entry = review?.tasks.find((item) => item.task_key === task.task_key);
      if (entry) {
        const errors = validateContentReview(review, task, report, manifest.batch_id);
        if (errors.length) throw new Error(`Invalid QA review for ${task.task_key}: ${errors.join("; ")}`);
        for (const evidence of entry.evidence_files) await fs.access(evidence);
        report.content = { status: entry.verdict, review: entry };
        await writeJsonAtomic(reportFile, report);
      }
      const status = !report.technical.ok || report.content.status === "failed" ? "failed" : (report.content.status === "passed" ? "passed" : "pending");
      updateTask(db, task.task_key, { qa_status: status, qa_report_file: reportFile, qa_checked_at: nowIso(), artifact_sha256: hash }, "qa_recorded");
    }
    const rows = listTasks(db, manifest.batch_id);
    manifest.qa_counts = qaCounts(rows); manifest.qa_complete = rows.length > 0 && rows.every((row) => row.qa_status === "passed");
    if (manifest.stage === "completed" && rows.some((row) => row.status !== "downloaded")) manifest.stage = "in_progress";
    await writeJsonAtomic(manifestPath, manifest);
    await synchronize(manifest, db, nodeModules, false);
    printJson({ ok: manifest.qa_counts.failed === 0, stage: manifest.stage, qa_counts: manifest.qa_counts, qa_complete: manifest.qa_complete,
      tasks: rows.map((row) => ({ task_key: row.task_key, status: row.status, qa_status: row.qa_status, qa_report_file: row.qa_report_file })) });
    if (manifest.qa_counts.failed) process.exitCode = 5;
  } finally { db.close(); release(); }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help());
    return;
  }
  if (command === "prepare") return commandPrepare(options);
  if (command === "validate-prompts") return commandValidatePrompts(options);
  if (command === "execute") return commandExecute(options, false);
  if (command === "status") return commandStatus(options);
  if (command === "qa") return commandQa(options);
  if (command === "retry-failed") return commandExecute(options, true);
  if (command === "retry-content-failed") return commandExecute(options, false, true);
  throw new Error(`Unknown command: ${command}\n${help()}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch((error) => {
  printJson({ ok: false, error: errorMessage(error), code: error?.code || "workflow_error" });
  process.exitCode = process.exitCode || 1;
});
