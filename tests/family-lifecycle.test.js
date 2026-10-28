import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const ok = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse('2026-10-27T10:00:00Z'), signFiles: async () => ({}), readImage: async () => ({ base64: 'aW1hZ2U=' }) });
  let sequence = 0;
  const call = (action, event = {}, openid = 'alice') => app({ action, ...event }, { OPENID: openid });
  const create = (name = '我们的小家', openid = 'alice') => ok(call('createFamily', { familyName: name, name: openid, requestId: `lifecycle-family-${++sequence}` }, openid));
  const command = (name, args, current, openid = 'alice') => ok(call('command', { name, args, revision: current.revision, familyId: current.familyId, requestId: `lifecycle-command-${++sequence}`, includeFeed: false }, openid));
  return { repository, call, create, command };
}

test('legacy invitation creation rejects a family switch between authorization and its transaction', async () => {
  const server = fixture();
  const first = await server.create('第一家');
  const second = await server.create('第二家');
  await ok(server.call('switchFamily', { familyId: first.familyId }));
  const before = await Promise.all([first, second].map(item => server.repository.get('families', item.familyId)));
  const originalTransaction = server.repository.transaction;
  let transactions = 0;
  server.repository.transaction = async callback => {
    if (++transactions === 2) {
      const account = await server.repository.get('users', hash('alice'));
      await originalTransaction(db => db.set('users', hash('alice'), { ...account, familyId: second.familyId }));
    }
    return originalTransaction(callback);
  };
  assert.equal((await server.call('createInvite', { familyId: first.familyId })).code, 'CONFLICT');
  assert.deepEqual(await Promise.all([first, second].map(item => server.repository.get('families', item.familyId))), before);
  assert.deepEqual(await server.repository.list('invites'), []);
  assert.equal((await server.repository.get('users', hash('alice'))).familyId, second.familyId);
});

test('legacy invitation creation respects an explicitly selected family', async () => {
  const server = fixture();
  const first = await server.create('第一家');
  const second = await server.create('第二家');
  assert.equal((await server.call('createInvite', { familyId: first.familyId })).code, 'CONFLICT');
  assert.deepEqual(await server.repository.list('invites'), []);
  const invitation = await ok(server.call('createInvite', { familyId: second.familyId }));
  const joined = await ok(server.call('joinFamily', { code: invitation.code }, 'bob'));
  assert.equal(joined.familyId, second.familyId);
});

test('deletion before the legacy invitation transaction cannot recreate a family or an invitation', async () => {
  const server = fixture();
  const created = await server.create();
  const originalTransaction = server.repository.transaction;
  let transactions = 0;
  server.repository.transaction = async callback => {
    if (++transactions === 2) await originalTransaction(async db => {
      const family = await db.get('families', created.familyId);
      const user = await db.get('users', hash('alice'));
      await db.set('families', created.familyId, { ...family, deletedAt: 1, members: [], revision: family.revision + 1 });
      await db.set('users', hash('alice'), { ...user, familyId: '', familyIds: [] });
    });
    return originalTransaction(callback);
  };
  assert.equal((await server.call('createInvite', { familyId: created.familyId })).code, 'NO_FAMILY');
  assert.equal((await server.repository.get('families', created.familyId)).deletedAt, 1);
  assert.deepEqual(await server.repository.list('invites'), []);
  assert.equal((await ok(server.call('bootstrap'))).needsFamily, true);
});

test('automatic owner succession preserves the successor membership and their private shares', async () => {
  const server = fixture();
  let current = await server.create();
  const invitation = await ok(server.call('prepareInvite'));
  await ok(server.call('joinFamily', { token: invitation.token }, 'bob'));
  current = await ok(server.call('bootstrap'));
  current = await server.command('saveRecipe', [createSeed().recipes[0]], current);
  const itemId = current.snapshot.recipes[0].id;
  const ownerShare = await ok(server.call('createDishShare', { kind: 'dish', itemId }));
  const successorShare = await ok(server.call('createDishShare', { kind: 'dish', itemId }, 'bob'));
  const membershipId = current.snapshot.family.members.find(member => member.id === hash('bob')).membershipId;
  assert.ok(membershipId);
  await ok(server.call('leaveFamily', { familyId: current.familyId }));
  const retained = await ok(server.call('bootstrap', {}, 'bob'));
  assert.equal(retained.snapshot.family.ownerId, hash('bob'));
  assert.equal(retained.snapshot.family.members[0].membershipId, membershipId);
  assert.deepEqual(retained.snapshot.recipes, current.snapshot.recipes);
  await ok(server.call('readShare', { token: successorShare.token }, 'visitor'));
  assert.equal((await server.call('readShare', { token: ownerShare.token }, 'visitor')).code, 'SHARE_EXPIRED');
});

