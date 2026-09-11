// TEST FIXTURES ONLY. These review records are synthetic, never production approvals.
import { countEnglishWords, calculateSemanticTaskHash, PROMPT_CONTRACT_VERSION, REQUIRED_USER_TEMPLATE_ZH, REQUIRED_PRODUCTION_LOCK_ZH } from "./prompts.mjs";

const PERSONAS = {
  renter: "26—30岁美国租客女性，刚搬入公寓，习惯把使用中的物品放在手边",
  "busy-adult": "34—39岁美国忙碌上班族男性，回家后整理当天使用的物品",
  student: "21—25岁美国大学生女性，在租住的家中完成课程和日常整理",
  "home-organizer": "38—43岁美国居家整理爱好者男性，喜欢给常用物品确定固定位置",
  "first-apartment": "25—29岁美国首次独居的女性，正在建立自己的居家使用习惯",
  "remote-worker": "30—35岁美国远程工作者男性，在家中工作后收拾使用区域",
  "practical-minimalist": "42—47岁美国务实极简生活者女性，只保留经常使用的物品",
  "busy-parent": "35—40岁美国有家庭的上班族男性，利用休息时间整理自己的使用区域",
  "everyday-user": "28—33岁美国普通居家使用者女性，正在分享当天实际使用的过程",
  "practical-shopper": "40—45岁美国实用型消费者男性，关注日常操作是否符合自身习惯",
};
const ROOMS = { "home-office": "家庭办公室的书桌", "living-room": "客厅的桌面", entryway: "玄关的桌面", kitchen: "厨房的台面", "dining-area": "家庭餐厅的桌面", bedroom: "卧室的桌面", closet: "卧室衣柜旁的桌面", bathroom: "浴室的台面", "laundry-area": "洗衣房的台面", garage: "家中车库的工作台" };
const HOOKS = {
  confession: "创作者略带不好意思地承认自己总把物品散放，随后抬眼对镜介绍当前做法",
  "relatable-mistake": "创作者刚伸错手便停下来，笑着对镜指出自己重复发生的小失误",
  "unexpected-result": "创作者先展示目前可见的使用状态，挑眉对镜分享这个普通发现",
  "problem-question": "创作者看向当前使用区域，张开手掌直接对镜问出自己的日常困扰",
  "friend-tip": "创作者靠近一步，像提醒熟悉的朋友一样，对镜介绍今天使用的小方法",
  "skeptical-discovery": "创作者先露出犹豫表情，再低头看产品，直接对镜解释自己的实际尝试",
  "routine-interruption": "创作者在自己的日常动作中停下，抬眼对镜指出值得展示的使用步骤",
  "before-after": "创作者保持连续出镜，用手指出当前使用状态，再对镜介绍自己刚刚完成的动作",
  "small-annoyance": "创作者轻轻皱眉指出使用区域的小烦恼，然后放松表情与镜头交流",
  "wish-I-knew": "创作者轻笑并抬起产品，直接对镜说明自己希望早点形成的日常习惯",
};
const DEMOS = {
  "real-use": "按照实际用途直接完成一次操作，手势清楚而克制",
  "close-handling": "将产品稍微靠近镜头并实际操作，镜头仍保留创作者的脸和上半身",
  "guided-placement": "先指示放置位置，再慢慢移动产品到该位置完成操作",
  "routine-integration": "沿用自己平时的站姿和使用顺序，自然完成一次日常操作",
  "problem-replay": "轻轻重现刚才的日常操作不便，再用当前产品完成相同步骤",
  "side-by-side": "在同一连续画面内指向使用区域与产品当前位置，亲手完成操作，不增加第二件产品",
  storage: "先将常用物品逐一放入产品，再指出集中存放的位置",
  cleanup: "按提供的清洁用途完成一次实际清理，不添加清洁剂",
  "fit-check": "依照已提供的尺寸信息在使用位置检查产品是否能正常放置",
  setup: "依照表格给出的安装方式完成一次设置，不增加未提供的零件",
  unbox: "依照表格提供的包装信息打开外包装后展示产品",
};
const PROOFS = {
  "visible-mechanism": "用手指出产品当前工作方式中能直接看见的部分",
  "use-state-change": "保持连续画面指出操作过程中可见的使用状态变化",
  "specific-feature": "停住手指，清楚指示表格卖点对应的那个可见特点",
  "objection-handling": "用当前画面回答自己的使用疑问，只描述眼前能够确认的状态",
  "lived-result": "按刚刚实际使用的顺序回看结果，给出范围有限的个人观察",
  "cleanup-result": "靠近指出刚完成清洁的使用区域，不承诺未提供的效果",
  "fit-result": "指出按提供尺寸放置后的状态，不宣称适合其他未说明的尺寸",
  "organization-result": "沿着集中存放的物品轻轻指示，让镜头看清它们的位置",
};
const CTAS = {
  "low-pressure": "轻轻点头，表示是否适合取决于观众自己的使用习惯，以低压力口吻结束",
  "save-for-later": "抬手示意可以先记住这个方法，有相同需求时再回来看",
  "same-problem": "对镜提起相同的小困扰，让有类似情况的人自行考虑这个方法",
  "routine-upgrade": "带着轻松笑容回到日常动作，建议把这个小步骤纳入自己的习惯",
  "worth-a-look": "微微抬起产品，让感兴趣的人看看实际使用方式再自行决定",
  "friend-recommendation": "像向朋友分享经验一样，说出自己会保留这个做法的原因",
  "try-it": "示意可以参考刚才的实际步骤，是否采用由观众自行决定",
  "keep-in-mind": "自然耸肩并点头，提醒有相同需求时可以想起这个使用方法",
  "simple-switch": "回到使用位置，建议从当前一个小步骤开始调整日常习惯",
  "problem-solved": "再次看向眼前的使用状态，再转回镜头，以实际体验轻松收尾",
};
const HOOK_LINES = [
  "I used to leave my desk stuff everywhere, and honestly, this little tray gave me one place to start.",
  "You know when you reach across your desk and the thing you wanted is sitting somewhere completely different again?",
  "Look at this corner of my desk now; everything I just put down is together in this little tray.",
  "Why do I keep spreading the same few things across my desk when I only need one spot for them?",
  "Come look at the tiny change I made here; I am just giving my everyday desk items a place.",
  "I wasn't looking for another desk thing, but I wanted somewhere to gather the items I already use daily.",
  "Hold on, before I start working again, let me show you what I do with these loose desk items.",
  "Here's where my desk items ended up after I gathered them, and you can see the entire process here.",
  "It's such a small annoyance, but I kept leaving these things spread out instead of putting them together here.",
  "I wish I'd started giving my desk items a regular spot sooner, because this is how I'm using it.",
];
const PAIN_LINES = [
  "I would set something down, move another thing over, and leave the whole group scattered across the space where I work.",
  "When I'm finished with something, my habit is to leave it right there instead of keeping the things I use together.",
  "Nothing dramatic was happening here; I just didn't have a regular place for the little items I keep on my desk.",
  "Watch where my hand goes first, because that's usually where I leave things, and then they end up spread around again.",
  "This is the part of my routine I wanted to change: putting each desk item down wherever my hand happened to land.",
];
const SOLUTION_LINES = [
  "Now I put the tray here, gather these desk items with my hands, and place them together inside it while keeping everything right in front of me.",
  "I bring the tray into my usual desk area and put the items I'm using inside, one at a time, so you can follow what I'm doing.",
  "All I'm doing is choosing a spot for this tray and moving the loose desk items into it, instead of leaving each one somewhere around the surface.",
  "Let me move this over and show you: the tray sits here while I gather these items, then I put them inside together as part of my routine.",
  "I keep the tray within my working area, pick up the desk items that are spread out, and place them into the same spot with my hands.",
];
const PROOF_LINES = [
  "You can see the items sitting together right here. That's the result I'm showing, just one place for the things that were spread across my desk.",
  "I'm pointing at the group inside the tray now, so you can see where everything I just moved ended up without changing to a different shot.",
  "Here is what I mean by keeping things together: these desk items are inside the tray, and I'm showing their actual position with my hand.",
  "The visible difference is simply where these items are sitting. I gathered them into the tray, and that's the actual result you can see beside me.",
  "I'm looking back at the items I just placed here. They're grouped inside this tray, which is exactly the little change I wanted for my desk.",
];
const CTA_LINES = [
  "If that fits how you use your desk, this is a simple idea you could keep in mind.",
  "You can save this idea for later, whenever you feel like giving your desk items a regular spot.",
  "If you do the same thing with your desk stuff, maybe this way of grouping it makes sense.",
  "I'm keeping this little step in my routine, and you can see if it fits yours as well.",
  "Have a look at how I'm using it, and decide whether that would work for your own desk.",
  "That's what I'd tell a friend: give the items you already use a place to sit together here.",
  "You could try grouping your own desk items like this and see how that fits your everyday routine.",
  "Keep it in mind the next time your desk items end up spread around the space you use.",
  "For me, it's just one small switch in where I put things when I'm using my desk today.",
  "That handles the little desk habit I was showing you, and now I'm getting back to my day.",
];
const FROTHER_LINES = [
  [
    "Let me show you how I'm using this little frother with milk here in my kitchen today.",
    "I wanted to show the actual stirring step up close, while keeping the cup right here where I can hold it steady.",
    "I lower the stirring head into the milk, press the single button, and let it work while you watch my hands and the cup beside me.",
    "Look at the foam you can see in the cup now. I'm only pointing out this visible change as I finish this actual stirring step.",
    "If that's part of your kitchen routine, you can keep this little demonstration in mind for another day.",
  ],
  [
    "Here's the cup after I started stirring, and I'm going to show you exactly what I'm doing with this frother.",
    "Instead of talking over a separate product shot, I'm keeping the cup beside me so you can follow the stirring step as it happens.",
    "My hand holds the cup here while I place the head inside, use the single button, and stir the milk with the frother in this continuous shot.",
    "You can see foam in the cup while I'm holding it steady. That's the visible result I'm describing, without promising anything beyond this actual demonstration.",
    "This is how I'm using it today; have a look and see whether the same step fits your routine.",
  ],
];

