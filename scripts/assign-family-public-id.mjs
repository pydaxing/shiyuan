import assert from 'node:assert/strict';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv } from 'vite';
import { verifyPreviewTarget } from './preview-weixin.mjs';
import { createCleanupReader, readAllCleanup, runIdeToFile } from './family-cleanup-db.mjs';
import { isFamilyPublicId } from '../src/domain/family.js';

const registry = 'family_public_ids';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function target() {
  const config = { ...loadEnv('production', process.cwd(), ''), ...process.env };
  assert.equal(config.VITE_DATA_MODE, 'cloud');
  const preview = await verifyPreviewTarget(process.cwd(), config);
  return { appid: preview.appid, env: preview.environment, functionName: preview.functionName };
}
async function references(call, familyId) {
  const rows = {};
  for (const collection of ['users', 'recipes', 'meal_sets', 'orders', 'inventory', 'purchases']) {
    rows[collection] = await readAllCleanup(call, collection, { familyId });
  }
  return rows;
}

export async function prepareFamilyPublicId(directory, familyId) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const liveTarget = await target();
  const call = createCleanupReader(liveTarget, join(directory, 'prepare'));
  const families = await readAllCleanup(call, 'families');
  const family = families.find(row => row._id === familyId);
  assert.ok(family && family.id === familyId && !family.deletedAt);
  assert.ok(Number.isSafeInteger(family.revision));
  assert.equal(family.publicId, undefined, 'This migration only allocates a previously missing public ID');
  const structure = await call('cloud_db_read_struct', ['--action', 'listCollections', '--limit', '100', '--offset', '0']);
  const registryExists = structure.collections.some(row => row.TableName === registry);
  const mappings = registryExists ? await readAllCleanup(call, registry) : [];
  const existing = mappings.filter(row => row.familyId === familyId);
  assert.ok(existing.length <= 1, 'Multiple prior reservations need reconciliation');
  let publicId = existing[0]?._id;
  if (!publicId) {
    const occupied = new Set([...mappings.map(row => row._id), ...families.map(row => row.publicId)]);
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = 'sy-' + randomInt(36 ** 6).toString(36).padStart(6, '0');
      if (!occupied.has(candidate)) { publicId = candidate; break; }
    }
  }
  assert.ok(isFamilyPublicId(publicId));
  assert.ok(!families.some(row => row.publicId === publicId));
  const mapping = existing[0] || { _id: publicId, familyId, createdAt: Date.now() };
  const backup = { target: liveTarget, families, mappings, references: await references(call, familyId) };
  const plan = { target: liveTarget, familyId, publicId, registryExists, mappingExists: Boolean(existing[0]), mapping, before: family, after: { ...family, publicId, revision: family.revision + 1 }, backupDigest: fingerprint(backup) };
  await save(join(directory, 'backup.json'), backup);
  await save(join(directory, 'plan.json'), plan);
  return { familyId, publicId, revision: [family.revision, plan.after.revision], references: Object.fromEntries(Object.entries(backup.references).map(([key, rows]) => [key, rows.length])), plannedWrites: [!registryExists && 'create registry', !existing[0] && 'reserve unique ID', 'update family publicId and revision'].filter(Boolean) };
}

