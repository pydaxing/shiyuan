import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { mealTimeline } from '../src/domain/meal-social.js';
import { memoryRepository } from './helpers/memory-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const mealOrder = (id, image) => ({
  id, diaryParticipantsVersion: 1, diaryParticipantUserIds: [hash('alice'), hash('bob')], memberId: hash('alice'), memberName: 'Alice', date: '2026-11-05', meal: '晚餐', status: 'accepted',
  items: [{ quantity: 1, recipe: { id: 'tomato', title: '番茄炒蛋', image, category: '素菜', servings: 2, minutes: 10, ingredients: [{ name: '番茄', quantity: 2, unit: '个' }], steps: [{ title: '炒熟', text: '将食材炒熟即可' }] } }],
});
const sharedImagePost = (number, spaceId, image, participantUserIds = []) => ({
  id: `meal-${number.toString(16).padStart(64, '0')}`, spaceId, authorId: hash('alice'),
  status: 'published', visibility: 'family', mealSharingVersion: 2, mealContext: 'family',
  participantUserIds, assetIds: [image], images: [image], kind: 'plan', date: '2026-11-05', meal: '晚餐', createdAt: Date.parse('2026-11-05T08:00:00Z'),
});
function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse('2026-11-05T08:00:00Z'), signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async id => id, readImage: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }) });
  const call = (action, payload = {}, who = 'alice') => app({ action, ...payload }, { OPENID: who });
  const family = async () => ok(await call('createFamily', { name: 'Alice', familyName: '一起吃饭的小家' })).familyId;
  const join = async (who, inviter = 'alice') => {
    const invite = ok(await call('prepareInvite', {}, inviter));
    return ok(await call('joinFamily', { name: who, token: invite.token }, who)).familyId;
  };
  const personal = async who => {
    ok(await call('updateProfile', { name: who }, who));
    return ok(await call('switchWorkspace', { mode: 'personal' }, who)).familyId;
  };
  let sequence = 0;
  const publish = async (spaceId, patch = {}, who = 'alice') => {
    const number = ++sequence;
    const image = `cloud://env/shared-meal-${number}`;
    await repository.set('media', hash(image), { fileId: image, familyId: spaceId, userId: hash(who), confirmed: true, mealPhoto: true });
    return call('publishMeal', { spaceId, requestId: `shared-meal-request-${number}`, kind: 'actual', date: '2026-11-05', meal: '晚餐', images: [image], visibility: 'family', mealSharingVersion: 2, showMealBadge: true, ...patch }, who);
  };
  const diary = async (spaceId, who = 'alice', patch = {}) => ok(await call('myMealPosts', { spaceId, mealSharingVersion: 2, ...patch }, who));
  return { repository, call, family, join, personal, publish, diary };
}

test('shared family meals have one canonical record and server-owned participant identities', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = ok(await f.publish(spaceId, { participantUserIds: [hash('stranger')], mealContext: 'personal' })).post;
  const stored = await f.repository.get('meal_posts', post.id);
  assert.equal(stored.spaceId, spaceId);
  assert.equal(stored.authorId, hash('alice'));
  assert.equal(stored.mealSharingVersion, 2);
  assert.equal(stored.mealContext, 'family');
  assert.deepEqual([...stored.participantUserIds].sort(), [hash('alice'), hash('bob')].sort());
  assert.equal(post.mealContext, 'family');
  assert.equal(post.showMealBadge, true);
  for (const key of ['authorId', 'spaceId', 'participantUserIds']) assert.equal(key in post, false, key);
  assert.deepEqual((await f.diary(spaceId)).posts.map(row => row.id), [post.id]);
  const bobPost = (await f.diary(spaceId, 'bob')).posts[0];
  assert.equal(bobPost.id, post.id);
  assert.equal(bobPost.isOwner, false);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
  assert.deepEqual(ok(await f.call('mealFeed', { spaceId }, 'bob')).posts, []);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, 'bob')).ok, true);
  const outsiderSpace = await f.personal('stranger');
  assert.deepEqual((await f.diary(outsiderSpace, 'stranger')).posts, []);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, 'stranger')).code, 'FORBIDDEN');
});