export function createPromptFixture(draft, slot, index = 0) {
  const product = draft.products.find((item) => item.product_id === slot.product_id);
  const frother = /奶泡/.test(product.product_name);
  const variant = (slot.variant_no || index + 1) - 1;
  const a = slot.diversity_assignment;
  const parts = frother ? [...FROTHER_LINES[variant % 2]] : [HOOK_LINES[variant % 10], PAIN_LINES[variant % 5], SOLUTION_LINES[variant % 5], PROOF_LINES[(variant + 2) % 5], CTA_LINES[variant % 10]];
  const dialogue = parts.join(" ");
  const counts = parts.map(countEnglishWords);
  const bounds = [[12,22],[15,25],[20,32],[18,30],[10,20]];
  if (counts.some((n,i) => n < bounds[i][0] || n > bounds[i][1]) || countEnglishWords(dialogue) < 100 || countEnglishWords(dialogue) > 115) throw new Error(`Fixture dialogue lengths ${variant}: ${counts.join(",")} = ${countEnglishWords(dialogue)}`);
  const persona = `${PERSONAS[a.persona] || PERSONAS["everyday-user"]}；短发或自然扎起的头发，保留真实皮肤纹理和轻微毛孔，身穿普通${variant % 2 ? "深蓝色衬衫与灰色长裤" : "灰色卫衣与黑色长裤"}。语速偏快、声音轻松且略兴奋，像临时叫朋友来看实际使用；换气、表情、眨眼和手势自然。`;
  const room = `真实美式${ROOMS[a.room] || "家中的桌面"}`;
  const productDescription = frother ? "表格中的手持奶泡器保持参考图所示颜色、结构和外形，单按键控制搅拌头，用于搅打杯内牛奶。" : "表格中的桌面收纳产品保持参考图所示颜色、材质、结构与外形，用于将桌面物品集中放置。";
  const productScene = `${productDescription}场景为${room}，维护良好的家具与完整整洁的桌面，保留正常使用痕迹；背景有少量书本和一盏台灯，仅作日常背景陈设，不参与演示；柔和侧窗自然光，保留真实纹理。收录房间环境音、脚步和${frother ? "搅拌头搅打杯内牛奶的声音" : "物品放入产品的声音"}，不用白底或影棚陈设。`;
  const actions = [
    `朋友手持镜头靠近，同一创作者从第一帧露脸并直接对镜口播。${HOOKS[a.hook] || HOOKS.confession}，视线在镜头与产品间自然移动。`,
    `创作者的脸和上半身保持在画面中，亲手${frother ? "拿稳装有牛奶的杯子，指示接下来搅打的位置" : "指出桌面物品散放的状态，伸手把它们移到自己面前"}，${variant % 2 ? "略微耸肩再抬眼看镜头" : "轻轻挑眉后低头看正在操作的位置"}。`,
    `创作者的脸和上半身继续可见，双手亲自${frother ? "把搅拌头放入杯中牛奶，按下单按键完成搅打" : "把桌面物品放进产品，集中放置在同一位置"}。${DEMOS[a.demo] || DEMOS["real-use"]}。`,
    `同一创作者的脸和上半身保持在画面中，${frother ? "用手指出杯内可见的泡沫变化" : "用手指出物品集中在产品中的可见状态"}。${PROOFS[a.proof] || PROOFS["lived-result"]}，不做商业化蒙太奇。`,
    `创作者拿着产品重新稳定对镜，脸在最后一帧仍清楚可见。${CTAS[a.cta] || CTAS["low-pressure"]}。`,
  ];
  const labels = ["0—5秒（Hook）", "5—11秒（Pain）", "11—18秒（Solution）", "18—25秒（Proof）", "25—30秒（CTA）"];
  const prompt = [REQUIRED_USER_TEMPLATE_ZH, `人物设定：${persona}`, `产品与场景：${productScene}`, "脚本结构与执行（Hook - Pain - Solution - Proof - CTA）：", ...labels.flatMap((label,i) => [label, [0,4].includes(i) ? "真人出镜：" : "创作者实操：", `镜头与动作：${actions[i]}`, `英文台词：“${parts[i]}”`]), REQUIRED_PRODUCTION_LOCK_ZH].join("\n");
  const evidence = {persona,room,hook:actions[0],demo:actions[2],proof:actions[3],cta:actions[4]};
  const creativePlan = Object.fromEntries(Object.keys(evidence).map((key) => [key,{assignment:a[key],evidence:evidence[key]}]));
  const claims = product.claims.map((claim) => claim.id);
  const factBindings = [
    ...product.claims.map((claim) => ({kind:"claim",prompt_quote:frother ? (claim.id === "C01" ? "单按键控制搅拌头" : "用手指出杯内可见的泡沫变化") : "用于将桌面物品集中放置",source_type:"claim",claim_id:claim.id,source_quote:claim.text})),
    {kind:"action",prompt_quote:frother ? "把搅拌头放入杯中牛奶，按下单按键完成搅打" : "把桌面物品放进产品，集中放置在同一位置",source_type:"product_info",source_quote:product.product_info},
    {kind:"prop",prompt_quote:frother ? "装有牛奶的杯子" : "桌面物品",source_type:"product_info",source_quote:product.product_info},
  ];
  return {task_key:slot.task_key,creative_signature:Object.values(a).join("|"),creative_plan:creativePlan,fact_bindings:factBindings,claim_ids:claims,dialogue_en:dialogue,prompt_en:prompt};
}

