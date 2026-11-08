import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { DEFAULT_AVATARS, DEFAULT_NICKNAMES, DEFAULT_PROFILE_VERSION, defaultAvatarForUser, defaultAvatarIdForUser, defaultAvatarIdForPath, defaultNicknameForUser, profileWithDefaults, isDefaultAvatar, isDefaultAvatarId, compatibleDefaultProfilePayload } from '../src/domain/default-profile.js';
import { createApplication } from '../server/application.mjs';
import { createIdentityPresentation } from '../server/identity-presentation.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const ok = async promise => { const value = await promise; assert.equal(value.ok, true, JSON.stringify(value)); return value.data; };
function fixture() {
  const db = memoryRepository();
  const app = createApplication({ repository: db, now: () => Date.parse('2026-11-08T10:00:00Z'), signFiles: async () => ({}) });
  const call = (action, event = {}, who = 'alice') => app({ action, ...event }, { OPENID: who });
  let sequence = 0;
  const family = (who = 'alice', event = {}) => ok(call('createFamily', { familyName: '测试厨房', requestId: `default-profile-family-${++sequence}`, defaultProfileVersion: 1, ...event }, who));
  return { db, call, family };
}

test('the immutable default catalog contains 20 distinct high resolution PNGs and 100 valid nicknames', async () => {
  assert.equal(DEFAULT_PROFILE_VERSION, 1);
  assert.equal(DEFAULT_AVATARS.length, 20);
  assert.equal(new Set(DEFAULT_AVATARS.map(item => item.id)).size, 20);
  assert.equal(DEFAULT_NICKNAMES.length, 100);
  assert.equal(new Set(DEFAULT_NICKNAMES).size, 100);
  assert.ok(DEFAULT_NICKNAMES.every(name => name.length > 0 && name.length <= 16));
  const digests = await Promise.all(DEFAULT_AVATARS.map(async (avatar, index) => {
    assert.equal(avatar.id, `food-${String(index + 1).padStart(2, '0')}`);
    assert.equal(defaultAvatarIdForPath(avatar.src), avatar.id);
    const bytes = await readFile(new URL(`../src${avatar.src}`, import.meta.url));
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 320); assert.equal(metadata.height, 320);
    assert.ok(bytes.length < 30000, 'bundled defaults remain small enough for the app package');
    return hash(bytes);
  }));
  assert.equal(new Set(digests).size, 20);
});

test('defaults are stable per immutable user ID and do not change existing personal choices', () => {
  const account = 'unique-account';
  const expected = profileWithDefaults({}, account);
  for (let i = 0; i < 100; i++) assert.deepEqual(profileWithDefaults({}, account), expected);
  assert.equal(expected.avatar, defaultAvatarForUser(account));
  assert.equal(expected.name, defaultNicknameForUser(account));
  const chosen = { name: '自己的昵称', avatar: 'cloud://own-photo', defaultAvatarId: 'food-01' };
  assert.deepEqual(profileWithDefaults(chosen, account), { name: chosen.name, avatar: chosen.avatar });
  assert.deepEqual(chosen, { name: '自己的昵称', avatar: 'cloud://own-photo', defaultAvatarId: 'food-01' });
  assert.equal(profileWithDefaults({ name: '自己的昵称' }, account).name, chosen.name);
  assert.deepEqual(profileWithDefaults({}, ''), { name: '', avatar: '' });
  assert.equal(profileWithDefaults({ defaultAvatarId: 'food-20' }, account).avatar, DEFAULT_AVATARS[19].src);
  assert.equal(defaultAvatarIdForUser(account, 'not-a-default'), defaultAvatarIdForUser(account));
});

test('only exact versioned default asset IDs and paths are accepted', () => {
  for (const value of ['/static/default-avatars/food-01.png?x=1', '/static/default-avatars/../secret.png', 'https://host/food-01.png', 'wxfile://food-01.png', 'food-01', null, {}]) assert.equal(isDefaultAvatar(value), false);
  for (const value of ['food-00', 'food-21', '../food-01', null, {}]) assert.equal(isDefaultAvatarId(value), false);
  assert.equal(isDefaultAvatar(DEFAULT_AVATARS[0].src), true);
  assert.equal(isDefaultAvatarId('food-01'), true);
});

