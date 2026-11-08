import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { createIdentityPresentation } from '../server/identity-presentation.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const ok = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
function fixture() {
  const db = memoryRepository();
  const app = createApplication({ repository: db, now: () => 1793865600000, signFiles: async () => ({}), readImage: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }) });
  let seq = 0;
  const call = (action, args = {}, who = 'alice') => app({ action, ...args }, { OPENID: who });
  const family = (name = '小家', who = 'alice') => ok(call('createFamily', { familyName: name, name: who, requestId: `identity-create-${++seq}` }, who));
  const image = async (id, userId, familyId, extra = {}) => { const fileId = `cloud://env/${id}`; await db.set('media', hash(fileId), { fileId, userId, familyId, confirmed: true, ...extra }); return fileId; };
  return { db, call, family, image };
}
test('legacy create/join payloads cannot overwrite an existing account with stale profile fields', async () => {
  const f = fixture(); const first = await f.family();
  await ok(f.call('updateProfile', { name: '新昵称' }));
  const second = await f.family('第二家');
  assert.equal(second.profile.name, '新昵称');
  assert.equal((await f.db.get('families', first.familyId)).members[0].name, '新昵称');
  const b = await f.family('别人家', 'bob'); const invite = await ok(f.call('prepareInvite', {}, 'bob'));
  const joined = await ok(f.call('joinFamily', { token: invite.token, name: '陈旧昵称', avatar: 'cloud://forged' }));
  assert.equal(joined.profile.name, '新昵称');
  assert.equal((await f.db.get('families', b.familyId)).members.find(m => m.id === hash('alice')).name, '新昵称');
});
test('optional profile compare-and-set blocks stale edits while legacy saves and exact retries work', async () => {
  const f = fixture(); await f.family();
  const baseline = { name: 'alice', avatar: '' };
  await ok(f.call('updateProfile', { name: '新名字', expectedProfile: baseline }));
  assert.equal((await f.call('updateProfile', { name: '旧设备修改', expectedProfile: baseline })).code, 'CONFLICT');
  await ok(f.call('updateProfile', { name: '新名字', expectedProfile: baseline }));
  await ok(f.call('updateProfile', { name: '兼容旧客户端' }));
});
test('personal meal names resolve by user ID without rewriting published snapshots or exposing IDs', async () => {
  const f = fixture(); await ok(f.call('updateProfile', { name: '原名' }));
  const personal = await ok(f.call('switchWorkspace', { mode: 'personal' }));
  const row = { id: 'meal-personal', spaceId: personal.familyId, authorId: hash('alice'), status: 'published', visibility: 'public', createdAt: 123, author: { name: '原名', avatar: '', mode: 'personal' }, dishes: [{ title: '当时的菜' }] };
  await f.db.set('meal_posts', row.id, row);
  await ok(f.call('updateProfile', { name: '新名' }));
  const feed = await ok(f.call('mealFeed', { spaceId: personal.familyId }));
  assert.equal(feed.posts[0].author.name, '新名');
  assert.equal(feed.posts[0].authorId, undefined);
  assert.equal(feed.posts[0].spaceId, undefined);
  assert.equal((await f.db.get('meal_posts', row.id)).author.name, '原名');
  assert.deepEqual(feed.posts[0].dishes, row.dishes);
});
test('current avatars use explicit capability and checked post context, never grant all owner media', async () => {
  const f = fixture(); const a = await f.family(); const b = await f.family('读者', 'bob');
  const old = await f.image('old', hash('alice'), a.familyId);
  const cover = await f.image('current', hash('alice'), a.familyId);
  const unrelated = await f.image('secret', hash('alice'), a.familyId);
  const family = await f.db.get('families', a.familyId); await f.db.set('families', a.familyId, { ...family, cover });
  const post = { id: 'meal-family', spaceId: a.familyId, authorId: hash('alice'), status: 'published', visibility: 'public', author: { name: '旧名', avatar: old, mode: 'family' }, assetIds: [old], createdAt: 1 };
  await f.db.set('meal_posts', post.id, post);
  const legacy = await ok(f.call('mealFeed', { spaceId: b.familyId }, 'bob'));
  assert.equal(legacy.posts[0].author.avatar, old);
  const modern = await ok(f.call('mealFeed', { spaceId: b.familyId, identityPresentationVersion: 1 }, 'bob'));
  assert.equal(modern.posts[0].author.avatar, cover);
  assert.equal(modern.posts[0].author.currentSpace, false);
  assert.deepEqual(modern.media[cover], { postId: post.id });
  await ok(f.call('mediaContent', { fileId: cover, variant: 'avatar', postId: post.id }, 'bob'));
  assert.equal((await f.call('mediaContent', { fileId: unrelated, variant: 'avatar', postId: post.id }, 'bob')).code, 'FORBIDDEN');
  await f.db.set('meal_posts', post.id, { ...post, visibility: 'private' });
  assert.equal((await f.call('mediaContent', { fileId: cover, variant: 'avatar', postId: post.id }, 'bob')).code, 'FORBIDDEN');
});
test('same-name families remain isolated and deleted/official identities retain historical attribution', async () => {
  const db = memoryRepository();
  await db.set('families', 'one', { id: 'one', name: '新一', members: [] });
  await db.set('families', 'two', { id: 'two', name: '新二', members: [] });
  const identity = createIdentityPresentation(db);
  const old = { author: '同名', familySnapshot: { name: '同名', cover: 'old-cover' } };
  assert.equal((await identity.community({ ...old, familyId: 'one' })).author, '新一');
  assert.equal((await identity.community({ ...old, familyId: 'two' })).author, '新二');
  assert.equal((await identity.community({ ...old, familyId: 'missing' })).author, '同名');
  const official = { ...old, familyId: 'one', publisherType: 'official' };
  assert.deepEqual(await identity.community(official), official);
});
test('request-local identity resolution shares repeated family reads and does not leak across requests', async () => {
  const db = memoryRepository(); await db.set('families', 'one', { id: 'one', name: '一' });
  let reads = 0; const original = db.get; db.get = (...args) => { reads++; return original(...args); };
  const identity = createIdentityPresentation(db);
  await Promise.all(Array.from({ length: 20 }, () => identity.community({ familyId: 'one', author: '旧' })));
  assert.equal(reads, 1);
  await db.set('families', 'one', { id: 'one', name: '二' });
  assert.equal((await createIdentityPresentation(db).community({ familyId: 'one' })).author, '二');
});
test('editing a legacy recipe retains its ID and unknown server fields without inventing its creator', async () => {
  const f = fixture(); const a = await f.family();
  const recipe = { ...createSeed().recipes[0], id: 'legacy-recipe', customServerField: 'preserve' };
  await f.db.set('recipes', hash(`${a.familyId}:${recipe.id}`), { familyId: a.familyId, value: recipe });
  const result = await ok(f.call('command', { name: 'saveRecipe', args: [{ ...recipe, title: '更新标题', createdBy: 'forged' }, recipe.id], familyId: a.familyId, revision: a.revision, requestId: 'legacy-recipe-save-001' }));
  const saved = (await f.db.get('recipes', hash(`${a.familyId}:${recipe.id}`))).value;
  assert.equal(saved.id, recipe.id); assert.equal(saved.customServerField, 'preserve');
  assert.equal(saved.createdBy, undefined); assert.equal(saved.updatedBy, hash('alice'));
  assert.equal(saved.title, '更新标题'); assert.ok(result.snapshot);
});


