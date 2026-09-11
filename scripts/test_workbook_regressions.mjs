#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseArgs, requireOption } from "./lib/common.mjs";
import { buildDraft, loadArtifactTool, syncWorkbook } from "./lib/workbook.mjs";

const { options } = parseArgs(["test", ...process.argv.slice(2)]);
const nodeModules = requireOption(options, "node-modules");
const python = requireOption(options, "python");
const { Workbook, SpreadsheetFile, FileBlob } = loadArtifactTool(nodeModules);
const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-workbook-regressions-"));
const tests = [];
const headers = ["product_id", "product_name", "product_images", "product_info", "selling_points", "video_count"];
const row = (id, name, count = 1) => [id, name, "https://example.test/tray.webp", `A ${name.toLowerCase()} for desk items.`, "Keeps desk items together", count];
const save = async (book, input) => (await SpreadsheetFile.exportXlsx(book)).save(input);
const load = async (input) => SpreadsheetFile.importXlsx(await FileBlob.load(input));
const draftFor = async (input, name) => (await buildDraft({ input, nodeModules, python, outputRoot: path.join(tempRoot, name) })).draft;
const make = async (name, rows, includeId = true) => {
  const book = Workbook.create();
  const sheet = book.worksheets.add("Products");
  const values = [headers, ...rows].map((cells) => includeId ? cells : cells.slice(1));
  sheet.getRangeByIndexes(0, 0, values.length, values[0].length).values = values;
  const input = path.join(tempRoot, `${name}.xlsx`);
  await save(book, input);
  return { book, sheet, input };
};
const record = (draft, productId, status, qa = undefined) => ({
  task_key: `${productId}::V001`, batch_id: draft.batch_id, product_id: productId,
  product_name: draft.products.find((product) => product.product_id === productId)?.product_name || productId,
  variant_no: 1, creative_signature: "test", claim_ids_json: "[]", prompt_en: "test",
  status, updated_at: "2026-09-05T00:00:00.000Z", qa_status: qa,
  qa_report_file: qa === "passed" ? path.join(tempRoot, "qa.json") : null,
  qa_checked_at: qa === "passed" ? "2026-09-05T00:00:00.000Z" : null,
});
const assertNoMutationOnReject = async (input, action, expected = /Cannot safely locate|Legacy product/) => {
  const before = await fs.readFile(input);
  await assert.rejects(action, expected);
  assert.deepEqual(await fs.readFile(input), before, "rejected sync must leave XLSX bytes unchanged");
};

