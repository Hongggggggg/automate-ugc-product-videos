import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { compactTimestamp, isHttpUrl, normalizeHeader, nowIso, replaceFile, sanitizeSegment, sha256, stableStringify, writeJsonAtomic } from "./common.mjs";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const FIELD_ALIASES = {
  product_id: ["product_id", "productid", "sku", "产品id", "产品编号", "商品id", "商品编号"],
  product_name: ["product_name", "productname", "name", "产品名称", "商品名称", "品名"],
  product_images: ["product_images", "product_image", "images", "image", "产品图片", "商品图片", "图片"],
  product_info: ["product_info", "product_description", "description", "产品信息", "商品信息", "产品描述", "商品描述"],
  selling_points: ["selling_points", "sellingpoints", "benefits", "卖点", "核心卖点", "产品卖点"],
  video_count: ["video_count", "videocount", "videos", "视频数量", "生成数量", "视频数"],
};
const REQUIRED_FIELDS = ["product_name", "product_images", "product_info", "selling_points", "video_count"];
const PRODUCT_STATUS_HEADERS = ["AI视频批次", "AI视频目标数", "AI视频已完成", "AI视频总体状态", "AI视频输出目录", "AI视频更新时间", "AI视频验收通过数", "AI视频内容验收状态"];
export const TASK_HEADERS = ["task_key", "batch_id", "product_id", "product_name", "variant_no", "creative_signature", "claim_ids", "中文提示词（含英文口播）", "review_status", "run_status", "api_key_slot", "job_id", "output_file", "error", "updated_at", "qa_status", "qa_report_file", "qa_checked_at"];

const ALIAS_LOOKUP = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const alias of aliases) ALIAS_LOOKUP.set(normalizeHeader(alias), field);
}

export function loadArtifactTool(nodeModules) {
  if (!nodeModules) throw new Error("Missing --node-modules from load_workspace_dependencies");
  const resolver = createRequire(path.join(path.resolve(nodeModules), "__artifact_resolver.cjs"));
  return resolver("@oai/artifact-tool");
}

