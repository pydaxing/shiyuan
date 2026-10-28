import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { emptySnapshot } from '../src/domain/empty.js';

const bundle = await build({ entryPoints: ['src/services/cloud.js'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_DATA_MODE: 'cloud', VITE_CLOUD_ENV: 'test-only' }) } });
let sequence = 0;
const deletion = (familyId = 'family-1', status = 'pending') => ({ familyId, status, phase: status === 'complete' ? 'complete' : 'private' });
const detached = (pendingDeletions = [], extra = {}) => ({ needsFamily: true, userId: 'alice', pendingDeletions, ...extra });
const snapshot = (familyId = 'family-1', userId = 'alice', pendingDeletions = []) => ({ snapshot: { ...emptySnapshot(), family: { ...emptySnapshot().family, id: familyId } }, familyId, userId, revision: 1, pendingDeletions });
const ok = data => ({ ok: true, data });
async function client(handler) {
  const calls = [];
  globalThis.wx = { cloud: { init() {}, async callFunction({ data }) { calls.push(data); return { result: await handler(data) }; } } };
  const app = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}#deletion-${++sequence}`);
  app.bindCloudState({ value: emptySnapshot() });
  app.cloudStatus.value = { phase: 'ready', familyId: 'family-1', userId: 'alice', revision: 1, busy: false, error: '' };
  return { ...app, calls };
}

for (const action of ['deleteFamily', 'leaveFamily']) test(`${action} waits for complete after a pending deletion response`, async () => {
  let continuations = 0;
  const app = await client(async data => {
    if (data.action === `${action}WithCleanup`) return ok(detached([deletion()], { deletion: deletion() }));
    assert.equal(data.action, 'continueFamilyDeletion');
    assert.equal(data.familyId, 'family-1');
    continuations += 1;
    const state = deletion('family-1', continuations === 2 ? 'complete' : 'pending');
    return ok(detached(state.status === 'pending' ? [state] : [], { deletion: state }));
  });
  const result = await app.manageFamily(action, { familyId: 'family-1' });
  assert.equal(result.deletion.status, 'complete');
  assert.equal(continuations, 2);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.phase, 'onboarding');
  assert.equal(app.cloudStatus.value.error, '');
  app.flushCloudCache();
});

test('a bounded pending cleanup remains actionable and ordinary bootstrap cannot erase it', async () => {
  const app = await client(async () => ok(detached([deletion()], { deletion: deletion() })));
  await assert.rejects(app.manageFamily('deleteFamily'), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.calls.filter(item => item.action === 'continueFamilyDeletion').length, 3);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  assert.match(app.cloudStatus.value.error, /尚未确认清理完成/);
  assert.equal(app.cloudStatus.value.phase, 'error');
  await app.cloudCall('bootstrap');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  assert.match(app.cloudStatus.value.error, /继续清理/);
  await assert.rejects(app.manageFamily('createFamily', { familyName: '另一家' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  app.flushCloudCache();
});

test('lost delete response is not treated as completed merely because membership disappeared', async () => {
  let available = false;
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') throw new Error('response lost');
    if (data.action === 'listFamilies') return ok({ families: [], pendingDeletions: [] });
    if (data.action === 'continueFamilyDeletion') {
      if (!available) throw new Error('offline');
      return ok(detached([], { deletion: deletion('family-1', 'complete') }));
    }
    return ok(detached());
  });
  await assert.rejects(app.manageFamily('deleteFamily'), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  available = true;
  const result = await app.recoverFamilyState();
  assert.equal(result.removed, true);
  assert.equal(result.deletion.status, 'complete');
  assert.equal(app.calls.filter(item => item.action === 'deleteFamilyWithCleanup').length, 1);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  app.flushCloudCache();
});

test('bootstrap after restart exposes and resumes all server-confirmed pending deletions', async () => {
  const unfinished = new Set(['old-a', 'old-b']);
  const app = await client(async data => {
    const states = () => [...unfinished].map(id => deletion(id));
    if (data.action === 'listFamilies') return ok({ families: [{ id: 'family-1' }], pendingDeletions: states() });
    if (data.action === 'continueFamilyDeletion') {
      assert.ok(unfinished.has(data.familyId));
      unfinished.delete(data.familyId);
      return ok({ ...snapshot('family-1', 'alice', states()), deletion: deletion(data.familyId, 'complete') });
    }
    return ok(snapshot('family-1', 'alice', states()));
  });
  await app.cloudCall('bootstrap');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  assert.equal(app.cloudStatus.value.pendingDeletions.length, 2);
  await app.refreshCloud();
  assert.deepEqual(app.calls.filter(item => item.action === 'continueFamilyDeletion').map(item => item.familyId), ['old-a', 'old-b']);
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  app.flushCloudCache();
});

test('ordinary exit with remaining members does not invoke deletion continuation', async () => {
  const app = await client(async data => {
    assert.equal(data.action, 'leaveFamilyWithCleanup');
    return ok(detached());
  });
  await app.manageFamily('leaveFamily');
  assert.deepEqual(app.calls.map(item => item.action), ['leaveFamilyWithCleanup']);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  app.flushCloudCache();
});

for (const action of ['leaveFamily', 'deleteFamily']) test(`${action} is rejected by an old service before it can remove the family`, async () => {
  let legacyMutations = 0;
  const app = await client(async data => {
    if (['leaveFamily', 'deleteFamily'].includes(data.action)) {
      legacyMutations += 1;
      return ok(detached());
    }
    assert.equal(data.action, `${action}WithCleanup`);
    return { ok: false, code: 'INVALID', message: '不支持的请求' };
  });
  await assert.rejects(app.manageFamily(action, { familyId: 'family-1' }), /请先更新家庭服务/);
  assert.equal(legacyMutations, 0);
  assert.deepEqual(app.calls.map(item => item.action), [`${action}WithCleanup`]);
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.cloudStatus.value.userId, 'alice');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, undefined);
  assert.equal(app.cloudStatus.value.busy, false);
  app.flushCloudCache();
});

