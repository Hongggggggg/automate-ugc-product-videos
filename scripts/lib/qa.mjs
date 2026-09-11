import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256, nowIso, writeJsonAtomic, errorMessage } from "./common.mjs";
const run = promisify(execFile);
export const CONTENT_CHECKS = ["creator_visibility", "product_fidelity", "prop_fidelity", "dialogue_audio", "ai_defects", "home_visual_quality"];
const rate = (value) => { const [a, b = "1"] = String(value || "0").split("/").map(Number); return b ? a / b : 0; };

export async function inspectVideo({ file, outputDir, ffprobe, ffmpeg, expected = {} }) {
  if (!ffprobe || !ffmpeg) throw new Error("Technical QA requires explicit --ffprobe and --ffmpeg executable paths");
  await fs.access(ffprobe); await fs.access(ffmpeg);
  const artifactHash = sha256(await fs.readFile(file));
  await fs.mkdir(outputDir, { recursive: true });
  const report = { schema_version: "1.0", file: path.resolve(file), artifact_sha256: artifactHash,
    checked_at: nowIso(), technical: { ok: false, checks: {}, errors: [] }, representative_frames: [], contact_sheet: null, content: { status: "pending" } };
  const check = (name, passed, detail) => { report.technical.checks[name] = { ok: Boolean(passed), detail }; if (!passed) report.technical.errors.push(`${name}: ${detail}`); };
  try {
    const { stdout } = await run(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const metadata = JSON.parse(stdout);
    const video = metadata.streams?.find((stream) => stream.codec_type === "video");
    const audio = metadata.streams?.find((stream) => stream.codec_type === "audio");
    const duration = Number(metadata.format?.duration || video?.duration);
    const fps = rate(video?.avg_frame_rate || video?.r_frame_rate);
    report.metadata = { duration, width: video?.width, height: video?.height, fps, audio_codec: audio?.codec_name || null };
    check("video", Boolean(video), "A video stream must exist");
    check("duration", Number.isFinite(duration) && Math.abs(duration - (expected.duration || 30)) <= 1, `Expected ${expected.duration || 30}s, observed ${duration}s`);
    check("dimensions", video?.width === 720 && video?.height === 1280, `Expected 720x1280, observed ${video?.width}x${video?.height}`);
    check("frame_rate", Math.abs(fps - (expected.fps_prompt_only || 24)) <= 0.5, `Expected ${expected.fps_prompt_only || 24}fps, observed ${fps}`);
    check("audio", Boolean(audio?.codec_name), "An audio stream must exist; content review checks audibility and spoken dialogue");
    try {
      await run(ffmpeg, ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { encoding: "utf8", timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
      check("decode", true, "Complete video and audio decoded without reported errors");
    } catch (error) { check("decode", false, errorMessage(error)); }
    if (video && Number.isFinite(duration) && duration > 0 && duration <= 120 && report.technical.checks.decode?.ok) {
      const last = Math.max(0, duration - 1 / Math.max(1, fps));
      const times = [];
      for (let t = 0; t < last; t += 3) times.push(t);
      // Avoid asking ffmpeg for a second frame only a few milliseconds after
      // the final three-second sample; some MP4s have no decodable frame at
      // that exact end timestamp.
      if (!times.length || last - times.at(-1) > 0.25) times.push(last);
      for (const [index, seconds] of times.entries()) {
        const image = path.join(outputDir, `frame-${String(index).padStart(3, "0")}.png`);
        await run(ffmpeg, ["-v", "error", "-y", "-ss", seconds.toFixed(4), "-i", file, "-frames:v", "1", "-vf", "scale=360:-2", "-update", "1", image], { timeout: 60000, maxBuffer: 1024 * 1024 });
        await fs.access(image);
        report.representative_frames.push({ seconds, file: image });
      }
      const contact = path.join(outputDir, "contact-sheet.png");
      await run(ffmpeg, ["-v", "error", "-y", "-framerate", "1", "-i", path.join(outputDir, "frame-%03d.png"), "-vf", `tile=4x${Math.ceil(times.length / 4)}`, "-frames:v", "1", "-update", "1", contact], { timeout: 60000, maxBuffer: 1024 * 1024 });
      report.contact_sheet = contact;
      check("frames", true, "Frames include first, last, and samples at intervals of at most three seconds");
    } else check("frames", false, "Cannot sample invalid or unexpectedly long video");
  } catch (error) { report.technical.errors.push(`QA inspection failed: ${errorMessage(error)}`); }
  report.technical.ok = report.technical.errors.length === 0 && Object.values(report.technical.checks).every((item) => item.ok);
  const reportFile = path.join(outputDir, "qa-report.json");
  await writeJsonAtomic(reportFile, report);
  return { report, reportFile };
}

export function validateContentReview(review, task, report, batchId) {
  const errors = [];
  const add = (message) => errors.push(message);
  if (!review || review.schema_version !== "1.0" || review.batch_id !== batchId) return ["Content review schema or batch does not match"];
  if (!Array.isArray(review.tasks) || review.tasks.some((item) => !item || typeof item !== "object" || Array.isArray(item))) return ["Content review tasks must be an array of task records"];
  const matches = review.tasks.filter((item) => item.task_key === task.task_key);
  if (matches.length !== 1) return ["Content review needs exactly one record for this task"];
  const item = matches[0];
  if (item.artifact_sha256 !== report.artifact_sha256) add("Content review belongs to different video bytes");
  if (!item.reviewer || typeof item.reviewer !== "string" || item.reviewer.trim().length < 3) add("Content review must identify the reviewer");
  if (!item.reviewed_at || !Number.isFinite(Date.parse(item.reviewed_at))) add("Content review must record reviewed_at");
  if (!["passed", "failed"].includes(item.verdict)) add("Content verdict must be passed or failed");
  for (const name of CONTENT_CHECKS) {
    const check = item.checks?.[name];
    if (typeof check?.ok !== "boolean" || typeof check.notes !== "string" || check.notes.trim().length < 10) add(`Missing evidence notes for ${name}`);
    if (item.verdict === "passed" && check?.ok !== true) add(`Passed review has a failed ${name} check`);
  }
  if (item.verdict === "failed" && !CONTENT_CHECKS.some((name) => item.checks?.[name]?.ok === false)) add("Failed review must identify at least one failed content check");
  if (!Array.isArray(item.evidence_files) || !item.evidence_files.length) { add("Content review must cite inspected frame/contact-sheet paths"); return errors; }
  const known = new Set([report.contact_sheet, ...(report.representative_frames || []).map((frame) => frame.file)].filter(Boolean).map((value) => path.resolve(value)));
  for (const evidence of item.evidence_files || []) if (typeof evidence !== "string" || !known.has(path.resolve(evidence))) add("Content review cites unknown inspection evidence");
  return errors;
}