function text(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function mapHeaderRow(row) {
  const mapping = {};
  for (let col = 0; col < row.length; col += 1) {
    const field = ALIAS_LOOKUP.get(normalizeHeader(row[col]));
    if (field && mapping[field] === undefined) mapping[field] = col;
  }
  return mapping;
}

// Range.values starts at the used range origin, not at A1. Keep all internal
// coordinates absolute so row identities and drawing anchors use the same basis.
function absoluteSheetValues(sheet) {
  const used = sheet.getUsedRange(true);
  if (!used) return [];
  const values = Array.from({ length: used.rowIndex }, () => []);
  for (const row of used.values || []) values.push([...Array(used.columnIndex).fill(null), ...row]);
  return values;
}

function sourceRowFingerprint(values, mapping) {
  const fields = Object.fromEntries(REQUIRED_FIELDS.map((field) => [field, text(values[mapping[field]])]));
  return sha256(stableStringify(fields));
}

function findProductSheet(workbook) {
  const candidates = [];
  for (const sheet of workbook.worksheets.items) {
    if (sheet.name === "AI视频任务") continue;
    const values = absoluteSheetValues(sheet);
    for (let row = 0; row < Math.min(10, values.length); row += 1) {
      const mapping = mapHeaderRow(values[row] || []);
      const score = Object.keys(mapping).length;
      if (score) candidates.push({ sheet, values, headerRow: row, mapping, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.headerRow - b.headerRow);
  if (!candidates.length) throw new Error("No worksheet contains recognized product headers");
  const best = candidates[0];
  const tiedSheets = [...new Set(candidates.filter((item) => item.score === best.score).map((item) => item.sheet.name))];
  if (tiedSheets.length > 1) throw new Error(`Ambiguous product sheets with equal header score: ${tiedSheets.join(", ")}`);
  const missing = REQUIRED_FIELDS.filter((field) => best.mapping[field] === undefined);
  if (missing.length) throw new Error(`Missing required columns: ${missing.join(", ")}`);
  return best;
}

function parseImageCell(value) {
  const raw = text(value);
  if (!raw) return [];
  if (raw.startsWith("[")) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("Product image JSON array is invalid"); }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Product image JSON must be a string array");
    return parsed.map((item) => item.trim()).filter(Boolean);
  }
  return raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function splitClaims(value) {
  return text(value).split(/\r?\n|[;；]+|\s*[•·]\s*/).map((item) => item.trim()).filter(Boolean);
}

async function validateImageReference(raw, workbookDir) {
  if (isHttpUrl(raw)) {
    const extension = path.extname(new URL(raw).pathname).toLowerCase();
    if (extension && !IMAGE_EXTENSIONS.has(extension)) throw new Error(`Unsupported image URL extension: ${extension}`);
    return { type: "url", value: raw };
  }
  const resolved = path.resolve(workbookDir, raw);
  const extension = path.extname(resolved).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error(`Unsupported local image extension: ${extension || "(none)"}`);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) throw new Error(`Image file not found: ${raw}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`Image exceeds 50 MiB: ${raw}`);
  const data = await fs.readFile(resolved);
  const isPng = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = data[0] === 0xff && data[1] === 0xd8;
  const isWebp = data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!(isPng || isJpeg || isWebp)) throw new Error(`Image content is not PNG, JPEG, or WebP: ${raw}`);
  return { type: "file", value: resolved, size: stat.size, sha256: sha256(data) };
}

async function extractEmbedded({ python, input, sheet, imageCol, outputDir }) {
  if (!python) return [];
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extract_embedded_images.py");
  const { stdout } = await execFileAsync(python, [script, "--input", input, "--sheet", sheet, "--image-col", String(imageCol), "--output-dir", outputDir], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout).images || [];
}

export async function inspectProducts({ input, nodeModules, python, outputRoot }) {
  if (path.extname(input).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx input is supported");
  const { FileBlob, SpreadsheetFile } = loadArtifactTool(nodeModules);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
  const selected = findProductSheet(workbook);
  const workbookDir = path.dirname(input);
  const rawRows = [];
  for (let row = selected.headerRow + 1; row < selected.values.length; row += 1) {
    const values = selected.values[row] || [];
    if (values.every((value) => !text(value))) continue;
    rawRows.push({ row, values });
  }
  const seed = rawRows.map(({ row, values }) => ({ row, values: Object.fromEntries(Object.entries(selected.mapping).map(([field, col]) => [field, text(values[col])])) }));
  const batchId = `${compactTimestamp()}-${sha256(stableStringify(seed)).slice(0, 8)}`;
  const batchDir = outputRoot || path.join(workbookDir, "ai-video-output", batchId);
  const embedded = await extractEmbedded({ python, input, sheet: selected.sheet.name, imageCol: selected.mapping.product_images, outputDir: path.join(batchDir, "extracted-images") });
  const embeddedByRow = new Map();
  for (const image of embedded) {
    const items = embeddedByRow.get(image.row) || [];
    items.push({ type: "file", value: image.path, size: image.size, sha256: image.sha256, embedded: true });
    embeddedByRow.set(image.row, items);
  }
  return { workbook, selected, rawRows, batchId, batchDir, embeddedByRow };
}

const DIVERSITY = {
  persona: ["renter", "busy-adult", "student", "home-organizer", "first-apartment", "remote-worker", "practical-minimalist", "busy-parent", "everyday-user", "practical-shopper"],
  hook: ["confession", "relatable-mistake", "unexpected-result", "problem-question", "friend-tip", "skeptical-discovery", "routine-interruption", "before-after", "small-annoyance", "wish-I-knew"],
  cta: ["low-pressure", "save-for-later", "same-problem", "routine-upgrade", "worth-a-look", "friend-recommendation", "try-it", "keep-in-mind", "simple-switch", "problem-solved"],
};

function factsText(product) {
  return [product.product_name, product.product_info, ...(product.claims || []).map((claim) => claim.text)].join(" ").toLowerCase();
}

function relevantRooms(product) {
  const facts = factsText(product);
  const rooms = [];
  const add = (...values) => values.forEach((value) => { if (!rooms.includes(value)) rooms.push(value); });
  if (/\b(?:entryway|entry way|console|keys?)\b|玄关|门厅|钥匙/i.test(facts)) add("entryway", "living-room");
  if (/\b(?:desk|office|workstation|computer)\b|书桌|办公|工作台|电脑/i.test(facts)) add("home-office");
  if (/\b(?:kitchen|cook|countertop|pantry|dish|cup|milk|coffee)\b|厨房|烹饪|台面|橱柜|餐具|杯|牛奶|咖啡/i.test(facts)) add("kitchen", "dining-area");
  if (/\b(?:bedroom|bedside|nightstand|closet|wardrobe)\b|卧室|床头|床边|衣柜/i.test(facts)) add("bedroom", "closet");
  if (/\b(?:bathroom|shower|toiletry)\b|浴室|卫生间|淋浴|洗漱/i.test(facts)) add("bathroom");
  if (/\b(?:laundry|washer|dryer)\b|洗衣|洗衣机|烘干机/i.test(facts)) add("laundry-area");
  if (/\b(?:garage|workbench|tool)\b|车库|工具台|工具/i.test(facts)) add("garage");
  if (!rooms.length) add("living-room", "home-office", "entryway");
  return rooms;
}

function factSupportedDemos(product) {
  const facts = factsText(product);
  const demos = ["real-use", "close-handling", "guided-placement", "routine-integration", "problem-replay", "side-by-side"];
  if (/\b(?:clean|wipe|wash|rinse)\b|清洁|擦拭|清洗|冲洗/i.test(facts)) demos.push("cleanup");
  if (/\b(?:store|storage|organize|organizer|compartment|tray)\b|收纳|储存|整理|隔层|托盘/i.test(facts)) demos.push("storage");
  if (/\b(?:fit|size|dimension|adjust|compatible)\b|适配|尺寸|调节|兼容/i.test(facts)) demos.push("fit-check");
  if (/\b(?:install|assemble|setup|set up|mount|connect)\b|安装|组装|设置|连接/i.test(facts)) demos.push("setup");
  if (/\b(?:unbox|unboxing|package|packaging|boxed)\b|开箱|包装|盒装/i.test(facts)) demos.push("unbox");
  return demos;
}

function factSupportedProofs(product) {
  const facts = factsText(product);
  const proofs = ["visible-mechanism", "use-state-change", "specific-feature", "objection-handling", "lived-result"];
  if (/\b(?:clean|wipe|wash|rinse)\b|清洁|擦拭|清洗|冲洗/i.test(facts)) proofs.push("cleanup-result");
  if (/\b(?:fit|size|dimension|adjust|compatible)\b|适配|尺寸|调节|兼容/i.test(facts)) proofs.push("fit-result");
  if (/\b(?:store|storage|organize|organizer|compartment|tray)\b|收纳|储存|整理|隔层|托盘/i.test(facts)) proofs.push("organization-result");
  return proofs;
}

function diversityAssignment(index, product) {
  const pools = {
    persona: DIVERSITY.persona,
    room: relevantRooms(product),
    hook: DIVERSITY.hook,
    demo: factSupportedDemos(product),
    proof: factSupportedProofs(product),
    cta: DIVERSITY.cta,
  };
  const keys = Object.keys(pools);
  return Object.fromEntries(keys.map((key, dimension) => [key, pools[key][(index + dimension) % pools[key].length]]));
}

export async function buildDraft({ input, nodeModules, python, outputRoot }) {
  const inspected = await inspectProducts({ input, nodeModules, python, outputRoot });
  const products = [];
  const invalidRows = [];
  const ids = new Set();
  for (const [rawIndex, { row, values }] of inspected.rawRows.entries()) {
    const excelRow = row + 1;
    const get = (field) => text(values[inspected.selected.mapping[field]]);
    const sourceProductId = get("product_id");
    const productId = sourceProductId || `ROW-${String(rawIndex + 1).padStart(6, "0")}`;
    const sourceIdentity = { source_product_id: sourceProductId, source_row_fingerprint: sourceRowFingerprint(values, inspected.selected.mapping) };
    const errors = [];
    const productName = get("product_name");
    const productInfo = get("product_info");
    const sellingPointsText = get("selling_points");
    const countRaw = get("video_count");
    const videoCount = Number(countRaw);
    if (!productName) errors.push("Missing product_name");
    if (!productInfo) errors.push("Missing product_info");
    if (!sellingPointsText) errors.push("Missing selling_points");
    if (!Number.isInteger(videoCount) || videoCount <= 0) errors.push("video_count must be a positive integer");
    if (ids.has(productId)) errors.push(`Duplicate product_id: ${productId}`);
    ids.add(productId);

    const images = [];
    try {
      for (const raw of parseImageCell(get("product_images"))) images.push(await validateImageReference(raw, path.dirname(input)));
      images.push(...(inspected.embeddedByRow.get(row) || []));
      const seen = new Set();
      const unique = images.filter((item) => {
        const key = item.type === "url" ? item.value : (item.sha256 || item.value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      images.splice(0, images.length, ...unique);
    } catch (error) {
      errors.push(error.message);
    }
    if (!images.length) errors.push("At least one product image is required");
    if (images.length > 9) errors.push("A product may use at most 9 image references");
    if (errors.length) {
      invalidRows.push({ workbook_row: excelRow, product_id: productId, ...sourceIdentity, errors });
      continue;
    }
    const claims = splitClaims(sellingPointsText).map((claim, index) => ({ id: `C${String(index + 1).padStart(2, "0")}`, text: claim }));
    products.push({ product_id: productId, product_name: productName, product_info: productInfo, claims, video_count: videoCount, workbook_row: excelRow, ...sourceIdentity, images });
  }
  if (!products.length) throw new Error(`No valid product rows. Invalid rows: ${JSON.stringify(invalidRows)}`);
  const taskSlots = [];
  for (const product of products) {
    for (let index = 0; index < product.video_count; index += 1) {
      const variant = index + 1;
      taskSlots.push({
        task_key: `${product.product_id}::V${String(variant).padStart(3, "0")}`,
        product_id: product.product_id,
        variant_no: variant,
        allowed_claim_ids: product.claims.map((claim) => claim.id),
        diversity_assignment: diversityAssignment(index, product),
      });
    }
  }
  const draft = {
    schema_version: "1.0",
    stage: "draft",
    batch_id: inspected.batchId,
    created_at: nowIso(),
    input_workbook: path.resolve(input),
    product_sheet: inspected.selected.sheet.name,
    header_row: inspected.selected.headerRow + 1,
    field_columns: inspected.selected.mapping,
    batch_dir: path.resolve(inspected.batchDir),
    settings: { model: "seedance2.5", duration: 30, ratio: "9:16", resolution: "720p", camera_movement: "auto", fps_prompt_only: 24 },
    products,
    invalid_rows: invalidRows,
    task_slots: taskSlots,
  };
  const draftPath = path.join(inspected.batchDir, "batch.draft.json");
  await writeJsonAtomic(draftPath, draft);
  return { draft, draftPath };
}

export async function assertWorkbookUnlocked(input) {
  const lock = path.join(path.dirname(input), `~$${path.basename(input)}`);
  try {
    await fs.access(lock);
    throw new Error(`Workbook appears open in Excel: ${lock}. Close Excel and retry.`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export async function createBackup(input) {
  const parsed = path.parse(input);
  const stamp = compactTimestamp();
  for (let sequence = 0; sequence < 100; sequence += 1) {
    const suffix = sequence ? `-${String(sequence).padStart(2, "0")}` : "";
    const backup = path.join(parsed.dir, `${parsed.name}.backup-${stamp}${suffix}${parsed.ext}`);
    try {
      await fs.copyFile(input, backup, fs.constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not create a unique timestamped backup for ${input}`);
}

function productStatus(rows) {
  if (rows.some((row) => row.status === "blocked")) return "blocked";
  if (rows.length && rows.every((row) => row.status === "downloaded")) return "completed";
  if (rows.length && rows.every((row) => ["downloaded", "failed"].includes(row.status))) return "completed_with_errors";
  if (rows.some((row) => ["queued", "submission_unknown", "running"].includes(row.status))) return "in_progress";
  return "ready";
}

function taskRow(record) {
  return [
    record.task_key,
    record.batch_id,
    record.product_id,
    record.product_name,
    record.variant_no,
    record.creative_signature,
    JSON.parse(record.claim_ids_json || "[]").join(", "),
    record.prompt_en,
    record.status === "drafted" ? "pending" : "reviewed",
    record.status,
    record.credential_slot || "",
    record.job_id || "",
    record.output_file || "",
    [record.error_code, record.error_message].filter(Boolean).join(": "),
    record.updated_at,
    record.qa_status || "pending",
    record.qa_report_file || "",
    record.qa_checked_at || "",
  ];
}

function existingTaskRows(sheet) {
  const used = sheet.getUsedRange(true);
  const values = used?.values || [];
  if (!values.length || normalizeHeader(values[0]?.[0]) !== "taskkey") return new Map();
  const headers = values[0].map((value) => text(value));
  const result = new Map();
  for (const row of values.slice(1)) {
    const key = text(row[0]);
    if (!key) continue;
    result.set(key, TASK_HEADERS.map((header) => {
      const candidates = header === "中文提示词（含英文口播）" ? [header, "prompt_en"] : [header];
      const index = candidates.map((candidate) => headers.indexOf(candidate)).find((candidate) => candidate >= 0);
      return index === undefined ? (header === "qa_status" ? "pending" : "") : (row[index] ?? "");
    }));
  }
  return result;
}

function getOrAddSheet(workbook, name) {
  try {
    return workbook.worksheets.getItem(name);
  } catch {
    return workbook.worksheets.add(name);
  }
}

function resolveProductRows(manifest, selected) {
  const { values, mapping, headerRow } = selected;
  const currentRows = [];
  for (let row = headerRow + 1; row < values.length; row += 1) {
    const cells = values[row] || [];
    if (!Object.values(mapping).some((col) => text(cells[col]))) continue;
    currentRows.push({ row, productId: text(cells[mapping.product_id]), fingerprint: sourceRowFingerprint(cells, mapping) });
  }
  const resolved = new Map();
  const claimedRows = new Set();
  for (const product of [...manifest.products, ...(manifest.invalid_rows || [])]) {
    const idMatches = currentRows.filter((item) => item.productId === product.product_id);
    if (idMatches.length > 1 && !product.errors) {
      throw new Error(`Cannot safely locate product ${product.product_id}: duplicate IDs in the current workbook. Correct the IDs and prepare a new draft.`);
    }
    let candidates = idMatches;
    if (product.source_row_fingerprint) {
      candidates = candidates.filter((item) => item.fingerprint === product.source_row_fingerprint);
      if (!idMatches.length && product.source_product_id === "") {
        candidates = currentRows.filter((item) => !item.productId && item.fingerprint === product.source_row_fingerprint);
      }
    }
    // Legacy drafts have no source fingerprint. A unique existing ID is the
    // only safe locator; never fall back to a historical worksheet row number.
    if (candidates.length !== 1 || claimedRows.has(candidates[0]?.row)) {
      throw new Error(`Cannot safely locate unchanged product ${product.product_id} in the current workbook. IDs or product rows changed or are ambiguous; prepare a new draft before syncing.`);
    }
    if (!product.source_row_fingerprint && !candidates[0].productId) {
      throw new Error(`Legacy product ${product.product_id} has no source fingerprint or existing ID; prepare a new draft before syncing.`);
    }
    claimedRows.add(candidates[0].row);
    resolved.set(product, candidates[0].row);
  }
  return resolved;
}

function contentQaStatus(rows) {
  if (rows.some((row) => row.qa_status === "failed")) return "failed";
  if (rows.length && rows.every((row) => row.status === "downloaded" && row.qa_status === "passed")) return "passed";
  return "pending";
}

export async function syncWorkbook({ manifest, stateRows, nodeModules, verify = false, createInitialBackup = false }) {
  const input = manifest.input_workbook;
  await assertWorkbookUnlocked(input);
  let backup = manifest.backup_file || null;
  if (createInitialBackup && !backup) backup = await createBackup(input);
  const { FileBlob, SpreadsheetFile } = loadArtifactTool(nodeModules);
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
  const productSheet = workbook.worksheets.getItem(manifest.product_sheet);
  const selected = findProductSheet({ worksheets: { items: [productSheet] } });
  const { values, headerRow } = selected;
  const resolvedRows = resolveProductRows(manifest, selected);
  const headers = [...(values[headerRow] || [])];
  const newHeaderCols = [];
  let productIdCol = selected.mapping.product_id;
  if (productIdCol === undefined) {
    productIdCol = headers.length;
    headers.push("product_id");
    newHeaderCols.push(productIdCol);
  }
  const statusCols = {};
  for (const header of PRODUCT_STATUS_HEADERS) {
    let col = headers.findIndex((value) => text(value) === header);
    if (col < 0) {
      col = headers.length;
      headers.push(header);
      newHeaderCols.push(col);
    }
    statusCols[header] = col;
  }
  // Do not rewrite original header cells: they may contain formulas or styles.
  for (const col of newHeaderCols) productSheet.getCell(headerRow, col).values = [[headers[col]]];
  const byProduct = new Map();
  for (const row of stateRows) {
    const list = byProduct.get(row.product_id) || [];
    list.push(row);
    byProduct.set(row.product_id, list);
  }
  for (const product of manifest.products) {
    const rowIndex = resolvedRows.get(product);
    const rows = byProduct.get(product.product_id) || [];
    const completed = rows.filter((row) => row.status === "downloaded").length;
    if (!text(values[rowIndex]?.[productIdCol])) productSheet.getCell(rowIndex, productIdCol).values = [[product.product_id]];
    const updates = {
      "AI视频批次": manifest.batch_id,
      "AI视频目标数": product.video_count,
      "AI视频已完成": completed,
      "AI视频验收通过数": rows.filter((row) => row.status === "downloaded" && row.qa_status === "passed").length,
      "AI视频内容验收状态": contentQaStatus(rows),
      "AI视频总体状态": productStatus(rows),
      "AI视频输出目录": path.join(manifest.batch_dir, sanitizeSegment(product.product_id)),
      "AI视频更新时间": nowIso(),
    };
    for (const [header, value] of Object.entries(updates)) productSheet.getCell(rowIndex, statusCols[header]).values = [[value]];
  }
  for (const invalid of manifest.invalid_rows || []) {
    const rowIndex = resolvedRows.get(invalid);
    if (!text(values[rowIndex]?.[productIdCol])) productSheet.getCell(rowIndex, productIdCol).values = [[invalid.product_id]];
    const updates = {
      "AI视频批次": manifest.batch_id,
      "AI视频目标数": 0,
      "AI视频已完成": 0,
      "AI视频验收通过数": 0,
      "AI视频内容验收状态": "pending",
      "AI视频总体状态": `invalid: ${(invalid.errors || []).join("; ")}`,
      "AI视频输出目录": "",
      "AI视频更新时间": nowIso(),
    };
    for (const [header, value] of Object.entries(updates)) productSheet.getCell(rowIndex, statusCols[header]).values = [[value]];
  }
  for (const col of newHeaderCols) productSheet.getCell(headerRow, col).format = { fill: "#17324D", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
  productSheet.freezePanes.freezeRows(headerRow + 1);
  const productDataRows = Math.max(1, values.length - headerRow - 1);
  const statusWidths = {
    "AI视频批次": 165,
    "AI视频目标数": 88,
    "AI视频已完成": 88,
    "AI视频总体状态": 150,
    "AI视频输出目录": 320,
    "AI视频更新时间": 175,
    "AI视频验收通过数": 120,
    "AI视频内容验收状态": 145,
  };
  for (const header of PRODUCT_STATUS_HEADERS) {
    const col = statusCols[header];
    const column = productSheet.getRangeByIndexes(headerRow, col, productDataRows + 1, 1);
    column.format.columnWidthPx = statusWidths[header];
    column.format.wrapText = true;
  }
  for (const header of ["AI视频目标数", "AI视频已完成", "AI视频验收通过数"]) {
    productSheet.getRangeByIndexes(headerRow + 1, statusCols[header], productDataRows, 1).format = {
      numberFormat: "0", horizontalAlignment: "center", verticalAlignment: "center",
    };
  }
  productSheet.getRangeByIndexes(headerRow + 1, statusCols["AI视频总体状态"], productDataRows, 1).format = {
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
  };
  productSheet.getRangeByIndexes(headerRow + 1, statusCols["AI视频更新时间"], productDataRows, 1).format.numberFormat = "yyyy-mm-dd hh:mm:ss";

  const taskSheet = getOrAddSheet(workbook, "AI视频任务");
  const merged = existingTaskRows(taskSheet);
  for (const record of stateRows) merged.set(record.task_key, taskRow(record));
  const taskValues = [TASK_HEADERS, ...[...merged.values()]];
  const oldUsed = taskSheet.getUsedRange();
  if (oldUsed) oldUsed.clear({ applyTo: "all" });
  taskSheet.getRangeByIndexes(0, 0, taskValues.length, TASK_HEADERS.length).values = taskValues;
  taskSheet.getRangeByIndexes(0, 0, 1, TASK_HEADERS.length).format = { fill: "#17324D", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
  taskSheet.freezePanes.freezeRows(1);
  taskSheet.showGridLines = false;
  const widths = [210, 150, 120, 160, 70, 260, 110, 520, 130, 110, 190, 150, 320, 260, 190, 110, 320, 190];
  widths.forEach((width, col) => { taskSheet.getRangeByIndexes(0, col, taskValues.length, 1).format.columnWidthPx = width; });
  if (taskValues.length > 1) {
    taskSheet.getRangeByIndexes(1, 4, taskValues.length - 1, 1).format.numberFormat = "0";
    taskSheet.getRangeByIndexes(1, 5, taskValues.length - 1, TASK_HEADERS.length - 5).format.wrapText = true;
  }

  const validationDir = path.join(manifest.batch_dir, "validation");
  if (verify) {
    await fs.mkdir(validationDir, { recursive: true });
    const productPreview = await workbook.render({ sheetName: manifest.product_sheet, autoCrop: "all", scale: 1, format: "png" });
    await fs.writeFile(path.join(validationDir, "product-sheet.png"), new Uint8Array(await productPreview.arrayBuffer()));
    const taskPreview = await workbook.render({ sheetName: "AI视频任务", range: `A1:R${Math.min(taskValues.length, 25)}`, scale: 1, format: "png" });
    await fs.writeFile(path.join(validationDir, "task-sheet.png"), new Uint8Array(await taskPreview.arrayBuffer()));
    const errors = await workbook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 100 }, summary: "formula error scan" });
    await fs.writeFile(path.join(validationDir, "formula-errors.ndjson"), errors.ndjson || "", "utf8");
  }
  const temp = `${input}.tmp`;
  await (await SpreadsheetFile.exportXlsx(workbook)).save(temp);
  await replaceFile(temp, input);
  await Promise.all([
    fs.rm(`${input}.inspect.ndjson`, { force: true }).catch(() => {}),
    fs.rm(`${temp}.inspect.ndjson`, { force: true }).catch(() => {}),
  ]);
  return { backup_file: backup, validation_dir: verify ? validationDir : null };
}
