import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,unlink,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SELECTABLE_UNITS} from '../src/domain/kitchen.js';
import {createIdeClient,readCollection,assertNoUnresolvedWrite,ingredientRecipes,setIngredientFields} from './standardize-live-ingredients.mjs';
import {digest,exactJsonCondition,verifyPendingRecipeWrite} from './normalize-community-recipes.mjs';
import {documentDigest,assertStagedRecipe} from './admin-recipe-import.mjs';
import {strictIngredient,assertStrictIngredient} from './strict-ingredient-amounts.mjs';
const execute=promisify(execFile);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=async(file,value)=>{await writeFile(file+'.tmp',JSON.stringify(value,null,2),{mode:0o600});await rename(file+'.tmp',file);};
const saveNew=(file,value)=>writeFile(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const at=(value,field)=>field.split('.').reduce((a,k)=>a?.[k],value);
const bodyField=collection=>({recipes:'value',posts:'recipes',imports:'recipeDraft',shares:'post'})[collection];
function withoutIngredients(value){if(Array.isArray(value))return value.map(withoutIngredients);if(value&&typeof value==='object'){const out={};for(const [key,child]of Object.entries(value))if(key!=='ingredients')out[key]=withoutIngredients(child);return out;}return value;}
export function strictDataUpdate(operation,current){
  assert.equal(current?._id,operation.documentId);
  for(const key of ['id','familyId','publisherId','familyItemId','createdBy','expiresAt','revoked','kind','status'])assert.deepEqual(current[key],operation.before[key],`归属或状态变化: ${key}`);
  if(operation.collection==='shares')assert.ok(!current.revoked&&current.expiresAt>Date.now(),'分享已失效，停止修改');
  if(operation.collection==='imports')assertStagedRecipe(current);
  const parent=bodyField(operation.collection);assert.ok(parent);
  assert.deepEqual(withoutIngredients(at(current,parent)),withoutIngredients(at(operation.before,parent)),'菜谱其他内容变化，需要重审');
  const keys=Object.keys(operation.fields);
  const matches=doc=>keys.every(key=>isDeepStrictEqual(at(current,key),at(doc,key)));
  if(matches(operation.after))return {alreadyApplied:true,expected:current};
  assert.ok(matches(operation.before),`食材已发生计划外变化: ${operation.documentId}`);
  if(operation.collection==='imports')assert.deepEqual(current,operation.before,'暂存内容变化，不能使用旧摘要');
  const query={_id:operation.documentId};
  for(const key of ['familyId','publisherId','familyItemId','createdBy','expiresAt','kind','status','contentDigest'])if(current[key]!==undefined)query[key]=current[key];
  if(operation.collection==='shares')query.revoked=current.revoked===undefined?{$exists:false}:current.revoked;
  query.$expr=exactJsonCondition('$'+parent,at(current,parent));
  return {alreadyApplied:false,query,update:{$set:operation.fields},expected:setIngredientFields(current,operation.fields)};
}
export function makeStrictPlan(backup){
  const {digest:backupDigest,...body}=backup;assert.equal(backupDigest,digest(body));
  const operations=[],counts={};
  const families=new Map((backup.collections.families||[]).map(family=>[family._id,family]));
  for(const collection of ['recipes','posts','shares','imports']){
    const docs=backup.collections[collection];if(!docs)continue;
    counts[collection]={checkedDocuments:docs.length,changedDocuments:0,checkedIngredients:0,changedIngredients:0,additionalRows:0};
    for(const before of docs){
      const fields={},changes=[];
      for(const {field,recipe}of ingredientRecipes(collection,before)){
        const next=recipe.ingredients.flatMap((ingredient,index)=>{
          counts[collection].checkedIngredients++;
          const result=strictIngredient(ingredient,{title:recipe.title,recipe,steps:recipe.steps});
          result.ingredients.forEach(assertStrictIngredient);
          if(!isDeepStrictEqual([ingredient],result.ingredients))changes.push({field:field+'.ingredients.'+index,title:recipe.title,before:ingredient,after:result.ingredients,kind:result.kind,reason:result.reason});
          return result.ingredients;
        });
        assert.ok(next.length>0&&next.length<=30,`配料行数不支持: ${recipe.title} ${next.length}`);
        if(!isDeepStrictEqual(next,recipe.ingredients))fields[field+'.ingredients']=next;
      }
      if(!Object.keys(fields).length)continue;
      let after=setIngredientFields(before,fields);
      if(collection==='imports'){assertStagedRecipe(before);fields.contentDigest=documentDigest(after);after=setIngredientFields(before,fields);assertStagedRecipe(after);}
      if(collection==='recipes')assert.ok(families.has(before.familyId),'缺少菜谱所属家庭的状态备份');
      const operation={collection,documentId:before._id,...(collection==='recipes'?{familyId:before.familyId,ownerFamilyDeletedAt:families.get(before.familyId).deletedAt??null}:{}),before,after,fields,changes};
      strictDataUpdate(operation,before);
      operations.push(operation);
      counts[collection].changedDocuments++;counts[collection].changedIngredients+=changes.length;
      counts[collection].additionalRows+=changes.reduce((n,c)=>n+c.after.length-1,0);
    }
  }
  const plan={version:1,preparedAt:new Date().toISOString(),target:backup.target,scopes:backup.scopes,backupDigest,allowedUnits:SELECTABLE_UNITS,textPresets:['适量','少许'],counts,operations};
  return {...plan,digest:digest(plan)};
}
export function strictInventory(collections){
  const counts={};
  for(const [collection,docs]of Object.entries(collections)){
    if(collection==='families')continue;
    counts[collection]={documents:docs.length,ingredients:0,measured:0,preset:0};
    for(const d of docs)for(const {recipe}of ingredientRecipes(collection,d))for(const item of recipe.ingredients){assertStrictIngredient(item);counts[collection].ingredients++;counts[collection][item.amountText===undefined?'measured':'preset']++;}
  }
  return counts;
}
export function reconcileStrictScope(collection,current,baseline){
  const currentIds=new Set(current.map(row=>row._id));
  const baselineIds=new Set(baseline.map(row=>row._id));
  assert.equal(currentIds.size,current.length,collection+'记录ID重复');
  assert.equal(baselineIds.size,baseline.length,collection+'备份记录ID重复');
  assert.ok(baseline.every(row=>currentIds.has(row._id)),collection+'原范围记录减少，需要重审');
  const added=current.filter(row=>!baselineIds.has(row._id));
  strictInventory({[collection]:added});
  return added.map(row=>row._id);
}
async function executePlan(output,expectedDigest,{canary=false,verifyOnly=false}={}){
  await assertNoUnresolvedWrite(output);
  const plan=await json(path.join(output,'plan.json'));const {digest:savedDigest,...body}=plan;
  assert.equal(savedDigest,expectedDigest);assert.equal(savedDigest,digest(body));
  assert.deepEqual(plan.allowedUnits,SELECTABLE_UNITS);
  const config=await json('cloudbaserc.json');assert.equal(plan.target.env,config.envId);
  const env=await readFile('.env.production','utf8');assert.equal(plan.target.appid,env.match(/^WEIXIN_APPID=(.+)$/m)?.[1].trim());
  const backup=await json(path.join(output,'backup.json'));assert.equal(backup.digest,plan.backupDigest);
  const lock=await open(path.join(output,'write.lock'),'wx',0o600);
  const dir=path.join(output,'run-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(dir,{mode:0o700});
  await lock.writeFile(JSON.stringify({pid:process.pid,runDirectory:dir}));
  const receipt={target:plan.target,planDigest:savedDigest,runDirectory:dir,canary,verifyOnly,state:'preflight',startedAt:new Date().toISOString(),operations:[],familyRefreshes:[],scopeAdditions:{preflight:{},final:{}}};
  const saveReceipt=()=>save(path.join(dir,'receipt.json'),receipt);
  const call=createIdeClient(plan.target,dir,'/usr/local/bin/wechatide',output);
  let writeIndex=0;
  const one=async(collection,id)=>{const rows=await readCollection(call,collection,{_id:id});assert.equal(rows.length,1);return rows[0];};
  const dispatch=async(collection,id,prepared,entry)=>{
    const index=writeIndex++;
    const q=path.join(dir,`query-${index}.json`),u=path.join(dir,`update-${index}.json`);
    await saveNew(q,prepared.query);await saveNew(u,prepared.update);
    Object.assign(entry,{state:'dispatched_outcome_unknown',queryFile:q,updateFile:u});receipt.state='writing_not_verified';await saveReceipt();
    let taskId;
    try{await call('cloud_db_write_doc',['--action','update','--collection-name',collection,'--query-file',q,'--update-file',u]);}
    catch(error){if(!error.taskId)throw error;taskId=error.taskId;}
    const readback=async()=>{const actual=await one(collection,id);await saveNew(path.join(dir,`readback-${index}.json`),actual);return actual;};
    if(taskId){
      entry.taskId=taskId;await saveReceipt();let attempt=0;
      await verifyPendingRecipeWrite(taskId,{
        queryTask:async(original,remaining)=>{
          const {stdout}=await execute('/usr/local/bin/wechatide',['-c','Codex','polling_task_result','--task-id',original],{timeout:Math.min(30000,remaining),maxBuffer:2000000});
          const response=JSON.parse(stdout.slice(stdout.indexOf('{')));await saveNew(path.join(dir,`pending-${index}-${++attempt}.json`),response);return response;
        },readback,expected:prepared.expected,
        clearGuard:async(original)=>{const file=path.join(output,'write-reconciliation-required.json');const guard=await json(file);assert.equal(guard.taskId,original);assert.deepEqual(guard.target,plan.target);await unlink(file);}
      });
    }else assert.deepEqual(await readback(),prepared.expected,'即时回读不符');
    entry.state='verified';entry.verifiedAt=new Date().toISOString();await saveReceipt();
  };
  try{
    const selected=canary?plan.operations.slice(0,1):plan.operations;
    for(const op of selected.filter(x=>x.collection==='recipes')){
      const family=await one('families',op.familyId);
      assert.equal(family.deletedAt??null,op.ownerFamilyDeletedAt,'家庭存续状态变化，需要重审');
    }
    const currentCollections={};
    const requiredCollections=canary?[selected[0].collection]:Object.keys(plan.scopes);
    for(const collection of requiredCollections){
      currentCollections[collection]=await readCollection(call,collection,plan.scopes[collection]);
      receipt.scopeAdditions.preflight[collection]=reconcileStrictScope(collection,currentCollections[collection],backup.collections[collection]);
    }
    await saveNew(path.join(dir,'preflight-backup.json'),{target:plan.target,collections:currentCollections});
    for(const op of selected)strictDataUpdate(op,currentCollections[op.collection].find(x=>x._id===op.documentId));
    receipt.state='preflight_complete';await saveReceipt();
    for(const [index,op]of selected.entries()){
      const prior=currentCollections[op.collection].find(x=>x._id===op.documentId);
      const current=strictDataUpdate(op,prior).alreadyApplied?prior:await one(op.collection,op.documentId);
      const prepared=strictDataUpdate(op,current);
      if(op.collection==='recipes'&&!prepared.alreadyApplied){
        const family=await one('families',op.familyId);
        assert.equal(family.deletedAt??null,op.ownerFamilyDeletedAt,'写入前家庭存续状态变化');
      }
      if(verifyOnly)assert.equal(prepared.alreadyApplied,true,'仍有未应用字段');
      const entry={collection:op.collection,documentId:op.documentId};receipt.operations.push(entry);
      if(prepared.alreadyApplied){entry.state='already_verified';await saveReceipt();}
      else await dispatch(op.collection,op.documentId,prepared,entry);
      if((index+1)%20===0||index+1===selected.length)console.log(JSON.stringify({checked:index+1,total:selected.length}));
    }
    if(!verifyOnly){
      for(const familyId of new Set(selected.filter(x=>x.collection==='recipes'&&x.ownerFamilyDeletedAt===null).map(x=>x.familyId))){
        const current=await one('families',familyId);assert.ok(!current.deletedAt&&Number.isSafeInteger(current.revision));
        const changedAt=Date.now();
        const prepared={query:{_id:familyId,revision:current.revision},update:{$inc:{revision:1},$set:{updatedAt:changedAt}},expected:{...current,revision:current.revision+1,updatedAt:changedAt}};
        const entry={collection:'families',documentId:familyId,beforeRevision:current.revision,reason:'Refresh cached family recipes after authorized ingredient normalization'};
        receipt.familyRefreshes.push(entry);await dispatch('families',familyId,prepared,entry);
      }
    }
    const afterCollections={},differences=[];
    for(const collection of requiredCollections){
      const rows=await readCollection(call,collection,plan.scopes[collection]);afterCollections[collection]=rows;
      receipt.scopeAdditions.final[collection]=reconcileStrictScope(collection,rows,currentCollections[collection]);
      for(const row of rows){
        const prior=currentCollections[collection].find(x=>x._id===row._id);
        if(!prior)continue; // Newly created, independently validated records are never migration targets.
        const op=selected.find(x=>x.collection===collection&&x.documentId===row._id);
        const expected=op?strictDataUpdate(op,prior).expected:prior;
        if(!isDeepStrictEqual(row,expected))differences.push({collection,documentId:row._id});
        if(op)assert.equal(strictDataUpdate(op,row).alreadyApplied,true);
      }
    }
    await saveNew(path.join(dir,'after.json'),{target:plan.target,collections:afterCollections});
    await saveNew(path.join(dir,'unplanned-differences.json'),differences);
    assert.deepEqual(differences,[],'出现计划外差异，应核对而不是覆盖');
    if(!canary)receipt.inventory=strictInventory(afterCollections);
    Object.assign(receipt,{state:canary?'canary_verified':'verified',completedAt:new Date().toISOString(),changedDocuments:receipt.operations.filter(x=>x.state==='verified').length});
    await saveReceipt();await save(path.join(output,'latest-run.json'),receipt);
    console.log(JSON.stringify({state:receipt.state,checked:receipt.operations.length,changedDocuments:receipt.changedDocuments,runDirectory:dir}));
  }catch(error){Object.assign(receipt,{state:'stopped_needs_reconciliation',stoppedAt:new Date().toISOString(),error:{message:error.message,taskId:error.taskId}});await saveReceipt();throw error;}
  finally{await lock.close();await unlink(path.join(output,'write.lock'));}
}
async function run(){
  const option=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:undefined;
  const output=path.resolve(option('--output')||'');assert.ok(output.startsWith(path.join(process.cwd(),'artifacts')+path.sep));
  if(process.argv.includes('--prepare')){
    const plan=makeStrictPlan(await json(path.join(output,'backup.json')));
    await saveNew(path.join(output,'plan.json'),plan);
    await saveNew(path.join(output,'changes.json'),plan.operations.flatMap(o=>o.changes.map(c=>({collection:o.collection,documentId:o.documentId,...c}))));
    console.log(JSON.stringify({state:'prepared_no_writes',digest:plan.digest,operations:plan.operations.length,counts:plan.counts}));return;
  }
  if(process.argv.includes('--apply')||process.argv.includes('--verify'))return executePlan(output,option('--plan-digest'),{canary:process.argv.includes('--canary'),verifyOnly:process.argv.includes('--verify')});
  throw Error('Use --prepare or --apply/--verify --plan-digest');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await run();
