#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { ApiError, completedVideoUrl, downloadVideo, isValidMp4, VintedClient } from "./lib/api.mjs";

const mp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftyp"), Buffer.from("isom"),
  Buffer.from([0x00, 0x00, 0x02, 0x00]), Buffer.from("isomiso2mp41"), Buffer.alloc(128, 7),
]);

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function send(response, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length, ...headers });
  response.end(body);
}

async function main() {
  const calls = { transient: [], throttle: 0, conflictWait: 0, gateway: 0, ranges: [], uploads: 0, uploadConnections: [], uploadSockets: [], socketEvents: [], bodies: [] };
  const polls = new Map();
  const socketIds = new WeakMap();
  let nextSocketId = 0;
  const liveCatalogShape = { models: [{ id: "seedance2.5", durations: [30], resolutions: ["720p"] }], ratios: ["9:16"], camera_movement: ["auto", "fixed"] };
  let catalog = liveCatalogShape;
  const protocolCalls = new Map();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/ready") return send(response, 200, { ready: true });
    if (url.pathname === "/v1/catalog") return send(response, 200, catalog);
    if (url.pathname === "/v1/balance") {
      if (request.headers.authorization === "Bearer sk-zero") return send(response, 402, { code: "insufficient_balance", message: "No credits" });
      return send(response, 200, { balance: 10 });
    }
    if (url.pathname === "/v1/files") {
      calls.uploads += 1;
      calls.uploadConnections.push(request.headers.connection || "");
      calls.uploadSockets.push(socketIds.get(request.socket));
      return send(response, 201, { image_id: "img-1" });
    }
    if (url.pathname === "/v1/videos" && request.method === "POST") {
      const body = await requestBody(request);
      calls.bodies.push(body);
      const key = request.headers["idempotency-key"];
      if (body.prompt === "transient") {
        calls.transient.push(key);
        if (calls.transient.length === 1) return send(response, 502, { code: "upstream" });
        return send(response, 202, { id: "job-transient", status: "queued" });
      }
      if (body.prompt === "conflict") return send(response, 409, { existing_id: "job-existing", status: "queued" });
      if (body.prompt === "conflict-wait") {
        calls.conflictWait += 1;
        if (calls.conflictWait === 1) return send(response, 409, { code: "still_finalizing", retry_after: 0 });
        return send(response, 202, { id: "job-after-conflict", status: "queued" });
      }
      if (body.prompt === "throttle") {
        calls.throttle += 1;
        if (calls.throttle === 1) return send(response, 429, { code: "rate_limited" }, { "retry-after": "0" });
        return send(response, 202, { id: "job-throttle", status: "queued" });
      }
      if (body.prompt === "throttle-exhausted") return send(response, 429, { code: "concurrency" }, { "retry-after": "120" });
      if (body.prompt === "gateway") {
        calls.gateway += 1;
        return send(response, 504, { code: "gateway_timeout" });
      }
      if (["gateway-then-rejected", "conflict-then-rejected"].includes(body.prompt)) {
        const count = (protocolCalls.get(body.prompt) || 0) + 1;
        protocolCalls.set(body.prompt, count);
        if (count === 1) return send(response, body.prompt === "gateway-then-rejected" ? 503 : 409, { code: "acceptance_unknown", retry_after: 0 });
        return send(response, 422, { code: "image_expired", message: "mock image expired on later attempt" });
      }
      if (body.prompt === "too-large") return send(response, 413, { code: "payload_too_large", message: "Too large" });
      return send(response, 202, { id: "job-ok", status: "queued" });
    }
    const jobMatch = url.pathname.match(/^\/v1\/videos\/(.+)$/);
    if (jobMatch) {
      const id = decodeURIComponent(jobMatch[1]);
      if (id === "job-fail") return send(response, 200, { id, status: "failed", error: { code: "generation_failed", message: "mock terminal failure" } });
      if (id === "job-long") return send(response, 200, { id, status: "running" });
      if (["job-invalid-json", "job-unknown-status", "job-missing-status", "job-recovered-status"].includes(id)) {
        const count = (protocolCalls.get(id) || 0) + 1;
        protocolCalls.set(id, count);
        if (id === "job-invalid-json") {
          response.writeHead(200, { "content-type": "text/html" });
          return response.end("<html>Temporarily unavailable</html>");
        }
        if (id === "job-unknown-status") return send(response, 200, { id, status: "unexpected-provider-status" });
        if (id === "job-missing-status" || count === 1) return send(response, 200, { id });
        return send(response, 200, { id, status: "succeeded" });
      }
      const count = (polls.get(id) || 0) + 1;
      polls.set(id, count);
      return count === 1 ? send(response, 200, { id, status: "running" }) : send(response, 200, { id, status: "completed", signed_url: "/media/video.mp4" });
    }
    if (["/media/wrong-range.mp4", "/media/unknown-total.mp4"].includes(url.pathname)) {
      const requestedStart = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0);
      const start = url.pathname === "/media/wrong-range.mp4" ? 0 : requestedStart;
      const chunk = mp4.subarray(start);
      response.writeHead(206, { "content-type": "video/mp4", "content-range": `bytes ${start}-${mp4.length - 1}/${url.pathname === "/media/unknown-total.mp4" ? "*" : mp4.length}` });
      return response.end(chunk);
    }
    if (url.pathname === "/media/video.mp4") {
      const range = request.headers.range;
      calls.ranges.push(range || "");
      if (range) {
        const start = Number(range.match(/bytes=(\d+)-/)?.[1] || 0);
        if (start >= mp4.length) {
          response.writeHead(416, { "content-range": `bytes */${mp4.length}` });
          return response.end();
        }
        const chunk = mp4.subarray(start);
        response.writeHead(206, { "content-type": "video/mp4", "content-length": chunk.length, "content-range": `bytes ${start}-${mp4.length - 1}/${mp4.length}` });
        return response.end(chunk);
      }
      response.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length });
      return response.end(mp4);
    }
    send(response, 404, { error: "not found" });
  });
  server.on("connection", (socket) => {
    const id = ++nextSocketId;
    socketIds.set(socket, id);
    calls.socketEvents.push(`open:${id}`);
    socket.once("close", () => calls.socketEvents.push(`close:${id}`));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-skill-api-"));
  try {
    const client = new VintedClient({ apiKey: "sk-test", baseUrl, pollMs: 5, maxPollMs: 1000, timeoutMs: 1000, maxRetries: 2 });
    await client.preflight();
    catalog = { models: [{ id: "seedance2.5", durations: [10], resolutions: ["480p"] }, { id: "other-model", durations: [30], resolutions: ["720p"], ratios: ["9:16"] }], ratios: ["9:16"] };
    await assert.rejects(() => client.preflight(), (error) => error.code === "catalog_mismatch" && error.fatal);
    catalog = { ...liveCatalogShape, models: [{ ...liveCatalogShape.models[0], ratios: ["16:9"] }] };
    await assert.rejects(() => client.preflight(), (error) => error.code === "catalog_mismatch");
    catalog = { ...liveCatalogShape, models: [{ id: "seedance2.5" }], durations: [30], resolutions: ["720p"] };
    await assert.rejects(() => client.preflight(), (error) => error.code === "catalog_mismatch");
    catalog = liveCatalogShape;
    const uploadFile = path.join(tmp, "image.png");
    await fs.writeFile(uploadFile, Buffer.from("mock-image"));
    assert.equal((await client.uploadImage(uploadFile)).imageId, "img-1");
    assert.equal(calls.uploads, 1);
    const isolatedClient = new VintedClient({ apiKey: "sk-test", baseUrl, isolateRequests: true });
    assert.equal((await isolatedClient.uploadImage(uploadFile)).imageId, "img-1");
    assert.equal((await isolatedClient.uploadImage(uploadFile)).imageId, "img-1");
    assert.deepEqual(calls.uploadConnections.slice(-2), ["close", "close"], "isolated requests must explicitly close the HTTP connection");
    assert.notEqual(calls.uploadSockets.at(-2), calls.uploadSockets.at(-1), "isolated requests must use different TCP sockets");
    await isolatedClient.close();

    const lifecycleOne = new VintedClient({ apiKey: "sk-test", baseUrl, isolateRequests: true });
    assert.equal((await lifecycleOne.uploadImage(uploadFile)).imageId, "img-1");
    const firstLifecycleSocket = calls.uploadSockets.at(-1);
    await lifecycleOne.close();
    assert(calls.socketEvents.includes(`close:${firstLifecycleSocket}`), "client.close must wait until its socket closes");

    const firstCloseIndex = calls.socketEvents.indexOf(`close:${firstLifecycleSocket}`);
    const lifecycleTwo = new VintedClient({ apiKey: "sk-test", baseUrl, isolateRequests: true });
    assert.equal((await lifecycleTwo.uploadImage(uploadFile)).imageId, "img-1");
    const secondLifecycleSocket = calls.uploadSockets.at(-1);
    assert.notEqual(secondLifecycleSocket, firstLifecycleSocket, "a later lifecycle must establish a new TCP socket");
    assert(calls.socketEvents.indexOf(`open:${secondLifecycleSocket}`) > firstCloseIndex, "the next lifecycle must connect only after the prior socket closed");
    await lifecycleTwo.close();
    const transientTask = { prompt_en: "transient", idempotency_key: "stable-key" };
    await assert.rejects(
      () => client.createVideo(transientTask, { image_ids: ["img-1"], image_urls: [] }),
      (error) => error.status === 502 && error.submissionUncertain === true,
    );
    assert.deepEqual(calls.transient, ["stable-key"], "the API client must make exactly one create attempt per call");
    const transient = await client.createVideo(transientTask, { image_ids: ["img-1"], image_urls: [] });
    assert.equal(transient.id, "job-transient");
    assert.deepEqual(calls.transient, ["stable-key", "stable-key"]);
    assert.equal(calls.bodies[0].model, "seedance2.5");
    assert.equal(calls.bodies[0].duration, 30);
    assert.equal(calls.bodies[0].ratio, "9:16");
    assert.equal(calls.bodies[0].resolution, "720p");
    assert.equal(calls.bodies[0].camera_movement, "auto");
    const conflict = await client.createVideo({ prompt_en: "conflict", idempotency_key: "conflict-key" }, { image_ids: [], image_urls: ["https://example.test/a.png"] });
    assert.equal(conflict.id, "job-existing");
    assert.equal(conflict.duplicate, true);
    await assert.rejects(
      () => client.createVideo({ prompt_en: "conflict-wait", idempotency_key: "conflict-wait-key" }, { image_ids: [], image_urls: [] }),
      (error) => error.status === 409 && error.submissionUncertain === true,
    );
    const conflictWait = await client.createVideo({ prompt_en: "conflict-wait", idempotency_key: "conflict-wait-key" }, { image_ids: [], image_urls: [] });
    assert.equal(conflictWait.id, "job-after-conflict");
    assert.equal(calls.conflictWait, 2);
    await assert.rejects(
      () => client.createVideo({ prompt_en: "throttle", idempotency_key: "rate-key" }, { image_ids: [], image_urls: [] }),
      (error) => error.status === 429 && error.submissionUncertain === false,
    );
    await client.createVideo({ prompt_en: "throttle", idempotency_key: "rate-key" }, { image_ids: [], image_urls: [] });
    assert.equal(client.rateLimited, true);
    const noRetryClient = new VintedClient({ apiKey: "sk-test", baseUrl, maxRetries: 0 });
    const before429 = Date.now();
    await assert.rejects(() => noRetryClient.createVideo({ prompt_en: "throttle-exhausted", idempotency_key: "same-logical-task" }, { image_ids: [], image_urls: [] }), (error) => error.status === 429);
    assert(noRetryClient.rateLimitUntil >= before429 + 120000, "final 429 must preserve cooldown for the next logical task");
    const completed = await client.pollVideo("job-ok");
    assert.equal(completedVideoUrl(completed), "/media/video.mp4");
    await assert.rejects(() => client.pollVideo("job-fail"), (error) => error instanceof ApiError && error.code === "generation_failed" && error.terminalJobFailure === true);
    const protocolClient = new VintedClient({ apiKey: "sk-test", baseUrl, pollMs: 1, maxRetries: 1 });
    await assert.rejects(() => protocolClient.pollVideo("job-invalid-json"), (error) => error.code === "invalid_json_response" && error.terminalJobFailure === false);
    assert.equal(protocolCalls.get("job-invalid-json"), 2, "malformed success responses must stop after bounded retries");
    for (const id of ["job-unknown-status", "job-missing-status"]) {
      await assert.rejects(() => protocolClient.pollVideo(id), (error) => error.code === "invalid_poll_response" && error.terminalJobFailure === false);
      assert.equal(protocolCalls.get(id), 2, "unknown or missing states must not poll forever");
    }
    assert.equal((await protocolClient.pollVideo("job-recovered-status")).status, "succeeded", "a transient malformed status can recover without creating a job");
    const unlimited = new VintedClient({ apiKey: "sk-test", baseUrl, pollMs: 1, timeoutMs: 1000, maxRetries: 0 });
    assert.equal(unlimited.maxPollMs, 0, "polling must have no task-level deadline by default");
    const windowed = new VintedClient({ apiKey: "sk-test", baseUrl, pollMs: 5, maxPollMs: 15, timeoutMs: 1000, maxRetries: 0 });
    await assert.rejects(
      () => windowed.pollVideo("job-long"),
      (error) => error instanceof ApiError && error.code === "poll_window_elapsed" && /remains submitted/.test(error.message),
    );

    const output = path.join(tmp, "video.mp4");
    await fs.writeFile(`${output}.part`, mp4.subarray(0, 12));
    await downloadVideo(client, "/media/video.mp4", output);
    assert.equal(await isValidMp4(output), true);
    assert(calls.ranges.includes("bytes=12-"));
    const before = calls.ranges.length;
    const reused = await downloadVideo(client, "/media/video.mp4", output);
    assert.equal(reused.reused, true);
    assert.equal(calls.ranges.length, before);

    const completePartOutput = path.join(tmp, "complete-part.mp4");
    await fs.writeFile(`${completePartOutput}.part`, mp4);
    await downloadVideo(client, "/media/video.mp4", completePartOutput);
    assert.deepEqual(await fs.readFile(completePartOutput), mp4, "416 with matching total must recover an already complete partial file");
    await assert.rejects(() => fs.stat(`${completePartOutput}.part`), (error) => error.code === "ENOENT");

    const wrongRangeOutput = path.join(tmp, "wrong-range.mp4");
    const firstBytes = mp4.subarray(0, 12);
    await fs.writeFile(`${wrongRangeOutput}.part`, firstBytes);
    await assert.rejects(() => downloadVideo(client, "/media/wrong-range.mp4", wrongRangeOutput), (error) => error.code === "download_range_mismatch");
    assert.deepEqual(await fs.readFile(`${wrongRangeOutput}.part`), firstBytes, "a mismatched range must not append corrupt bytes");

    const unknownTotalOutput = path.join(tmp, "unknown-total.mp4");
    await fs.writeFile(`${unknownTotalOutput}.part`, firstBytes);
    await downloadVideo(client, "/media/unknown-total.mp4", unknownTotalOutput);
    assert.deepEqual(await fs.readFile(unknownTotalOutput), mp4, "chunked range responses without a known total must validate the returned byte interval");

    const oversizedPartOutput = path.join(tmp, "oversized-part.mp4");
    const oversizedPart = Buffer.concat([mp4, Buffer.from([1])]);
    await fs.writeFile(`${oversizedPartOutput}.part`, oversizedPart);
    await assert.rejects(() => downloadVideo(client, "/media/video.mp4", oversizedPartOutput), (error) => error.status === 416 && error.code === "download_range_mismatch");
    assert.deepEqual(await fs.readFile(`${oversizedPartOutput}.part`), oversizedPart, "an inconsistent 416 must preserve the existing partial file");

    await assert.rejects(
      () => client.createVideo({ prompt_en: "gateway", idempotency_key: "gateway-key" }, { image_ids: [], image_urls: [] }),
      (error) => error instanceof ApiError && error.status === 504,
    );
    assert.equal(calls.gateway, 1, "createVideo must never retry internally");
    await assert.rejects(
      () => client.createVideo({ prompt_en: "too-large", idempotency_key: "large-key" }, { image_ids: [], image_urls: [] }),
      (error) => error instanceof ApiError && error.status === 413 && error.submissionUncertain === false,
    );
    for (const prompt of ["gateway-then-rejected", "conflict-then-rejected"]) {
      await assert.rejects(
        () => client.createVideo({ prompt_en: prompt, idempotency_key: prompt }, { image_ids: ["original-image"], image_urls: [] }),
        (error) => error instanceof ApiError && error.submissionUncertain === true,
      );
      await assert.rejects(
        () => client.createVideo({ prompt_en: prompt, idempotency_key: prompt }, { image_ids: ["original-image"], image_urls: [] }),
        (error) => error instanceof ApiError && error.status === 422 && error.submissionUncertain === false,
      );
      assert.equal(protocolCalls.get(prompt), 2, "each explicit create call must send exactly one request");
    }
    const zero = new VintedClient({ apiKey: "sk-zero", baseUrl, pollMs: 1, maxRetries: 0 });
    await assert.rejects(() => zero.preflight(), (error) => error instanceof ApiError && error.status === 402 && error.fatal);
    process.stdout.write(`${JSON.stringify({ ok: true, tests: ["catalog-and-balance-preflight", "local-image-upload", "isolated-one-shot-transport", "client-close-before-next-lifecycle", "fixed-seedance-request", "202", "poll-success", "poll-422-failure", "poll-unlimited-by-default", "finite-poll-window-is-resumable", "single-attempt-502", "409-existing-id-recovery", "409-without-id-single-attempt", "429-cooldown-single-attempt", "402-stop", "413-current-task-failure", "504-single-attempt", "relative-signed-url", "range-resume", "repeat-download-skip", "catalog-model-specific-capabilities", "catalog-model-ratio-overrides-global", "catalog-requires-model-duration-resolution", "provider-terminal-failure-outcome", "non-json-success-bounded", "missing-and-unknown-status-bounded", "malformed-status-recovery", "complete-part-416-recovery", "range-offset-consistency", "chunked-range-unknown-total", "inconsistent-416-preserves-part", "separate-5xx-and-422-attempts", "separate-409-and-422-attempts", "direct-413-is-not-submission-uncertain"] })}\n`);
  } finally {
    server.close();
    await once(server, "close");
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
