import { sha256, stableStringify } from "./common.mjs";

export const REQUIRED_USER_TEMPLATE_ZH = [
  "生成一条 30 秒、9:16 竖屏、24fps 的真实美国 TikTok UGC 居家带货视频，整体呈现普通 iPhone 后置摄像头手持拍摄质感，轻微自然手持晃动，自动曝光偶尔变化，保留真实室内环境白噪音与生活感。不要影棚布光、电影级运镜、未来科技、电视购物或赛博朋克风格。",
  "全程使用自然美式英语真人口播，声音年轻、轻松、略带兴奋感，如同好友现场分享，拒绝播音腔与硬广感。确保准确唇形口型同步但不要夸张（Lip-sync）、自然换气停顿。眼神要自然，要适不能空洞，不能一直盯着一个地方看，要适当眨眼睛，不要字幕、贴纸、品牌水印、价格、购买小黄车按钮。严格避免脸部融化变形、衣服花纹闪烁变样、手指畸形、过度磨皮假面、无重力飘动及任何 AI 瑕疵。",
].join("\n");

export const PROMPT_CONTRACT_VERSION = "2026-09-07-zh-reviewed-v4";

export const REQUIRED_PRODUCTION_LOCK_ZH = [
  "固定制作要求：生成规格为30秒、9:16竖屏、720p、24fps、真实美国TikTok UGC居家带货视频。使用普通iPhone后置摄像头由朋友手持跟拍，保留轻微自然晃动、偶尔自动曝光呼吸、真实室内环境白噪音与生活痕迹。禁止影棚布光、电影级运镜、未来科技、电视购物和赛博朋克风格。",
  "真人创作者全程使用自然美式英语口播，声音年轻、放松、略带兴奋，像向朋友分享好物；口型同步准确但克制，换气自然，禁止播音腔和硬广腔。禁止字幕、贴纸、品牌水印、价格、购物车按钮及任何购买界面。避免脸部融化、身份漂移、衣服花纹变化、手或手指畸形、过度磨皮假面、物体漂浮、不可能动作及任何可见AI瑕疵。",
  "同一位创作者始终是主要人物：钩子和行动号召阶段必须露脸并直接对镜口播；痛点、解决方案和证明阶段必须由该创作者亲自操作，身体或双手清楚可见。创作者的脸必须出现在每个镜头中，包括第一帧和最后一帧，并在至少70%的时长内占据有意义的画面面积。中间阶段可以靠近双手，但同一画面仍须保留创作者的脸或上半身。最多使用两次自然跳切。严禁纯产品或纯道具镜头、产品美化镜头序列、纯旁白蒙太奇、无人露脸桌面展示，以及商业广告式前后对比蒙太奇。产品、演示道具、痛点状态和证明动作必须由表格事实支持；允许与房间合理匹配、仅作背景且不参与操作或证明卖点的少量日常陈设，不暗示配件随产品附送。",
  "创作者眼神自然专注，不空洞；视线应在镜头、产品和操作之间合理移动，适当自然眨眼，不能一直盯着同一个位置。",
  "家居与拍摄质感：选择维护良好、舒适、有审美但普通人真实居住的现代美式家庭，家具柜体完整，墙面与台面干净完好，材质自然可信。背景保留少量日常陈设与轻微使用痕迹，例如随手放的杯子、叠放的毛巾、书本或小型家电，摆放松弛而有秩序，操作区域清楚；不把家拍成空无一物的样板间。禁止残破柜门、掉漆开裂、发霉墙面、脏污油垢、垃圾堆积、廉价破败感、豪宅炫富或刻意布景。以柔和侧窗自然光为主，肤色和白平衡自然，保留皮肤与家居纹理，背景适度清晰；近距离平视或略低的台面高度中近景，人物与产品同框，仅有轻微手机手持漂移，禁止戏剧性光影、重滤镜、过度虚化、刻意压暗或剧烈晃动。",
  "参考图用途：白底产品图仅用于保持产品外观、颜色、结构和身份一致；不得复制白底背景、影棚构图或纯产品展示方式到视频中。",
].join("\n\n");