try {
  // Both row and column origin differ from A1; the embedded image must follow
  // the absolute product-image column, and unrelated formula/format must survive.
  const book = Workbook.create();
  const sheet = book.worksheets.add("Products");
  const imageRow = row("OFFSET", "Tray");
  imageRow[2] = "";
  sheet.getRange("C3:H4").values = [headers, imageRow];
  sheet.getRange("D4").format.font.bold = true;
  sheet.getRange("J4").formulas = [["=40+2"]];
  sheet.images.add({
    dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW5kAAAAASUVORK5CYII=",
    anchor: { from: { row: 3, col: 4 }, extent: { widthPx: 32, heightPx: 32 } },
  });
  book.worksheets.add("Notes").getRange("B2").values = [["Keep this note"]];
  const input = path.join(tempRoot, "offset.xlsx");
  await save(book, input);
  const draft = await draftFor(input, "offset-batch");
  assert.equal(draft.header_row, 3);
  assert.equal(draft.field_columns.product_images, 4);
  assert.equal(draft.products[0].workbook_row, 4);
  assert.equal(draft.products[0].images.length, 1);
  assert.equal(draft.products[0].images[0].embedded, true);
  await syncWorkbook({ manifest: draft, stateRows: [], nodeModules });
  const checked = await load(input);
  const checkedSheet = checked.worksheets.getItem("Products");
  assert.deepEqual(checkedSheet.getRange("C3:H4").values.map((cells) => cells.map((value) => value ?? "")), [headers, imageRow]);
  assert.equal(checkedSheet.getRange("A1").values[0][0] ?? "", "");
  assert.equal(checkedSheet.getRange("D4").format.font.bold, true);
  assert.equal(checkedSheet.getRange("J4").formulas[0][0], "=40+2");
  assert.equal(checked.worksheets.getItem("Notes").getRange("B2").values[0][0], "Keep this note");
  const extraction = await execFileAsync(python, [path.join(scriptDir, "extract_embedded_images.py"), "--input", input, "--sheet", "Products", "--image-col", "4", "--output-dir", path.join(tempRoot, "after-sync-images")], { encoding: "utf8" });
  assert.equal(JSON.parse(extraction.stdout).images[0].sha256, draft.products[0].images[0].sha256);
  tests.push("absolute-row-column-and-embedded-image", "preserve-product-cells-formula-style-and-other-sheet");

  const sorted = await make("sorted", [row("A", "Tray"), row("B", "Box")]);
  const sortedDraft = await draftFor(sorted.input, "sorted-batch");
  // Simulates a row insertion plus sorting and moving the entire table.
  sorted.sheet.getUsedRange().clear({ applyTo: "all" });
  sorted.sheet.getRange("C4:H7").values = [headers, row("B", "Box"), ["", "", "", "", "", ""], row("A", "Tray")];
  await save(sorted.book, sorted.input);
  await syncWorkbook({ manifest: sortedDraft, stateRows: [record(sortedDraft, "A", "downloaded"), record(sortedDraft, "B", "running")], nodeModules });
  const sortedCheck = (await load(sorted.input)).worksheets.getItem("Products");
  assert.deepEqual(sortedCheck.getRange("C5:D5").values[0], ["B", "Box"]);
  assert.deepEqual(sortedCheck.getRange("C7:D7").values[0], ["A", "Tray"]);
  const sortedHeaders = sortedCheck.getRange("A4:Q4").values[0];
  assert.equal(sortedCheck.getCell(4, sortedHeaders.indexOf("AI视频已完成")).values[0][0], 0);
  assert.equal(sortedCheck.getCell(6, sortedHeaders.indexOf("AI视频已完成")).values[0][0], 1);
  tests.push("reidentify-sorted-inserted-and-relocated-rows");

  const generated = await make("generated", [row("", "Tray"), row("", "Box")], false);
  const generatedDraft = await draftFor(generated.input, "generated-batch");
  generated.sheet.getRange("A2:E3").values = [row("", "Box").slice(1), row("", "Tray").slice(1)];
  await save(generated.book, generated.input);
  for (let index = 0; index < 3; index += 1) await syncWorkbook({ manifest: generatedDraft, stateRows: [], nodeModules });
  const generatedCheck = (await load(generated.input)).worksheets.getItem("Products");
  const generatedValues = generatedCheck.getUsedRange(true).values;
  assert.equal(generatedValues[0].filter((value) => value === "product_id").length, 1);
  const idCol = generatedValues[0].indexOf("product_id");
  assert.equal(generatedValues[1][idCol], "ROW-000002");
  assert.equal(generatedValues[2][idCol], "ROW-000001");
  tests.push("generated-ids-follow-original-row-fingerprints", "repeated-sync-reuses-one-id-column");

  const changed = await make("changed", [row("A", "Tray")]);
  const changedDraft = await draftFor(changed.input, "changed-batch");
  changed.sheet.getRange("B2").values = [["Different item"]];
  await save(changed.book, changed.input);
  await assertNoMutationOnReject(changed.input, () => syncWorkbook({ manifest: changedDraft, stateRows: [], nodeModules }));
  tests.push("changed-product-is-rejected-without-overwriting-workbook");

  const duplicate = await make("duplicate-after-prepare", [row("A", "Tray")]);
  const duplicateDraft = await draftFor(duplicate.input, "duplicate-after-prepare-batch");
  duplicate.sheet.getRange("A3:F3").values = [row("A", "Box")];
  await save(duplicate.book, duplicate.input);
  await assertNoMutationOnReject(duplicate.input, () => syncWorkbook({ manifest: duplicateDraft, stateRows: [], nodeModules }));
  tests.push("ambiguous-current-rows-are-rejected");

  const legacy = await make("legacy-id", [row("A", "Tray"), row("B", "Box")]);
  const legacyDraft = await draftFor(legacy.input, "legacy-id-batch");
  for (const product of legacyDraft.products) {
    delete product.source_row_fingerprint;
    delete product.source_product_id;
    product.workbook_row = 999;
  }
  legacy.sheet.getRange("A2:F3").values = [row("B", "Box"), row("A", "Tray")];
  await save(legacy.book, legacy.input);
  await syncWorkbook({ manifest: legacyDraft, stateRows: [], nodeModules });
  assert.deepEqual((await load(legacy.input)).worksheets.getItem("Products").getRange("A2:B3").values, [["B", "Box"], ["A", "Tray"]]);
  const legacyNoId = await make("legacy-no-id", [row("", "Tray")], false);
  const legacyNoIdDraft = await draftFor(legacyNoId.input, "legacy-no-id-batch");
  delete legacyNoIdDraft.products[0].source_row_fingerprint;
  delete legacyNoIdDraft.products[0].source_product_id;
  await assertNoMutationOnReject(legacyNoId.input, () => syncWorkbook({ manifest: legacyNoIdDraft, stateRows: [], nodeModules }));
  tests.push("legacy-manifest-uses-only-unique-current-ids", "legacy-without-id-is-rejected");

  const qa = await make("qa", [row("A", "Tray")]);
  const qaDraft = await draftFor(qa.input, "qa-batch");
  await syncWorkbook({ manifest: qaDraft, stateRows: [record(qaDraft, "A", "downloaded")], nodeModules });
  let qaBook = await load(qa.input);
  let qaValues = qaBook.worksheets.getItem("Products").getUsedRange(true).values;
  assert.equal(qaValues[1][qaValues[0].indexOf("AI视频总体状态")], "completed");
  assert.equal(qaValues[1][qaValues[0].indexOf("AI视频内容验收状态")], "pending");
  assert.equal(qaValues[1][qaValues[0].indexOf("AI视频验收通过数")], 0);
  let taskValues = qaBook.worksheets.getItem("AI视频任务").getUsedRange(true).values;
  assert.equal(taskValues[1][taskValues[0].indexOf("qa_status")], "pending");
  await syncWorkbook({ manifest: qaDraft, stateRows: [record(qaDraft, "A", "downloaded", "passed")], nodeModules });
  qaBook = await load(qa.input);
  qaValues = qaBook.worksheets.getItem("Products").getUsedRange(true).values;
  assert.equal(qaValues[1][qaValues[0].indexOf("AI视频内容验收状态")], "passed");
  assert.equal(qaValues[1][qaValues[0].indexOf("AI视频验收通过数")], 1);
  taskValues = qaBook.worksheets.getItem("AI视频任务").getUsedRange(true).values;
  assert.equal(taskValues[1][taskValues[0].indexOf("qa_report_file")], path.join(tempRoot, "qa.json"));
  tests.push("download-completion-and-content-qa-are-independent");

  const diversity = await make("diversity", [row("D", "Storage tray", 7)]);
  const diversityDraft = await draftFor(diversity.input, "diversity-batch");
  assert.equal(new Set(diversityDraft.task_slots.map((slot) => slot.diversity_assignment.demo)).size, 7);
  tests.push("seven-demo-pool-rotates-through-every-option");

  console.log(JSON.stringify({ ok: true, tests }));
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedTemp) !== resolvedParent || !path.basename(resolvedTemp).startsWith("ugc-workbook-regressions-")) throw new Error("Unsafe test cleanup path");
  await fs.rm(resolvedTemp, { recursive: true, force: true });
}
