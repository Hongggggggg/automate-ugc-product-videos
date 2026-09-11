# vinted.cam video API contract

Source of truth: <https://vinted.cam/developers>. Query `GET /v1/catalog` at runtime before submitting because live catalog constraints outrank this reference.

## Fixed request

- Base URL: `https://vinted.cam`
- Authentication: `Authorization: Bearer <assigned key>`. Configure the required primary `VINTED_API_KEY` and optional distinct `VINTED_API_KEY_2`, `VINTED_API_KEY_3`, and later numbered slots; gaps are allowed.
- Create: `POST /v1/videos`; HTTP 202 is success and returns `{"id","status":"queued"}`.
- Model: `seedance2.5`
- Duration: `30`
- Ratio: `9:16`
- Resolution: `720p`
- Camera movement: `auto`
- Prompt: 1–6000 characters
- Workflow reference maximum: 9 images

Every create request must have a persisted unique `Idempotency-Key`. A network retry for the same logical task must reuse it.

## Catalog preflight

Check the structured catalog, not substrings in the complete JSON. The public catalog verified on 2026-09-05 places model IDs, durations and resolutions in `models[]`, with shared `ratios` and `camera_movement` arrays at the root. Locate the exact `seedance2.5` entry and require its own `durations` to include 30 and its own `resolutions` to include `720p`. Require `9:16` in the model's ratio list when present, otherwise in the root shared ratios. If a camera movement list is supplied, it must include `auto`. Never use another model's capabilities or root duration/resolution unions to satisfy the target model's requirements. Unknown or incompatible catalog structures stop new submissions with `catalog_mismatch`.

## Submission cadence

Create one worker per valid API key. Fresh tasks enter a shared FIFO queue, while submitted or uncertain tasks remain pinned to their batch-scoped credential identifier. Each task uses a new isolated HTTP/TLS client with `agent: false`, `Connection: close`, no-cache headers, and tracked requests/sockets. The worker holds its key through image review, `POST /v1/files`, create, polling, download, MP4 validation, and `client.close()`; the next task starts only after every prior socket emits `close`.

The start time of every `POST /v1/videos` must be at least 31 seconds after the same key's preceding create attempt across restarts. Persist the per-credential reservation before sending. Different keys may submit at the same time. The API client performs exactly one create request per call; the workflow sends each retry through the assigned key's cadence. Uncertain retries reuse the frozen request, uploaded image IDs, original idempotency key, and credential binding. A definite 429 keeps the task and cooldown on that worker.

## Images

Upload local and extracted images with `POST /v1/files` JSON `{"image_b64":"..."}` and retain the returned `image_id` until its `expires_at`. For new tasks this workflow uses visually reviewed, hash-bound local snapshots only; remote URL intake must be materialized before final preparation. Check the entire reference set before the first upload using [reference-image-review.md](reference-image-review.md). Legacy uncertain requests keep their already-frozen URLs/IDs for idempotent recovery.

## Poll and download

Poll `GET /v1/videos/{job_id}` every four seconds. Intermediate states are `queued` and `running`; terminal states are `succeeded` and `failed`. By default, keep polling an accepted job until the provider returns a terminal state. A caller may set a finite polling window for operational reasons, but expiration of that window is non-terminal: keep the task `running`, preserve its `job_id`, and resume with GET requests only. Never convert a polling-window expiration into `blocked` or submit another paid job.

HTTP success must contain valid JSON. Empty or non-JSON success responses are retried within the configured API retry limit and then fail with `invalid_json_response`. Missing or unrecognized task states receive at most `maxRetries + 1` consecutive observations, separated by the polling interval, before `invalid_poll_response`. These are protocol failures, not provider-reported generation failures: preserve the existing job ID and resume GET-only. A finite polling window can stop sooner and is also resumable.

The API exposes `ApiError.terminalJobFailure`, which is true only when polling receives an explicit failed/canceled/error task state. HTTP status alone, including a GET 4xx, does not establish that the paid generation job failed. The workflow must not mint a replacement idempotency key for a protocol or transport error.

For a successful task, obtain `GET /v1/videos/{job_id}/signed_url`. Its `url` may be site-relative; resolve it against the API base. Download to `.part`, use HTTP Range when resuming, validate the complete byte count when known and an MP4 `ftyp` header, then atomically rename to the final `.mp4`. Before appending any 206 response, require a valid `Content-Range` whose start matches the requested offset, whose end and total are consistent, and whose byte interval matches the body length (and `Content-Length` when supplied). A chunked 206 response with an unknown total still has to match its declared byte interval. A server that ignores Range and returns 200 replaces the partial file with the complete response.

If an interrupted run already wrote the complete `.part` before renaming, a resumed Range request can return 416. Recover it only when `Content-Range: bytes */N` matches the existing partial file's exact length and its MP4 header passes validation, then atomically rename it. An inconsistent Range or 416 reports `download_range_mismatch` and preserves the partial file for investigation; never append mismatched bytes or silently accept an oversized partial. These checks establish transport integrity only. ffprobe, decode checks and visual/content QA remain separate post-download steps.

## Errors

- 401/403: disable the affected credential, preserve known jobs and uncertain requests, and requeue only a certainly unaccepted task for another healthy worker. Block all remaining fresh submissions only when no credential remains available.
- 402: disable the affected credential and report insufficient balance; other funded credentials continue.
- 409 without a task ID: retry the same idempotent request through a new 31-second reservation for its assigned key; a file may still be finalizing.
- 413/422 from a new submission: fail only the affected task. A query or download error with the same HTTP status must retain the existing job ID; only a provider-reported terminal task state permits marking that paid generation as failed.
- 429: obey `Retry-After` or JSON `retry_after`, keep the task's original credential, image IDs, and idempotency key, and occupy only that worker while it cools. Every later attempt still reserves that key's 31-second slot.
- 5xx and network errors: retry at most five times with bounded backoff.
- 502/504 during download: refresh the signed URL and resume, at most five attempts.

Never log headers, keys, base64 bodies, or signed URLs. Persist only a batch-scoped one-way credential identifier, per-key cadence, and safe slot such as `key-2`. Status, progress, issue JSON, and workbooks may expose slots and credential counts but never key contents. Include provider `request_id` in sanitized error records when available.

An ambiguous create history survives later errors: `ApiError.submissionUncertain` is true if a create previously encountered network loss, timeout, 5xx, invalid success JSON, or a 409 without a recoverable ID. Do not interpret a later 413/422 as proof that no earlier job exists. Retain the original request body and idempotency key across recovery.
