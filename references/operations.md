# Operations and recovery

SQLite is authoritative. A process lock serializes mutation of a batch; an exited owner can be recovered on restart. Task updates and their events are atomic. The workbook is a synchronized human-readable mirror.

## State machine

`drafted → ready → queued → running → downloaded`

Exceptional states are `submission_unknown`, `failed`, and `blocked`. `submission_unknown` means creation may already have been accepted; it is not permission to create a new logical task. Mark `downloaded` only after the final MP4 exists and passes validation.

The task key is stable for a product ID and variant slot. The integrity digest covers batch ID, prompt hashes, image references, model, duration, ratio, resolution, and camera movement. It is an internal tamper check, not a user-approval token. Execution must reject a mismatched digest. SQLite additionally freezes the complete request (including images and request settings). Existing task contents cannot be changed in place: prepare a fresh batch for changed content, preserving the old batch for recovery. New manifests also bind the independent semantic review and original prompt inputs.

The successful prompt-validation report also carries the current prompt-contract version. Require the current report and independent semantic review before fresh paid submissions. A request to produce videos authorizes the validated initial batch, so execute it without another approval pause. Do not demand regenerated prompts merely to poll or download an already-paid job, or recover an uncertain create using its original validated request.

## Resume

- `ready`: submit automatically after the integrity and review checks pass. Treat legacy `awaiting_approval` rows as `ready`.
- `queued` or `running` with a job ID: poll the existing job; never resubmit.
- A finite local polling window ending while the provider still reports `queued` or `running`: keep the task `running`, record `poll_window_elapsed`, and resume the same job later. The default execute path has no task-level polling deadline.
- Legacy `blocked/poll_timeout` rows with a job ID: restore `running` and poll the existing job. Do not create a replacement.
- When every unfinished task already has a job ID, skip catalog and balance preflight; those checks guard new submissions and must not prevent GET-only polling or download of jobs that were already paid for.
- A timed-out or protocol-ambiguous create without a recoverable job ID: persist `submission_unknown`, the original idempotency key and exact uploaded-image inputs, and retry only that same request. A later execute may restore legacy failed/timeout rows to this state. Never reset its retry generation. Even a later 400/413/422 cannot prove that an earlier ambiguous attempt was not accepted; preserve the uncertain state and original key until the original job is resolved. If a legacy local-image request cannot be reconstructed, preserve state and recover the provider job ID; do not silently upload different image IDs under the old key.
- Before every `POST /v1/videos` attempt, read the assigned credential's persisted cadence and wait until at least 31 seconds have elapsed since that key's preceding create-request start. Record the new start before sending it. This applies to first attempts and every 409-without-ID, 429, 5xx, timeout, and network retry across restarts; different keys have independent clocks.
- Create one worker per valid API key. Each worker atomically claims from the shared FIFO queue and holds its key through image checking, upload, create, polling, download, MP4 validation, and explicit client/socket shutdown. Only then may that worker claim another task. Different workers may run concurrently, but one key never owns two unfinished lifecycles.
- `downloaded` with a valid final file: skip.
- `downloaded` with a missing or invalid file: restore `running` and redownload the existing job.
- Definite provider `failed`: leave untouched during normal execute. Protocol, polling and download failures with a known job ID remain recoverable; only an explicit failed/canceled provider status permits a separately requested paid replacement via retry-failed.
- Persist only a batch-scoped one-way credential identifier, a safe display slot, and per-credential cadence. Bind legacy submitted tasks without an identifier to the primary key and seed its cadence from the singleton record left by the single-key version. Leave fresh tasks unbound. Raw keys never enter durable state; status, events, issue JSON, and the workbook may expose only slots and configured/available/disabled counts.
- A definite 401/402/403 disables only the affected key. A certainly rejected, unaccepted task clears its frozen image IDs and credential binding so another healthy worker can claim it; preserve known jobs and uncertain request bodies on the original key. Block all remaining fresh tasks only when every configured key is unavailable.
- A definite 429 records `Retry-After`, keeps the same frozen image IDs and idempotency key, and keeps the task on its assigned worker. That worker remains occupied until both cooldown and its own 31-second cadence have elapsed; other workers continue. An ambiguous retry remains `submission_unknown` and reserves its key if recovery is exhausted.
- Before reporting completion, verify local output presence/header and recorded byte hash. Preserve a changed or invalid file under an unverified filename, then recover the original job. Invalidate QA whenever the video bytes change.