test('comment and reply recipient names follow their IDs without crossing posts', async () => {
  const db = memoryRepository();
  await db.set('users', 'author', { name: '作者新名' });
  await db.set('users', 'recipient', { name: '收件人新名' });
  await db.set('comments', 'target', { id: 'target', postId: 'post-one', memberId: 'recipient' });
  const row = { memberId: 'author', author: '旧名', postId: 'post-one', replyToId: 'target', replyToAuthor: '旧称呼' };
  const identity = createIdentityPresentation(db);
  assert.equal((await identity.comment(row)).author, '作者新名');
  assert.equal((await identity.comment(row)).replyToAuthor, '收件人新名');
  assert.equal((await identity.comment({ ...row, postId: 'another' })).replyToAuthor, '旧称呼');
  assert.equal(row.replyToAuthor, '旧称呼');
});

test('explicit invitation profile edits synchronize memberships atomically and reject stale or invalid invites', async () => {
  const f = fixture(); const first = await f.family();
  const personal = await ok(f.call('switchWorkspace', { mode: 'personal' }));
  const target = await f.family('目标家庭', 'bob');
  const invitation = await ok(f.call('prepareInvite', {}, 'bob'));
  const expectedProfile = { name: 'alice', avatar: '' };
  const invalid = await f.call('joinFamilyWithProfile', { token: 'invalid', name: '不能保存', expectedProfile });
  assert.equal(invalid.ok, false);
  assert.equal((await f.db.get('users', hash('alice'))).name, 'alice');
  await ok(f.call('updateProfile', { name: '另一设备' }));
  const stale = await f.call('joinFamilyWithProfile', { token: invitation.token, name: '陈旧编辑', expectedProfile });
  assert.equal(stale.code, 'CONFLICT');
  assert.equal((await f.db.get('families', target.familyId)).members.length, 1);
  await ok(f.call('joinFamilyWithProfile', { token: invitation.token, name: '主动修改', expectedProfile: { name: '另一设备', avatar: '' } }));
  for (const id of [first.familyId, personal.familyId, target.familyId]) {
    assert.equal((await f.db.get('families', id)).members.find(member => member.id === hash('alice')).name, '主动修改');
  }
  assert.equal((await f.db.get('users', hash('alice'))).name, '主动修改');
});

