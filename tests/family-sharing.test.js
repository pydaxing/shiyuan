import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';
import { invitationCard, dishShareCard, registerShare, shareMessage, removeShare } from '../src/services/native-share.js';
import { FAMILY_AVATARS, familyAvatar, FAMILY_APPEARANCE_DEFAULTS } from '../src/domain/family.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
function fixture() {
  const repository = memoryRepository();
  let clock = Date.parse('2026-09-11T03:00:00Z');
  let sequence = 0;
  const app = createApplication({ repository, now: () => clock, signFiles: async () => ({}), storeImage: async fileId => ({ fileId, encryptionKey: 'server-only' }), storeImageBytes: async () => ({ fileId: `cloud://env/profile-${++sequence}`, encryptionKey: 'server-only' }), readImage: async () => ({ base64: 'aW1hZ2U=' }) });
  const call = (action, payload = {}, openid = 'alice') => app({ action, ...payload }, { OPENID: openid });
  const success = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
  const create = (name = '我们的小家', openid = 'alice', requestId = `family-request-${++sequence}`) => success(call('createFamily', { familyName: name, name: openid, requestId }, openid));
  const command = (name, args, revision, openid = 'alice') => success(call('command', { name, args, revision, requestId: `command-request-${++sequence}`, includeFeed: false }, openid));
  return { repository, call, success, create, command, advance: milliseconds => { clock += milliseconds; } };
}

test('deleting a listed non-current family preserves the active family and requires explicit targeting', async () => {
  const server = fixture();
  const target = await server.create('爸妈家');
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  const current = await server.create('现在的小家');
  const activeBefore = await server.repository.get('families', current.familyId);
  const payload = { familyId: target.familyId, expectedCurrentFamilyId: current.familyId, confirmName: '爸妈家' };
  assert.equal((await server.call('deleteFamily', { familyId: target.familyId, confirmName: '爸妈家' })).code, 'CONFLICT');
  assert.equal((await server.call('deleteFamily', { ...payload, confirmName: '现在的小家' })).ok, false);
  const result = await server.success(server.call('deleteFamily', payload));
  assert.equal(result.familyId, current.familyId);
  assert.deepEqual(await server.repository.get('families', current.familyId), activeBefore);
  assert.ok((await server.repository.get('families', target.familyId)).deletedAt);
  assert.equal((await server.repository.get('users', hash('bob'))).familyId, '');
  assert.equal((await server.success(server.call('deleteFamily', payload))).deletion.familyId, target.familyId);
  assert.equal((await server.success(server.call('bootstrap'))).familyId, current.familyId);
});

for (const owner of [false, true]) {
  test(`leaving a non-current family uses that card's membership and administrator role: ${owner}`, async () => {
    const server = fixture();
    const target = await server.create('共同的家');
    const invite = await server.success(server.call('prepareInvite'));
    await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
    const leavingUser = owner ? 'alice' : 'bob';
    const remainingUser = owner ? 'bob' : 'alice';
    const current = await server.create('另一个家', leavingUser);
    const activeBefore = await server.repository.get('families', current.familyId);
    const result = await server.success(server.call('leaveFamily', { familyId: target.familyId, expectedCurrentFamilyId: current.familyId }, leavingUser));
    assert.equal(result.familyId, current.familyId);
    assert.deepEqual(await server.repository.get('families', current.familyId), activeBefore);
    const remaining = await server.repository.get('families', target.familyId);
    assert.deepEqual(remaining.members.map(member => member.id), [hash(remainingUser)]);
    assert.equal(remaining.ownerId, hash(remainingUser));
    assert.deepEqual((await server.repository.get('users', hash(leavingUser))).familyIds, [current.familyId]);
  });
}

test('leaving the last-member family from its card cannot delete the active family on a retry', async () => {
  const server = fixture();
  const target = await server.create('旧家庭');
  const current = await server.create('当前家庭');
  const activeBefore = await server.repository.get('families', current.familyId);
  const payload = { familyId: target.familyId, expectedCurrentFamilyId: current.familyId };
  const result = await server.success(server.call('leaveFamily', payload));
  assert.equal(result.familyId, current.familyId);
  assert.ok((await server.repository.get('families', target.familyId)).deletedAt);
  const retry = await server.success(server.call('leaveFamily', payload));
  assert.equal(retry.deletion.familyId, target.familyId);
  assert.deepEqual(await server.repository.get('families', current.familyId), activeBefore);
});