const PERSONA_LABEL = "人物设定：";
const PRODUCT_SCENE_LABEL = "产品与场景：";
const SCRIPT_LABEL = "脚本结构与执行（Hook - Pain - Solution - Proof - CTA）：";
const PRODUCTION_LOCK_LABEL = "固定制作要求：";
const STAGE_DIALOGUE_LABEL = "英文台词：";
const LABELS = [
  PERSONA_LABEL,
  PRODUCT_SCENE_LABEL,
  SCRIPT_LABEL,
  "0—5秒（Hook）",
  "5—11秒（Pain）",
  "11—18秒（Solution）",
  "18—25秒（Proof）",
  "25—30秒（CTA）",
  PRODUCTION_LOCK_LABEL,
];
const UGC_STAGE_RULES = [
  { label: "0—5秒（Hook）", next: "5—11秒（Pain）", marker: "真人出镜：", evidence: /(?:脸|面部|露脸|对镜|镜头|口播)/, minWords: 12, maxWords: 22 },
  { label: "5—11秒（Pain）", next: "11—18秒（Solution）", marker: "创作者实操：", evidence: /(?:脸|上半身|身体|手|拿|放|使用|操作|演示|展示)/, minWords: 15, maxWords: 25 },
  { label: "11—18秒（Solution）", next: "18—25秒（Proof）", marker: "创作者实操：", evidence: /(?:脸|上半身|身体|手|拿|放|使用|操作|演示|展示)/, minWords: 20, maxWords: 32 },
  { label: "18—25秒（Proof）", next: "25—30秒（CTA）", marker: "创作者实操：", evidence: /(?:脸|上半身|身体|手|拿|放|使用|操作|演示|展示)/, minWords: 18, maxWords: 30 },
  { label: "25—30秒（CTA）", next: PRODUCTION_LOCK_LABEL, marker: "真人出镜：", evidence: /(?:脸|面部|露脸|对镜|镜头|口播)/, minWords: 10, maxWords: 20 },
];

const MIDDLE_STAGE_LABELS = [
  ["5—11秒（Pain）", "11—18秒（Solution）"],
  ["11—18秒（Solution）", "18—25秒（Proof）"],
  ["18—25秒（Proof）", "25—30秒（CTA）"],
];

const VISIBLE_CREATOR_EVIDENCE = /(?:(?:脸|面部|上半身)[^。！？\n]{0,35}(?:可见|入镜|画面中|保留)|(?:可见|入镜|画面中|保留)[^。！？\n]{0,35}(?:脸|面部|上半身)|露脸|直接对镜口播)/;
const HIDDEN_CREATOR_CONTRADICTION = /(?:(?:脸|面部|上半身)[^。！？\n]{0,20}(?:不可见|不再可见|不入镜|不出镜|被遮挡|离开画面|画面外)|(?:看不见|不露脸|不见脸|背对镜头|仅(?:有|拍|保留)?(?:双手|手部|背部)|只(?:拍|见)(?:产品|双手|背部)))/;
const CREATIVE_DIMENSIONS = ["persona", "room", "hook", "demo", "proof", "cta"];
const REVIEW_CHECKS = ["factual_support", "creator_visibility", "creative_alignment", "natural_dialogue", "home_visual_quality"];