## Per-task failure reporting

A definite provider terminal failure or a reference-image rejection ends only that task. Persist its product ID, variant, job ID if available, error code and readable provider reason; continue the next eligible task without creating a replacement for the failed one. `task_settled` emits these details; `execute` returns all issues and saves `task-issues.json`; `status` and the workbook task `error` column expose the same reason. Tell the user promptly and include the full failed-item list in the final handoff. If the provider omits a reason, say “供应商未提供具体失败原因”; do not infer face rejection, insufficient balance or another root cause without evidence.

Local reference-image issues use `failed` with `failure_kind=input_preflight` and make no upload/create requests. Treat `submission_unknown` and `running` transport interruptions as pending recovery, not definite generation failures. Catalog or batch-integrity failures stop all new paid submissions. Credential, access, or balance failures disable only the affected key unless every key is unavailable; a definite 429 cools only its assigned worker. Corrected input/review content requires a fresh validated batch; ordinary `execute` does not automatically retry failed items.

## Retry failed

`retry-failed` is a new paid action only for definite generation or request failures. It first routes uncertain creates and existing-job transport failures back to recovery. Require explicit user intent and the current integrity digest. Increment the retry generation, clear the old job ID and legacy credential binding, create a new idempotency key, and return the task to `ready` without a credential binding so the next healthy worker can claim it from the shared FIFO queue. Preserve the prior error in the event log.

`retry-content-failed` is a separate paid action for a downloaded task whose durable content QA is `failed`. Require explicit user intent and the current integrity digest. Preserve the rejected MP4 beside the output as `.qa-failed-<artifact-hash>.mp4`, retain its QA report and audit events, clear the active job/output state and legacy credential binding, and submit exactly one replacement through the shared FIFO queue using the same validated prompt and reference-image sources with a new retry-generation idempotency key. Do not include provider-failed tasks or unreviewed downloads in this command.

## Workbook synchronization

Submit the validated batch through the per-key worker pool without a second user approval. A worker remains occupied until its task is downloaded and validated or explicitly fails, and until its task client confirms every socket is closed. Serialize workbook writes after each acceptance, task completion and successful finalization. Abrupt termination leaves SQLite authoritative for the next resume. Never require a workbook flush to recover a paid job. Reparse current worksheet coordinates and locate rows by unique product ID and saved source fingerprint; refuse ambiguous or edited identities instead of writing through old row numbers. Product status is:

- `ready` when validated tasks have not yet been submitted;
- `in_progress` when any task is queued, submission_unknown, or running;
- `completed` when every task is downloaded;
- `completed_with_errors` when all tasks are terminal and at least one failed;
- `blocked` when a required original credential is missing, all credentials are unavailable, or a global submission gate prevents progress. A slow accepted job remains `running` and reserves its key.

Never delete SQLite or partial downloads automatically. A later run must be able to resume from both.

## Post-download content QA

Technical download success is not the same as acceptable content. Use ffprobe and representative contact frames at least every three seconds across the full 30 seconds. Verify the same creator is the primary human subject, their face or upper body is visible in every sampled frame, their face occupies a meaningful part of at least 70% of sampled frames, the first and last sampled frames show the face, their body or hands visibly perform Pain, Solution, and Proof, the supplied product identity stays stable, only fact-permitted demonstration props appear, while reasonable non-demonstrating background items are allowed; furniture is well maintained, the home has a few everyday items, and natural window light and phone texture are preserved, the Hook-Pain-Solution-Proof-CTA sequence is visually credible, and no obvious AI defect is present.

If a technically valid MP4 fails content QA, retain it and report it as `downloaded_but_failed_qa`; do not silently call it acceptable and do not create another paid task without explicit user authorization. Transport state remains recoverable in SQLite, while the user-facing handoff records the QA finding.

## Durable content QA

Run the `qa` command and follow [content-qa.md](content-qa.md). Transport `completed` means downloaded files exist; it does not mean content passed. Task rows persist `qa_status` (`pending`, `passed`, `failed`), `qa_report_file`, `qa_checked_at`, and video SHA-256. The workbook has separate content-QA columns and counts. Technical failure or an explicit failed content review yields QA `failed` without changing the recoverable transport state or buying a replacement.

The initial technical check cannot verify a creator, product identity, natural dialogue, or absence of visual defects. It leaves content pending until a reviewer actually inspects saved frames and audible dialogue and supplies a file-hash-bound review.