test('targeted family operations still reject stale selection, outsiders, invalid targets and non-administrators', async () => {
  const server = fixture();
  const target = await server.create('共同的家');
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  const current = await server.create('自己的家', 'bob');
  const payload = { familyId: target.familyId, expectedCurrentFamilyId: current.familyId, confirmName: '共同的家' };
  assert.equal((await server.call('deleteFamily', payload, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('leaveFamily', { ...payload, expectedCurrentFamilyId: target.familyId }, 'bob')).code, 'CONFLICT');
  assert.equal((await server.call('leaveFamily', { ...payload, familyId: 'unknown-family' }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('leaveFamily', { ...payload, familyId: '' }, 'bob')).code, 'INVALID');
  assert.equal((await server.call('removeMember', { ...payload, memberId: hash('alice') }, 'bob')).ok, false);
  const stranger = await server.create('无关家庭', 'stranger');
  assert.equal((await server.call('leaveFamily', { ...payload, expectedCurrentFamilyId: stranger.familyId }, 'stranger')).code, 'FORBIDDEN');
  assert.equal((await server.repository.get('families', target.familyId)).members.length, 2);
  assert.equal((await server.repository.get('users', hash('bob'))).familyId, current.familyId);
});

test('legacy accounts migrate lazily; multiple households keep independent data and active selection', async () => {
  const server = fixture();
  const first = await server.create('小家');
  const account = await server.repository.get('users', hash('alice'));
  delete account.familyIds;
  await server.repository.set('users', hash('alice'), account);
  await server.command('saveRecipe', [createSeed().recipes[0]], first.revision);
  const second = await server.create('爸妈家');
  assert.notEqual(first.familyId, second.familyId);
  assert.equal(second.snapshot.recipes.length, 0);
  const listed = await server.success(server.call('listFamilies'));
  assert.equal(listed.families.length, 2);
  assert.equal(listed.families.filter(family => family.current).length, 1);
  const switched = await server.success(server.call('switchFamily', { familyId: first.familyId }));
  assert.equal(switched.snapshot.recipes.length, 1);
  assert.equal((await server.call('switchFamily', { familyId: first.familyId }, 'stranger')).code, 'FORBIDDEN');
});

test('create family retries are idempotent and failed retries do not create a third family', async () => {
  const server = fixture();
  const first = await server.create('小家', 'alice', 'create-idempotent-001');
  const repeated = await server.create('小家', 'alice', 'create-idempotent-001');
  assert.equal(repeated.familyId, first.familyId);
  assert.equal((await server.call('createFamily', { familyName: '其他', requestId: 'create-idempotent-001' })).code, 'CONFLICT');
  assert.equal((await server.success(server.call('listFamilies'))).families.length, 1);
});

test('family defaults persist across retries; cover takes precedence over default portraits', async () => {
  const server = fixture();
  const current = await server.create('小家', 'alice', 'portrait-request-001');
  assert.ok(FAMILY_AVATARS.includes(current.snapshot.family.avatar));
  const repeated = await server.create('小家', 'alice', 'portrait-request-001');
  assert.equal(repeated.snapshot.family.avatar, current.snapshot.family.avatar);
  const chosen = await server.success(server.call('createFamily', { familyName: '另一个家', requestId: 'portrait-request-002', familyAvatar: FAMILY_AVATARS[3] }));
  assert.equal(chosen.snapshot.family.avatar, FAMILY_AVATARS[3]);
  assert.equal((await server.call('createFamily', { familyName: '不合法', requestId: 'portrait-request-003', familyAvatar: 'https://foreign/avatar' })).ok, false);
  assert.equal(familyAvatar({ cover: 'cloud://cover', avatar: FAMILY_AVATARS[0] }), 'cloud://cover');
  assert.equal(familyAvatar({ id: 'old-family' }), familyAvatar({ id: 'old-family', name: 'changed' }));
  for (const path of FAMILY_AVATARS) assert.ok(readFileSync(new URL(`../src${path}`, import.meta.url)).length > 100);
});

async function uploadFamilyDraft(server, requestId, openid = 'alice') {
  const ticket = await server.success(server.call('familyCoverTicket', { requestId }, openid));
  return server.success(server.call('familyCoverConfirm', { requestId, ticket: ticket.id, fileId: `cloud://env/${ticket.path}` }, openid));
}

test('new family keeps the default cover and menu copy when no appearance is supplied', async () => {
  const server = fixture();
  const created = await server.success(server.call('createFamilyWithAppearance', { familyName: '新家', cover: '', coverTitle: '', requestId: 'empty-cover-create-001' }));
  assert.equal(created.snapshot.family.cover, '');
  assert.equal(created.snapshot.family.coverTitle, FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(created.snapshot.family.coverSubtitle, FAMILY_APPEARANCE_DEFAULTS.coverSubtitle);
  assert.equal((await server.call('createFamily', { familyName: ' ', requestId: 'invalid-name-create-001' })).ok, false);
  assert.equal((await server.call('createFamily', { familyName: '新家', coverTitle: '字'.repeat(31), requestId: 'long-title-create-001' })).ok, false);
  assert.equal((await server.success(server.call('listFamilies'))).families.length, 1);
});

test('subtitle-aware family creation is atomic, idempotent and retains both lines when switching families', async () => {
  const server = fixture();
  const previous = await server.create('原来的小家');
  const payload = { familyName: '周末的小家', cover: '', coverTitle: ' 都是爱吃的菜 ', coverSubtitle: ' 一日三餐，一起吃饭 ', requestId: 'create-with-subtitle-001' };
  const created = await server.success(server.call('createFamilyWithSubtitle', payload));
  assert.equal(created.snapshot.family.coverTitle, '都是爱吃的菜');
  assert.equal(created.snapshot.family.coverSubtitle, '一日三餐，一起吃饭');
  const repeated = await server.success(server.call('createFamilyWithSubtitle', payload));
  assert.equal(repeated.familyId, created.familyId);
  assert.equal((await server.call('createFamilyWithSubtitle', { ...payload, coverSubtitle: '别的内容' })).code, 'CONFLICT');
  for (const [index, invalid] of [null, 1, {}, '字'.repeat(51)].entries()) {
    assert.equal((await server.call('createFamilyWithSubtitle', { ...payload, coverSubtitle: invalid, requestId: `invalid-subtitle-create-${index}` })).ok, false);
  }
  assert.equal((await server.success(server.call('listFamilies'))).families.length, 2);
  const switched = await server.success(server.call('switchFamily', { familyId: previous.familyId }));
  assert.equal(switched.snapshot.family.coverSubtitle, FAMILY_APPEARANCE_DEFAULTS.coverSubtitle);
  const restored = await server.success(server.call('switchFamily', { familyId: created.familyId }));
  assert.equal(restored.snapshot.family.coverTitle, '都是爱吃的菜');
  assert.equal(restored.snapshot.family.coverSubtitle, '一日三餐，一起吃饭');
});

test('subtitle-aware family edits return both lines in patches, reload correctly and preserve legacy callers', async () => {
  const server = fixture();
  const created = await server.create();
  const appearance = { name: '小家菜单', cover: '', coverTitle: ' 一起开饭 ', coverSubtitle: ' 好好吃饭，慢慢生活 ' };
  const payload = { name: 'customizeFamilyWithSubtitle', args: [appearance], revision: created.revision, requestId: 'edit-with-subtitle-001', responseMode: 'changes' };
  const saved = await server.success(server.call('command', payload));
  assert.equal(saved.changes.family.coverTitle, '一起开饭');
  assert.equal(saved.changes.family.coverSubtitle, '好好吃饭，慢慢生活');
  assert.equal((await server.success(server.call('command', payload))).revision, saved.revision);
  assert.equal((await server.call('command', { ...payload, args: [{ ...appearance, coverSubtitle: '换个标题' }] })).code, 'CONFLICT');
  for (const [index, invalid] of [null, 1, {}, '字'.repeat(51)].entries()) {
    assert.equal((await server.call('command', { ...payload, revision: saved.revision, requestId: `invalid-subtitle-edit-${index}`, args: [{ ...appearance, coverSubtitle: invalid }] })).ok, false);
  }
  const reloaded = await server.success(server.call('bootstrap'));
  assert.equal(reloaded.revision, saved.revision);
  assert.equal(reloaded.snapshot.family.coverSubtitle, '好好吃饭，慢慢生活');
  const legacy = await server.command('customizeFamily', [{ name: '旧客户端改名', cover: '', coverTitle: '旧客户端标题' }], saved.revision);
  assert.equal(legacy.snapshot.family.coverSubtitle, '好好吃饭，慢慢生活');
  assert.equal((await server.repository.get('families', created.familyId)).coverSubtitle, '好好吃饭，慢慢生活');
});

test('new family cover drafts are private to their uploader and adopted atomically on creation', async () => {
  const server = fixture();
  const previous = await server.create();
  const previousBefore = await server.repository.get('families', previous.familyId);
  const invitation = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invitation.token }, 'bob'));
  const requestId = 'cover-creation-request-001';
  const uploaded = await uploadFamilyDraft(server, requestId);
  const media = await server.repository.get('media', hash(uploaded.fileId));
  assert.equal(media.familyDraftRequest, requestId);
  assert.notEqual(media.familyId, previous.familyId);
  assert.equal((await server.call('mediaContent', { fileId: uploaded.fileId, variant: 'detail' })).ok, true);
  assert.equal((await server.call('mediaContent', { fileId: uploaded.fileId, variant: 'detail' }, 'bob')).code, 'FORBIDDEN');
  const payload = { familyName: '周末小家', cover: uploaded.fileId, coverTitle: ' 一起吃饭 ', requestId };
  const created = await server.success(server.call('createFamilyWithAppearance', payload));
  assert.equal(created.snapshot.family.cover, uploaded.fileId);
  assert.equal(created.snapshot.family.coverTitle, '一起吃饭');
  const adopted = await server.repository.get('media', hash(uploaded.fileId));
  assert.equal(adopted.familyId, created.familyId);
  assert.equal(adopted.familyDraftRequest, undefined);
  assert.equal(adopted.encryptionKey, media.encryptionKey);
  const repeated = await server.success(server.call('createFamily', payload));
  assert.equal(repeated.familyId, created.familyId);
  assert.equal((await server.call('createFamily', { ...payload, coverTitle: '不同标题' })).code, 'CONFLICT');
  assert.equal((await server.call('createFamily', { ...payload, cover: '' })).code, 'CONFLICT');
  const oldFamily = await server.repository.get('families', previous.familyId);
  assert.equal(oldFamily.cover, previousBefore.cover);
  assert.equal(oldFamily.name, previousBefore.name);
  const newInvite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: newInvite.token }, 'bob'));
  await server.success(server.call('switchFamily', { familyId: previous.familyId }, 'bob'));
  assert.equal((await server.call('mediaContent', { fileId: uploaded.fileId, variant: 'card' }, 'bob')).ok, true);
});