const FACT_GATED_CONCEPTS = [
  { prompt: /(?:开箱|包装|拆盒|unbox|unboxing|package|packaging|boxed)/i, facts: /(?:开箱|包装|拆盒|unbox|unboxing|package|packaging|boxed)/i, label: "packaging or unboxing" },
  { prompt: /(?:口红|化妆|化妆品|睫毛膏|lipstick|makeup|cosmetics?|mascara)/i, facts: /(?:口红|化妆|化妆品|睫毛膏|lipstick|makeup|cosmetics?|mascara)/i, label: "cosmetics" },
  { prompt: /(?:首饰|珠宝|项链|手链|耳环|jewelry|jewellery|necklace|bracelet|earrings?)/i, facts: /(?:首饰|珠宝|项链|手链|耳环|jewelry|jewellery|necklace|bracelet|earrings?)/i, label: "jewelry" },
  { prompt: /(?:剪刀|scissors?)/i, facts: /(?:剪刀|scissors?)/i, label: "scissors" },
  { prompt: /(?:药物|药品|药片|medicine|medication|tablets?|capsules?|(?:take|swallow|prescription)\s+(?:a\s+)?pills?)/i, facts: /(?:药物|药品|药片|medicine|medication|tablets?|capsules?|(?:take|swallow|prescription)\s+(?:a\s+)?pills?)/i, label: "medicine" },
  { prompt: /(?:婴儿|儿童|幼儿|孩子|baby|child|toddler|kid)/i, facts: /(?:婴儿|儿童|幼儿|孩子|baby|child|toddler|kid)/i, label: "child-related use" },
  { prompt: /(?:狗|猫|宠物|\bdog\b|\bcat\b|\bpet\b)/i, facts: /(?:狗|猫|宠物|\bdog\b|\bcat\b|\bpet\b)/i, label: "pet-related use" },
];