test('wire compatibility translates displayed defaults while retaining a genuinely stale compare-and-set', () => {
  const display = profileWithDefaults({}, 'alice');
  const baseline = { raw: { name: '', avatar: '' }, displayed: display };
  const command = { name: '新名字', avatar: display.avatar, expectedProfile: { ...display } };
  const safe = compatibleDefaultProfilePayload(command, baseline);
  assert.equal(safe.avatar, '');
  assert.equal(safe.defaultAvatarId, defaultAvatarIdForPath(display.avatar));
  assert.deepEqual(safe.expectedProfile, { name: '', avatar: '', defaultAvatarId: safe.defaultAvatarId });
  assert.deepEqual(command.expectedProfile, display);
  const changedBaseline = { raw: { name: '另一设备修改', avatar: 'cloud://new' }, displayed: { name: '另一设备修改', avatar: 'cloud://new' } };
  const stale = compatibleDefaultProfilePayload(command, changedBaseline);
  assert.equal(stale.expectedProfile.name, display.name);
  assert.notEqual(stale.expectedProfile.avatar, 'cloud://new');
});

test('new-account bootstrap presents defaults without creating database records or affecting legacy responses', async () => {
  const f = fixture();
  const result = await ok(f.call('bootstrap', { defaultProfileVersion: 1 }));
  assert.equal(result.needsFamily, true);
  assert.equal(result.userId, hash('alice'));
  assert.deepEqual(result.profile, profileWithDefaults({}, result.userId));
  assert.deepEqual(result.profileBaseline, { name: '', avatar: '' });
  assert.equal(await f.db.get('users', result.userId), null);
  const legacy = await ok(f.call('bootstrap'));
  assert.deepEqual(legacy.profile, { name: '', avatar: '' });
  assert.equal(legacy.defaultProfileVersion, undefined);
  assert.equal(legacy.profileBaseline, undefined);
  assert.equal(await f.db.get('users', result.userId), null);
});

test('existing empty profiles receive stable presentation with no read-time backfill', async () => {
  const f = fixture(); const first = await f.family();
  const id = hash('alice');
  const old = { ...await f.db.get('users', id), name: '', avatar: '' };
  delete old.defaultAvatarId;
  await f.db.set('users', id, old);
  for (let i = 0; i < 3; i++) {
    const result = await ok(f.call('bootstrap', { defaultProfileVersion: 1, knownFamilyId: first.familyId, knownRevision: first.revision }));
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.profile, profileWithDefaults(old, id));
    assert.deepEqual(await f.db.get('users', id), old);
  }
  const directory = await ok(f.call('listFamilies', { defaultProfileVersion: 1 }));
  assert.deepEqual(directory.profile, profileWithDefaults(old, id));
  assert.deepEqual(directory.profileBaseline, { name: '', avatar: '' });
});

test('create and personal onboarding persist stable IDs while legacy avatar fields stay compatible', async () => {
  const f = fixture(); const id = hash('alice');
  const created = await f.family();
  const user = await f.db.get('users', id);
  assert.equal(user.name, defaultNicknameForUser(id));
  assert.equal(user.avatar, ''); assert.equal(user.defaultAvatarId, defaultAvatarIdForUser(id));
  const member = (await f.db.get('families', created.familyId)).members[0];
  assert.equal(member.id, id); assert.equal(member.avatar, ''); assert.equal(member.defaultAvatarId, user.defaultAvatarId);
  const personal = await ok(f.call('switchWorkspace', { mode: 'personal', defaultProfileVersion: 1 }));
  assert.equal(personal.profile.avatar, created.profile.avatar);
  assert.equal(personal.snapshot.family.members[0].defaultAvatarId, user.defaultAvatarId);
  assert.equal(personal.snapshot.family.members[0].avatar, '');
  const again = await ok(f.call('switchWorkspace', { mode: 'family', defaultProfileVersion: 1 }));
  assert.deepEqual(again.profile, created.profile);
  const legacy = await ok(f.call('bootstrap'));
  assert.equal(legacy.profile.avatar, '');
  assert.equal(legacy.snapshot.family.members[0].avatar, '');
});

test('default profile selection never becomes account identity, even when names and images collide', async () => {
  const f = fixture();
  const one = await f.family('alice', { name: '同一个昵称', avatar: DEFAULT_AVATARS[0].src });
  const two = await f.family('bob', { name: '同一个昵称', avatar: DEFAULT_AVATARS[0].src });
  assert.notEqual(one.userId, two.userId);
  assert.equal(one.userId, hash('alice')); assert.equal(two.userId, hash('bob'));
  assert.deepEqual(one.profile, two.profile);
  assert.notEqual(one.familyId, two.familyId);
  assert.equal((await f.db.get('families', one.familyId)).members[0].id, one.userId);
  const forged = await ok(f.call('bootstrap', { defaultProfileVersion: 1, userId: two.userId }));
  assert.equal(forged.userId, one.userId);
});