test('family creation rejects foreign, reused, unconfirmed and wrong-session cover images', async () => {
  const server = fixture();
  const original = await server.create();
  const requestId = 'guarded-cover-request-001';
  const uploaded = await uploadFamilyDraft(server, requestId);
  assert.equal((await server.call('createFamily', { familyName: '新家', cover: uploaded.fileId, requestId: 'wrong-cover-request-001' })).code, 'FORBIDDEN');
  assert.equal((await server.call('createFamily', { familyName: '新家', cover: uploaded.fileId, requestId }, 'stranger')).code, 'FORBIDDEN');
  const ticket = await server.success(server.call('familyCoverTicket', { requestId }));
  assert.equal((await server.call('createFamily', { familyName: '新家', cover: `cloud://env/${ticket.path}`, requestId })).code, 'FORBIDDEN');
  for (const cover of ['https://example.com/photo.jpg', '/static/family-home-default.jpg']) assert.equal((await server.call('createFamily', { familyName: '新家', cover, requestId })).ok, false);
  assert.equal((await server.success(server.call('bootstrap'))).familyId, original.familyId);
  const created = await server.success(server.call('createFamily', { familyName: '新家', cover: uploaded.fileId, requestId }));
  assert.equal((await server.call('createFamily', { familyName: '另一个家', cover: uploaded.fileId, requestId: 'reused-cover-request-001' })).code, 'FORBIDDEN');
  assert.equal((await server.repository.get('media', hash(uploaded.fileId))).familyId, created.familyId);
});