test('personal diary combines own solo meals and family participation across spaces without duplicates', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const aliceFamily = ok(await f.publish(spaceId)).post;
  const bobFamily = ok(await f.publish(spaceId, { visibility: 'public' }, 'bob')).post;
  const personalSpace = await f.personal('alice');
  const solo = ok(await f.publish(personalSpace, { visibility: 'private', showMealBadge: false })).post;
  assert.equal(solo.mealContext, 'personal');
  assert.equal(solo.showMealBadge, false);
  const stored = await f.repository.get('meal_posts', solo.id);
  assert.deepEqual(stored.participantUserIds, [hash('alice')]);
  const ids = (await f.diary(personalSpace)).posts.map(row => row.id);
  assert.equal(ids.length, 3);
  assert.deepEqual(new Set(ids), new Set([aliceFamily.id, bobFamily.id, solo.id]));
  const bobPersonal = await f.personal('bob');
  assert.deepEqual(new Set((await f.diary(bobPersonal, 'bob')).posts.map(row => row.id)), new Set([aliceFamily.id, bobFamily.id]));
  assert.equal((await f.call('mediaContent', { fileId: solo.images[0] }, 'bob')).code, 'FORBIDDEN');
});

test('membership snapshot controls personal history while current family members see shared family history', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const beforeJoin = ok(await f.publish(spaceId)).post;
  await f.join('carol');
  assert.deepEqual((await f.diary(spaceId, 'carol')).posts.map(row => row.id), [beforeJoin.id]);
  assert.equal((await f.call('mediaContent', { fileId: beforeJoin.images[0] }, 'carol')).ok, true);
  const carolPersonal = await f.personal('carol');
  assert.deepEqual((await f.diary(carolPersonal, 'carol')).posts, [], 'later membership must not invent attendance for earlier meals');
  ok(await f.call('leaveFamily', { familyId: spaceId }, 'bob'));
  const bobPersonal = await f.personal('bob');
  assert.deepEqual((await f.diary(bobPersonal, 'bob')).posts.map(row => row.id), [beforeJoin.id]);
  assert.equal((await f.call('mediaContent', { fileId: beforeJoin.images[0] }, 'bob')).ok, true);
  const afterLeave = ok(await f.publish(spaceId)).post;
  assert.deepEqual((await f.diary(bobPersonal, 'bob')).posts.map(row => row.id), [beforeJoin.id]);
  assert.equal((await f.call('mediaContent', { fileId: afterLeave.images[0] }, 'bob')).code, 'FORBIDDEN');
});

test('legacy private records stay private and legacy requests retain their original diary scope', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const legacyPrivate = ok(await f.publish(spaceId, { mealSharingVersion: undefined, showMealBadge: undefined, visibility: 'private' })).post;
  const legacyPublic = ok(await f.publish(spaceId, { mealSharingVersion: undefined, showMealBadge: undefined, visibility: 'public' })).post;
  const shared = ok(await f.publish(spaceId)).post;
  assert.deepEqual(ok(await f.call('myMealPosts', { spaceId }, 'bob')).posts, [], 'unversioned older clients continue reading only their own records');
  assert.deepEqual(new Set((await f.diary(spaceId, 'bob')).posts.map(row => row.id)), new Set([legacyPublic.id, shared.id]));
  assert.equal((await f.call('mediaContent', { fileId: legacyPrivate.images[0] }, 'bob')).code, 'FORBIDDEN');
  const stored = await f.repository.get('meal_posts', legacyPrivate.id);
  assert.equal(stored.mealSharingVersion, undefined);
  assert.equal(stored.participantUserIds, undefined);
  assert.equal((await f.call('setMealVisibility', { spaceId, postId: legacyPrivate.id, visibility: 'family', mealSharingVersion: 2 })).ok, false);
  const personalSpace = await f.personal('alice');
  assert.deepEqual(ok(await f.call('myMealPosts', { spaceId: personalSpace })).posts, [], 'old personal diary does not gain cross-space records implicitly');
  assert.deepEqual(new Set((await f.diary(personalSpace)).posts.map(row => row.id)), new Set([legacyPrivate.id, legacyPublic.id, shared.id]));
});