test('uncovered family uses current member avatar with post-scoped access and preserves legacy response', async () => {
  const f = fixture(); const a = await f.family(); const b = await f.family('读者', 'bob');
  const avatar = await f.image('profile-avatar', hash('alice'), a.familyId, { profile: true });
  await ok(f.call('updateProfile', { name: 'alice', avatar }));
  const post = { id: 'uncovered-family', spaceId: a.familyId, authorId: hash('alice'), status: 'published', visibility: 'public', mealSharingVersion: 2, author: { name: '小家', avatar: '', mode: 'family' }, assetIds: [], createdAt: 1 };
  await f.db.set('meal_posts', post.id, post);
  const modern = await ok(f.call('mealFeed', { spaceId: b.familyId, identityPresentationVersion: 1 }, 'bob'));
  assert.equal(modern.posts[0].author.avatar, avatar);
  await ok(f.call('mediaContent', { fileId: avatar, variant: 'avatar', postId: post.id }, 'bob'));
  const legacy = await ok(f.call('mealFeed', { spaceId: b.familyId }, 'bob'));
  assert.equal(legacy.posts[0].author.avatar, '');
  const family = await f.db.get('families', a.familyId);
  await f.db.set('families', a.familyId, { ...family, members: [] });
  assert.equal((await createIdentityPresentation(f.db).meal(post, { liveImages: true })).avatar, '');
  assert.equal((await f.call('mediaContent', { fileId: avatar, variant: 'avatar', postId: post.id }, 'bob')).code, 'FORBIDDEN');
});

test('new join may omit avatar, while existing account avatar survives old empty join payload', async () => {
  const f = fixture(); const a = await f.family();
  const avatar = await f.image('joining-avatar', hash('alice'), a.familyId, { profile: true });
  await ok(f.call('updateProfile', { name: 'alice', avatar }));
  const b = await f.family('目标家庭', 'bob');
  const invitation = await ok(f.call('prepareInvite', {}, 'bob'));
  const joined = await ok(f.call('joinFamily', { token: invitation.token, name: '旧昵称', avatar: '' }));
  assert.equal(joined.profile.avatar, avatar);
  assert.equal((await f.db.get('families', b.familyId)).members.find(m => m.id === hash('alice')).avatar, avatar);
  const newcomer = await ok(f.call('joinFamily', { token: invitation.token, name: '新家人' }, 'charlie'));
  assert.equal(newcomer.profile.avatar, '');
});

test('personal friend shares store nickname and follow later profile renames by ID', async () => {
  const f = fixture();
  await ok(f.call('updateProfile', { name: '小豆的昵称' }));
  const personal = await ok(f.call('switchWorkspace', { mode: 'personal' }));
  const recipe = { ...createSeed().recipes[0], id: 'personal-share-recipe' };
  await f.db.set('recipes', hash(`${personal.familyId}:${recipe.id}`), { familyId: personal.familyId, value: recipe });
  const share = await ok(f.call('createDishShare', { familyId: personal.familyId, itemId: recipe.id, kind: 'dish' }));
  assert.equal((await f.db.get('shares', hash(share.token))).post.author, '小豆的昵称');
  await ok(f.call('updateProfile', { name: '小豆新昵称' }));
  assert.equal((await ok(f.call('readShare', { token: share.token }))).post.author, '小豆新昵称');
  assert.equal((await f.db.get('families', personal.familyId)).name, '我的餐桌');
});
