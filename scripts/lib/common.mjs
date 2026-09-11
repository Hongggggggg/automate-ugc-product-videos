import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options };
}

export function requireOption(options, name) {
  const value = options[name];
  if (!value || value === true) throw new Error(`Missing required option --${name}`);
  return path.resolve(String(value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await replaceFile(temp, file);
}

export async function replaceFile(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
    const old = `${destination}.replacing`;
    await fs.rm(old, { force: true });
    await fs.rename(destination, old);
    try {
      await fs.rename(source, destination);
      await fs.rm(old, { force: true });
    } catch (replacementError) {
      await fs.rename(old, destination).catch(() => {});
      throw replacementError;
    }
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..+/, "");
}

export function normalizeHeader(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_\-—–:：/\\()[\]（）【】.,，。]+/g, "");
}

export function sanitizeSegment(value) {
  const cleaned = String(value ?? "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/[. ]+$/g, "");
  return (cleaned || "unnamed").slice(0, 80);
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function parseEnvFile(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Missing .env file at ${file}. Save VINTED_API_KEY=sk-... locally; do not paste the key into chat.`);
    }
    throw error;
  }
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function ensureVintedEnvFile(file) {
  try {
    await fs.access(file);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const template = [
    "# Save the Vinted API key locally. Never paste it into chat or commit this file.",
    "VINTED_API_KEY=sk-replace-locally",
    "",
  ].join("\n");
  try {
    await fs.writeFile(file, template, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export async function requireVintedKeys(envFile) {
  const created = await ensureVintedEnvFile(envFile);
  if (created) {
    throw new Error(`Created .env template at ${envFile}. Save VINTED_API_KEY there locally, then retry; do not paste the key into chat.`);
  }
  const values = await parseEnvFile(envFile);
  if (!Object.prototype.hasOwnProperty.call(values, "VINTED_API_KEY")) {
    throw new Error(`VINTED_API_KEY is missing in ${envFile}. Save the real key locally; do not paste the key into chat.`);
  }
  const invalidNames = Object.keys(values).filter((name) => name.startsWith("VINTED_API_KEY_") && !/^VINTED_API_KEY_[2-9]\d*$/.test(name));
  if (invalidNames.length) throw new Error(`Invalid numbered API key variables in ${envFile}: ${invalidNames.join(", ")}. Use VINTED_API_KEY_2, VINTED_API_KEY_3, and so on.`);
  const entries = [
    { name: "VINTED_API_KEY", number: 1 },
    ...Object.keys(values)
      .map((name) => ({ name, match: name.match(/^VINTED_API_KEY_([2-9]\d*)$/) }))
      .filter((entry) => entry.match)
      .map((entry) => ({ name: entry.name, number: Number(entry.match[1]) }))
      .sort((left, right) => left.number - right.number),
  ].map(({ name, number }) => ({
    name,
    slot: `key-${number}`,
    key: validateVintedKey(name, values[name], envFile),
  }));
  const duplicate = entries.find((entry, index) => entries.findIndex((candidate) => candidate.key === entry.key) !== index);
  if (duplicate) throw new Error(`Duplicate API key value detected at ${duplicate.name} in ${envFile}. Every configured slot must use a different key.`);
  return entries;
}

export async function requireVintedKey(envFile) {
  return (await requireVintedKeys(envFile))[0].key;
}

function validateVintedKey(name, key, envFile) {
  const value = String(key ?? "").trim();
  const placeholder = /replace|example|your[-_ ]?key|changeme|xxx/i.test(value);
  if (!/^sk-[A-Za-z0-9._-]{3,}$/.test(value) || placeholder) {
    throw new Error(`${name} is missing, malformed, or still a placeholder in ${envFile}. Save a real key locally; do not paste it into chat.`);
  }
  return value;
}

export function credentialIdForBatch(batchId, key) {
  return crypto.createHmac("sha256", String(key)).update(String(batchId)).digest("hex");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function errorMessage(error) {
  return String(error?.message || error || "Unknown error").replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]").replace(/https?:\/\/[^\s<>"“”]+/gi, "[URL REDACTED]").replace(/\bsk-[A-Za-z0-9._-]+/g, "[KEY REDACTED]").slice(0, 2000);
}
