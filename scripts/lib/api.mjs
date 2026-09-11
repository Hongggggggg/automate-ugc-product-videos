import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { errorMessage, replaceFile, sha256, sleep } from "./common.mjs";

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name).toLowerCase()];
      if (Array.isArray(value)) return value.join(", ");
      return value === undefined ? null : String(value);
    },
  };
}

function withoutBodyHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !["content-length", "content-type"].includes(name.toLowerCase())));
}

function headersForRedirect(headers, source, destination, switchToGet) {
  const next = switchToGet ? withoutBodyHeaders(headers) : { ...headers };
  if (source.origin !== destination.origin) {
    for (const name of Object.keys(next)) {
      if (["authorization", "cookie", "proxy-authorization"].includes(name.toLowerCase())) delete next[name];
    }
  }
  return next;
}

// Node's global fetch owns a process-wide Undici dispatcher. Constructing a
// new VintedClient does not create a new connection pool. Isolation mode uses
// native one-shot requests with agent:false so no HTTP/TLS socket can be
// reused by the next request or the next video task.
function requestWithoutPool(urlValue, { method = "GET", headers = {}, body, signal, tracker } = {}, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (tracker?.closing) {
      reject(new Error("API client is closing"));
      return;
    }
    const url = new URL(urlValue);
    const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
    if (!transport) {
      reject(new Error(`Unsupported URL protocol: ${url.protocol}`));
      return;
    }
    const request = transport.request(url, { method, headers, agent: false, signal }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && redirectsLeft > 0) {
        response.resume();
        const switchToGet = status === 303 || ([301, 302].includes(status) && method.toUpperCase() === "POST");
        const destination = new URL(location, url);
        resolve(requestWithoutPool(destination.toString(), {
          method: switchToGet ? "GET" : method,
          headers: headersForRedirect(headers, url, destination, switchToGet),
          body: switchToGet ? undefined : body,
          signal,
          tracker,
        }, redirectsLeft - 1));
        return;
      }
      resolve({
        status,
        headers: responseHeaders(response.headers),
        body: response,
        async text() {
          const chunks = [];
          for await (const chunk of response) chunks.push(chunk);
          return Buffer.concat(chunks).toString("utf8");
        },
      });
    });
    tracker?.trackRequest(request);
    request.once("socket", (socket) => tracker?.trackSocket(socket));
    request.once("error", reject);
    request.end(body);
  });
}

async function cancelBody(body) {
  if (!body) return;
  if (typeof body.cancel === "function") await body.cancel();
  else if (typeof body.destroy === "function") body.destroy();
}

function readableBody(body) {
  return typeof body?.getReader === "function" ? Readable.fromWeb(body) : body;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = "api_error", payload = null, requestId = null, fatal = false, terminalJobFailure = false, submissionUncertain = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
    this.requestId = requestId;
    this.fatal = fatal;
    this.terminalJobFailure = terminalJobFailure;
    this.submissionUncertain = submissionUncertain;
  }
}

function retryDelay(response, attempt, payload = null) {
  const payloadDelay = Number(payload?.retry_after ?? payload?.error?.retry_after);
  if (Number.isFinite(payloadDelay)) return Math.max(0, payloadDelay * 1000);
  const header = response?.headers?.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 1000 * (2 ** attempt)) + Math.floor(Math.random() * 250);
}

function errorFrom(response, payload, raw) {
  const status = response.status;
  const body = payload && typeof payload === "object" ? payload : {};
  const message = body.message || body.error?.message || body.error || raw || `HTTP ${status}`;
  const code = body.code || body.error?.code || `http_${status}`;
  return new ApiError(String(message), {
    status,
    code: String(code),
    payload,
    requestId: response.headers.get("x-request-id"),
    fatal: [401, 402, 403].includes(status),
  });
}

export class VintedClient {
  constructor({ apiKey, baseUrl = "https://vinted.cam", pollMs = 4000, maxPollMs = 0, timeoutMs = 60_000, maxRetries = 5, isolateRequests = false } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.pollMs = pollMs;
    const numericMaxPollMs = Number(maxPollMs);
    this.maxPollMs = Number.isFinite(numericMaxPollMs) && numericMaxPollMs > 0 ? numericMaxPollMs : 0;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.isolateRequests = Boolean(isolateRequests);
    this.rateLimited = false;
    this.rateLimitUntil = 0;
    this.activeRequests = new Set();
    this.activeSockets = new Set();
    this.closing = false;
  }

