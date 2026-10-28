import assert from 'node:assert/strict';
import { mkdir,readFile,writeFile,rename,unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv } from 'vite';
import { verifyPreviewTarget } from './preview-weixin.mjs';
import { runIdeToFile,createCleanupReader,readAllCleanup } from './family-cleanup-db.mjs';
import { TARGET,KEEP_FAMILY,COLLECTIONS,fingerprint,buildCleanupPlan,validatePlan,cloudRefs } from './family-cleanup-plan.mjs';
import { acquireHistoricalLock,releaseHistoricalLock } from './normalize-historical-ingredient-snapshots.mjs';

const json=async file=>JSON.parse(await readFile(file,'utf8'));
const newJson=async(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function atomicJson(file,value){const temp=file+'.'+randomUUID()+'.tmp';await newJson(temp,value);await rename(temp,file)}
const rowMap=rows=>new Map(rows.map(x=>[x._id,x]));
const opShape=plan=>plan.operations.map(op=>({action:op.action,collection:op.collection,fields:op.fields,rows:op.rows.map(x=>({before:fingerprint(x.before),after:fingerprint(x.after)}))}));
export function assertNoActiveBackground(snapshot,removedIds,now=Date.now()){
  const removed=new Set(removedIds);
  for(const job of snapshot.collections.imports)if(['authorized_import_job_v1','authorized_import_task_v1','image_delivery_job_v1'].includes(job.kind)){
    assert.ok(Number.isFinite(job.expiresAt)&&job.expiresAt<=now,'active import/image job blocks cleanup');
    assert.ok(!job.leaseUntil||job.leaseUntil<=now,'active task lease blocks cleanup');
  }
  for(const media of snapshot.collections.media)if(removed.has(media.familyId)&&!media.confirmed&&media.expiresAt!==undefined)assert.ok(media.expiresAt<=now,'live removed-family upload ticket blocks cleanup');
}
export function mutationArgs(op,queryFile,updateFile){return ['--action',op.action,'--collection-name',op.collection,'--query-file',queryFile,...(op.action==='update'?['--update-file',updateFile]:[]),...(op.rows.length>1?['--is-multi']:[])]}
export async function validatePending(directory){
  const guard=await json(path.join(directory,'write-reconciliation-required.json'));
  const plan=await json(guard.planPath),backup=await json(guard.backupPath);
  validatePlan(plan,backup);
  assert.equal(guard.planDigest,plan.digest);assert.deepEqual(guard.target,TARGET);
  assert.equal(guard.tool,'cloud_db_write_doc');assert.equal(guard.state,'pending');assert.ok(guard.taskId);
  const op=plan.operations[guard.operationIndex];assert.ok(op);
  assert.deepEqual(await json(guard.queryFile),op.query);
  if(op.action==='update')assert.deepEqual(await json(guard.updateFile),{$set:op.fields});
  assert.deepEqual(guard.args,mutationArgs(op,guard.queryFile,guard.updateFile));
  const lock=await json(path.join(directory,'write.lock'));assert.equal(lock.planDigest,plan.digest);assert.equal(lock.pid,guard.reconciler?.pid??guard.pid);if(guard.reconciler)assert.equal(lock.owner,guard.reconciler.lockOwner);process.kill(lock.pid,0);
  return {allowedForSingleNativeConfirmation:true,target:TARGET,planDigest:plan.digest,operationIndex:op.index,action:op.action,collection:op.collection,documentCount:op.rows.length,taskId:guard.taskId};
}
async function readSnapshot(call,directory,label){
  const structure=await call('cloud_db_read_struct',['--action','listCollections','--limit','100','--offset','0']);
  assert.equal(structure.pager.Total,COLLECTIONS.length);assert.deepEqual(structure.collections.map(x=>x.TableName).sort(),[...COLLECTIONS].sort());
  const collections={};for(const name of COLLECTIONS)collections[name]=await readAllCleanup(call,name);
  const backup={target:TARGET,capturedAt:new Date().toISOString(),collections};await newJson(path.join(directory,label+'.json'),backup);return backup;
}
export function verifyFinal(plan,preflight,final){
  assert.deepEqual(final.target,TARGET);
  const changes=new Map(plan.operations.flatMap(op=>op.rows.map(row=>[op.collection+'/'+row.before._id,row.after])));
  const maps=Object.fromEntries(COLLECTIONS.map(name=>[name,rowMap(final.collections[name])]));
  for(const [key,after] of changes){const split=key.indexOf('/'),collection=key.slice(0,split),id=key.slice(split+1),current=maps[collection].get(id);if(after)assert.deepEqual(current,after);else assert.equal(current,undefined,`${collection}: delete missing`)}
  for(const name of COLLECTIONS)if(name!=='rate_limits'){
    const expectedIds=new Set(preflight.collections[name].map(x=>x._id));
    for(const op of plan.operations.filter(x=>x.collection===name))for(const row of op.rows){if(row.after)expectedIds.add(row.before._id);else expectedIds.delete(row.before._id)}
    assert.deepEqual([...maps[name].keys()].sort(),[...expectedIds].sort(),`${name}: final ID set drifted`);
  }
  const preservedChanges=[];
  for(const name of COLLECTIONS)if(name!=='rate_limits')for(const before of preflight.collections[name])if(!changes.has(name+'/'+before._id)) {
    if(fingerprint(maps[name].get(before._id)??null)!==fingerprint(before))preservedChanges.push(name+'/'+before._id);
  }
  assert.deepEqual(preservedChanges,[],'unplanned preserved document changes; inspect snapshots');
  assert.deepEqual(final.collections.families.map(x=>x._id),[KEEP_FAMILY]);
  const remaining=buildCleanupPlan(final);assert.equal(remaining.operations.length,0,'cleanup residuals');
  const expectedPublished=preflight.collections.posts.filter(x=>x.status==='published').map(x=>x._id).sort();
  assert.deepEqual(final.collections.posts.filter(x=>x.status==='published').map(x=>x._id).sort(),expectedPublished);
  return {familyCount:1,publishedPosts:expectedPublished.length,unplannedChanges:0,remainingOperations:0,counts:Object.fromEntries(COLLECTIONS.map(name=>[name,final.collections[name].length]))};
}
export async function executeCleanup(directory,backupPath,expectedDigest,{verifyOnly=false,resume=false}={}){
  const planPath=path.join(directory,'plan.json'),plan=await json(planPath),backup=await json(backupPath);validatePlan(plan,backup);assert.equal(plan.digest,expectedDigest);
  const config={...loadEnv('production',process.cwd(),''),...process.env};assert.equal(config.VITE_DATA_MODE,'cloud');
  const preview=await verifyPreviewTarget(process.cwd(),config);assert.deepEqual({appid:preview.appid,env:preview.environment},TARGET);assert.equal(preview.functionName??preview.function,'kitchen-v2');
  const runDirectory=path.join(directory,'run-'+new Date().toISOString().replaceAll(':','-'));await mkdir(runDirectory,{recursive:true,mode:0o700});
  const lock=await acquireHistoricalLock(directory,resume,{planDigest:plan.digest,runDirectory});
  const guardFile=path.join(directory,'write-reconciliation-required.json'),receiptFile=path.join(runDirectory,'receipt.json');
  const receipt={planDigest:plan.digest,target:TARGET,state:'preflight',runDirectory,startedAt:new Date().toISOString(),operations:[]};
  const saveReceipt=()=>atomicJson(receiptFile,receipt);const call=createCleanupReader(TARGET,runDirectory);let sequence=0;
  const readOperation=op=>readAllCleanup(call,op.collection,{_id:{$in:op.rows.map(x=>x.before._id)}});
  const assertAfter=async op=>{const rows=await readOperation(op);const expected=op.rows.map(x=>x.after).filter(Boolean).sort((a,b)=>a._id.localeCompare(b._id));assert.deepEqual(rows.sort((a,b)=>a._id.localeCompare(b._id)),expected,'mutation readback differs');return rows};
  const settle=async(guard,op)=>{
    assert.equal(guard.planDigest,plan.digest);assert.deepEqual(guard.args,mutationArgs(op,guard.queryFile,guard.updateFile));
    assert.deepEqual(await json(guard.queryFile),op.query);if(op.action==='update')assert.deepEqual(await json(guard.updateFile),{$set:op.fields});
    assert.ok(guard.taskId&&guard.state==='pending','unresolved dispatch outcome: do not reissue');
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){await delay(2000);const{response}=await runIdeToFile(null,runDirectory,'poll-'+(++sequence),'polling_task_result',['--task-id',guard.taskId]);assert.equal(response.ok,true);assert.equal(response.result?.success,true);assert.equal(response.result.taskId,guard.taskId);if(response.result.status==='pending')continue;assert.equal(response.result.status,'success','original task failed or was rejected: do not retry');await assertAfter(op);await newJson(path.join(runDirectory,'settled-'+op.index+'.json'),guard);await unlink(guardFile);return}
    throw Error('Original task pending beyond deadline; retain guard and do not reissue');
  };
  try {
    await saveReceipt();
    let guard;try{guard=await json(guardFile)}catch(e){if(e.code!=='ENOENT')throw e}
    if(guard){assert.ok(resume,'unresolved original mutation; resume reconciliation only');guard={...guard,reconciler:{pid:process.pid,lockOwner:lock.owner,runDirectory}};await atomicJson(guardFile,guard);await settle(guard,plan.operations[guard.operationIndex]);receipt.reconciledOriginalTask=guard.taskId;await saveReceipt()}
    if(verifyOnly){const final=await readSnapshot(call,runDirectory,'final');const preflight=await json(path.join(directory,'preflight.json'));receipt.validation=verifyFinal(plan,preflight,final);receipt.state='verified';await saveReceipt();console.log(JSON.stringify({state:receipt.state,...receipt.validation,runDirectory}));return}
    let preflight;
    if(resume){preflight=await json(path.join(directory,'preflight.json'))}
    else {preflight=await readSnapshot(call,runDirectory,'preflight');assert.deepEqual(opShape(buildCleanupPlan(preflight,{cleanupAt:plan.cleanupAt})),opShape(plan),'live plan changed: no writes allowed');await newJson(path.join(directory,'preflight.json'),preflight)}
    assertNoActiveBackground(preflight,plan.removedFamilyIds);
    const {response:functionInfo}=await runIdeToFile(TARGET,runDirectory,'function-config','cloud_fn_info',['--names','kitchen-v2']);
    assert.equal(functionInfo.ok,true);assert.equal(functionInfo.result?.list?.length,1);
    const timeoutSeconds=functionInfo.result.list[0].timeout;assert.ok(Number.isInteger(timeoutSeconds)&&timeoutSeconds>0&&timeoutSeconds<=300);
    const drainAfterFence=async(compareRemaining=true)=>{
      console.log(JSON.stringify({state:'draining_inflight_requests',seconds:timeoutSeconds+2}));
      const until=Date.now()+(timeoutSeconds+2)*1000;while(Date.now()<until)await delay(Math.min(15000,until-Date.now()));
      const drained=await readSnapshot(call,runDirectory,'after-family-fence');assertNoActiveBackground(drained,plan.removedFamilyIds);
      if(compareRemaining)assert.deepEqual(opShape(buildCleanupPlan(drained,{cleanupAt:plan.cleanupAt})),opShape({...plan,operations:plan.operations.filter(x=>!(x.collection==='families'&&x.action==='update'))}),'data drift during fence drain: stop before child deletion');
    };
    if(resume)await drainAfterFence(false);
    console.log(JSON.stringify({state:'preflight_complete',operations:plan.operations.length,runDirectory}));
    for(const op of plan.operations){
      const current=await readOperation(op);const expected=op.rows.map(x=>x.after).filter(Boolean);
      const laterFinal=new Map(plan.operations.filter(x=>x.index>=op.index&&x.collection===op.collection).flatMap(x=>x.rows.map(row=>[row.before._id,row.after])));
      const terminalExpected=op.rows.map(row=>laterFinal.get(row.before._id)).filter(Boolean);
      const sortedFingerprint=rows=>fingerprint(rows.slice().sort((a,b)=>a._id.localeCompare(b._id)));
      if(resume&&[expected,terminalExpected].some(rows=>sortedFingerprint(current)===sortedFingerprint(rows))){receipt.operations.push({index:op.index,state:'already_verified'});await saveReceipt();continue}
      assert.deepEqual(current.sort((a,b)=>a._id.localeCompare(b._id)),op.rows.map(x=>x.before).sort((a,b)=>a._id.localeCompare(b._id)),`live ${op.collection} changed; stop`);
      const familyRows=await readAllCleanup(call,'families');const keep=familyRows.find(x=>x._id===KEEP_FAMILY);assert.ok(keep&&!keep.deletedAt&&keep.members.some(x=>x.id===plan.keepOwnerId));assert.deepEqual(familyRows.map(x=>x._id).sort(),[KEEP_FAMILY,...plan.removedFamilyIds].sort(),'family set changed');
      const accountRows=await readAllCleanup(call,'users',{_id:plan.keepOwnerId});assert.equal(accountRows[0]?.familyId,KEEP_FAMILY);
      if(op.collection==='media'){
        const live=await readSnapshot(call,runDirectory,'before-media');const livePlan=buildCleanupPlan(live);const deletable=new Set(livePlan.operations.filter(x=>x.collection==='media').flatMap(x=>x.rows.map(y=>y.before._id)));assert.ok(op.rows.every(x=>deletable.has(x.before._id)),'media gained preserved references');
      }
      if(op.collection==='families'&&op.action==='delete'){
        // Recheck for new child records and stale pointers before the final shells disappear.
        const live=await readSnapshot(call,runDirectory,'before-families');const remaining=buildCleanupPlan(live);assert.ok(remaining.operations.every(x=>x.collection==='families'),'new private data appeared; stop before family deletion');
      }
      const queryFile=path.join(runDirectory,'query-'+op.index+'.json'),updateFile=op.action==='update'?path.join(runDirectory,'update-'+op.index+'.json'):null;
      await newJson(queryFile,op.query);if(updateFile)await newJson(updateFile,{$set:op.fields});
      // Exercise exactly the CAS query through the read API before requesting any mutation.
      const matched=await call('cloud_db_read_doc',['--collection-name',op.collection,'--query-file',queryFile,'--projection','{"_id":1}','--limit','100','--offset','0']);
      assert.equal(matched.total,op.rows.length);assert.deepEqual(matched.data.map(x=>x._id).sort(),op.rows.map(x=>x.before._id).sort());
      const args=mutationArgs(op,queryFile,updateFile);
      const intent={target:TARGET,tool:'cloud_db_write_doc',state:'dispatching',pid:process.pid,planPath,backupPath,planDigest:plan.digest,operationIndex:op.index,queryFile,updateFile,args,startedAt:new Date().toISOString()};
      await newJson(guardFile,intent);let response;
      ({response}=await runIdeToFile(TARGET,runDirectory,'write-'+op.index,'cloud_db_write_doc',args));
      const taskId=response.taskId||response.result?.taskId;
      if(taskId||response.pending||response.result?.pending){assert.ok(taskId);const pending={...intent,state:'pending',taskId};await atomicJson(guardFile,pending);console.log(JSON.stringify({state:'pending_single_approval',index:op.index,action:op.action,collection:op.collection,documents:op.rows.length,taskId}));await settle(pending,op)}
      else {assert.equal(response.ok,true);assert.equal(response.result?.success,true);await assertAfter(op);await newJson(path.join(runDirectory,'settled-'+op.index+'.json'),{...intent,state:'verified_synchronous'});await unlink(guardFile)}
      receipt.operations.push({index:op.index,action:op.action,collection:op.collection,documents:op.rows.length,state:'readback_verified'});await saveReceipt();console.log(JSON.stringify(receipt.operations.at(-1)));
      if(op.collection==='families'&&op.action==='update')await drainAfterFence();
    }
    const final=await readSnapshot(call,runDirectory,'final');receipt.validation=verifyFinal(plan,preflight,final);receipt.state='completed_and_verified';receipt.completedAt=new Date().toISOString();await saveReceipt();await newJson(path.join(directory,'result.json'),receipt);console.log(JSON.stringify({state:receipt.state,validation:receipt.validation,runDirectory}));
  }catch(error){receipt.state='stopped_requires_inspection';receipt.error=error.message;await saveReceipt();throw error}
  finally{await releaseHistoricalLock(lock)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const option=name=>process.argv[process.argv.indexOf(name)+1];
  if(process.argv.includes('--validate-pending'))console.log(JSON.stringify(await validatePending(path.resolve(option('--directory')))));
  else {assert.ok(process.argv.includes('--apply')||process.argv.includes('--verify'));await executeCleanup(path.resolve(option('--directory')),path.resolve(option('--backup')),option('--plan-digest'),{verifyOnly:process.argv.includes('--verify'),resume:process.argv.includes('--resume')})}
}