test('continuations retain the deleted target when bootstrap selects another family', async () => {
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') return ok({ ...snapshot('family-2', 'alice', [deletion()]), deletion: deletion() });
    assert.equal(data.familyId, 'family-1');
    return ok({ ...snapshot('family-2'), deletion: deletion('family-1', 'complete') });
  });
  await app.manageFamily('deleteFamily');
  assert.equal(app.cloudStatus.value.familyId, 'family-2');
  assert.equal(app.calls[1].familyId, 'family-1');
  app.flushCloudCache();
});

test('account changes stop continuation before any further deletion request', async () => {
  let app;
  app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') return ok(detached([deletion()], { deletion: deletion() }));
    app.cloudStatus.value.userId = 'bob';
    return ok({ ...snapshot('bobs-family', 'bob'), deletion: deletion() });
  });
  await assert.rejects(app.manageFamily('deleteFamily'), { code: 'SCOPE_CHANGED' });
  assert.equal(app.calls.filter(item => item.action === 'continueFamilyDeletion').length, 1);
  assert.equal(app.cloudStatus.value.userId, 'bob');
  app.flushCloudCache();
});

for (const code of ['FORBIDDEN', 'CONFLICT', 'NO_FAMILY', 'UNAUTHENTICATED', 'INVALID', 'RATE_LIMIT']) test(`an acknowledged ${code} removal refusal refreshes the remaining family without inventing a cleanup`, async () => {
  const message = '当前操作未提交';
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') return { ok: false, code, message };
    if (data.action === 'listFamilies') return ok({ families: [{ id: 'remaining-family' }], pendingDeletions: [] });
    assert.ok(['bootstrap', 'switchFamily'].includes(data.action));
    return ok(snapshot('remaining-family'));
  });
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'departed-family' }), error => error.code === code && error.message === message);
  assert.deepEqual(app.calls.map(item => item.action), ['deleteFamilyWithCleanup', 'bootstrap', 'listFamilies']);
  assert.equal(app.cloudStatus.value.familyId, 'remaining-family');
  assert.equal(app.cloudStatus.value.phase, 'ready');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.error, message);
  await app.manageFamily('switchFamily', { familyId: 'remaining-family' });
  assert.equal(app.calls.at(-1).action, 'switchFamily');
  app.flushCloudCache();
});

test('a rejected deletion keeps its refusal after resuming only server-confirmed earlier cleanup', async () => {
  const state = deletion('earlier-family');
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') return { ok: false, code: 'FORBIDDEN', message: '你已不在这个家庭中' };
    if (data.action === 'listFamilies') return ok({ families: [{ id: 'remaining-family' }], pendingDeletions: [state] });
    if (data.action === 'continueFamilyDeletion') {
      assert.equal(data.familyId, 'earlier-family');
      return ok({ ...snapshot('remaining-family'), deletion: deletion('earlier-family', 'complete') });
    }
    return ok(snapshot('remaining-family', 'alice', [state]));
  });
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'departed-family' }), { code: 'FORBIDDEN' });
  assert.deepEqual(app.calls.filter(item => item.action === 'continueFamilyDeletion').map(item => item.familyId), ['earlier-family']);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.familyId, 'remaining-family');
  app.flushCloudCache();
});

test('a business refusal followed by a failed refresh can recover later without reporting removal success', async () => {
  let online = false;
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') return { ok: false, code: 'FORBIDDEN', message: '你已不在这个家庭中' };
    if (!online) throw new Error('offline');
    if (data.action === 'listFamilies') return ok({ families: [{ id: 'remaining-family' }], pendingDeletions: [] });
    assert.equal(data.action, 'bootstrap');
    return ok(snapshot('remaining-family'));
  });
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'departed-family' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  online = true;
  const recovered = await app.recoverFamilyState();
  assert.equal(recovered.removed, false);
  assert.equal(recovered.deletion, undefined);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.familyId, 'remaining-family');
  assert.equal(app.calls.some(item => item.action === 'continueFamilyDeletion'), false);
  app.flushCloudCache();
});

for (const failure of ['INTERNAL', 'transport']) test(`${failure} removal failure remains uncertain even when the target is absent`, async () => {
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') {
      if (failure === 'transport') throw Object.assign(new Error('connection closed'), { code: 'FORBIDDEN' });
      return { ok: false, code: 'INTERNAL', message: '服务暂不可用' };
    }
    if (data.action === 'listFamilies') return ok({ families: [{ id: 'remaining-family' }], pendingDeletions: [] });
    if (data.action === 'continueFamilyDeletion') {
      assert.equal(data.familyId, 'departed-family');
      throw new Error('cleanup unavailable');
    }
    return ok(snapshot('remaining-family'));
  });
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'departed-family' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  assert.deepEqual(app.calls.filter(item => item.action === 'continueFamilyDeletion').map(item => item.familyId), ['departed-family']);
  app.flushCloudCache();
});