test('first-time joining assigns defaults atomically, retries do not add another member', async () => {
  const f = fixture(); const target = await f.family('bob');
  const invitation = await ok(f.call('prepareInvite', {}, 'bob'));
  const before = await f.db.get('invites', hash(invitation.token));
  const results = await Promise.all([1, 2].map(() => ok(f.call('joinFamily', { token: invitation.token, defaultProfileVersion: 1 }))));
  assert.deepEqual(results[0].profile, results[1].profile);
  const family = await f.db.get('families', target.familyId);
  assert.equal(family.members.filter(member => member.id === hash('alice')).length, 1);
  const member = family.members.find(member => member.id === hash('alice'));
  assert.equal(member.avatar, ''); assert.equal(member.name, defaultNicknameForUser(member.id));
  assert.equal(member.defaultAvatarId, defaultAvatarIdForUser(member.id));
  assert.equal((await f.db.get('invites', hash(invitation.token))).remaining, before.remaining - 1);
});

test('invalid invitation cannot persist generated defaults or a nickname draft', async () => {
  const f = fixture(); const display = profileWithDefaults({}, hash('alice'));
  const result = await f.call('joinFamilyWithProfile', { token: 'invalid', name: '新昵称', avatar: display.avatar, expectedProfile: display, defaultProfileVersion: 1 });
  assert.equal(result.ok, false);
  assert.equal(await f.db.get('users', hash('alice')), null);
});

test('saving a generated profile maps to additive defaults and propagates to existing memberships', async () => {
  const f = fixture(); const first = await f.family();
  const personal = await ok(f.call('switchWorkspace', { mode: 'personal' }));
  const chosen = DEFAULT_AVATARS[19];
  const saved = await ok(f.call('updateProfile', { name: '昵称已更换', avatar: chosen.src, expectedProfile: first.profile, defaultProfileVersion: 1 }));
  assert.deepEqual(saved.profile, { name: '昵称已更换', avatar: chosen.src });
  const user = await f.db.get('users', hash('alice'));
  assert.equal(user.avatar, ''); assert.equal(user.defaultAvatarId, chosen.id);
  for (const familyId of [first.familyId, personal.familyId]) {
    const member = (await f.db.get('families', familyId)).members.find(member => member.id === user._id);
    assert.equal(member.avatar, ''); assert.equal(member.defaultAvatarId, chosen.id); assert.equal(member.name, '昵称已更换');
  }
  const stale = await f.call('updateProfile', { name: '旧设备想改名', avatar: first.profile.avatar, expectedProfile: first.profile });
  assert.equal(stale.code, 'CONFLICT');
  assert.equal((await f.db.get('users', user._id)).name, '昵称已更换');
});

test('a changed default ID participates in profile concurrency even though both legacy avatar fields are empty', async () => {
  const f = fixture();
  const first = await f.family('alice', { avatar: DEFAULT_AVATARS[0].src });
  await ok(f.call('updateProfile', { name: first.profile.name, avatar: DEFAULT_AVATARS[1].src }));
  const stale = compatibleDefaultProfilePayload({ name: '过期改名', avatar: first.profile.avatar, expectedProfile: first.profile });
  assert.equal((await f.call('updateProfile', stale)).code, 'CONFLICT');
});

test('cloud avatars still require confirmation and user ownership; arbitrary static paths remain forbidden', async () => {
  const f = fixture(); const first = await f.family();
  for (const avatar of ['/static/untrusted.png', 'https://untrusted.test/avatar.png', 'wxfile://temporary']) {
    assert.equal((await f.call('updateProfile', { name: '不会保存', avatar })).ok, false);
  }
  const fileId = 'cloud://env/own-avatar';
  await f.db.set('media', hash(fileId), { fileId, confirmed: true, profile: true, userId: hash('bob') });
  assert.equal((await f.call('updateProfile', { name: '不能越权', avatar: fileId })).code, 'FORBIDDEN');
  await f.db.set('media', hash(fileId), { fileId, confirmed: false, profile: true, userId: hash('alice') });
  assert.equal((await f.call('updateProfile', { name: '未确认', avatar: fileId })).code, 'FORBIDDEN');
  await f.db.set('media', hash(fileId), { fileId, confirmed: true, profile: true, userId: hash('alice') });
  const saved = await ok(f.call('updateProfile', { name: first.profile.name, avatar: fileId, defaultProfileVersion: 1 }));
  assert.equal(saved.profile.avatar, fileId);
  assert.equal((await f.db.get('users', hash('alice'))).defaultAvatarId, '');
  const staleJoin = await f.family('alice', { name: '过时昵称', avatar: DEFAULT_AVATARS[0].src });
  assert.equal(staleJoin.profile.avatar, fileId);
  assert.equal((await f.call('updateProfile', { name: first.profile.name, avatar: '', defaultAvatarId: 'food-999' })).code, 'INVALID');
});