test('v2 visibility matches publishing context and rejects client attempts to alter ownership', async () => {
  const f = fixture(), spaceId = await f.family();
  assert.equal((await f.publish(spaceId, { visibility: 'private' })).ok, false);
  const personalSpace = await f.personal('alice');
  assert.equal((await f.publish(personalSpace, { visibility: 'family' })).ok, false);
  const solo = ok(await f.publish(personalSpace, { visibility: 'public', showMealBadge: false, mealContext: 'family', participantUserIds: [hash('bob')] })).post;
  assert.equal(solo.mealContext, 'personal');
  assert.equal(solo.showMealBadge, false);
  assert.deepEqual((await f.repository.get('meal_posts', solo.id)).participantUserIds, [hash('alice')]);
  assert.equal((await f.call('setMealVisibility', { spaceId: personalSpace, postId: solo.id, visibility: 'family', mealSharingVersion: 2 })).ok, false);
  assert.equal((await f.publish(personalSpace, { visibility: 'public', showMealBadge: 'yes' })).ok, false);
});

test('only the publisher can change a shared record and legacy private downgrade revokes family access', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = ok(await f.publish(spaceId, { visibility: 'public' })).post;
  assert.equal((await f.call('setMealVisibility', { spaceId, postId: post.id, visibility: 'family', mealSharingVersion: 2 }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await f.call('deleteMealPost', { spaceId, postId: post.id }, 'bob')).code, 'FORBIDDEN');
  ok(await f.call('setMealVisibility', { spaceId, postId: post.id, visibility: 'family', mealSharingVersion: 2 }));
  assert.deepEqual(ok(await f.call('mealFeed', { spaceId }, 'bob')).posts, []);
  assert.deepEqual((await f.diary(spaceId, 'bob')).posts.map(row => row.id), [post.id]);
  ok(await f.call('setMealVisibility', { spaceId, postId: post.id, visibility: 'private' }));
  assert.deepEqual((await f.diary(spaceId, 'bob')).posts, []);
  const bobPersonal = await f.personal('bob');
  assert.deepEqual((await f.diary(bobPersonal, 'bob')).posts, []);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await f.call('mediaUrl', { fileId: post.images[0] }, 'bob')).code, 'FORBIDDEN');
  assert.deepEqual((await f.diary(spaceId)).posts.map(row => row.id), [post.id]);
});

test('concurrent family opening creates one shared meal and completes the arrangement atomically', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const order = mealOrder('dinner', '/static/food.png');
  await f.repository.set('orders', hash(`${spaceId}:dinner`), { familyId: spaceId, value: order });
  const event = { spaceId, requestId: 'shared-opening-alice', kind: 'plan', orderId: 'dinner', visibility: 'family', mealSharingVersion: 2, showMealBadge: false };
  const results = await Promise.all([f.call('finishMeal', event), f.call('finishMeal', { ...event, requestId: 'shared-opening-bob' }, 'bob')]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.equal(results.find(row => !row.ok).code, 'ALREADY_FINISHED');
  const post = results.find(row => row.ok).data.post;
  assert.equal(post.mealStarted, true);
  assert.equal(post.showMealBadge, false);
  const completed = await f.repository.get('orders', hash(`${spaceId}:dinner`));
  assert.equal(completed.value.status, 'completed');
  assert.equal(completed.value.mealPostId, post.id);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
  for (const who of ['alice', 'bob']) {
    const posts = (await f.diary(spaceId, who)).posts;
    assert.deepEqual(posts.map(row => row.id), [post.id]);
    assert.equal(posts[0].sourceOrderId, order.id, 'all members can deduplicate the shared arrangement in the current family');
    assert.deepEqual(mealTimeline([completed.value], posts).map(row => row.id), [`post:${post.id}`]);
  }
  const bobPersonal = await f.personal('bob');
  const personalPosts = (await f.diary(bobPersonal, 'bob')).posts;
  assert.deepEqual(personalPosts.map(row => row.id), [post.id]);
  assert.equal('sourceOrderId' in personalPosts[0], false, 'a family order reference must not leak into a different workspace');
  assert.deepEqual(new Set(mealTimeline([order], personalPosts).map(row => row.id)), new Set([`order:${order.id}`, `post:${post.id}`]), 'an unrelated personal arrangement with the same local ID must remain visible');
  const replay = ok(await f.call('finishMeal', event));
  assert.equal(replay.replay, true);
  assert.equal(replay.post.id, post.id);
});