export function countEnglishWords(text) {
  return (String(text).match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
}

function normalizedWords(text) {
  return (String(text).toLowerCase().match(/[a-z]+(?:'[a-z]+)*/g) || []);
}

function ngrams(text, size = 4) {
  const words = normalizedWords(text);
  const result = new Set();
  for (let index = 0; index <= words.length - size; index += 1) result.add(words.slice(index, index + size).join(" "));
  return result;
}

export function jaccard(left, right) {
  const a = ngrams(left);
  const b = ngrams(right);
  if (!a.size && !b.size) return 1;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function sectionText(prompt, label, next) {
  const start = prompt.indexOf(label);
  const end = prompt.indexOf(next, start + label.length);
  if (start < 0 || end < 0) return "";
  return prompt.slice(start + label.length, end);
}

function productFacts(draft, slot) {
  const product = draft.products.find((item) => item.product_id === slot.product_id);
  if (!product) return "";
  return [product.product_name, product.product_info, ...(product.claims || []).map((claim) => claim.text)].join(" ");
}

function normalizeDialogue(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function extractStageDialogue(section) {
  const start = section.indexOf(STAGE_DIALOGUE_LABEL);
  if (start < 0) return "";
  return section
    .slice(start + STAGE_DIALOGUE_LABEL.length)
    .trim()
    .replace(/^[\s*_\x60"'“”‘’]+/, "")
    .replace(/[\s*_\x60"'“”‘’]+$/, "")
    .trim();
}

function containsEnglishInstructionProse(prompt, stageDialogues) {
  let instructions = String(prompt);
  for (const dialogue of stageDialogues) if (dialogue) instructions = instructions.replace(dialogue, "");
  instructions = instructions
    .replace(REQUIRED_USER_TEMPLATE_ZH, "")
    .replace(REQUIRED_PRODUCTION_LOCK_ZH, "")
    .replace(SCRIPT_LABEL, "")
    .replace(/\b(?:TikTok|UGC|iPhone|Lip-sync|AI|USB-C|USB|LED|MP4|Hook|Pain|Solution|Proof|CTA)\b/gi, "");
  return /(?:\b[A-Za-z]+(?:['’-][A-Za-z]+)?\b[\s,;:'"()/-]*){2,}/.test(instructions);
}

export function validatePromptBatch(draft, promptBatch) {
  const errors = [];
  if (!Array.isArray(promptBatch?.tasks) || promptBatch.tasks.some((task) => !task || typeof task !== "object" || Array.isArray(task))) return [{ field: "tasks", message: "tasks must be an array of task objects" }];
  if (promptBatch?.schema_version !== "1.0") errors.push({ field: "schema_version", message: "Must equal 1.0" });
  if (promptBatch?.batch_id !== draft.batch_id) errors.push({ field: "batch_id", message: "Does not match draft batch_id" });
  const expected = new Map(draft.task_slots.map((slot) => [slot.task_key, slot]));
  const received = new Map();

  for (const task of promptBatch?.tasks || []) {
    const key = String(task?.task_key || "");
    if (!expected.has(key)) {
      errors.push({ task_key: key, message: "Unknown task_key" });
      continue;
    }
    if (received.has(key)) errors.push({ task_key: key, message: "Duplicate task_key" });
    received.set(key, task);
    const prompt = String(task.prompt_en || "");
    const dialogue = String(task.dialogue_en || "").trim();
    if (!prompt || prompt.length > 6000) errors.push({ task_key: key, message: "prompt_en must contain 1-6000 characters" });
    let previous = -1;
    for (const label of LABELS) {
      const index = prompt.indexOf(label);
      if (index < 0) errors.push({ task_key: key, message: `Missing exact label: ${label}` });
      else if (index <= previous) errors.push({ task_key: key, message: `Label is out of order: ${label}` });
      previous = Math.max(previous, index);
    }
    const words = countEnglishWords(dialogue);
    if (isRepetitiveDialogue(dialogue)) errors.push({ task_key: key, message: "英文口播包含重复填充词或重复短语，必须重写为自然连贯的美式英语" });
    if (words < 100 || words > 115) errors.push({ task_key: key, message: `dialogue_en has ${words} words; expected 100-115` });
    if (!prompt.includes(REQUIRED_USER_TEMPLATE_ZH)) errors.push({ task_key: key, message: "Missing exact mandatory Chinese user template" });
    if (!prompt.includes(REQUIRED_PRODUCTION_LOCK_ZH)) errors.push({ task_key: key, message: "Missing exact mandatory Chinese production lock" });
    const persona = sectionText(prompt, PERSONA_LABEL, PRODUCT_SCENE_LABEL);
    if (persona.length < 80) errors.push({ task_key: key, message: "人物设定必须具体描述美国创作者的年龄/身份、外观、服装和口播状态" });
    for (const [label, pattern] of [
      ["年龄或人物身份", /(?:\d{2}\s*[—–-]\s*\d{2}\s*岁|美国|女性|男性|妈妈|爸爸|学生|上班族|租客|屋主)/],
      ["外观与真实质感", /(?:头发|发型|皮肤|毛孔|雀斑|胡茬|眼镜|素颜|妆)/],
      ["服装", /(?:身穿|穿着|卫衣|T恤|衬衫|毛衣|上衣|裤|短裤|裙)/],
      ["口播情绪与状态", /(?:语速|声音|语气|情绪|口吻|换气|手势)/],
    ]) if (!pattern.test(persona)) errors.push({ task_key: key, message: `人物设定缺少：${label}` });
    const productScene = sectionText(prompt, PRODUCT_SCENE_LABEL, SCRIPT_LABEL);
    if (productScene.length < 80) errors.push({ task_key: key, message: "产品与场景必须具体描述产品外观、事实相关家居空间、生活痕迹和环境声音" });
    for (const [label, pattern] of [
      ["产品外观或结构", /(?:产品|机身|材质|颜色|按钮|手柄|刷头|容器|结构|外形)/],
      ["事实相关家居空间", /(?:厨房|卧室|客厅|浴室|书房|家庭办公室|洗衣房|餐厅|玄关|家中|居家)/],
      ["真实生活痕迹", /(?:生活痕迹|使用痕迹|水渍|湿毛巾|台面|沙发|地毯|桌面|杯|杂物|凌乱|开封)/],
      ["维护良好的家居", /(?:维护良好|保养良好|干净完好|完整整洁)/],
      ["自然光与真实质感", /(?:侧窗|窗光|自然光)/],
      ["具体日常背景陈设", /(?:杯子|毛巾|书本|绿植|台灯|小型家电|咖啡机|靠垫|收纳篮)/],
      ["环境声音", /(?:环境音|白噪音|水流|水声|电机|脚步|布料|房间回音|生活声音)/],
    ]) if (!pattern.test(productScene)) errors.push({ task_key: key, message: `产品与场景缺少：${label}` });
    const sceneInstructions = prompt.replace(REQUIRED_PRODUCTION_LOCK_ZH, "");
    if (hasAffirmativeConcept(sceneInstructions, /(?:残破柜|破损柜|掉漆|开裂|发霉|垃圾堆积|空无一物|家徒四壁)/)) errors.push({ task_key: key, message: "家居场景包含破败或空置指令，与维护良好且有生活感的要求矛盾" });
    const stageDialogues = [];
    for (const rule of UGC_STAGE_RULES) {
      const section = sectionText(prompt, rule.label, rule.next);
      if (!section.includes(rule.marker)) errors.push({ task_key: key, message: `UGC stage violation: ${rule.label} must contain ${rule.marker}` });
      else if (!rule.evidence.test(section)) errors.push({ task_key: key, message: `UGC stage violation: ${rule.label} lacks visible human action` });
      if (!section.includes("镜头与动作：")) errors.push({ task_key: key, message: `时间脚本缺少镜头与动作：${rule.label}` });
      const stageDialogue = extractStageDialogue(section);
      stageDialogues.push(stageDialogue);
      const stageWords = countEnglishWords(stageDialogue);
      if (!stageDialogue) errors.push({ task_key: key, message: `时间脚本缺少逐段英文台词：${rule.label}` });
      else if (stageWords < rule.minWords || stageWords > rule.maxWords) errors.push({ task_key: key, message: `${rule.label} 英文台词为 ${stageWords} 词；应为 ${rule.minWords}-${rule.maxWords} 词` });
    }
    if (dialogue && normalizeDialogue(stageDialogues.join(" ")) !== normalizeDialogue(dialogue)) errors.push({ task_key: key, message: "dialogue_en 必须与五段“英文台词”按时间顺序逐字一致" });
    if (containsEnglishInstructionProse(prompt, stageDialogues)) errors.push({ task_key: key, message: "提示词说明必须全部使用中文；仅五段“英文台词”内容可使用英文" });
    for (const rule of UGC_STAGE_RULES) {
      const section = sectionText(prompt, rule.label, rule.next);
      const action = section.split(STAGE_DIALOGUE_LABEL)[0];
      if (hasAffirmativeConcept(action, HIDDEN_CREATOR_CONTRADICTION)) errors.push({ task_key: key, message: `UGC stage violation: ${rule.label} 镜头明确隐藏创作者，与真人可见性要求矛盾` });
      if (!VISIBLE_CREATOR_EVIDENCE.test(action)) errors.push({ task_key: key, message: `UGC stage violation: ${rule.label} 必须明确说明创作者的脸或上半身在画面中可见` });
    }
    const facts = productFacts(draft, expected.get(key));
    for (const concept of FACT_GATED_CONCEPTS) {
      if (hasAffirmativeConcept(prompt, concept.prompt) && !hasAffirmativeConcept(facts, concept.facts)) errors.push({ task_key: key, message: `Unsupported visual concept not found in supplied facts: ${concept.label}` });
    }
    const signature = String(task.creative_signature || "");
    const signatureParts = signature.split("|").map((part) => part.trim()).filter(Boolean);
    if (signatureParts.length !== 6) errors.push({ task_key: key, message: "creative_signature must contain six pipe-separated dimensions" });
    const assignment = expected.get(key).diversity_assignment;
    if (assignment) {
      const assignedParts = [assignment.persona, assignment.room, assignment.hook, assignment.demo, assignment.proof, assignment.cta];
      if (signatureParts.length === 6 && signatureParts.some((part, index) => part !== assignedParts[index])) errors.push({ task_key: key, message: `creative_signature must match assigned dimensions: ${assignedParts.join("|")}` });
    }
    const allowedClaims = new Set(expected.get(key).allowed_claim_ids);
    if (!Array.isArray(task.claim_ids) || !task.claim_ids.length) errors.push({ task_key: key, message: "claim_ids must contain at least one supplied claim" });
    for (const claimId of Array.isArray(task.claim_ids) ? task.claim_ids : []) if (!allowedClaims.has(claimId)) errors.push({ task_key: key, message: `Unknown claim ID: ${claimId}` });
    errors.push(...validateEvidenceBindings(draft, expected.get(key), task));
  }

  for (const key of expected.keys()) if (!received.has(key)) errors.push({ task_key: key, message: "Missing task" });

  for (const product of draft.products) {
    const siblings = (promptBatch?.tasks || []).filter((task) => expected.get(task.task_key)?.product_id === product.product_id);
    const signatures = new Set();
    const openings = new Set();
    const visualScripts = new Set();
    for (const task of siblings) {
      const visual = visualScript(task.prompt_en);
      if (visualScripts.has(visual)) errors.push({ task_key: task.task_key, message: "Duplicate visual script for product; changing signature or dialogue alone is not a new creative variant" });
      visualScripts.add(visual);
      const signature = String(task.creative_signature || "").toLowerCase();
      if (signatures.has(signature)) errors.push({ task_key: task.task_key, message: "Duplicate creative_signature for product" });
      signatures.add(signature);
      const opening = normalizedWords(task.dialogue_en).slice(0, 15).join(" ");
      if (openings.has(opening)) errors.push({ task_key: task.task_key, message: "Duplicate first 15 dialogue words for product" });
      openings.add(opening);
    }
    for (let left = 0; left < siblings.length; left += 1) {
      for (let right = left + 1; right < siblings.length; right += 1) {
        const similarity = jaccard(siblings[left].dialogue_en, siblings[right].dialogue_en);
        if (similarity >= 0.65) errors.push({ task_key: siblings[right].task_key, message: `Dialogue too similar to ${siblings[left].task_key}: ${similarity.toFixed(3)}` });
      }
    }
  }
  return errors;
}

export function calculateBatchIntegrityDigest(manifest) {
  const payload = {
    batch_id: manifest.batch_id,
    model: manifest.settings.model,
    duration: manifest.settings.duration,
    ratio: manifest.settings.ratio,
    resolution: manifest.settings.resolution,
    camera_movement: manifest.settings.camera_movement,
    tasks: manifest.tasks.map((task) => ({
      task_key: task.task_key,
      prompt_hash: sha256(task.prompt_en),
      images: task.images,
    })),
  };
  if (manifest.prompt_review?.sha256) payload.semantic_review_hash = manifest.prompt_review.sha256;
  if (manifest.reference_image_review) payload.reference_image_review_hash = sha256(stableStringify(manifest.reference_image_review));
  if (manifest.prompt_batch) payload.prompt_batch_hash = sha256(stableStringify(manifest.prompt_batch));
  return sha256(stableStringify(payload));
}

// Backward-compatible export for older manifests and external test fixtures.
// This value is an integrity checksum; it is no longer a user-approval token.
export const calculateApprovalDigest = calculateBatchIntegrityDigest;


// These are deliberately conservative structural checks, not a semantic fact checker.
function hasAffirmativeConcept(text, pattern) {
  const matches = String(text).matchAll(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  for (const match of matches) {
    const prefix = String(text).slice(Math.max(0, match.index - 40), match.index);
    if (/(?:禁止|严禁|避免|不要|不得|无需|不|without\b|no\b|never\b|not\b|don't\b|do not\b)(?:使用|出现|加入|展示|添加|涉及|接触)?\s*[^，,;；。!?\n]{0,12}$/i.test(prefix)) continue;
    return true;
  }
  return false;
}

function isRepetitiveDialogue(text) {
  const words = normalizedWords(text);
  if (words.length < 30) return false;
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  if (counts.size / words.length < 0.3 || Math.max(...counts.values()) / words.length > 0.18) return true;
  const phrases = new Map();
  for (let i = 0; i <= words.length - 4; i += 1) {
    const phrase = words.slice(i, i + 4).join(" ");
    phrases.set(phrase, (phrases.get(phrase) || 0) + 1);
  }
  return [...phrases.values()].some((count) => count >= 4);
}

function visualScript(prompt) {
  const text = String(prompt || "");
  return [sectionText(text, PERSONA_LABEL, PRODUCT_SCENE_LABEL), sectionText(text, PRODUCT_SCENE_LABEL, SCRIPT_LABEL),
    ...UGC_STAGE_RULES.map((rule) => sectionText(text, rule.label, rule.next).split(STAGE_DIALOGUE_LABEL)[0]),
  ].join("\n").replace(/\s+/g, "").trim();
}

function validateEvidenceBindings(draft, slot, task) {
  const errors = [];
  const add = (message) => errors.push({ task_key: task.task_key, message });
  const prompt = String(task.prompt_en || "");
  const sections = {
    persona: sectionText(prompt, PERSONA_LABEL, PRODUCT_SCENE_LABEL),
    room: sectionText(prompt, PRODUCT_SCENE_LABEL, SCRIPT_LABEL),
    hook: sectionText(prompt, UGC_STAGE_RULES[0].label, UGC_STAGE_RULES[0].next).split(STAGE_DIALOGUE_LABEL)[0],
    demo: sectionText(prompt, UGC_STAGE_RULES[2].label, UGC_STAGE_RULES[2].next).split(STAGE_DIALOGUE_LABEL)[0],
    proof: sectionText(prompt, UGC_STAGE_RULES[3].label, UGC_STAGE_RULES[3].next).split(STAGE_DIALOGUE_LABEL)[0],
    cta: sectionText(prompt, UGC_STAGE_RULES[4].label, UGC_STAGE_RULES[4].next).split(STAGE_DIALOGUE_LABEL)[0],
  };
  for (const dimension of CREATIVE_DIMENSIONS) {
    const plan = task.creative_plan?.[dimension];
    if (!plan || typeof plan.assignment !== "string" || plan.assignment !== slot.diversity_assignment?.[dimension]) add(`creative_plan.${dimension}.assignment must match the task slot`);
    if (typeof plan?.evidence !== "string" || plan.evidence.trim().length < 8 || !sections[dimension].includes(plan.evidence)) add(`creative_plan.${dimension}.evidence must quote at least 8 characters from its actual instruction section`);
  }
  const product = draft.products.find((item) => item.product_id === slot.product_id);
  if (!Array.isArray(task.fact_bindings) || !task.fact_bindings.length) {
    add("fact_bindings must trace claims, actions, and props to exact supplied fact quotations");
    return errors;
  }
  const boundClaims = new Set();
  let hasAction = false;
  for (const binding of task.fact_bindings) {
    if (!binding || !["claim", "action", "prop"].includes(binding.kind)) { add("fact_bindings.kind must be claim, action, or prop"); continue; }
    if (typeof binding.prompt_quote !== "string" || binding.prompt_quote.trim().length < 4 || !prompt.includes(binding.prompt_quote)) add("fact_bindings.prompt_quote must be an exact nonempty quotation from this prompt");
    let source = "";
    if (binding.source_type === "product_name") source = product?.product_name || "";
    else if (binding.source_type === "product_info") source = product?.product_info || "";
    else if (binding.source_type === "claim") {
      source = product?.claims?.find((claim) => claim.id === binding.claim_id)?.text || "";
      if (!(Array.isArray(task.claim_ids) && task.claim_ids.includes(binding.claim_id))) add("fact_bindings.claim_id must be listed in this task's claim_ids");
      if (source) boundClaims.add(binding.claim_id);
    } else add("fact_bindings.source_type must be product_name, product_info, or claim");
    if (typeof binding.source_quote !== "string" || binding.source_quote.trim().length < 2 || !source.includes(binding.source_quote)) add("fact_bindings.source_quote must be an exact quotation from the specified supplied source");
    if (binding.kind === "action") hasAction = true;
  }
  for (const claimId of Array.isArray(task.claim_ids) ? task.claim_ids : []) if (!boundClaims.has(claimId)) add(`Used claim ${claimId} is missing an exact source binding`);
  if (!hasAction) add("fact_bindings must include the demonstrated action; semantic review must check completeness for all actions and props");
  return errors;
}

export function calculateSemanticTaskHash(draft, task) {
  const slot = draft.task_slots?.find((item) => item.task_key === task.task_key);
  const product = draft.products?.find((item) => item.product_id === slot?.product_id);
  return sha256(stableStringify({ prompt_contract_version: PROMPT_CONTRACT_VERSION, batch_id: draft.batch_id, task, slot, product }));
}

export function calculateSemanticReviewHash(review) {
  return sha256(stableStringify(review));
}

// This checks the review record against the reviewed inputs; it does not authenticate
// reviewer identity or semantic judgement. Independent review is a workflow duty.
export function validateSemanticReview(draft, promptBatch, review, { allowTestFixture = false } = {}) {
  const errors = [];
  const add = (message, key) => errors.push({ ...(key ? { task_key: key } : {}), field: "semantic_review", message });
  if (!review || typeof review !== "object" || Array.isArray(review)) return [{ field: "semantic_review", message: "An independent semantic review sidecar is required" }];
  if (review.schema_version !== "1.0") add("Semantic review schema_version must equal 1.0");
  if (review.batch_id !== draft.batch_id) add("Semantic review batch_id does not match the draft");
  if (review.prompt_contract_version !== PROMPT_CONTRACT_VERSION) add("Semantic review contract version is stale");
  if (review.test_fixture === true && !allowTestFixture) add("TEST_FIXTURE review cannot authorize real production work");
  if (!Array.isArray(review.tasks)) { add("Semantic review tasks must be an array"); return errors; }
  if (!Array.isArray(promptBatch?.tasks)) { add("Prompt batch tasks must be an array before semantic review"); return errors; }
  if (promptBatch.tasks.some((task) => !task || typeof task !== "object" || Array.isArray(task))) return [{ field: "tasks", message: "tasks must contain task objects" }];
  const expected = new Map(promptBatch.tasks.map((task) => [task.task_key, task]));
  const seen = new Set();
  for (const item of review.tasks) {
    const key = item?.task_key;
    if (!expected.has(key)) { add("Unknown task in semantic review", key); continue; }
    if (seen.has(key)) add("Duplicate task in semantic review", key);
    seen.add(key);
    if (item.task_hash !== calculateSemanticTaskHash(draft, expected.get(key))) add("Semantic review task hash is stale or does not match all prompt, plan, and fact inputs", key);
    const reviewer = item.reviewer;
    if (!reviewer || typeof reviewer.id !== "string" || reviewer.id.trim().length < 3 || !["human", "agent"].includes(reviewer.kind) || reviewer.independent_of_author !== true || typeof reviewer.method !== "string" || reviewer.method.trim().length < 20) add("Each task needs an identified independent reviewer and a concrete review method", key);
    if (typeof item.reviewed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(item.reviewed_at) || !Number.isFinite(Date.parse(item.reviewed_at))) add("Semantic review must have a valid ISO reviewed_at timestamp", key);
    if (item.verdict !== "approved") add("Semantic review must explicitly approve the task", key);
    if (!Array.isArray(item.findings) || item.findings.length) add("Semantic review has unresolved findings or is missing its findings list", key);
    for (const name of REVIEW_CHECKS) {
      const check = item.checks?.[name];
      if (check?.ok !== true || typeof check.evidence !== "string" || check.evidence.trim().length < 20) add(`Semantic review ${name} must pass with a concrete evidence explanation`, key);
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) add("Missing task in independent semantic review", key);
  return errors;
}