test('new Discover responses show safe defaults without exposing account IDs or changing meal snapshots', async () => {
  const f = fixture(); const first = await f.family();
  const post = { id: 'meal-default-avatar', spaceId: first.familyId, authorId: first.userId, status: 'published', visibility: 'public', createdAt: 123, author: { name: '旧家庭名', avatar: '', mode: 'family' }, dishes: [], photos: [] };
  await f.db.set('meal_posts', post.id, post);
  const modern = await ok(f.call('mealFeed', { spaceId: first.familyId, identityPresentationVersion: 1, defaultProfileVersion: 1 }));
  assert.equal(modern.posts[0].author.avatar, defaultAvatarForUser(first.userId));
  assert.equal(modern.posts[0].authorId, undefined);
  assert.equal(modern.posts[0].spaceId, undefined);
  assert.equal(modern.posts[0].author.userId, undefined);
  const legacy = await ok(f.call('mealFeed', { spaceId: first.familyId, identityPresentationVersion: 1 }));
  assert.equal(legacy.posts[0].author.avatar, '');
  assert.deepEqual(await f.db.get('meal_posts', post.id), { ...post, _id: post.id });
});

test('default identity presentation honors member exit and deleted accounts', async () => {
  const db = memoryRepository();
  await db.set('users', 'alice', { name: '', avatar: '' });
  await db.set('families', 'family', { id: 'family', name: '当前家庭', members: [{ id: 'alice', name: '', avatar: '' }] });
  const options = { liveImages: true, defaultProfileVersion: 1 };
  const row = { authorId: 'alice', spaceId: 'family', mealSharingVersion: 2, author: { mode: 'family', name: '旧家庭名', avatar: '' } };
  assert.equal((await createIdentityPresentation(db).meal(row, options)).avatar, defaultAvatarForUser('alice'));
  await db.set('families', 'family', { id: 'family', name: '当前家庭', members: [] });
  await db.set('users', 'alice', { name: '退出后的昵称', avatar: 'cloud://after-leaving' });
  assert.equal((await createIdentityPresentation(db).meal(row, options)).avatar, defaultAvatarForUser('alice'));
  await db.set('users', 'alice', { name: '', avatar: '', deletedAt: 1 });
  const personal = { ...row, author: { mode: 'personal', name: '历史昵称', avatar: 'cloud://historical' } };
  assert.deepEqual(await createIdentityPresentation(db).meal(personal, options), personal.author);
});

test('historical meals with missing identities receive only safe defaults while preserving every existing saved image', async () => {
  const db = memoryRepository();
  const variants = [
    { authorId: 'alice', spaceId: 'missing-family', author: { mode: 'family', name: '旧家庭', avatar: '' } },
    { authorId: 'missing-user', spaceId: 'missing-personal', author: { mode: 'personal', name: '旧用户', avatar: '' } },
    { authorId: 'deleted-user', spaceId: 'personal', author: { mode: 'personal', name: '已删除用户', avatar: '' } },
    { authorId: 'alice', spaceId: 'departed-family', author: { mode: 'family', name: '已退出家庭', avatar: '' } },
  ];
  await db.set('users', 'deleted-user', { name: '不能泄露', avatar: 'cloud://after-deletion', deletedAt: 1 });
  await db.set('users', 'alice', { name: '退出后的昵称', avatar: 'cloud://after-exit' });
  await db.set('families', 'departed-family', { id: 'departed-family', name: '现在的名称', members: [] });
  for (const row of variants) {
    const identity = createIdentityPresentation(db);
    const modern = await identity.meal(row, { liveImages: true, defaultProfileVersion: 1 });
    assert.deepEqual(modern, { ...row.author, avatar: defaultAvatarForUser(row.authorId) });
    assert.deepEqual(await identity.meal(row, { liveImages: true }), row.author);
    assert.deepEqual(await identity.meal(row, { defaultProfileVersion: 1 }), row.author);
    const withSaved = { ...row, author: { ...row.author, avatar: 'cloud://historical-image' } };
    assert.deepEqual(await identity.meal(withSaved, { liveImages: true, defaultProfileVersion: 1 }), withSaved.author);
  }
});

test('full command and replay responses preserve a deliberately selected default avatar', async () => {
  const f = fixture(); const first = await f.family('alice', { avatar: DEFAULT_AVATARS[19].src });
  const request = { name: 'setFeature', args: ['fridge', true], familyId: first.familyId, revision: first.revision, requestId: 'default-command-replay-001', defaultProfileVersion: 1 };
  const result = await ok(f.call('command', request));
  const replay = await ok(f.call('command', request));
  assert.equal(result.profile.avatar, DEFAULT_AVATARS[19].src);
  assert.equal(replay.profile.avatar, DEFAULT_AVATARS[19].src);
  assert.equal(result.profileBaseline.avatar, '');
  assert.equal(replay.profileBaseline.avatar, '');
});