test('cover upload tickets bind confirmation to both account and creation request', async () => {
  const server = fixture();
  const requestId = 'draft-ticket-request-001';
  assert.equal((await server.call('familyCoverTicket', { requestId: 'bad' })).ok, false);
  const ticket = await server.success(server.call('familyCoverTicket', { requestId }));
  const payload = { requestId, ticket: ticket.id, fileId: `cloud://env/${ticket.path}` };
  assert.equal((await server.call('familyCoverConfirm', { ...payload, requestId: 'another-ticket-request' })).code, 'FORBIDDEN');
  assert.equal((await server.call('familyCoverConfirm', payload, 'stranger')).code, 'FORBIDDEN');
  assert.equal((await server.call('familyCoverConfirm', { ...payload, fileId: 'cloud://env/private/other.jpg' })).code, 'FORBIDDEN');
  const confirmed = await server.success(server.call('familyCoverConfirm', payload));
  assert.deepEqual(await server.success(server.call('familyCoverConfirm', payload)), confirmed);
  const expired = await server.success(server.call('familyCoverTicket', { requestId }));
  server.advance(3600001);
  assert.equal((await server.call('familyCoverConfirm', { requestId, ticket: expired.id, fileId: `cloud://env/${expired.path}` })).code, 'FORBIDDEN');
});

test('failed family writes roll back draft adoption and allow the same creation to retry', async () => {
  const server = fixture();
  const previous = await server.create();
  const requestId = 'rollback-cover-request-001';
  const uploaded = await uploadFamilyDraft(server, requestId);
  const before = await server.repository.get('media', hash(uploaded.fileId));
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(db => callback({ ...db, set: async (table, id, value) => {
    if (table === 'families') throw new Error('Simulated create failure');
    return db.set(table, id, value);
  } }));
  const payload = { familyName: '新家', cover: uploaded.fileId, coverTitle: '一起吃饭', requestId };
  assert.equal((await server.call('createFamily', payload)).ok, false);
  assert.deepEqual(await server.repository.get('media', hash(uploaded.fileId)), before);
  assert.equal((await server.repository.get('users', hash('alice'))).familyId, previous.familyId);
  server.repository.transaction = transaction;
  const created = await server.success(server.call('createFamily', payload));
  assert.equal(created.snapshot.family.cover, uploaded.fileId);
  assert.equal((await server.success(server.call('listFamilies'))).families.length, 2);
});