  trackRequest(request) {
    if (this.closing) request.destroy();
    this.activeRequests.add(request);
    request.once("close", () => this.activeRequests.delete(request));
  }

  trackSocket(socket) {
    if (this.closing) socket.destroy();
    this.activeSockets.add(socket);
    socket.once("close", () => this.activeSockets.delete(socket));
  }

  async close() {
    this.closing = true;
    const requests = [...this.activeRequests];
    const sockets = [...this.activeSockets];
    const requestClosed = requests.map((request) => request.closed
      ? Promise.resolve()
      : new Promise((resolve) => request.once("close", resolve)));
    const socketClosed = sockets.map((socket) => socket.closed
      ? Promise.resolve()
      : new Promise((resolve) => socket.once("close", resolve)));
    for (const request of requests) request.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([...requestClosed, ...socketClosed]);
    await new Promise((resolve) => setImmediate(resolve));
  }

  url(value) {
    return new URL(value, `${this.baseUrl}/`).toString();
  }

  async requestJson(endpoint, { method = "GET", body, headers = {}, auth = true, accepted = [200], retry = true } = {}) {
    let lastError;
    const retryLimit = retry ? this.maxRetries : 0;
    const tracksSubmission = method.toUpperCase() === "POST" && new URL(this.url(endpoint)).pathname === "/v1/videos";
    let submissionUncertain = false;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        const serializedBody = body === undefined ? undefined : JSON.stringify(body);
        const requestHeaders = {
          accept: "application/json",
          ...(this.isolateRequests ? { connection: "close", "cache-control": "no-store" } : {}),
          ...(serializedBody === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(serializedBody) }),
          ...(auth ? { authorization: `Bearer ${this.apiKey}` } : {}),
          ...headers,
        };
        response = this.isolateRequests
          ? await requestWithoutPool(this.url(endpoint), { method, headers: requestHeaders, body: serializedBody, signal: controller.signal, tracker: this })
          : await fetch(this.url(endpoint), { method, headers: requestHeaders, body: serializedBody, signal: controller.signal });
        if (tracksSubmission && response.status >= 500) submissionUncertain = true;
        const raw = await response.text();
        let payload = null;
        let validJson = false;
        if (raw) {
          try { payload = JSON.parse(raw); validJson = true; } catch { payload = raw; }
        }
        if (accepted.includes(response.status)) {
          if (!validJson) {
            if (tracksSubmission) submissionUncertain = true;
            throw new ApiError("API returned an empty or non-JSON success response", { status: response.status, code: "invalid_json_response", requestId: response.headers.get("x-request-id") });
          }
          return { payload, response, submissionUncertain };
        }
        const apiError = errorFrom(response, payload, raw);
        lastError = apiError;
        const retryable = response.status === 429 || response.status >= 500;
        if (response.status === 429) {
          this.rateLimited = true;
          this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + retryDelay(response, attempt, payload));
        }
        if (!retryable || attempt === retryLimit) throw apiError;
        await sleep(retryDelay(response, attempt, payload));
      } catch (error) {
        const normalized = error instanceof ApiError ? error : new ApiError(errorMessage(error), { code: error?.name === "AbortError" ? "timeout" : "network_error" });
        if (tracksSubmission && !normalized.status) submissionUncertain = true;
        normalized.submissionUncertain ||= submissionUncertain;
        lastError = normalized;
        if ((normalized.status && normalized.code !== "invalid_json_response") || attempt === retryLimit) throw normalized;
        await sleep(Math.min(30_000, 1000 * (2 ** attempt)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async preflight() {
    const catalog = await this.preflightCatalog();
    const balance = await this.preflightCredential();
    return { catalog, balance };
  }

  async preflightCatalog() {
    await this.requestJson("/ready", { auth: false, accepted: [200] });
    const catalog = (await this.requestJson("/v1/catalog", { auth: false, accepted: [200] })).payload;
    const model = Array.isArray(catalog?.models) ? catalog.models.find((entry) => entry?.id === "seedance2.5") : null;
    const supports = (values, required) => Array.isArray(values) && values.some((value) => String(value) === String(required));
    // The live catalog places durations/resolutions on each model and shared ratios at the root.
    // If the model declares a narrower ratio list, that list takes precedence.
    const ratios = model?.ratios === undefined ? catalog?.ratios : model.ratios;
    if (!model || !supports(model.durations, 30) || !supports(model.resolutions, "720p") || !supports(ratios, "9:16") || (catalog.camera_movement !== undefined && !supports(catalog.camera_movement, "auto"))) {
      throw new ApiError("Catalog does not advertise seedance2.5 with 30 seconds, 9:16, 720p and auto camera movement", { code: "catalog_mismatch", fatal: true });
    }
    return catalog;
  }

  async preflightCredential() {
    const balance = (await this.requestJson("/v1/balance", { accepted: [200] })).payload;
    const numeric = Number(balance?.balance ?? balance?.credits ?? balance?.data?.balance);
    if (Number.isFinite(numeric) && numeric <= 0) throw new ApiError("Vinted balance is empty", { status: 402, code: "insufficient_balance", fatal: true });
    return balance;
  }

  async uploadImage(file, { bytes } = {}) {
    const imageB64 = (bytes ?? await fsp.readFile(file)).toString("base64");
    const { payload } = await this.requestJson("/v1/files", { method: "POST", body: { image_b64: imageB64 }, accepted: [200, 201] });
    const imageId = payload?.image_id || payload?.id || payload?.data?.image_id;
    if (!imageId) throw new ApiError("Upload response did not contain image_id", { code: "invalid_upload_response" });
    return { imageId, expiresAt: payload?.expires_at || payload?.data?.expires_at || null };
  }

  async createVideoOnce(task, imageInputs) {
    const body = {
      prompt: task.prompt_en,
      model: "seedance2.5",
      duration: 30,
      ratio: "9:16",
      resolution: "720p",
      camera_movement: "auto",
      ...(imageInputs.image_ids.length ? { image_ids: imageInputs.image_ids } : {}),
      ...(imageInputs.image_urls.length === 1 ? { image_url: imageInputs.image_urls[0] } : {}),
      ...(imageInputs.image_urls.length > 1 ? { image_urls: imageInputs.image_urls } : {}),
    };
    const result = await this.requestJson("/v1/videos", {
      method: "POST",
      body,
      headers: { "Idempotency-Key": task.idempotency_key },
      accepted: [200, 201, 202, 409],
      retry: false,
    });
    const { payload, response } = result;
    const id = payload?.id || payload?.job_id || payload?.data?.id || payload?.existing_id;
    if (id) return { id: String(id), status: payload?.status || "queued", duplicate: response.status === 409 };
    throw new ApiError(`Video creation returned ${response.status} without a task id`, {
      status: response.status,
      code: "invalid_create_response",
      payload,
      requestId: response.headers.get("x-request-id"),
      submissionUncertain: true,
    });
  }

  // Video creation is deliberately one attempt. The workflow owns retries so
  // every POST /v1/videos attempt passes through the persisted cadence for its assigned credential.
  async createVideo(task, imageInputs) {
    return this.createVideoOnce(task, imageInputs);
  }

  async getVideo(jobId) {
    return (await this.requestJson(`/v1/videos/${encodeURIComponent(jobId)}`, { accepted: [200] })).payload;
  }

  async getSignedUrl(jobId) {
    return (await this.requestJson(`/v1/videos/${encodeURIComponent(jobId)}/signed_url`, { accepted: [200] })).payload;
  }

  async pollVideo(jobId) {
    const started = Date.now();
    let invalidResponses = 0;
    while (true) {
      if (this.maxPollMs > 0 && Date.now() - started > this.maxPollMs) {
        throw new ApiError(
          `Video task ${jobId} is still pending after the configured polling window; the existing job remains submitted and can be resumed`,
          { code: "poll_window_elapsed" },
        );
      }
      const payload = await this.getVideo(jobId);
      const value = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      const status = typeof value?.status === "string" ? value.status.toLowerCase() : "";
      if (["completed", "succeeded", "success", "done"].includes(status)) return value;
      if (["failed", "canceled", "cancelled", "error"].includes(status)) {
        const detail = value?.error;
        const message = [detail?.message, detail, value?.failure_reason, value?.message].find(item => typeof item === "string" && item.trim()) || `供应商未提供具体失败原因（状态：${status}）`;
        throw new ApiError(errorMessage(message), { status: 422, code: detail?.code || value?.code || status, requestId: value?.request_id || detail?.request_id, payload: value, terminalJobFailure: true });
      }
      if (!["queued", "running"].includes(status)) {
        invalidResponses += 1;
        if (invalidResponses > this.maxRetries) {
          throw new ApiError("Video polling returned no recognized task status; preserve the existing job and resume later", { code: "invalid_poll_response" });
        }
      } else {
        invalidResponses = 0;
      }
      await sleep(this.pollMs);
    }
  }
}

export function completedVideoUrl(payload) {
  return payload?.signed_url || payload?.download_url || payload?.video_url || payload?.url || payload?.data?.signed_url || payload?.data?.url || payload?.output?.signed_url || payload?.output?.url || payload?.result?.signed_url || null;
}

export async function isValidMp4(file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size < 12) return false;
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return bytesRead >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp";
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export async function downloadVideo(client, signedUrl, destination) {
  if (!signedUrl) throw new ApiError("Completed task has no signed_url", { code: "missing_signed_url" });
  if (await isValidMp4(destination)) return { file: destination, reused: true };
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const part = `${destination}.part`;
  const existing = (await fsp.stat(part).catch(() => null))?.size || 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.timeoutMs);
  try {
    const response = client.isolateRequests
      ? await requestWithoutPool(client.url(signedUrl), {
        headers: { connection: "close", "cache-control": "no-store", ...(existing ? { range: `bytes=${existing}-` } : {}) },
        signal: controller.signal,
        tracker: client,
      })
      : await fetch(client.url(signedUrl), { headers: existing ? { range: `bytes=${existing}-` } : {}, signal: controller.signal });
    const contentRange = response.headers.get("content-range");
    if (response.status === 416 && existing > 0) {
      await cancelBody(response.body);
      const completeRange = contentRange?.match(/^bytes \*\/(\d+)$/i);
      const total = completeRange ? Number(completeRange[1]) : NaN;
      if (Number.isSafeInteger(total) && total === existing && await isValidMp4(part)) {
        await replaceFile(part, destination);
        return { file: destination, reused: false };
      }
      throw new ApiError("Partial file does not match the complete length reported by the server", { status: 416, code: "download_range_mismatch" });
    }
    if (![200, 206].includes(response.status) || !response.body) {
      await cancelBody(response.body);
      throw new ApiError(`Download failed with HTTP ${response.status}`, { status: response.status, code: [401, 403, 404].includes(response.status) ? "signed_url_expired" : "download_failed" });
    }
    const append = existing > 0 && response.status === 206;
    const lengthHeader = response.headers.get("content-length");
    const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    let expected = contentLength;
    let expectedChunk = contentLength;
    if (response.status === 206) {
      const range = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
      const start = range ? Number(range[1]) : NaN;
      const end = range ? Number(range[2]) : NaN;
      const total = range && range[3] !== "*" ? Number(range[3]) : null;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== existing || end < start || (total !== null && (!Number.isSafeInteger(total) || total <= end)) || (contentLength !== null && contentLength !== end - start + 1)) {
        await cancelBody(response.body);
        throw new ApiError("Download Content-Range does not match the requested offset or response length", { code: "download_range_mismatch" });
      }
      expectedChunk = end - start + 1;
      expected = total;
    }
    if (!append) await fsp.writeFile(part, new Uint8Array());
    await pipeline(readableBody(response.body), fs.createWriteStream(part, { flags: append ? "a" : "w" }));
    const stat = await fsp.stat(part);
    const receivedChunk = stat.size - (append ? existing : 0);
    if (expectedChunk !== null && receivedChunk !== expectedChunk) throw new ApiError(`Download response size mismatch: received ${receivedChunk}, expected ${expectedChunk}`, { code: "download_size_mismatch" });
    if (expected !== null && stat.size !== expected) throw new ApiError(`Download size mismatch: received ${stat.size}, expected ${expected}`, { code: "download_size_mismatch" });
    if (!(await isValidMp4(part))) throw new ApiError("Downloaded file failed MP4 header validation", { code: "invalid_mp4" });
    await replaceFile(part, destination);
    return { file: destination, reused: false };
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError(errorMessage(error), { code: error?.name === "AbortError" ? "download_timeout" : "download_error" });
  } finally {
    clearTimeout(timer);
  }
}

export function sourceHash(image) {
  return image.sha256 || sha256(`${image.type}:${image.value}`);
}
