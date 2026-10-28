import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exactJsonCondition } from './normalize-community-recipes.mjs';

export const KEEP_FAMILY = 'family-1792647111258-fcb7c18538b6245e1029dcec';
export const TARGET = { appid: 'wx1fe9d6db08a0e91b', env: 'cloudbase-d8gqg3oqed7609824' };
export const COLLECTIONS = ['users','families','recipes','meal_sets','orders','inventory','purchases','invites','shares','requests','imports','posts','comments','reports','rate_limits','media'];
const PRIVATE = ['recipes','meal_sets','orders','inventory','purchases','invites','shares','requests'];
const IMPORT_KINDS = ['authorized_import_job_v1','authorized_import_task_v1','owner_reviewed_import_v1','authorized_recipe_staging_v1','image_delivery_job_v1'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])])) : value;
export const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function cloudRefs(value, result = new Set()) {
  if (typeof value === 'string') { if (value.startsWith('cloud://')) result.add(value); }
  else if (value && typeof value === 'object') for (const child of Object.values(value)) cloudRefs(child,result);
  return result;
}
export function validateSnapshot(backup) {
  assert.deepEqual(backup.target,TARGET);
  assert.deepEqual(Object.keys(backup.collections).sort(),[...COLLECTIONS].sort());
  for (const [name,rows] of Object.entries(backup.collections)) {
    assert.ok(Array.isArray(rows),name);
    assert.ok(rows.every(x => typeof x._id === 'string' && x._id));
    assert.equal(new Set(rows.map(x=>x._id)).size,rows.length,`${name}: duplicate ids`);
  }
  for (const family of backup.collections.families) assert.equal(family.id,family._id);
  const keep = backup.collections.families.find(x=>x._id===KEEP_FAMILY);
  assert.ok(keep && !keep.deletedAt && keep.members.length > 0,'retained family is inactive');
  assert.ok(keep.members.some(x=>x.id===keep.ownerId),'retained owner missing');
  const user = backup.collections.users.find(x=>x._id===keep.ownerId);
  assert.equal(user?.familyId,KEEP_FAMILY,'retained owner changed current family');
  return keep;
}
export function exactBatchQuery(rows) {
  assert.ok(rows.length > 0 && rows.length <= 60);
  const branches = rows.map(before=>({_id:before._id,$expr:exactJsonCondition('$$ROOT',before)}));
  return branches.length === 1 ? branches[0] : {$or:branches};
}
export function buildCleanupPlan(backup, { cleanupAt = Date.parse(backup.capturedAt || '2026-10-27T00:00:00.000Z') } = {}) {
  assert.ok(Number.isFinite(cleanupAt) && cleanupAt > 0);
  const keep = validateSnapshot(backup), c=backup.collections;
  const D=new Set(c.families.filter(x=>x._id!==KEEP_FAMILY).map(x=>x._id));
  const known=new Set(c.families.map(x=>x._id));
  const removed=Object.fromEntries(COLLECTIONS.map(x=>[x,new Set()]));
  const reason=new Map();
  const remove=(name,row,why)=>{removed[name].add(row._id);reason.set(name+'/'+row._id,why)};
  for(const name of PRIVATE) for(const row of c[name]) {
    assert.ok(known.has(row.familyId),`${name}: missing/unknown owner ${row._id}`);
    if(D.has(row.familyId)) remove(name,row,'removed family private data');
  }
  for(const row of c.families) if(D.has(row._id)) remove('families',row,'removed family');
  for(const row of c.posts) {
    assert.ok(['published','deleted'].includes(row.status),'unknown post status');
    if(D.has(row.familyId) && row.status==='deleted') remove('posts',row,'already withdrawn post of removed family');
  }
  for(const name of ['comments','reports']) for(const row of c[name]) if(removed.posts.has(row.postId)) remove(name,row,'dependent of withdrawn post');
  for(const row of c.imports) {
    if(!row.kind) {
      assert.ok(row.postId && known.has(row.familyId),'unknown household import edge');
      assert.ok(c.posts.some(p=>p._id===row.postId),'import edge has missing post');
      if(D.has(row.familyId)||removed.posts.has(row.postId)) remove('imports',row,'removed family collection edge or removed post');
    } else assert.ok(IMPORT_KINDS.includes(row.kind),'unknown global import kind');
  }
  // Global source/review records and their job/task chain survive as public provenance.
  const keptImports=c.imports.filter(x=>!removed.imports.has(x._id));
  for(const row of keptImports.filter(x=>x.kind==='authorized_import_task_v1')) assert.ok(keptImports.some(j=>j._id===row.jobId),'missing source job');
  const protectedRefs = new Set();
  for(const [name,rows] of Object.entries(c)) if(name!=='media') for(const row of rows) if(!removed[name].has(row._id)) cloudRefs(row,protectedRefs);
  const keptMedia = new Set(c.media.filter(x=>!D.has(x.familyId)).map(x=>x._id));
  for(const row of c.media) if(keptMedia.has(row._id)) cloudRefs(row,protectedRefs);
  let changed=true;
  while(changed){changed=false;for(const row of c.media) if(!keptMedia.has(row._id)) {
    const refs=cloudRefs(row);
    if([...refs].some(ref=>protectedRefs.has(ref))) {keptMedia.add(row._id);for(const ref of refs)protectedRefs.add(ref);changed=true;}
  }}
  for(const row of c.media) if(D.has(row.familyId)&&!keptMedia.has(row._id)) remove('media',row,'unreferenced private media metadata');
  const mutations=[];
  for(const row of c.users) {
    const ids=keep.members.some(m=>m.id===row._id)?[KEEP_FAMILY]:[];
    const fields={familyId:ids[0]||'',familyIds:ids};
    if(row.familyId!==fields.familyId || fingerprint(row.familyIds||[])!==fingerprint(ids)) mutations.push({collection:'users',before:row,after:{...row,...fields},fields,reason:'repair membership pointers to surviving family'});
  }
  const affectedPosts=new Set(c.imports.filter(x=>removed.imports.has(x._id)&&!x.kind).map(x=>x.postId));
  for(const row of c.posts) if(affectedPosts.has(row._id)&&!removed.posts.has(row._id)) {
    const count=new Set(keptImports.filter(x=>!x.kind&&x.postId===row._id).map(x=>x.familyId)).size;
    const fields={importedFamilyCount:count};
    if(row.card)fields['card.importedFamilyCount']=count;
    if(row.importedFamilyCount!==count||(row.card&&row.card.importedFamilyCount!==count)) mutations.push({collection:'posts',before:row,after:{...row,importedFamilyCount:count,...(row.card?{card:{...row.card,importedFamilyCount:count}}:{})},fields,reason:'recount remaining family collections'});
  }
  const operations=[];
  const appendBatches=(action,collection,items,fields)=>{
    let rows=[];
    const flush=()=>{if(!rows.length)return;operations.push({index:operations.length,action,collection,rows, ...(fields?{fields}:{}),query:exactBatchQuery(rows.map(x=>x.before))});rows=[]};
    for(const item of items){
      const next=[...rows,item];
      if(rows.length&&(next.length>60||Buffer.byteLength(JSON.stringify(exactBatchQuery(next.map(x=>x.before))))>90000))flush();
      rows.push(item);
    }flush();
  };
  // Disable old-family membership before removing dependencies. Normal app writes
  // read this document inside their transaction, so concurrent writers conflict.
  const fencedFamilies = c.families.filter(x=>D.has(x._id)&&!x.deletedAt);
  const fenceFields = { deletedAt: cleanupAt };
  appendBatches('update','families',fencedFamilies.map(before=>({before,after:{...before,...fenceFields},reason:'disable removed family before dependent cleanup'})),fenceFields);
  // Remove private dependencies, fix accounts/counts, then remove family shells.
  const deleteOrder=['invites','shares','requests','comments','reports','imports','recipes','meal_sets','orders','inventory','purchases','posts','media'];
  for(const name of deleteOrder)appendBatches('delete',name,c[name].filter(x=>removed[name].has(x._id)).map(before=>({before,after:null,reason:reason.get(name+'/'+before._id)})));
  for(const name of ['users','posts']) {
    const groups=new Map();for(const item of mutations.filter(x=>x.collection===name)){const key=JSON.stringify(item.fields);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item)}
    for(const [key,rows] of groups)appendBatches('update',name,rows.map(({before,after,reason})=>({before,after,reason})),JSON.parse(key));
  }
  appendBatches('delete','families',c.families.filter(x=>removed.families.has(x._id)).map(original=>({before:original.deletedAt?original:{...original,...fenceFields},after:null,reason:'removed family'})));
  for(const op of operations)assert.ok(Buffer.byteLength(JSON.stringify(op.query))<100000,'single CAS query too large');
  const projected=structuredClone(c);
  for(const op of operations)for(const row of op.rows){const i=projected[op.collection].findIndex(x=>x._id===row.before._id);assert.ok(i>=0);if(row.after)projected[op.collection][i]=row.after;else projected[op.collection].splice(i,1)}
  assert.equal(projected.families.length,1);
  for(const name of PRIVATE)assert.ok(projected[name].every(x=>x.familyId===KEEP_FAMILY));
  assert.equal(projected.posts.filter(x=>x.status==='published').length,c.posts.filter(x=>x.status==='published').length);
  const totals=Object.fromEntries(COLLECTIONS.map(name=>[name,{before:c[name].length,deleted:removed[name].size,updated:mutations.filter(x=>x.collection===name).length+(name==='families'?fencedFamilies.length:0),after:projected[name].length}]));
  const body={version:2,target:TARGET,cleanupAt,keepFamilyId:KEEP_FAMILY,keepOwnerId:keep.ownerId,backupDigest:fingerprint(backup),removedFamilyIds:[...D].sort(),totals,operations,protectedMediaIds:[...keptMedia].sort(),protectedCloudReferenceCount:protectedRefs.size};
  return {...body,digest:fingerprint(body)};
}
export function validatePlan(plan,backup){const{digest,...body}=plan;assert.equal(digest,fingerprint(body));assert.deepEqual(plan,buildCleanupPlan(backup),'plan differs from deterministic reviewed rules');return true}
