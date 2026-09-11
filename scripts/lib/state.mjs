import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { nowIso, sha256, stableStringify } from "./common.mjs";

const STATUSES = new Set(["drafted", "ready", "awaiting_approval", "queued", "submission_unknown", "running", "downloaded", "failed", "blocked"]);
const FIXED_SETTINGS = { model: "seedance2.5", duration: 30, ratio: "9:16", resolution: "720p", camera_movement: "auto" };
const json = (value) => JSON.stringify(value ?? null);
function decode(row) {
  return row ? { ...row, variant_no: Number(row.variant_no), attempts: Number(row.attempts), retry_generation: Number(row.retry_generation) } : null;
}

export function acquireStateLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const owner = json({ pid: process.pid, created_at: nowIso() });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, owner); fs.closeSync(fd);
      return () => { if (fs.existsSync(lock) && fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let current, pid;
      try { current = fs.readFileSync(lock, "utf8"); pid = JSON.parse(current).pid; } catch { throw new Error(`State lock is unreadable: ${lock}`); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid state lock: ${lock}`);
      try { process.kill(pid, 0); throw new Error(`Another workflow process (${pid}) owns ${lock}`); }
      catch (probe) {
        if (probe.code !== "ESRCH") throw probe;
        try { if (fs.readFileSync(lock, "utf8") === current) fs.unlinkSync(lock); } catch (race) { if (race.code !== "ENOENT") throw race; }
      }
    }
  }
  throw new Error(`Could not acquire state lock: ${lock}`);
}

export function openState(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks (
      task_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, product_id TEXT NOT NULL,
      product_name TEXT NOT NULL, variant_no INTEGER NOT NULL, creative_signature TEXT NOT NULL,
      claim_ids_json TEXT NOT NULL, prompt_en TEXT NOT NULL, prompt_hash TEXT NOT NULL,
      images_json TEXT NOT NULL, status TEXT NOT NULL, job_id TEXT, idempotency_key TEXT NOT NULL,
      output_file TEXT NOT NULL, error_code TEXT, error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, retry_generation INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_batch_status ON tasks(batch_id, status);
    CREATE TABLE IF NOT EXISTS image_uploads (
      source_hash TEXT PRIMARY KEY, image_id TEXT NOT NULL, expires_at TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_key TEXT, event_type TEXT NOT NULL,
      details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credential_cadence (
      credential_id TEXT PRIMARY KEY, last_submission_started_at TEXT,
      last_submission_response_at TEXT, cooldown_until TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submission_cadence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_submission_started_at TEXT, last_submission_response_at TEXT,
      cooldown_until TEXT, updated_at TEXT NOT NULL
    );
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name));
  for (const [name, definition] of Object.entries({
    request_hash: "TEXT", failure_kind: "TEXT", qa_status: "TEXT NOT NULL DEFAULT 'pending'",
    qa_report_file: "TEXT", qa_checked_at: "TEXT", artifact_sha256: "TEXT", submission_images_json: "TEXT",
    credential_id: "TEXT", credential_slot: "TEXT",
  })) if (!columns.has(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  const cadenceColumns = new Set(db.prepare("PRAGMA table_info(credential_cadence)").all().map((row) => row.name));
  if (!cadenceColumns.has("cooldown_until")) db.exec("ALTER TABLE credential_cadence ADD COLUMN cooldown_until TEXT");
  return db;
}

function requestHash(task, settings) {
  return sha256(stableStringify({ task_key: task.task_key, product_id: task.product_id,
    product_name: task.product_name, variant_no: Number(task.variant_no), prompt_en: task.prompt_en,
    images: task.images, creative_signature: task.creative_signature, claim_ids: task.claim_ids,
    output_file: task.output_file, settings: Object.fromEntries(Object.keys(FIXED_SETTINGS).map((key) => [key, settings?.[key] ?? FIXED_SETTINGS[key]])) }));
}

export function initializeTasks(db, manifest) {
  const find = db.prepare("SELECT * FROM tasks WHERE task_key = ?");
  const insert = db.prepare(`INSERT INTO tasks
    (task_key,batch_id,product_id,product_name,variant_no,creative_signature,claim_ids_json,prompt_en,prompt_hash,images_json,status,idempotency_key,output_file,updated_at,request_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const requested = new Set(manifest.tasks.map((task) => task.task_key));
    if (requested.size !== manifest.tasks.length) throw new Error("Duplicate task keys in manifest");
    for (const row of listTasks(db, manifest.batch_id)) if (!requested.has(row.task_key)) throw new Error(`Existing task removed from manifest: ${row.task_key}. Prepare a fresh batch.`);
    for (const task of manifest.tasks) {
      const hash = requestHash(task, manifest.settings);
      const existing = find.get(task.task_key);
      if (existing) {
        if (existing.batch_id !== manifest.batch_id) throw new Error(`Task belongs to another batch: ${task.task_key}. Use a new batch directory.`);
        const legacyHash = requestHash({ ...existing, images: JSON.parse(existing.images_json), claim_ids: JSON.parse(existing.claim_ids_json) }, FIXED_SETTINGS);
        if ((existing.request_hash || legacyHash) !== hash) throw new Error(`Immutable task request changed for ${task.task_key} (prompt, images, metadata, output or settings). Prepare and validate a fresh batch; existing paid jobs remain recoverable.`);
        if (!existing.request_hash) db.prepare("UPDATE tasks SET request_hash = ? WHERE task_key = ?").run(hash, task.task_key);
      } else {
        const key = `ugc-${sha256(`${manifest.batch_id}:${task.task_key}:0`).slice(0, 40)}`;
        insert.run(task.task_key, manifest.batch_id, task.product_id, task.product_name, task.variant_no, task.creative_signature, json(task.claim_ids), task.prompt_en, sha256(task.prompt_en), json(task.images), "ready", key, task.output_file, nowIso(), hash);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function listTasks(db, batchId) { return db.prepare("SELECT * FROM tasks WHERE batch_id = ? ORDER BY product_id, variant_no").all(batchId).map(decode); }
export function getTask(db, taskKey) { return decode(db.prepare("SELECT * FROM tasks WHERE task_key = ?").get(taskKey)); }
export function updateTask(db, taskKey, changes, eventType = "state_changed") {
  const allowed = new Set(["status", "job_id", "output_file", "error_code", "error_message", "attempts", "idempotency_key", "retry_generation", "failure_kind", "qa_status", "qa_report_file", "qa_checked_at", "artifact_sha256", "submission_images_json", "credential_id", "credential_slot"]);
  const entries = Object.entries(changes).filter(([key]) => allowed.has(key));
  if (changes.status && !STATUSES.has(changes.status)) throw new Error(`Invalid task status: ${changes.status}`);
  if (changes.qa_status && !["pending", "passed", "failed"].includes(changes.qa_status)) throw new Error(`Invalid QA status: ${changes.qa_status}`);
  if (!entries.length) return getTask(db, taskKey);
  entries.push(["updated_at", nowIso()]);
  db.exec("SAVEPOINT update_task");
  try {
    const result = db.prepare(`UPDATE tasks SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE task_key = ?`).run(...entries.map(([, value]) => value ?? null), taskKey);
    if (!result.changes) throw new Error(`Unknown task_key: ${taskKey}`);
    addEvent(db, taskKey, eventType, changes);
    db.exec("RELEASE update_task");
  } catch (error) { db.exec("ROLLBACK TO update_task; RELEASE update_task"); throw error; }
  return getTask(db, taskKey);
}
export function addEvent(db, taskKey, eventType, details = {}) {
  db.prepare("INSERT INTO events (task_key,event_type,details_json,created_at) VALUES (?,?,?,?)").run(taskKey || null, eventType, json(details), nowIso());
}
export function latestEventTime(db, eventType) { return db.prepare("SELECT created_at FROM events WHERE event_type = ? ORDER BY id DESC LIMIT 1").get(eventType)?.created_at || null; }
export function getCredentialCadence(db, credentialId) {
  return db.prepare("SELECT * FROM credential_cadence WHERE credential_id = ?").get(credentialId) || null;
}
export function ensureCredentialCadence(db, credentialId, seed = {}) {
  db.prepare(`INSERT INTO credential_cadence
    (credential_id,last_submission_started_at,last_submission_response_at,cooldown_until,updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(credential_id) DO NOTHING`).run(
    credentialId,
    seed.last_submission_started_at || null,
    seed.last_submission_response_at || null,
    seed.cooldown_until || null,
    nowIso(),
  );
  return getCredentialCadence(db, credentialId);
}
export function recordCredentialCadence(db, credentialId, field, createdAt = nowIso()) {
  if (!["last_submission_started_at", "last_submission_response_at", "cooldown_until"].includes(field)) {
    throw new Error(`Invalid credential cadence field: ${field}`);
  }
  ensureCredentialCadence(db, credentialId);
  db.prepare(`UPDATE credential_cadence SET ${field} = ?, updated_at = ? WHERE credential_id = ?`).run(createdAt, nowIso(), credentialId);
  return getCredentialCadence(db, credentialId);
}
export function getSubmissionCadence(db) {
  return db.prepare("SELECT * FROM submission_cadence WHERE id = 1").get() || null;
}
function latestIso(...values) {
  const present = values.filter(Boolean);
  return present.length ? present.sort().at(-1) : null;
}
export function ensureSubmissionCadence(db, seed = {}) {
  const existing = getSubmissionCadence(db);
  if (existing) return existing;
  const legacy = db.prepare(`SELECT
    MAX(last_submission_started_at) AS last_submission_started_at,
    MAX(last_submission_response_at) AS last_submission_response_at,
    MAX(cooldown_until) AS cooldown_until
    FROM credential_cadence`).get();
  const started = latestIso(seed.last_submission_started_at, legacy?.last_submission_started_at, latestEventTime(db, "submission_started"));
  const responded = latestIso(seed.last_submission_response_at, legacy?.last_submission_response_at, latestEventTime(db, "submission_response_received"));
  const cooldown = latestIso(seed.cooldown_until, legacy?.cooldown_until);
  db.prepare(`INSERT INTO submission_cadence
    (id,last_submission_started_at,last_submission_response_at,cooldown_until,updated_at)
    VALUES (1,?,?,?,?)`).run(started, responded, cooldown, nowIso());
  return getSubmissionCadence(db);
}
export function recordSubmissionCadence(db, field, createdAt = nowIso()) {
  if (!["last_submission_started_at", "last_submission_response_at", "cooldown_until"].includes(field)) {
    throw new Error(`Invalid submission cadence field: ${field}`);
  }
  ensureSubmissionCadence(db);
  db.prepare(`UPDATE submission_cadence SET ${field} = ?, updated_at = ? WHERE id = 1`).run(createdAt, nowIso());
  return getSubmissionCadence(db);
}
export function getUpload(db, hash) { return db.prepare("SELECT * FROM image_uploads WHERE source_hash = ?").get(hash) || null; }
export function saveUpload(db, hash, imageId, expiresAt = null) {
  db.prepare(`INSERT INTO image_uploads (source_hash,image_id,expires_at,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(source_hash) DO UPDATE SET image_id=excluded.image_id,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(hash, imageId, expiresAt, nowIso());
}
function isProviderFailure(row) {
  return row.failure_kind === "provider_terminal" || (!row.failure_kind && Boolean(row.job_id) && ["failed", "canceled", "cancelled", "error", "generation_failed"].includes(row.error_code));
}
export function recoverInterruptedTasks(db, batchId) {
  for (const row of listTasks(db, batchId)) {
    if (row.status === "failed" && row.job_id && !isProviderFailure(row)) {
      updateTask(db, row.task_key, { status: "running", failure_kind: null }, "recover_existing_job");
    } else if (row.status === "failed" && !row.job_id && row.attempts > 0 && row.failure_kind !== "request_rejected" && !["payload_too_large", "http_413", "http_422", "validation_error"].includes(row.error_code)) {
      updateTask(db, row.task_key, { status: "submission_unknown", failure_kind: null }, "recover_uncertain_submission");
    } else if (row.status === "blocked" && !row.job_id) {
      updateTask(db, row.task_key, { status: row.attempts > 0 ? "submission_unknown" : "ready", failure_kind: null }, "recheck_submission_blocker");
    }
  }
}
export function resetFailedTasks(db, batchId) {
  recoverInterruptedTasks(db, batchId);
  const rows = listTasks(db, batchId).filter((row) => row.status === "failed" && (!row.job_id || isProviderFailure(row)));
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const generation = row.retry_generation + 1;
      const key = `ugc-${sha256(`${batchId}:${row.task_key}:${generation}`).slice(0, 40)}`;
      addEvent(db, row.task_key, "prior_failed_attempt", { job_id: row.job_id, error_code: row.error_code, error_message: row.error_message, idempotency_key: row.idempotency_key });
      updateTask(db, row.task_key, { status: "ready", job_id: null, error_code: null, error_message: null, failure_kind: null, attempts: 0, retry_generation: generation, idempotency_key: key, submission_images_json: null, credential_id: null, credential_slot: null, qa_status: "pending", qa_report_file: null, qa_checked_at: null, artifact_sha256: null }, "failed_task_retried");
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return rows.length;
}
export function statusCounts(rows) { const counts = {}; for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1; return counts; }
export function qaCounts(rows) { const counts = { pending: 0, passed: 0, failed: 0 }; for (const row of rows) counts[row.qa_status || "pending"] += 1; return counts; }
