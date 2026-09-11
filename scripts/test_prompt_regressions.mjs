#!/usr/bin/env node
import assert from "node:assert/strict";
import { calculateBatchIntegrityDigest, calculateSemanticTaskHash, calculateSemanticReviewHash, REQUIRED_PRODUCTION_LOCK_ZH, validatePromptBatch, validateSemanticReview } from "./lib/prompts.mjs";
import { createPromptFixture, createTestSemanticReview } from "./lib/test-fixtures.mjs";

const slots = [
  {task_key:"TRAY::V001",product_id:"TRAY",variant_no:1,allowed_claim_ids:["C01"],diversity_assignment:{persona:"renter",room:"home-office",hook:"confession",demo:"real-use",proof:"visible-mechanism",cta:"low-pressure"}},
  {task_key:"TRAY::V002",product_id:"TRAY",variant_no:2,allowed_claim_ids:["C01"],diversity_assignment:{persona:"busy-adult",room:"home-office",hook:"relatable-mistake",demo:"guided-placement",proof:"use-state-change",cta:"save-for-later"}},
];
const draft = {schema_version:"1.0",batch_id:"prompt-regressions",products:[{product_id:"TRAY",product_name:"Desk Tray",product_info:"A desk tray for small desk items.",claims:[{id:"C01",text:"Keeps desk items together"}],images:[]}],task_slots:slots};
const batch = {schema_version:"1.0",batch_id:draft.batch_id,tasks:slots.map((slot,index)=>createPromptFixture(draft,slot,index))};
const review = createTestSemanticReview(draft,batch);
const mockOptions = {allowTestFixture:true};
const tests=[];
function test(name, fn) {fn();tests.push(name);}
function mutate(fn) {const changed=structuredClone(batch);fn(changed.tasks[0],changed);return changed;}
function hasError(changed, pattern) {assert(validatePromptBatch(draft,changed).some((error)=>pattern.test(error.message)));}