export async function applyFamilyPublicId(directory) {
  const plan = await json(join(directory, 'plan.json'));
  const backup = await json(join(directory, 'backup.json'));
  assert.deepEqual(await target(), plan.target);
  assert.deepEqual(backup.target, plan.target);
  assert.equal(fingerprint(backup), plan.backupDigest);
  assert.ok(isFamilyPublicId(plan.publicId));
  assert.deepEqual(plan.after, { ...plan.before, publicId: plan.publicId, revision: plan.before.revision + 1 });
  assert.equal(plan.mapping._id, plan.publicId);
  assert.equal(plan.mapping.familyId, plan.familyId);
  const run = join(directory, 'apply');
  await mkdir(run, { mode: 0o700 }); // Never redispatch an earlier ambiguous run.
  const call = createCleanupReader(plan.target, run);
  const before = await readAllCleanup(call, 'families');
  assert.deepEqual(before, backup.families, 'Family changed since backup');
  assert.deepEqual(await references(call, plan.familyId), backup.references, 'Family data changed since backup');
  let sequence = 0;
  async function mutate(label, tool, args) {
    const intent = { label, target: plan.target, tool, args, state: 'dispatching' };
    await save(join(run, label + '-intent.json'), intent);
    const { response } = await runIdeToFile(plan.target, run, label, tool, args);
    const taskId = response.taskId || response.result?.taskId;
    if (taskId || response.pending || response.result?.pending) {
      assert.ok(taskId);
      await save(join(run, label + '-pending.json'), { ...intent, taskId, state: 'pending' });
      console.log(JSON.stringify({ label, state: 'pending', taskId }));
      let complete = false;
      for (let n = 0; n < 100; n++) {
        await delay(2000);
        const { response: poll } = await runIdeToFile(null, run, 'poll-' + (++sequence), 'polling_task_result', ['--task-id', taskId]);
        assert.equal(poll.ok, true);
        assert.equal(poll.result?.success, true);
        assert.equal(poll.result.taskId, taskId);
        if (poll.result.status === 'pending') continue;
        assert.equal(poll.result.status, 'success', JSON.stringify(poll.result));
        complete = true;
        break;
      }
      assert.ok(complete, 'Pending operation: inspect original task; do not redispatch');
    } else {
      assert.equal(response.ok, true);
      assert.equal(response.result?.success, true, JSON.stringify(response.result));
    }
    await save(join(run, label + '-settled.json'), { ...intent, state: 'settled' });
    console.log(JSON.stringify({ label, state: 'settled' }));
  }
  if (!plan.registryExists) await mutate('create-registry', 'cloud_db_write_struct', ['--action', 'createCollection', '--collection-name', registry]);
  const mappings = await readAllCleanup(call, registry);
  assert.deepEqual(mappings, backup.mappings, 'Registry changed since backup');
  if (!plan.mappingExists) {
    const file = join(run, 'mapping.json');
    await save(file, [plan.mapping]);
    await mutate('reserve-id', 'cloud_db_write_doc', ['--action', 'insert', '--collection-name', registry, '--documents-file', file]);
  }
  assert.deepEqual(await readAllCleanup(call, registry, { _id: plan.publicId }), [plan.mapping], 'Reservation did not match');
  const query = { _id: plan.familyId, revision: plan.before.revision, publicId: { $exists: false } };
  assert.deepEqual(await readAllCleanup(call, 'families', query), [plan.before], 'Family changed before update');
  const queryFile = join(run, 'family-query.json'), updateFile = join(run, 'family-update.json');
  await save(queryFile, query);
  await save(updateFile, { $set: { publicId: plan.publicId }, $inc: { revision: 1 } });
  await mutate('assign-family-id', 'cloud_db_write_doc', ['--action', 'update', '--collection-name', 'families', '--query-file', queryFile, '--update-file', updateFile]);
  const after = await readAllCleanup(call, 'families');
  assert.deepEqual(after, backup.families.map(row => row._id === plan.familyId ? plan.after : row));
  const finalReferences = await references(call, plan.familyId);
  assert.deepEqual(finalReferences, backup.references, 'Related records changed during migration');
  const finalMappings = await readAllCleanup(call, registry);
  assert.deepEqual(finalMappings, [...backup.mappings, ...(!plan.mappingExists ? [plan.mapping] : [])].sort((a, b) => a._id.localeCompare(b._id)));
  const indexes = await call('cloud_db_read_struct', ['--action', 'listIndexes', '--collection-name', registry]);
  await save(join(directory, 'after.json'), { target: plan.target, families: after, mappings: finalMappings, references: finalReferences, indexes });
  const result = { publicId: plan.publicId, revision: plan.after.revision, familyCount: after.length, relatedDataUnchanged: true, references: Object.fromEntries(Object.entries(finalReferences).map(([key, rows]) => [key, rows.length])), cloudFunctionDeployed: false };
  await save(join(directory, 'result.json'), result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory, familyId] = process.argv.slice(2);
  assert.ok(['prepare', 'apply'].includes(mode) && directory);
  console.log(JSON.stringify(mode === 'prepare' ? await prepareFamilyPublicId(resolve(directory), familyId) : await applyFamilyPublicId(resolve(directory))));
}