test('family participants retain access to recipe-cover meal images after leaving the family', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const image = 'cloud://env/family-recipe-cover';
  await f.repository.set('media', hash(image), { fileId: image, familyId: spaceId, userId: hash('alice'), confirmed: true });
  const order = mealOrder('cover-dinner', image);
  await f.repository.set('orders', hash(`${spaceId}:${order.id}`), { familyId: spaceId, value: order });
  const post = ok(await f.call('finishMeal', { spaceId, requestId: 'shared-cover-opening', kind: 'plan', orderId: order.id, visibility: 'family', mealSharingVersion: 2 })).post;
  ok(await f.call('leaveFamily', { familyId: spaceId }, 'bob'));
  const bobPersonal = await f.personal('bob');
  assert.deepEqual((await f.diary(bobPersonal, 'bob')).posts[0].images, [image]);
  assert.equal((await f.call('mediaContent', { fileId: image }, 'bob')).ok, true);
  assert.equal((await f.call('mediaUrl', { fileId: image }, 'bob')).ok, true);
  ok(await f.call('deleteMealPost', { spaceId, postId: post.id }));
  assert.equal((await f.diary(bobPersonal, 'bob')).posts[0].id, post.id);
  assert.equal((await f.call('mediaContent', { fileId: image }, 'bob')).ok, true);
  assert.equal((await f.call('mediaUrl', { fileId: image }, 'bob')).ok, true);
});

test('a later visible image reference grants access when the first family reference is inaccessible', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  await f.personal('bob');
  const otherSpace = 'unrelated-family', image = 'cloud://env/reused-family-cover';
  await f.repository.set('families', otherSpace, { id: otherSpace, kind: 'family', members: [{ id: hash('alice') }] });
  await f.repository.set('media', hash(image), { fileId: image, familyId: otherSpace, userId: hash('alice'), confirmed: true });
  const inaccessible = sharedImagePost(1, otherSpace, image, [hash('alice')]);
  const visible = sharedImagePost(2, spaceId, image, [hash('alice')]);
  await f.repository.set('meal_posts', inaccessible.id, inaccessible);
  await f.repository.set('meal_posts', visible.id, visible);
  for (const action of ['mediaContent', 'mediaUrl']) {
    assert.equal((await f.call(action, { fileId: image }, 'bob')).ok, true, `${action}: current membership grants access through the later reference, even without a participation snapshot`);
  }
  await f.repository.remove('meal_posts', visible.id);
  for (const action of ['mediaContent', 'mediaUrl']) {
    assert.equal((await f.call(action, { fileId: image }, 'bob')).code, 'FORBIDDEN', `${action}: the earlier inaccessible reference cannot grant access`);
  }
});

test('image access scans past one hundred inaccessible references and still enforces the final permission', async () => {
  const f = fixture();
  await f.personal('bob');
  const spaceId = 'former-family', image = 'cloud://env/many-family-cover-references';
  await f.repository.set('families', spaceId, { id: spaceId, kind: 'family', members: [{ id: hash('alice') }] });
  await f.repository.set('media', hash(image), { fileId: image, familyId: spaceId, userId: hash('alice'), confirmed: true });
  for (let index = 1; index <= 105; index++) {
    const post = sharedImagePost(index, spaceId, image, [hash('alice')]);
    await f.repository.set('meal_posts', post.id, post);
  }
  const visible = sharedImagePost(106, spaceId, image, [hash('alice'), hash('bob')]);
  await f.repository.set('meal_posts', visible.id, visible);
  for (const action of ['mediaContent', 'mediaUrl']) {
    assert.equal((await f.call(action, { fileId: image }, 'bob')).ok, true, `${action}: the former participant's readable reference is on the second page`);
  }
  await f.repository.set('meal_posts', visible.id, { ...visible, visibility: 'private' });
  for (const action of ['mediaContent', 'mediaUrl']) {
    assert.equal((await f.call(action, { fileId: image }, 'bob')).code, 'FORBIDDEN', `${action}: all pages are exhausted without access after the shared record becomes private`);
  }
});

