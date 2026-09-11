import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api.mjs";
import { sha256 } from "./common.mjs";

// A hash-bound record of actual visual inspection, not an automatic face detector.
// Validate the ENTIRE reference set before any bytes leave for the provider.
export async function checkReferenceImages(images, review, batchId, { allowTestFixture = false } = {}) {
  const fail = (code, message) => { throw new ApiError(message, { code }); };
  if (!Array.isArray(images) || !images.length || images.length > 9) fail("reference_images_invalid", "参考图需为1至9张；本条已跳过，未上传或生成。");
  if (!review || review.schema_version !== "1.0" || review.batch_id !== batchId || !Array.isArray(review.images)) fail("image_review_missing", "缺少匹配批次的参考图人脸检查记录；本条已跳过，未上传或生成。");
  if (review.test_fixture === true && !allowTestFixture) fail("image_review_test_fixture", "测试人脸检查记录不能用于真实生成。");
  const checked = [];
  for (const [index, image] of images.entries()) {
    const label = `参考图${index + 1}`;
    if (!image || !["file", "local"].includes(image.type) || typeof image.value !== "string") fail("image_local_snapshot_required", `${label}需先保存为本地文件并检查实际图像；禁止将未核验的远程链接交给生成接口。`);
    let bytes;
    try {
      const stat = await fs.stat(image.value);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) fail("reference_image_invalid", `${label}不是可用图像文件或超过50 MiB。`);
      bytes = await fs.readFile(image.value);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      fail("reference_image_unreadable", `${label}（${path.basename(image.value)}）无法读取；本条已跳过，未上传或生成。`);
    }
    const hash = sha256(bytes);
    if (!image.sha256 || hash !== image.sha256) fail("approval_image_changed", `${label}（${path.basename(image.value)}）与准备时的图像哈希不符；请重新检查并准备新批次。`);
    const records = review.images.filter(item => item && item.sha256 === hash);
    if (records.length !== 1) fail("image_review_missing", `${label}缺少唯一的图像哈希对应人脸检查记录；本条已跳过。`);
    const item = records[0];
    if (typeof item.reviewer !== "string" || item.reviewer.trim().length < 3 || typeof item.evidence !== "string" || item.evidence.trim().length < 10 || typeof item.reviewed_at !== "string" || !Number.isFinite(Date.parse(item.reviewed_at))) fail("image_review_invalid", `${label}缺少检查者、时间或实际观察依据；不能视为无人脸。`);
    if (item.verdict === "face_present") fail("reference_face_present", `${label}（${path.basename(image.value)}）含人脸内容；按本工作流的SD2.5输入限制，本条已跳过，未上传或生成。`);
    if (item.verdict !== "no_face") fail("reference_face_uncertain", `${label}（${path.basename(image.value)}）尚不能确认无人脸；本条已跳过，未上传或生成。`);
    checked.push({ image, bytes });
  }
  return checked;
}

export async function referenceImageIssues(products, review, batchId, options) {
  const issues = [];
  for (const product of products) {
    try { await checkReferenceImages(product.images, review, batchId, options); }
    catch (error) { issues.push({ product_id: product.product_id, error_code: error.code, error: error.message }); }
  }
  return issues;
}