test("natural-diverse-fixtures",()=>assert.deepEqual(validatePromptBatch(draft,batch),[]));
test("damaged-home-instructions-rejected",()=>hasError(mutate(task=>{task.prompt_en += "\n背景为残破柜门和发霉墙面。";}),/破败或空置/));
test("maintained-home-with-background-objects-is-accepted",()=>assert.deepEqual(validatePromptBatch(draft,batch),[]));
test("home-quality-review-is-required",()=>{
  const changed=structuredClone(review); delete changed.tasks[0].checks.home_visual_quality;
  assert(validateSemanticReview(draft,batch,changed,mockOptions).some(e=>/home_visual_quality/.test(e.message)));
});
test("explicit-independent-review-required",()=>assert(validateSemanticReview(draft,batch,null).length));
test("test-review-denied-by-default",()=>assert(validateSemanticReview(draft,batch,review).some(e=>/TEST_FIXTURE/.test(e.message))));
test("mock-review-explicitly-enabled",()=>assert.deepEqual(validateSemanticReview(draft,batch,review,mockOptions),[]));
test("face-invisible-is-not-visible",()=>{
  const changed=mutate(task=>{task.prompt_en=task.prompt_en.replace("创作者的脸和上半身保持在画面中，亲手", "创作者的脸不可见，仅背部在画面中，亲手");});
  hasError(changed,/明确隐藏创作者/);
});
test("hook-cannot-hide-creator",()=>hasError(mutate(task=>{task.prompt_en=task.prompt_en.replace("从第一帧露脸并直接对镜口播","从第一帧不露脸，仅拍双手");}),/明确隐藏创作者/));
test("negative-prop-prohibition-not-an-unsupported-use",()=>{
  const changed=mutate(task=>{task.prompt_en=task.prompt_en.replace("换气、表情、眨眼和手势自然。","换气、表情、眨眼和手势自然。不使用化妆品。禁止出现宠物。");task.creative_plan.persona.evidence=task.creative_plan.persona.evidence.replace("换气、表情、眨眼和手势自然。","换气、表情、眨眼和手势自然。不使用化妆品。禁止出现宠物。");});
  assert.deepEqual(validatePromptBatch(draft,changed),[]);
});
test("actual-unsupported-unboxing-still-fails",()=>hasError(mutate(task=>{task.prompt_en+="\n创作者展示开箱和包装。";}),/packaging or unboxing/));
test("signature-evidence-cannot-be-unrelated-text",()=>hasError(mutate(task=>{task.creative_plan.persona.evidence="这段文字并不在实际人物设定中";}),/creative_plan.persona.evidence/));
test("signature-evidence-cannot-come-from-other-section",()=>hasError(mutate(task=>{task.creative_plan.persona.evidence=task.creative_plan.room.evidence;}),/creative_plan.persona.evidence/));
test("copying-visuals-and-changing-dialogue-is-not-a-variant",()=>{
  const changed=structuredClone(batch);const other=changed.tasks[1];const original=changed.tasks[0];
  const lines=other.prompt_en.match(/英文台词：[^\n]*/g);let i=0;
  other.prompt_en=original.prompt_en.replace(/英文台词：[^\n]*/g,()=>lines[i++]);
  other.creative_plan=structuredClone(original.creative_plan);
  for(const key of Object.keys(other.creative_plan)) other.creative_plan[key].assignment=slots[1].diversity_assignment[key];
  hasError(changed,/Duplicate visual script/);
});
test("repeated-filler-dialogue-rejected",()=>{
  const changed=mutate(task=>{task.dialogue_en=Array(105).fill("bright").join(" ");});
  hasError(changed,/重复填充词/);
});
test("repeated-phrase-dialogue-rejected",()=>hasError(mutate(task=>{task.dialogue_en=Array(21).fill("This is really very nice").join(" ");}),/重复填充词/));
test("fabric-pills-not-medicine-substring",()=>{
  const changed=mutate(task=>{task.prompt_en+="\n词汇边界检查：fabric pills。";});
  assert(!validatePromptBatch(draft,changed).some(e=>/medicine/.test(e.message)));
});
test("invented-source-quotation-rejected",()=>hasError(mutate(task=>{task.fact_bindings[0].source_quote="Kills all bacteria permanently";}),/source_quote/));
test("unbound-claim-rejected",()=>hasError(mutate(task=>{task.fact_bindings=task.fact_bindings.filter(binding=>binding.source_type!=="claim");}),/missing an exact source binding/));
test("claims-actions-props-need-bindings",()=>hasError(mutate(task=>{delete task.fact_bindings;}),/fact_bindings must trace/));
test("unsupported-medical-insertion-invalidates-semantic-review",()=>{
  const changed=mutate(task=>{task.prompt_en=task.prompt_en.replace("用于将桌面物品集中放置。","用于将桌面物品集中放置。采用纯钛材质，能够一夜治愈失眠、杀灭所有细菌，永久有效。");});
  assert(validateSemanticReview(draft,changed,review,mockOptions).some(e=>/task hash/.test(e.message)));
});
test("invented-props-insertion-invalidates-semantic-review",()=>{
  const changed=mutate(task=>{task.prompt_en+="\n再放入牛排、草莓和赠送的金属叉子。";});
  assert(validateSemanticReview(draft,changed,review,mockOptions).some(e=>/task hash/.test(e.message)));
});
test("fact-or-plan-edit-invalidates-review",()=>{
  const newDraft=structuredClone(draft);newDraft.products[0].claims[0].text="Changed fact";
  assert.notEqual(calculateSemanticTaskHash(draft,batch.tasks[0]),calculateSemanticTaskHash(newDraft,batch.tasks[0]));
  assert(validateSemanticReview(newDraft,batch,review,mockOptions).some(e=>/task hash/.test(e.message)));
  const changed=mutate(task=>{task.creative_plan.hook.assignment="friend-tip";});
  assert(validateSemanticReview(draft,changed,review,mockOptions).some(e=>/task hash/.test(e.message)));
});
test("review-must-cover-every-task-and-have-no-findings",()=>{
  const partial=structuredClone(review);partial.tasks.pop();assert(validateSemanticReview(draft,batch,partial,mockOptions).some(e=>/Missing task/.test(e.message)));
  const rejected=structuredClone(review);rejected.tasks[0].findings=["Unsupported product claim"];rejected.tasks[0].verdict="rejected";
  assert(validateSemanticReview(draft,batch,rejected,mockOptions).some(e=>/unresolved findings/.test(e.message)));
});
test("author-self-attestation-is-not-independent-review",()=>{
  const changed=structuredClone(review);changed.tasks[0].reviewer.independent_of_author=false;
  assert(validateSemanticReview(draft,batch,changed,mockOptions).some(e=>/independent reviewer/.test(e.message)));
});
test("missing-review-explanations-rejected",()=>{
  const changed=structuredClone(review);changed.tasks[0].checks.factual_support={ok:true,evidence:"ok"};
  assert(validateSemanticReview(draft,batch,changed,mockOptions).some(e=>/factual_support/.test(e.message)));
});
test("production-lock-still-exact",()=>hasError(mutate(task=>{task.prompt_en=task.prompt_en.replace(REQUIRED_PRODUCTION_LOCK_ZH,"");}),/mandatory Chinese production lock/));
test("integrity-digest-freezes-review-and-whole-prompt-batch",()=>{
  const manifest={batch_id:draft.batch_id,settings:{model:"seedance2.5",duration:30,ratio:"9:16",resolution:"720p",camera_movement:"auto"},tasks:batch.tasks.map(task=>({...task,images:[]})),prompt_batch:batch,prompt_review:{sha256:calculateSemanticReviewHash(review)}};
  const original=calculateBatchIntegrityDigest(manifest);const changed=structuredClone(manifest);changed.prompt_review.sha256="different";assert.notEqual(calculateBatchIntegrityDigest(changed),original);
  const changedPlan=structuredClone(manifest);changedPlan.prompt_batch.tasks[0].fact_bindings[0].source_quote="changed";assert.notEqual(calculateBatchIntegrityDigest(changedPlan),original);
});
test("malformed-task-records-return-validation-errors",()=>{
  for(const tasks of [[null],[{} ,null],[[]], ["invalid"]]) {
    const malformed={...batch,tasks};
    assert(validatePromptBatch(draft,malformed).length);
    assert(validateSemanticReview(draft,malformed,review,mockOptions).length);
  }
});
console.log(JSON.stringify({ok:true,count:tests.length,tests}));