for (const legacy of [false, true]) for (const removal of ['leaveFamily', 'removeMember']) {
  test(`friend shares stay invalid after ${removal} and rejoining (${legacy ? 'legacy' : 'new'} membership)`, async () => {
    const server = fixture();
    let current = await server.create();
    const invite = await ok(server.call('prepareInvite'));
    await ok(server.call('joinFamily', { token: invite.token }, 'bob'));
    if (legacy) {
      const family = await server.repository.get('families', current.familyId);
      family.members.forEach(member => { delete member.membershipId; });
      await server.repository.set('families', current.familyId, family);
    }
    current = await ok(server.call('bootstrap'));
    const image = 'cloud://env/private-lifecycle-image';
    await server.repository.set('media', hash(image), { fileId: image, confirmed: true, familyId: current.familyId });
    current = await server.command('saveRecipe', [{ ...createSeed().recipes[0], image }], current);
    const ownerShare = await ok(server.call('createDishShare', { kind: 'dish', itemId: current.snapshot.recipes[0].id }));
    const share = await ok(server.call('createDishShare', { kind: 'dish', itemId: current.snapshot.recipes[0].id }, 'bob'));
    if (legacy) {
      const record = await server.repository.get('shares', hash(share.token));
      delete record.membershipId;
      await server.repository.set('shares', hash(share.token), record);
    }
    await ok(server.call('readShare', { token: share.token }, 'visitor'));
    await server.create('接收方', 'recipient');
    const copied = await ok(server.call('importShare', { token: share.token }, 'recipient'));
    await ok(server.call(removal, { familyId: current.familyId, ...(removal === 'removeMember' ? { memberId: hash('bob') } : {}) }, removal === 'removeMember' ? 'alice' : 'bob'));
    assert.equal((await server.call('readShare', { token: share.token }, 'visitor')).code, 'SHARE_EXPIRED');
    const nextInvite = await ok(server.call('prepareInvite'));
    await ok(server.call('joinFamily', { token: nextInvite.token }, 'bob'));
    assert.equal((await server.call('readShare', { token: share.token }, 'visitor')).code, 'SHARE_EXPIRED');
    assert.equal((await server.call('importShare', { token: share.token }, 'recipient')).code, 'SHARE_EXPIRED');
    assert.equal((await server.call('mediaContent', { fileId: image, shareToken: share.token }, 'visitor')).code, 'SHARE_EXPIRED');
    await ok(server.call('readShare', { token: ownerShare.token }, 'visitor'));
    const newShare = await ok(server.call('createDishShare', { kind: 'dish', itemId: current.snapshot.recipes[0].id }, 'bob'));
    await ok(server.call('readShare', { token: newShare.token }, 'visitor'));
    assert.deepEqual((await ok(server.call('bootstrap', {}, 'recipient'))).snapshot.recipes, copied.snapshot.recipes);
  });
}

for (const action of ['removeMember', 'deleteFamily']) for (const staleState of ['missing', 'deleted', 'not-member']) {
  test(`${action} repairs a ${staleState} current pointer without losing another valid membership`, async () => {
    const server = fixture();
    const fallback = await server.create('保留家庭', 'bob');
    const doomed = await server.create('目标家庭');
    const invitation = await ok(server.call('prepareInvite'));
    await ok(server.call('joinFamily', { token: invitation.token }, 'bob'));
    const account = await server.repository.get('users', hash('bob'));
    if (staleState !== 'missing') await server.repository.set('families', 'stale-family', { id: 'stale-family', members: staleState === 'not-member' ? [] : [{ id: hash('bob') }], ...(staleState === 'deleted' ? { deletedAt: 1 } : {}) });
    await server.repository.set('users', hash('bob'), { ...account, familyId: 'stale-family', familyIds: [...account.familyIds, 'stale-family'] });
    await ok(server.call(action, { familyId: doomed.familyId, memberId: hash('bob'), confirmName: '目标家庭' }));
    const updated = await server.repository.get('users', hash('bob'));
    assert.deepEqual(updated.familyIds, [fallback.familyId]);
    assert.equal(updated.familyId, fallback.familyId);
    assert.equal((await ok(server.call('bootstrap', {}, 'bob'))).familyId, fallback.familyId);
  });
}

test('legacy onboarding can recover from a deleted current family while keeping active memberships', async () => {
  const server = fixture();
  const retained = await server.create('保留家庭');
  const stale = await server.create('已删除家庭');
  const record = await server.repository.get('families', stale.familyId);
  await server.repository.set('families', stale.familyId, { ...record, deletedAt: 1, members: [] });
  const result = await ok(server.call('createFamily', { familyName: '恢复家庭', name: 'alice' }));
  assert.equal(result.snapshot.family.name, '恢复家庭');
  assert.notEqual(result.familyId, stale.familyId);
  assert.deepEqual((await server.repository.get('users', hash('alice'))).familyIds, [retained.familyId, result.familyId]);
});
