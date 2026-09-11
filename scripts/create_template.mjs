#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, requireOption } from "./lib/common.mjs";
import { loadArtifactTool } from "./lib/workbook.mjs";

const { options } = parseArgs(["create", ...process.argv.slice(2)]);
const nodeModules = requireOption(options, "node-modules");
const output = requireOption(options, "output");
const { SpreadsheetFile, Workbook } = loadArtifactTool(nodeModules);

const workbook = Workbook.create();
const products = workbook.worksheets.add("产品表");
products.getRange("A1:F1").values = [["SKU", "产品名称", "产品图片", "产品信息", "卖点", "视频数量"]];
products.getRange("A1:F1").format = { fill: "#17324D", font: { bold: true, color: "#FFFFFF" }, wrapText: true, rowHeightPx: 42 };
products.getRange("A2:F51").format = { wrapText: true, verticalAlignment: "top" };
products.freezePanes.freezeRows(1);
products.showGridLines = false;
[130, 190, 280, 340, 340, 110].forEach((width, index) => { products.getRangeByIndexes(0, index, 51, 1).format.columnWidthPx = width; });
products.getRange("F2:F51").format.numberFormat = "0";

const guide = workbook.worksheets.add("填写说明");
guide.getRange("A1:B12").values = [
  ["AI UGC 产品视频批量输入模板", ""],
  ["规则", "说明"],
  ["一行一个产品", "不要合并产品数据单元格；视频数量决定该产品要生成多少份差异化提示词。"],
  ["图片：本地路径", "相对于本工作簿所在目录，例如 images/product-a.webp。"],
  ["图片：公网直链", "使用可公开访问的 HTTP/HTTPS 图片直链。"],
  ["图片：多张", "单元格内逐行填写或使用 JSON 字符串数组；也可把图片锚定在该产品行的产品图片列。"],
  ["图片限制", "PNG、JPEG、WebP；去重后每个产品最多 9 张。合成测试产品建议至少 3 个一致的白底角度。"],
  ["产品 ID", "可留空；首次准备批次时生成稳定 ROW-000001 类编号并回写。"],
  ["事实边界", "产品信息和卖点必须真实。Proof 不会自动发明数字、医疗、安全、比较或认证结论。"],
  ["审核", "准备阶段只生成提示词并回写。必须在聊天中整批批准后才调用收费视频接口。"],
  ["密钥", "在工作流根目录 .env 保存 VINTED_API_KEY=sk-...；不要把 Key 粘贴到聊天中。"],
  ["固定视频设置", "seedance2.5，30 秒，9:16，720p，camera_movement=auto；24fps 写入提示词。"],
];
guide.mergeCells("A1:B1");
guide.getRange("A1:B1").format = { fill: "#17324D", font: { bold: true, color: "#FFFFFF", size: 16 }, rowHeightPx: 36 };
guide.getRange("A2:B2").format = { fill: "#D9943B", font: { bold: true, color: "#FFFFFF" } };
guide.getRange("A3:B12").format = { wrapText: true, verticalAlignment: "top" };
guide.getRange("A1:A12").format.columnWidthPx = 190;
guide.getRange("B1:B12").format.columnWidthPx = 620;
guide.showGridLines = false;

await fs.mkdir(path.dirname(output), { recursive: true });
await (await SpreadsheetFile.exportXlsx(workbook)).save(output);
await fs.rm(`${output}.inspect.ndjson`, { force: true });
const preview = await workbook.render({ sheetName: "填写说明", range: "A1:B12", scale: 1, format: "png" });
await fs.writeFile(`${output}.preview.png`, new Uint8Array(await preview.arrayBuffer()));
const productPreview = await workbook.render({ sheetName: "产品表", range: "A1:F12", scale: 1, format: "png" });
await fs.writeFile(`${output}.product-preview.png`, new Uint8Array(await productPreview.arrayBuffer()));
process.stdout.write(`${JSON.stringify({ ok: true, output, previews: [`${output}.preview.png`, `${output}.product-preview.png`] })}\n`);