test('only current administrator can assign one household head; honorary title grants no permissions', async () => {
  const server = fixture();
  await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  assert.equal((await server.call('setFamilyHead', { memberId: hash('bob') }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('setFamilyHead', { memberId: 'outsider' })).ok, false);
  const titled = await server.success(server.call('setFamilyHead', { memberId: hash('bob') }));
  assert.equal(titled.snapshot.family.headMemberId, hash('bob'));
  assert.equal(titled.snapshot.family.ownerId, hash('alice'));
  assert.equal((await server.call('deleteFamily', { confirmName: '我们的小家' }, 'bob')).code, 'FORBIDDEN');
  const reassigned = await server.success(server.call('setFamilyHead', { memberId: hash('alice') }));
  assert.equal(reassigned.snapshot.family.headMemberId, hash('alice'));
  const cleared = await server.success(server.call('setFamilyHead', { memberId: '' }));
  assert.equal(cleared.snapshot.family.headMemberId, '');
});

test('ownership transfer revokes old invitations and permissions without ejecting the previous owner', async () => {
  const server = fixture();
  const created = await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  const args = { successorId: hash('bob'), expectedOwnerId: hash('alice'), familyId: created.familyId };
  assert.equal((await server.call('transferFamilyOwner', args, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('transferFamilyOwner', { ...args, expectedOwnerId: 'outdated' })).code, 'CONFLICT');
  assert.equal((await server.call('transferFamilyOwner', { ...args, familyId: 'another-family' })).code, 'CONFLICT');
  const transferred = await server.success(server.call('transferFamilyOwner', args));
  assert.equal(transferred.snapshot.family.ownerId, hash('bob'));
  assert.equal(transferred.snapshot.family.members.length, 2);
  assert.equal(transferred.snapshot.family.members.find(member => member.id === hash('bob')).role, '家庭管理员');
  assert.equal((await server.call('readInvite', { token: invite.token }, 'stranger')).code, 'INVITE_EXPIRED');
  assert.equal((await server.call('prepareInvite')).code, 'FORBIDDEN');
  assert.equal((await server.call('setFamilyHead', { memberId: hash('alice') })).code, 'FORBIDDEN');
  const replacement = await server.success(server.call('prepareInvite', {}, 'bob'));
  assert.notEqual(replacement.token, invite.token);
  assert.equal((await server.call('transferFamilyOwner', args)).code, 'FORBIDDEN');
});

test('administrator exit auto-transfers and leaves atomically; regular exit clears honorary title', async () => {
  const server = fixture();
  const other = await server.create('另一个家');
  const current = await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  await server.success(server.call('setFamilyHead', { memberId: hash('alice') }));
  const before = await server.repository.get('families', current.familyId);
  assert.equal((await server.call('leaveFamily', { successorId: 'outsider', expectedOwnerId: hash('alice') })).ok, false);
  assert.deepEqual(await server.repository.get('families', current.familyId), before);
  const result = await server.success(server.call('leaveFamily', { familyId: current.familyId }));
  assert.equal(result.familyId, other.familyId);
  const remaining = await server.repository.get('families', current.familyId);
  assert.equal(remaining.ownerId, hash('bob'));
  assert.equal(remaining.headMemberId, '');
  assert.deepEqual(remaining.members.map(member => member.id), [hash('bob')]);
  assert.equal((await server.call('readInvite', { token: invite.token })).code, 'INVITE_EXPIRED');
  assert.equal((await server.call('leaveFamily', { familyId: current.familyId, successorId: hash('bob'), expectedOwnerId: hash('alice') })).code, 'CONFLICT');
  const nextInvite = await server.success(server.call('prepareInvite', {}, 'bob'));
  await server.success(server.call('joinFamily', { token: nextInvite.token }, 'carol'));
  await server.success(server.call('setFamilyHead', { memberId: hash('carol') }, 'bob'));
  const left = await server.success(server.call('leaveFamily', { familyId: current.familyId }, 'carol'));
  assert.equal(left.needsFamily, true);
  assert.equal((await server.repository.get('families', current.familyId)).headMemberId, '');
});

test('automatic succession follows join order while explicit legacy selection remains supported', async () => {
  for (const explicit of [false, true]) {
    const server = fixture();
    const created = await server.create();
    const invite = await server.success(server.call('prepareInvite'));
    for (const openid of ['bob', 'carol']) await server.success(server.call('joinFamily', { token: invite.token }, openid));
    const payload = explicit ? { successorId: hash('carol'), expectedOwnerId: hash('alice') } : {};
    const before = await server.repository.get('families', created.familyId);
    assert.equal((await server.call('leaveFamily', { expectedOwnerId: 'outdated' })).code, 'CONFLICT');
    assert.deepEqual(await server.repository.get('families', created.familyId), before);
    await server.success(server.call('leaveFamily', { familyId: created.familyId, ...payload }));
    const remaining = await server.repository.get('families', created.familyId);
    assert.equal(remaining.ownerId, hash(explicit ? 'carol' : 'bob'));
    assert.equal(remaining.members.length, 2);
    assert.equal(remaining.members.filter(member => member.role === '家庭管理员').length, 1);
    assert.equal(remaining.revision, before.revision + 1);
  }
});

test('last member exit deletes the family without a name and clears all membership and invitation access', async () => {
  const server = fixture();
  const created = await server.create();
  const invitation = await server.success(server.call('prepareInvite'));
  assert.equal((await server.call('leaveFamily', { familyId: created.familyId }, 'outsider')).code, 'NO_FAMILY');
  const result = await server.success(server.call('leaveFamily', { familyId: created.familyId }));
  assert.equal(result.needsFamily, true);
  const deleted = await server.repository.get('families', created.familyId);
  assert.ok(deleted.deletedAt);
  assert.deepEqual(deleted.members, []);
  const account = await server.repository.get('users', hash('alice'));
  assert.deepEqual(account.familyIds, []);
  assert.equal(account.familyId, '');
  assert.deepEqual((await server.success(server.call('listFamilies'))).families, []);
  assert.equal((await server.call('readInvite', { token: invitation.token }, 'bob')).code, 'INVITE_EXPIRED');
  assert.equal((await server.call('joinFamily', { token: invitation.token }, 'bob')).code, 'INVITE_EXPIRED');
  assert.equal((await server.call('switchFamily', { familyId: created.familyId })).code, 'FORBIDDEN');
  assert.equal((await server.success(server.call('leaveFamily', { familyId: created.familyId }))).deletion.familyId, created.familyId);
});

test('last member exit selects another family and a stale retry cannot delete that family', async () => {
  const server = fixture();
  const other = await server.create('另一个家');
  const current = await server.create();
  const result = await server.success(server.call('leaveFamily', { familyId: current.familyId }));
  assert.equal(result.familyId, other.familyId);
  assert.deepEqual((await server.repository.get('users', hash('alice'))).familyIds, [other.familyId]);
  assert.equal((await server.success(server.call('leaveFamily', { familyId: current.familyId }))).deletion.familyId, current.familyId);
  assert.deepEqual(await server.repository.get('families', other.familyId), { ...other.snapshot.family, _id: other.familyId });
});

test('simultaneous exits leave no empty live family or dangling memberships', async () => {
  const server = fixture();
  const created = await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  const results = await Promise.all(['alice', 'bob'].map(openid => server.call('leaveFamily', { familyId: created.familyId }, openid)));
  for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  const deleted = await server.repository.get('families', created.familyId);
  assert.ok(deleted.deletedAt);
  assert.deepEqual(deleted.members, []);
  for (const openid of ['alice', 'bob']) {
    assert.equal((await server.success(server.call('bootstrap', {}, openid))).needsFamily, true);
    assert.deepEqual((await server.repository.get('users', hash(openid))).familyIds, []);
  }
});

test('failed exit writes roll back owner transfer, invitations and memberships together', async () => {
  const server = fixture();
  const created = await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  const before = await server.repository.get('families', created.familyId);
  const originalTransaction = server.repository.transaction;
  server.repository.transaction = callback => originalTransaction(db => callback({ ...db, set: async (table, id, value) => {
    if (table === 'families') throw new Error('Simulated write failure');
    return db.set(table, id, value);
  } }));
  assert.equal((await server.call('leaveFamily', { familyId: created.familyId })).ok, false);
  assert.deepEqual(await server.repository.get('families', created.familyId), before);
  assert.equal((await server.repository.get('users', hash('alice'))).familyId, created.familyId);
  assert.equal((await server.repository.get('invites', hash(invite.token))).revoked, false);
});

test('joined households expose only their current cover while another household is selected', async () => {
  const server = fixture();
  const first = await server.create();
  const cover = 'cloud://env/cover.bin';
  const privatePhoto = 'cloud://env/other-private.bin';
  const family = await server.repository.get('families', first.familyId);
  await server.repository.set('families', first.familyId, { ...family, cover });
  for (const fileId of [cover, privatePhoto]) await server.repository.set('media', hash(fileId), { familyId: first.familyId, confirmed: true, fileId });
  await server.create('第二个家');
  const listed = await server.success(server.call('listFamilies'));
  assert.equal(listed.families.find(item => item.id === first.familyId).cover, cover);
  assert.equal(listed.families.find(item => item.id === first.familyId).avatar, cover);
  assert.equal((await server.call('mediaContent', { fileId: cover })).ok, true);
  assert.equal((await server.call('mediaContent', { fileId: privatePhoto })).code, 'FORBIDDEN');
  assert.equal((await server.call('mediaContent', { fileId: cover }, 'stranger')).code, 'FORBIDDEN');
  await server.repository.set('families', first.familyId, { ...family, cover, deletedAt: Date.now() });
  assert.equal((await server.call('mediaContent', { fileId: cover })).code, 'FORBIDDEN');
});

test('invitation exposes the current cover preview but no private gallery, original image or family membership', async () => {
  const server = fixture();
  const created = await server.create();
  const fileId = 'cloud://env/invitation-cover';
  const another = 'cloud://env/private-step';
  for (const image of [fileId, another]) await server.repository.set('media', hash(image), { fileId: image, confirmed: true, familyId: created.familyId });
  await server.command('customizeFamily', [{ name: '有封面的小家', cover: fileId, coverTitle: '' }], created.revision);
  const invitation = await server.success(server.call('prepareInvite'));
  const inviteToken = invitation.token;
  const preview = await server.success(server.call('readInvite', { token: inviteToken }, 'guest'));
  assert.equal(preview.familyCover, fileId);
  assert.deepEqual(Object.keys(preview).sort(), ['familyCover', 'familyId', 'familyName', 'joined', 'memberCount']);
  assert.equal((await server.success(server.call('bootstrap', {}, 'guest'))).needsFamily, true);
  assert.equal((await server.call('mediaContent', { fileId, variant: 'detail' }, 'guest')).code, 'FORBIDDEN');
  const image = await server.success(server.call('mediaContent', { fileId, variant: 'detail', inviteToken }, 'guest'));
  assert.equal(image.base64, 'aW1hZ2U=');
  assert.equal((await server.call('mediaContent', { fileId, variant: 'original', inviteToken }, 'guest')).code, 'FORBIDDEN');
  assert.equal((await server.call('mediaContent', { fileId: another, variant: 'detail', inviteToken }, 'guest')).code, 'FORBIDDEN');
  const batch = await server.success(server.call('mediaBatch', { images: [{ fileId, variant: 'detail' }, { fileId: another, variant: 'detail' }], inviteToken }, 'guest'));
  assert.deepEqual(batch.images.map(item => item.ok), [true, false]);
  const changed = await server.repository.get('families', created.familyId);
  await server.repository.set('families', created.familyId, { ...changed, cover: another });
  assert.equal((await server.success(server.call('readInvite', { token: inviteToken }, 'guest'))).familyCover, another);
  assert.equal((await server.call('mediaContent', { fileId, variant: 'detail', inviteToken }, 'guest')).code, 'FORBIDDEN');
  await server.success(server.call('mediaContent', { fileId: another, variant: 'detail', inviteToken }, 'guest'));
  await server.repository.set('families', created.familyId, { ...changed, cover: '' });
  assert.equal((await server.success(server.call('readInvite', { token: inviteToken }, 'guest'))).familyCover, '');
  assert.equal((await server.call('mediaContent', { fileId: another, variant: 'detail', inviteToken }, 'guest')).code, 'FORBIDDEN');
  server.advance(86400001);
  assert.equal((await server.call('mediaContent', { fileId: another, variant: 'detail', inviteToken }, 'guest')).code, 'INVITE_EXPIRED');
});

test('invitation read never joins automatically; confirmation retains existing families and repeated joins consume one seat', async () => {
  const server = fixture();
  const first = await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  assert.match(invite.token, /^[a-f0-9]{48}$/);
  assert.equal((await server.success(server.call('prepareInvite'))).token, invite.token);
  const bobHome = await server.create('Bob家', 'bob');
  const preview = await server.success(server.call('readInvite', { token: invite.token }, 'bob'));
  assert.equal(preview.joined, false);
  assert.equal(preview.memberCount, 1);
  assert.equal(preview.familyCover, '');
  assert.equal((await server.success(server.call('bootstrap', {}, 'bob'))).familyId, bobHome.familyId);
  const joined = await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  assert.equal(joined.familyId, first.familyId);
  assert.equal((await server.success(server.call('listFamilies', {}, 'bob'))).families.length, 2);
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  assert.equal((await server.repository.get('invites', hash(invite.token))).remaining, 18);
  assert.equal((await server.success(server.call('bootstrap'))).snapshot.family.members.length, 2);
  assert.equal(JSON.stringify(joined).includes(invite.token), false);
  assert.equal((await server.call('prepareInvite', {}, 'bob')).code, 'FORBIDDEN');
});

test('expired invites and removed members cannot silently rejoin using an old invitation', async () => {
  const server = fixture();
  await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  await server.success(server.call('removeMember', { memberId: hash('bob') }));
  assert.equal((await server.call('joinFamily', { token: invite.token }, 'bob')).code, 'INVITE_EXPIRED');
  const next = await server.success(server.call('prepareInvite'));
  server.advance(86400001);
  assert.equal((await server.call('readInvite', { token: next.token }, 'bob')).code, 'INVITE_EXPIRED');
});

test('household deletion requires owner and exact name, revokes invites and leaves other households intact', async () => {
  const server = fixture();
  const bobHome = await server.create('Bob的小家', 'bob');
  const first = await server.create('准备删除');
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  assert.equal((await server.call('deleteFamily', { confirmName: '准备删除' }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('deleteFamily', { confirmName: '不是这个名字' })).ok, false);
  await server.success(server.call('deleteFamily', { familyId: first.familyId, confirmName: '准备删除' }));
  assert.equal((await server.success(server.call('bootstrap'))).needsFamily, true);
  assert.equal((await server.success(server.call('bootstrap', {}, 'bob'))).familyId, bobHome.familyId);
  assert.equal((await server.call('readInvite', { token: invite.token }, 'bob')).code, 'INVITE_EXPIRED');
  assert.equal((await server.call('switchFamily', { familyId: first.familyId })).code, 'FORBIDDEN');
});

test('removing a member does not switch their other currently selected household', async () => {
  const server = fixture();
  const bobHome = await server.create('Bob家', 'bob');
  await server.create();
  const invite = await server.success(server.call('prepareInvite'));
  await server.success(server.call('joinFamily', { token: invite.token }, 'bob'));
  await server.success(server.call('switchFamily', { familyId: bobHome.familyId }, 'bob'));
  await server.success(server.call('removeMember', { memberId: hash('bob') }));
  assert.equal((await server.success(server.call('bootstrap', {}, 'bob'))).familyId, bobHome.familyId);
});

test('profile uses caller identity, supports onboarding avatar and updates names across all joined families', async () => {
  const server = fixture();
  const upload = await server.success(server.call('profileUpload', { base64: 'YWJj' }));
  await server.create('小家');
  await server.create('爸妈家');
  const result = await server.success(server.call('updateProfile', { name: '小厨师', avatar: upload.fileId, userId: hash('bob') }));
  assert.deepEqual(result.profile, { name: '小厨师', avatar: upload.fileId });
  const families = (await server.success(server.call('listFamilies'))).families;
  for (const family of families) assert.equal((await server.repository.get('families', family.id)).members[0].name, '小厨师');
  assert.equal((await server.call('updateProfile', { name: '冒充', avatar: upload.fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('mediaContent', { fileId: upload.fileId }, 'bob')).code, 'FORBIDDEN');
});

test('family limits are enforced transactionally', async () => {
  const server = fixture();
  for (let index = 0; index < 10; index += 1) await server.create(`家${index}`);
  assert.equal((await server.call('createFamily', { familyName: '第十一个', requestId: 'extra-family-001' })).ok, false);
  assert.equal((await server.success(server.call('listFamilies'))).families.length, 10);
});

test('dish and set share links expose only selected recipes and work for first-time visitors with scoped photos', async () => {
  const server = fixture();
  let current = await server.create();
  const fileId = 'cloud://env/private-food.bin';
  const secret = 'cloud://env/private-family-cover.bin';
  for (const image of [fileId, secret]) await server.repository.set('media', hash(image), { familyId: current.familyId, confirmed: true });
  current = await server.command('saveRecipe', [{ ...createSeed().recipes[0], image: fileId }], current.revision);
  current = await server.command('saveRecipe', [createSeed().recipes[1]], current.revision);
  current = await server.command('saveMealSet', [{ title: '两菜套餐', recipeIds: current.snapshot.recipes.map(recipe => recipe.id), image: '' }], current.revision);
  for (const kind of ['dish', 'set']) {
    const item = kind === 'dish' ? current.snapshot.recipes.find(recipe => recipe.image === fileId) : current.snapshot.mealSets[0];
    const share = await server.success(server.call('createDishShare', { familyId: current.familyId, itemId: item.id, kind }));
    const detail = await server.success(server.call('readShare', { token: share.token }, 'visitor'));
    assert.equal(detail.post.recipes.length, kind === 'dish' ? 1 : 2);
    assert.equal(detail.post.kind, kind === 'dish' ? 'dish' : 'menu');
    assert.equal(detail.post.familyId, undefined);
    assert.equal(detail.post.members, undefined);
    assert.equal((await server.success(server.call('bootstrap', {}, 'visitor'))).needsFamily, true);
    assert.equal((await server.call('mediaContent', { fileId }, 'visitor')).code, 'FORBIDDEN');
    assert.equal((await server.call('mediaContent', { fileId, shareToken: share.token }, 'visitor')).ok, true);
    assert.equal((await server.call('mediaContent', { fileId: secret, shareToken: share.token }, 'visitor')).code, 'FORBIDDEN');
    assert.equal((await server.call('importShare', { token: share.token }, 'visitor')).code, 'NO_FAMILY');
  }
  assert.equal((await server.repository.list('posts')).length, 0);
});

test('friend imports deduplicate, survive source deletion and do not depend on link expiration', async () => {
  const server = fixture();
  let current = await server.create('分享方');
  const fileId = 'cloud://env/imported-photo.bin';
  await server.repository.set('media', hash(fileId), { familyId: current.familyId, confirmed: true });
  current = await server.command('saveRecipe', [{ ...createSeed().recipes[0], image: fileId }], current.revision);
  const share = await server.success(server.call('createDishShare', { kind: 'dish', itemId: current.snapshot.recipes[0].id }));
  await server.create('接收方', 'bob');
  await server.success(server.call('importShare', { token: share.token }, 'bob'));
  await server.success(server.call('importShare', { token: share.token }, 'bob'));
  assert.equal((await server.success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes.length, 1);
  await server.success(server.call('deleteFamily', { confirmName: '分享方' }));
  assert.equal((await server.call('readShare', { token: share.token }, 'visitor')).code, 'SHARE_EXPIRED');
  assert.equal((await server.success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes.length, 1);
  server.advance(31 * 86400000);
  assert.equal((await server.call('mediaContent', { fileId }, 'bob')).ok, true);
  assert.equal((await server.call('mediaContent', { fileId }, 'visitor')).code, 'FORBIDDEN');
});

test('published dish links are readable without membership but cannot mutate family data', async () => {
  const server = fixture();
  let current = await server.create();
  current = await server.command('saveRecipe', [createSeed().recipes[0]], current.revision);
  current = await server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish'], current.revision);
  const detail = await server.success(server.call('readPost', { postId: current.value }, 'visitor'));
  assert.ok(detail.post.recipes[0].steps.length);
  assert.equal(detail.post.familyId, undefined);
  assert.deepEqual(detail.comments, []);
  assert.equal((await server.call('command', { name: 'addComment', args: [current.value, 'hello'], requestId: 'guest-command-001' }, 'visitor')).code, 'NO_FAMILY');
});

test('last member exit preserves public recipes and copies already imported by other families', async () => {
  const server = fixture();
  let current = await server.create();
  current = await server.command('saveRecipe', [createSeed().recipes[0]], current.revision);
  const share = await server.success(server.call('createDishShare', { kind: 'dish', itemId: current.snapshot.recipes[0].id }));
  current = await server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish'], current.revision);
  const before = await server.success(server.call('readPost', { postId: current.value }, 'visitor'));
  await server.create('接收方', 'bob');
  const imported = await server.success(server.call('importShare', { token: share.token }, 'bob'));
  await server.success(server.call('leaveFamily', { familyId: current.familyId }));
  assert.equal((await server.call('readShare', { token: share.token }, 'visitor')).code, 'SHARE_EXPIRED');
  const { familySnapshot, ...retainedPost } = (await server.success(server.call('readPost', { postId: current.value }, 'visitor'))).post;
  const { familySnapshot: previousIdentity, ...previousPost } = before.post;
  assert.deepEqual(retainedPost, previousPost);
  assert.equal(familySnapshot.name, before.post.author);
  if (previousIdentity) assert.deepEqual(familySnapshot, previousIdentity);
  assert.deepEqual((await server.success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes, imported.snapshot.recipes);
});

test('share buttons route invitations, dishes and sets via native share hooks, not clipboard codes', () => {
  const invite = invitationCard({ token: 'a'.repeat(48), familyName: '我们的小家' });
  const key = registerShare(invite);
  assert.equal(shareMessage({ target: { dataset: { shareKey: key } } }).path, invite.path);
  removeShare(key);
  assert.equal(shareMessage({ target: { dataset: { shareKey: key } } }).path, '/pages/index/index');
  assert.match(dishShareCard({ id: 'post-1', kind: 'menu', title: '套餐' }).path, /postId=post-1/);
  assert.match(dishShareCard({ token: 'b'.repeat(48), kind: 'dish', title: '菜' }).path, /token=/);
  const root = new URL('../', import.meta.url);
  const button = readFileSync(new URL('src/components/NativeShareButton.vue', root), 'utf8');
  assert.match(button, /open-type/);
  assert.match(button, /data-share-key/);
  const entry = readFileSync(new URL('src/pages/invite/index.vue', root), 'utf8');
  assert.match(entry, /确认加入家庭/);
  assert.doesNotMatch(entry, /setClipboardData/);
  const page = JSON.parse(readFileSync(new URL('src/pages.json', root), 'utf8'));
  assert.ok(page.pages.some(item => item.path === 'pages/shared/index'));
  assert.ok(page.pages.some(item => item.path === 'pages/invite/index'));
  for (const target of ['invite', 'shared']) {
    const source = readFileSync(new URL(`src/pages/${target}/index.vue`, root), 'utf8');
    assert.match(source, /<view class="app-shell"[^>]*><view class="entry-page /);
    assert.match(source, /@click="dismissFocusedKeyboard"/);
  }
});
