import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCleanupPlan,KEEP_FAMILY,TARGET,COLLECTIONS } from '../scripts/family-cleanup-plan.mjs';
import { verifyFinal,mutationArgs } from '../scripts/apply-family-cleanup.mjs';
function fixture(){
 const collections=Object.fromEntries(COLLECTIONS.map(c=>[c,[]]));
 collections.families=[{_id:KEEP_FAMILY,id:KEEP_FAMILY,ownerId:'u',members:[{id:'u'}]},{_id:'gone',id:'gone',ownerId:'v',members:[{id:'v'}]}];
 collections.users=[{_id:'u',familyId:KEEP_FAMILY,familyIds:[KEEP_FAMILY]},{_id:'v',familyId:'gone',familyIds:['gone'],name:'保留账号'}];
 collections.orders=[{_id:'keep-order',familyId:KEEP_FAMILY,value:{x:1}},{_id:'old-order',familyId:'gone',value:{x:2}}];
 collections.posts=[{_id:'public',status:'published',familyId:'gone',importedFamilyCount:1,card:{importedFamilyCount:1}}];
 collections.imports=[{_id:'edge',familyId:'gone',postId:'public'}];
 return {target:TARGET,collections};
}
function applied(before,plan){const final=structuredClone(before);for(const op of plan.operations)for(const row of op.rows){const i=final.collections[op.collection].findIndex(x=>x._id===row.before._id);if(row.after)final.collections[op.collection][i]=structuredClone(row.after);else final.collections[op.collection].splice(i,1)}return final}
test('final verification requires every planned removal, preserves current order and public post',()=>{const before=fixture(),plan=buildCleanupPlan(before),after=applied(before,plan);assert.equal(verifyFinal(plan,before,after).remainingOperations,0);after.collections.orders.push(before.collections.orders[1]);assert.throws(()=>verifyFinal(plan,before,after));});
test('final verification rejects unplanned retained content mutation',()=>{const before=fixture(),plan=buildCleanupPlan(before),after=applied(before,plan);after.collections.orders[0].value.x=7;assert.throws(()=>verifyFinal(plan,before,after),/unplanned preserved/);});
test('new foreign private records cannot pass final orphan checks',()=>{const before=fixture(),plan=buildCleanupPlan(before),after=applied(before,plan);after.collections.orders.push({_id:'new-foreign',familyId:'gone',value:{}});assert.throws(()=>verifyFinal(plan,before,after),/final ID set drifted/);});
test('account fields outside family pointers survive cleanup',()=>{const before=fixture(),plan=buildCleanupPlan(before),after=applied(before,plan);assert.equal(after.collections.users[1].name,'保留账号');after.collections.users[1].name='modified';assert.throws(()=>verifyFinal(plan,before,after));});
test('mutation arguments never permit upsert and distinguish delete from update',()=>{const plan=buildCleanupPlan(fixture());for(const op of plan.operations){const args=mutationArgs(op,'/q','/u');assert.ok(!args.includes('--upsert'));assert.equal(args.includes('--update-file'),op.action==='update');assert.equal(args.includes('--is-multi'),op.rows.length>1);assert.equal(args[1],op.action);assert.equal(args[3],op.collection)}});

test('new retained-family records cannot be silently reported as unchanged',()=>{const before=fixture(),plan=buildCleanupPlan(before),after=applied(before,plan);after.collections.recipes.push({_id:'new-keep',familyId:KEEP_FAMILY,value:{}});assert.throws(()=>verifyFinal(plan,before,after),/final ID set drifted/);});

test('active import leases and upload tickets stop cleanup before writes',async()=>{
 const {assertNoActiveBackground}=await import('../scripts/apply-family-cleanup.mjs');const b=fixture();
 b.collections.imports.push({_id:'job',kind:'authorized_import_task_v1',expiresAt:200,leaseUntil:0});assert.throws(()=>assertNoActiveBackground(b,['gone'],100),/active import/);
 b.collections.imports.at(-1).expiresAt=90;b.collections.imports.at(-1).leaseUntil=200;assert.throws(()=>assertNoActiveBackground(b,['gone'],100),/active task lease/);
 b.collections.imports.at(-1).leaseUntil=0;b.collections.media.push({_id:'ticket',familyId:'gone',expiresAt:200});assert.throws(()=>assertNoActiveBackground(b,['gone'],100),/upload ticket/);
 b.collections.media[0].expiresAt=90;assertNoActiveBackground(b,['gone'],100);
});