export function createTestSemanticReview(draft, promptBatch) {
  return {schema_version:"1.0",batch_id:draft.batch_id,prompt_contract_version:PROMPT_CONTRACT_VERSION,test_fixture:true,tasks:promptBatch.tasks.map((task) => ({
    task_key:task.task_key,task_hash:calculateSemanticTaskHash(draft,task),
    reviewer:{id:"TEST_FIXTURE_ONLY_mock_reviewer",kind:"agent",independent_of_author:true,method:"Synthetic test record for deterministic local mock tests only; no human or agent semantic approval is asserted."},
    reviewed_at:"2026-09-05T00:00:00.000Z",verdict:"approved",findings:[],
    checks:{
      factual_support:{ok:true,evidence:"TEST FIXTURE ONLY: exact input quotations and provided product actions are used in this controlled test data."},
      creator_visibility:{ok:true,evidence:"TEST FIXTURE ONLY: every fixture action explicitly retains the creator's face and upper body in the shot."},
      creative_alignment:{ok:true,evidence:"TEST FIXTURE ONLY: fixture instruction dictionaries vary the creator, hook, actions, and ending with assigned dimensions."},
      home_visual_quality:{ok:true,evidence:"TEST FIXTURE ONLY: maintained furniture, a few background books and lamp, soft window light and natural phone texture are described."},
      natural_dialogue:{ok:true,evidence:"TEST FIXTURE ONLY: authored five-stage English sentences describe the product operation instead of filler tokens."},
    },
  }))};
}

export function createTestImageReview(draft) {
  return { schema_version: "1.0", batch_id: draft.batch_id, test_fixture: true,
    images: [...new Set(draft.products.flatMap(p => p.images.map(i => i.sha256)).filter(Boolean))].map(hash => ({
      sha256: hash, verdict: "no_face", reviewer: "TEST_FIXTURE_ONLY", reviewed_at: "2026-09-07T00:00:00.000Z",
      evidence: "TEST FIXTURE ONLY: synthetic local fixture bytes; no actual visual review is asserted."
    })) };
}