test('publication retries retain identity, participant snapshot and display choice', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const event = { requestId: 'shared-replay-request', showMealBadge: false };
  const post = ok(await f.publish(spaceId, event)).post;
  const payload = { spaceId, ...event, kind: 'actual', date: '2026-11-05', meal: '晚餐', images: post.images, visibility: 'family', mealSharingVersion: 2 };
  await f.join('carol');
  const replay = ok(await f.call('publishMeal', payload));
  assert.equal(replay.replay, true);
  assert.equal(replay.post.id, post.id);
  assert.deepEqual(new Set((await f.repository.get('meal_posts', post.id)).participantUserIds), new Set([hash('alice'), hash('bob')]));
  assert.equal((await f.call('publishMeal', { ...payload, showMealBadge: true })).code, 'CONFLICT');
  assert.equal((await f.repository.list('meal_posts')).length, 1);
});

test('aggregated personal diary pagination has no gaps or duplicates with overlapping sources and tied timestamps', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = ok(await f.publish(spaceId)).post;
  const base = await f.repository.get('meal_posts', post.id);
  const personalSpace = await f.personal('bob');
  const expected = [post.id];
  for (let index = 0; index < 66; index++) {
    const id = `meal-${hash(`shared-diary-pagination-${index}`)}`;
    const authorId = index % 2 ? hash('bob') : hash('alice');
    const isPrivate = index % 3 === 0;
    await f.repository.set('meal_posts', id, { ...base, id, authorId, visibility: isPrivate ? 'private' : index % 2 ? 'public' : 'family' });
    if (authorId === hash('bob') || !isPrivate) expected.push(id);
  }
  const seen = []; let cursor;
  for (let page = 0; page < 5; page++) {
    const result = await f.diary(personalSpace, 'bob', { cursor });
    assert.ok(result.posts.length <= 20);
    seen.push(...result.posts.map(row => row.id));
    cursor = result.cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, expected.sort((a, b) => b.localeCompare(a)));
  assert.equal(new Set(seen).size, expected.length);
  assert.equal(cursor, null);
});

test('deleting a shared diary reference preserves other members and media access', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = ok(await f.publish(spaceId)).post;
  const bobPersonal = await f.personal('bob');
  assert.equal((await f.diary(bobPersonal, 'bob')).posts.length, 1);
  ok(await f.call('deleteMealPost', { spaceId, postId: post.id }));
  assert.deepEqual((await f.diary(spaceId)).posts, []);
  assert.equal((await f.diary(bobPersonal, 'bob')).posts[0].id, post.id);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, 'bob')).ok, true);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] })).ok, true);
});


test('manual recording preserves arranged participants after membership changes', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const order = mealOrder('snapshot-dinner', '/static/food.png');
  await f.repository.set('orders', hash(`${spaceId}:${order.id}`), { familyId: spaceId, value: order });
  await f.join('carol');
  const post = ok(await f.call('finishMeal', { spaceId, orderId: order.id, kind: 'plan', requestId: 'snapshot-members-meal', visibility: 'public', mealSharingVersion: 2 })).post;
  assert.deepEqual((await f.repository.get('meal_posts', post.id)).participantUserIds.sort(), [hash('alice'), hash('bob')].sort());
  const carolSpace = await f.personal('carol');
  assert.equal((await f.diary(carolSpace, 'carol')).posts.some(row => row.id === post.id), false);
});
