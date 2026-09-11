#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureVintedEnvFile, parseArgs, requireVintedKey, sha256 } from "./lib/common.mjs";
import { countEnglishWords, PROMPT_CONTRACT_VERSION, REQUIRED_PRODUCTION_LOCK_ZH, REQUIRED_USER_TEMPLATE_ZH, validatePromptBatch } from "./lib/prompts.mjs";
import { assertWorkbookUnlocked, buildDraft, loadArtifactTool, syncWorkbook } from "./lib/workbook.mjs";
import { initializeTasks, listTasks, openState } from "./lib/state.mjs";
import { createPromptFixture, createTestSemanticReview } from "./lib/test-fixtures.mjs";

const execFileAsync = promisify(execFile);

async function main() {
  const { options } = parseArgs(["test", ...process.argv.slice(2)]);
  const nodeModules = path.resolve(String(options["node-modules"]));
  const python = path.resolve(String(options.python));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ugc-skill-core-"));
  try {
    const envFile = path.join(tmp, ".env");
    assert.equal(await ensureVintedEnvFile(envFile), true);
    assert.equal(await ensureVintedEnvFile(envFile), false);
    await assert.rejects(() => requireVintedKey(envFile), /placeholder/);
    const input = path.join(tmp, "products.xlsx");
    const localImage = path.join(tmp, "local-product.png");
    const { FileBlob, SpreadsheetFile, Workbook } = loadArtifactTool(nodeModules);
    const workbook = Workbook.create();
    const sheet = workbook.worksheets.add("产品清单");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    await fs.writeFile(localImage, Buffer.from(png, "base64"));
    const tooMany = JSON.stringify(Array.from({ length: 10 }, (_, index) => `https://example.test/image-${index}.png`));
    sheet.getRange("A1:F6").values = [
      ["SKU", "产品名称", "产品图片", "产品信息", "卖点", "视频数量"],
      ["", "Test Organizer", "https://example.test/product.png", "A compact organizer for a desk.", "Keeps supplied items together\nFits the stated desk use", 10],
      ["LOCAL", "Local Image Item", JSON.stringify(["local-product.png", "local-product.png"]), "A desk tray for small desk items, shown in the supplied local image.", "Keeps desk items together", 1],
      ["CNKITCHEN", "手持奶泡器", "https://example.test/frother.png", "适用于居家厨房搅打杯内牛奶或咖啡饮品。", "单按键启动搅拌头\n杯中可见泡沫变化", 2],
      ["", "Broken Row", "", "Missing image and count", "One claim", 0],
      ["MANY", "Too Many Images", tooMany, "Has excessive references.", "One supplied claim", 1],
    ];
    sheet.getRange("A1:F1").format = { fill: "#17324D", font: { bold: true, color: "#FFFFFF" } };
    sheet.images.add({ dataUrl: `data:image/png;base64,${png}`, anchor: { from: { row: 1, col: 2 }, extent: { widthPx: 80, heightPx: 80 } } });
    await (await SpreadsheetFile.exportXlsx(workbook)).save(input);

    const { draft } = await buildDraft({ input, nodeModules, python, outputRoot: path.join(tmp, "batch") });
    assert.equal(draft.products.length, 3);
    assert.equal(draft.invalid_rows.length, 2);
    assert.equal(draft.products[0].product_id, "ROW-000001");
    assert.equal(draft.products[0].images.length, 2);
    assert.equal(draft.products[1].images.length, 1, "duplicate local images must be removed");
    assert.equal(draft.task_slots.length, 13);
    assert(draft.invalid_rows.some((row) => row.product_id === "MANY" && row.errors.some((error) => /at most 9/.test(error))));
    const organizerSlots = draft.task_slots.filter((slot) => slot.product_id === "ROW-000001");
    assert(organizerSlots.every((slot) => slot.diversity_assignment.demo !== "unbox"), "unboxing must not be assigned without packaging facts");
    assert(organizerSlots.every((slot) => slot.diversity_assignment.room === "home-office"), "desk products must use a fact-relevant room");
    const chineseKitchenSlots = draft.task_slots.filter((slot) => slot.product_id === "CNKITCHEN");
    assert(chineseKitchenSlots.every((slot) => ["kitchen", "dining-area"].includes(slot.diversity_assignment.room)), "Chinese kitchen facts must use a fact-relevant room");
    assert(chineseKitchenSlots.every((slot) => slot.diversity_assignment.room !== "home-office"), "Chinese kitchen facts must not fall back to home-office");

    const tasks = draft.task_slots.map((slot, index) => createPromptFixture(draft, slot, index));
    const promptBatch = { schema_version: "1.0", batch_id: draft.batch_id, tasks };
    assert.deepEqual(validatePromptBatch(draft, promptBatch), []);
    const missingTemplateBatch = structuredClone(promptBatch);
    missingTemplateBatch.tasks[0].prompt_en = missingTemplateBatch.tasks[0].prompt_en.replace(REQUIRED_USER_TEMPLATE_ZH, "");
    assert(validatePromptBatch(draft, missingTemplateBatch).some((item) => /mandatory Chinese user template/.test(item.message)));
    const missingPersonaBatch = structuredClone(promptBatch);
    missingPersonaBatch.tasks[0].prompt_en = missingPersonaBatch.tasks[0].prompt_en.replace("人物设定：", "");
    assert(validatePromptBatch(draft, missingPersonaBatch).some((item) => /Missing exact label: 人物设定/.test(item.message)));
    const missingSceneBatch = structuredClone(promptBatch);
    missingSceneBatch.tasks[0].prompt_en = missingSceneBatch.tasks[0].prompt_en.replace("产品与场景：", "");
    assert(validatePromptBatch(draft, missingSceneBatch).some((item) => /Missing exact label: 产品与场景/.test(item.message)));
    const missingTimelineActionBatch = structuredClone(promptBatch);
    missingTimelineActionBatch.tasks[0].prompt_en = missingTimelineActionBatch.tasks[0].prompt_en.replace("镜头与动作：", "");
    assert(validatePromptBatch(draft, missingTimelineActionBatch).some((item) => /时间脚本缺少镜头与动作/.test(item.message)));
    const dialogueMismatchBatch = structuredClone(promptBatch);
    dialogueMismatchBatch.tasks[0].prompt_en = dialogueMismatchBatch.tasks[0].prompt_en.replace("英文台词：“", "英文台词：“extra ");
    assert(validatePromptBatch(draft, dialogueMismatchBatch).some((item) => /逐字一致/.test(item.message)));
    const facelessBatch = structuredClone(promptBatch);
    facelessBatch.tasks[0].prompt_en = facelessBatch.tasks[0].prompt_en.replace("真人出镜：", "");
    assert(validatePromptBatch(draft, facelessBatch).some((item) => /UGC stage violation/.test(item.message)));
    const missingVisibilityLockBatch = structuredClone(promptBatch);
    missingVisibilityLockBatch.tasks[0].prompt_en = missingVisibilityLockBatch.tasks[0].prompt_en.replace(REQUIRED_PRODUCTION_LOCK_ZH, "");
    assert(validatePromptBatch(draft, missingVisibilityLockBatch).some((item) => /Chinese production lock/.test(item.message)));
    const facelessMiddleBatch = structuredClone(promptBatch);
    facelessMiddleBatch.tasks[0].prompt_en = facelessMiddleBatch.tasks[0].prompt_en.replace("创作者的脸和上半身保持在画面中，亲手指出桌面物品散放的状态", "创作者用双手展示日常痛点");
    assert(validatePromptBatch(draft, facelessMiddleBatch).some((item) => /必须明确说明创作者的脸或上半身/.test(item.message)));
    const unsupportedUnboxBatch = structuredClone(promptBatch);
    unsupportedUnboxBatch.tasks[0].prompt_en += "\n用纯产品镜头展示开箱和包装。";
    assert(validatePromptBatch(draft, unsupportedUnboxBatch).some((item) => /packaging or unboxing/.test(item.message)));
    const englishInstructionsBatch = structuredClone(promptBatch);
    englishInstructionsBatch.tasks[0].prompt_en = englishInstructionsBatch.tasks[0].prompt_en.replace("朋友手持镜头靠近", "The camera moves closer");
    assert(validatePromptBatch(draft, englishInstructionsBatch).some((item) => /提示词说明必须全部使用中文/.test(item.message)));
    const harmlessCatchBatch = structuredClone(promptBatch);
    harmlessCatchBatch.tasks[0].prompt_en += "\n英文词汇边界测试：catch。";
    assert(!validatePromptBatch(draft, harmlessCatchBatch).some((item) => /pet-related use/.test(item.message)), "catch must not be mistaken for the standalone pet term cat");
    const fabricPillsBatch = structuredClone(promptBatch);
    fabricPillsBatch.tasks[0].prompt_en += "\n英文词汇边界测试：fabric pills。";
    assert(!validatePromptBatch(draft, fabricPillsBatch).some((item) => /medicine/.test(item.message)), "fabric pills must not be mistaken for medicine");
    const duplicateBatch = structuredClone(promptBatch);
    duplicateBatch.tasks[1].creative_signature = duplicateBatch.tasks[0].creative_signature;
    duplicateBatch.tasks[1].dialogue_en = duplicateBatch.tasks[0].dialogue_en;
    duplicateBatch.tasks[1].prompt_en = duplicateBatch.tasks[0].prompt_en;
    assert(validatePromptBatch(draft, duplicateBatch).some((item) => /Duplicate|similar/.test(item.message)));

    const productsById = new Map(draft.products.map((product) => [product.product_id, product]));
    const manifest = {
      ...draft,
      stage: "ready",
      state_db: path.join(tmp, "state.sqlite"),
      tasks: tasks.map((task, index) => {
        const slot = draft.task_slots[index];
        const product = productsById.get(slot.product_id);
        return { ...slot, ...task, product_name: product.product_name, images: product.images, output_file: path.join(tmp, "batch", product.product_id, `video-${String(slot.variant_no).padStart(2, "0")}.mp4`) };
      }),
    };
    const db = openState(manifest.state_db);
    let rows;
    try {
      initializeTasks(db, manifest);
      initializeTasks(db, manifest);
      rows = listTasks(db, manifest.batch_id);
      assert.equal(rows.length, 13);
      assert.equal(new Set(rows.map((row) => row.idempotency_key)).size, 13);
    } finally {
      db.close();
    }
    const synced = await syncWorkbook({ manifest, stateRows: rows, nodeModules, verify: false, createInitialBackup: true });
    assert(await fs.stat(synced.backup_file));
    const updated = await SpreadsheetFile.importXlsx(await FileBlob.load(input));
    assert(updated.worksheets.items.some((item) => item.name === "AI视频任务"));
    assert(updated.worksheets.getItem("AI视频任务").getUsedRange(true).values[0].includes("中文提示词（含英文口播）"));
    assert(updated.worksheets.getItem("AI视频任务").getUsedRange(true).values[0].includes("api_key_slot"));
    assert(!updated.worksheets.getItem("AI视频任务").getUsedRange(true).values[0].includes("prompt_en"));
    assert.equal(updated.worksheets.getItem("产品清单").getCell(1, 0).values[0][0], "ROW-000001");
    assert.equal(updated.worksheets.getItem("产品清单").getCell(4, 0).values[0][0], "ROW-000004", "invalid rows with blank IDs must still receive a stable ID");
    const second = await buildDraft({ input, nodeModules, python, outputRoot: path.join(tmp, "batch-after-sync") });
    assert.equal(second.draft.products[0].images.length, 2, "embedded image must survive workbook synchronization");

    const promptFile = path.join(tmp, "prompts.json");
    await fs.writeFile(promptFile, `${JSON.stringify(promptBatch, null, 2)}\n`, "utf8");
    const reviewFile = path.join(tmp, "review.TEST_FIXTURE_ONLY.json");
    await fs.writeFile(reviewFile, JSON.stringify(createTestSemanticReview(draft, promptBatch)), "utf8");
    const workflow = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflow.mjs");
    const cliArgs = [workflow, "prepare", "--input", input, "--draft", path.join(draft.batch_dir, "batch.draft.json"), "--prompts", promptFile, "--review", reviewFile, "--allow-test-review", "--node-modules", nodeModules, "--python", python, "--skip-key-check"];
    const firstPrepare = await execFileAsync(process.execPath, cliArgs, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const firstSummary = JSON.parse(firstPrepare.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(firstSummary.stage, "ready");
    assert.equal(typeof firstSummary.integrity_digest, "string");
    assert.equal(Object.hasOwn(firstSummary, "approval_digest"), false);
    const finalized = JSON.parse(await fs.readFile(firstSummary.manifest, "utf8"));
    assert.equal(finalized.prompt_validation.ok, true);
    assert.equal(finalized.prompt_validation.prompt_contract_version, PROMPT_CONTRACT_VERSION);
    assert.equal((await fs.stat(finalized.prompt_validation.report_file)).isFile(), true);
    const validationReport = JSON.parse(await fs.readFile(finalized.prompt_validation.report_file, "utf8"));
    assert.equal(validationReport.ok, true);
    assert.equal(validationReport.errors.length, 0);
    const firstBackup = finalized.backup_file;
    const secondPrepare = await execFileAsync(process.execPath, cliArgs, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
    const secondSummary = JSON.parse(secondPrepare.stdout.trim().split(/\r?\n/).at(-1));
    const finalizedAgain = JSON.parse(await fs.readFile(secondSummary.manifest, "utf8"));
    assert.equal(finalizedAgain.backup_file, firstBackup, "repeated finalization must reuse the original batch backup");

    const lock = path.join(tmp, `~$${path.basename(input)}`);
    await fs.writeFile(lock, "locked");
    await assert.rejects(() => assertWorkbookUnlocked(input), /appears open in Excel/);
    await fs.rm(lock);
    process.stdout.write(`${JSON.stringify({ ok: true, tests: ["auto-create-env", "placeholder-key-stop", "aliases", "empty-id", "local-path", "json-image-list", "mixed-images", "duplicate-images", "nine-image-limit", "embedded-image-preservation", "invalid-row", "invalid-video-count", "fact-relevant-diversity", "chinese-fact-room-detection", "ten-prompt-diversity", "mandatory-Chinese-template", "Chinese-production-lock", "Chinese-only-prompt-instructions", "five-stage-UGC-anchors", "full-video-creator-visibility-lock", "middle-stage-visible-creator", "fact-gated-unbox", "fabric-pills-not-medicine", "prompt-contract-version", "prompt-validation-report", "sqlite-idempotency", "two-stage-cli-finalize", "repeat-finalize-recovery", "backup", "workbook-lock"], sha256: sha256(await fs.readFile(input)) })}\n`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
