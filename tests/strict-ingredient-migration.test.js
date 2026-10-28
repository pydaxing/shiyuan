import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../scripts/normalize-community-recipes.mjs';
import {makeStrictPlan,strictDataUpdate,strictInventory,reconcileStrictScope} from '../scripts/normalize-strict-ingredient-data.mjs';
const recipe=()=>({id:'r1',title:'示例菜谱',ingredients:[{name:'香菜',quantity:null,unit:'',amountText:'1把'}],steps:[{title:'拌匀',text:'洗净后拌匀'}]});
function fixture(){const before={_id:'recipe-doc',familyId:'family-a',value:recipe()};const raw={target:{appid:'wx1fe9d6db08a0e91b',env:'cloudbase-d8gqg3oqed7609824'},scopes:{recipes:{}},collections:{recipes:[before],families:[{_id:'family-a',revision:1}]}};const backup={...raw,digest:digest(raw)};return {before,plan:makeStrictPlan(backup)};}
test('strict migration rejects a concurrent quantity edit instead of overwriting it',()=>{const {before,plan}=fixture();const changed=structuredClone(before);changed.value.ingredients[0].amountText='2把';assert.throws(()=>strictDataUpdate(plan.operations[0],changed),/计划外变化/);});
test('strict migration rejects ownership and recipe body changes',()=>{const {before,plan}=fixture();const changed=structuredClone(before);changed.familyId='family-b';assert.throws(()=>strictDataUpdate(plan.operations[0],changed),/归属/);changed.familyId=before.familyId;changed.value.steps[0].text='新做法';assert.throws(()=>strictDataUpdate(plan.operations[0],changed),/其他内容变化/);});
test('strict migration preserves unrelated metadata while guarding the entire recipe JSON',()=>{const {before,plan}=fixture();const op=plan.operations[0];const current={...before,externalCounter:3};const prepared=strictDataUpdate(op,current);assert.equal(prepared.expected.externalCounter,3);assert.deepEqual(Object.keys(prepared.update.$set),['value.ingredients']);assert.ok(prepared.query.$expr);assert.ok(JSON.stringify(prepared.query.$expr).includes('$objectToArray'));assert.deepEqual(prepared.expected.value.ingredients,[{name:'香菜',quantity:1,unit:'把'}]);});
test('a resumed document in the exact planned amount state is skipped',()=>{const {plan}=fixture();const op=plan.operations[0];assert.equal(strictDataUpdate(op,op.after).alreadyApplied,true);});
test('final strict inventory rejects hidden units and nonpreset text even if normal app validation accepts them',()=>{const doc=recipe();doc.ingredients=[{name:'盐',quantity:1,unit:'小勺'}];assert.throws(()=>strictInventory({recipes:[{value:doc}]}));doc.ingredients=[{name:'盐',quantity:null,unit:'',amountText:'1勺'}];assert.throws(()=>strictInventory({recipes:[{value:doc}]}));});
test('share identity and revocation changes invalidate an ingredient migration',()=>{
  const before={_id:'share-doc',familyId:'family-a',createdBy:'member-a',expiresAt:Date.now()+86400000,post:{id:'post-a',familyId:'family-a',recipes:[recipe()]}};
  const raw={target:{appid:'wx1fe9d6db08a0e91b',env:'cloudbase-d8gqg3oqed7609824'},scopes:{shares:{}},collections:{shares:[before],families:[]}};
  const op=makeStrictPlan({...raw,digest:digest(raw)}).operations[0];
  for(const key of ['id','familyId']){const changed=structuredClone(before);changed.post[key]='different';assert.throws(()=>strictDataUpdate(op,changed),/其他内容变化/);}
  assert.throws(()=>strictDataUpdate(op,{...before,revoked:true}),/归属或状态变化/);
  assert.deepEqual(strictDataUpdate(op,before).query.revoked,{$exists:false});
});
test('concurrent conforming new recipes stay outside the frozen migration plan',()=>{
  const {before,plan}=fixture();
  const fresh={_id:'new-recipe',familyId:'other-family',value:{...recipe(),ingredients:[{name:'胡萝卜',quantity:1/3,unit:'根'}]}};
  const snapshot=structuredClone(fresh);
  assert.deepEqual(reconcileStrictScope('recipes',[before,fresh],[before]),['new-recipe']);
  assert.deepEqual(fresh,snapshot);
  assert.equal(plan.operations.length,1);
  fresh.value.ingredients[0]={name:'胡萝卜',quantity:null,unit:'',amountText:'原文未注明'};
  assert.throws(()=>reconcileStrictScope('recipes',[before,fresh],[before]));
});
test('scope reconciliation refuses disappeared or duplicate records',()=>{
  const {before}=fixture();
  assert.throws(()=>reconcileStrictScope('recipes',[],[before]),/减少/);
  assert.throws(()=>reconcileStrictScope('recipes',[before,before],[before]),/重复/);
});
