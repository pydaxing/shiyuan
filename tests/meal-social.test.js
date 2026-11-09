import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { mealPublicationAge, mealTimeline, mealCheckinDays, MEAL_MOODS } from '../src/domain/meal-social.js';
import { createFamilyDeletionMedia } from '../server/family-deletion-media.mjs';
import { createSeed } from '../src/data/seed.js';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture(now = () => Date.parse('2026-11-05T08:00:00Z')) {
  const repository = memoryRepository();
  const removed = [];
  const cleanupMedia = createFamilyDeletionMedia({ repository, removeFiles: async ids => { removed.push(...ids); return { fileList: ids.map(fileID => ({ fileID, status: 0 })) }; } });
  const app = createApplication({ repository, cleanupMedia, now, signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async id => id, readImage: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }) });
  const call = (action, payload = {}, who = 'alice') => app({ action, ...payload }, { OPENID: who });
  const enter = async who => {
    assert.equal((await call('updateProfile', { name: who }, who)).ok, true);
    const result = await call('switchWorkspace', { mode: 'personal' }, who);
    assert.equal(result.ok, true);
    return result.data.familyId;
  };
  const photo = async (spaceId, who = 'alice', name = 'photo') => {
    const id = `cloud://env/${name}`;
    await repository.set('media', hash(id), { fileId: id, familyId: spaceId, userId: hash(who), confirmed: true, mealPhoto: true });
    return id;
  };
  const actual = async (spaceId, extra = {}, who = 'alice') => call('publishMeal', { spaceId, requestId: 'meal-request-0001', kind: 'actual', date: '2026-11-05', meal: '午餐', images: [await photo(spaceId, who)], visibility: 'private', ...extra }, who);
  return { repository, call, enter, photo, actual, removed };
}
test('personal switch isolates recipes/orders and preserves the original membership', async () => {
  const f = fixture();
  const created = await f.call('createFamily', { name: 'Alice', familyName: '小家' });
  const familyId = created.data.familyId;
  await f.repository.set('orders', hash(`${familyId}:order`), { familyId, value: { id: 'order', date: '2026-11-05', meal: '晚餐', status: 'cancelled', memberName: 'Alice', items: [] } });
  const personal = await f.call('switchWorkspace', { mode: 'personal', expectedSpaceId: familyId });
  assert.equal(personal.ok, true);
  assert.equal(personal.data.snapshot.family.kind, 'personal');
  assert.equal(personal.data.snapshot.orders.length, 0);
  const user = await f.repository.get('users', hash('alice'));
  assert.equal(user.familyId, familyId);
  assert.deepEqual(user.familyIds, [familyId]);
  assert.equal((await f.call('prepareInvite')).code, 'FORBIDDEN');
  assert.equal((await f.call('createInvite')).code, 'FORBIDDEN');
  assert.equal((await f.call('deleteFamily', { confirmName: '我的餐桌' })).code, 'FORBIDDEN');
  assert.equal((await f.call('switchFamily', { familyId: personal.data.familyId })).code, 'FORBIDDEN');
  const back = await f.call('switchWorkspace', { mode: 'family', expectedSpaceId: personal.data.familyId });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.data.familyId, familyId);
  assert.equal(back.data.snapshot.orders.length, 1);
  assert.equal((await f.call('switchWorkspace', { mode: 'personal', expectedSpaceId: 'old-space' })).code, 'CONFLICT');
});
test('private actual photos are protected even from a member of the same family', async () => {
  const f = fixture();
  const made = await f.call('createFamily', { name: 'Alice', familyName: '小家' });
  const spaceId = made.data.familyId;
  const invite = await f.call('prepareInvite');
  await f.call('joinFamily', { name: 'Bob', token: invite.data.token }, 'bob');
  const published = await f.actual(spaceId);
  assert.equal(published.ok, true);
  const fileId = published.data.post.images[0];
  assert.equal((await f.call('mediaContent', { fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await f.call('mediaUrl', { fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await f.call('myMealPosts', { spaceId }, 'bob')).data.posts.length, 0);
  assert.equal((await f.call('mealFeed', { spaceId }, 'bob')).data.posts.length, 0);
  assert.equal((await f.call('mediaContent', { fileId })).ok, true);
  assert.equal((await f.call('setMealVisibility', { spaceId, postId: published.data.post.id, visibility: 'public' })).ok, true);
  assert.equal((await f.call('mediaContent', { fileId }, 'bob')).ok, true);
  await f.call('setMealVisibility', { spaceId, postId: published.data.post.id, visibility: 'private' });
  assert.equal((await f.call('mediaContent', { fileId }, 'bob')).code, 'FORBIDDEN');
});
test('publishing and concurrent endorsements are idempotent and cancelable', async () => {
  const f = fixture(); const spaceId = await f.enter('alice'); const other = await f.enter('bob');
  const published = await f.actual(spaceId, { visibility: 'public' });
  assert.equal(published.ok, true); const postId = published.data.post.id;
  const again = await f.call('publishMeal', { spaceId, requestId: 'meal-request-0001', kind: 'actual', date: '2026-11-05', meal: '午餐', visibility: 'public', images: published.data.post.images });
  assert.equal(again.data.post.id, postId); assert.equal(again.data.replay, true);
  const likes = await Promise.all(Array.from({ length: 8 }, () => f.call('setMealLike', { spaceId: other, postId, selected: true }, 'bob')));
  assert.ok(likes.every(result => result.ok && result.data.post.likeCount === 1));
  const tags = await Promise.all(Array.from({ length: 8 }, () => f.call('setMealReaction', { spaceId: other, postId, tagId: 'want', selected: true }, 'bob')));
  assert.ok(tags.every(result => result.ok && result.data.post.reactions[0].count === 1));
  const off = await f.call('setMealReaction', { spaceId: other, postId, tagId: 'want', selected: false }, 'bob');
  assert.equal(off.data.post.reactions[0].count, 0);
  assert.equal((await f.call('setMealLike', { spaceId: other, postId, selected: false }, 'bob')).data.post.likeCount, 0);
  assert.equal((await f.call('setMealReaction', { spaceId: other, postId, tagId: 'custom', selected: true }, 'bob')).code, 'INVALID');
  assert.equal((await f.call('deleteMealPost', { spaceId: other, postId }, 'bob')).code, 'FORBIDDEN');
  await f.call('deleteMealPost', { spaceId, postId });
  assert.equal((await f.call('deleteMealPost', { spaceId, postId })).ok, true);
  assert.equal((await f.call('mealFeed', { spaceId: other }, 'bob')).data.posts.length, 0);
  assert.equal((await f.call('mediaContent', { fileId: published.data.post.images[0] })).code, 'FORBIDDEN');
});
test('planned meals publish a minimal snapshot and never count as actual check-ins', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  await f.repository.set('orders', hash(`${spaceId}:dinner`), { familyId: spaceId, value: { id: 'dinner', date: '2026-11-05', meal: '晚餐', status: 'accepted', note: 'SECRET', memberId: 'PRIVATE_ID', items: [{ recipe: { title: '番茄炒蛋', image: '/static/food.png', ingredients: [{ name: 'SECRET' }] } }] } });
  const event = { spaceId, requestId: 'plan-request-0001', kind: 'plan', orderId: 'dinner', visibility: 'public' };
  const result = await f.call('publishMeal', event);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.post.dishes, [{ title: '番茄炒蛋', image: '/static/food.png' }]);
  assert.equal(JSON.stringify(result.data.post).includes('SECRET'), false);
  assert.equal(JSON.stringify(result.data.post).includes('PRIVATE_ID'), false);
  assert.equal('spaceId' in result.data.post, false);
  assert.equal('authorId' in result.data.post, false);
  assert.equal('recipeSnapshots' in result.data.post, false);
  assert.equal((await f.repository.get('meal_posts', result.data.post.id)).recipeSnapshots[0].ingredients[0].name, 'SECRET');
  assert.equal((await f.call('publishMeal', { ...event, requestId: 'plan-request-0002' })).code, 'ALREADY_PUBLISHED');
  assert.equal(mealCheckinDays([result.data.post]), 0);
  assert.equal(mealTimeline([{ id: 'dinner', date: '2026-11-05', meal: '晚餐', status: 'accepted' }], [result.data.post]).length, 1);
  assert.equal(result.data.post.sourceOrderId, 'dinner');
  const history = mealTimeline([{ id: 'dinner', date: '2026-11-05', meal: '晚餐' }], [result.data.post]);
  assert.equal(history[0].post.id, result.data.post.id);
  const otherSpace = await f.enter('bob');
  const outsider = await f.call('mealFeed', { spaceId: otherSpace }, 'bob');
  assert.equal('sourceOrderId' in outsider.data.posts[0], false);
  const withdrawn = await f.call('setMealVisibility', { spaceId, postId: result.data.post.id, visibility: 'private' });
  assert.equal(mealTimeline([], [withdrawn.data.post])[0].post.id, result.data.post.id, 'withdrawn plans stay manageable even after deleting the source order');

  await f.call('deleteMealPost', { spaceId, postId: result.data.post.id });
  const repost = await f.call('publishMeal', { ...event, requestId: 'plan-request-0003' });
  assert.equal(repost.ok, true); assert.notEqual(repost.data.post.id, result.data.post.id);
});
test('reject foreign photos, ordinary recipe photos, future check-ins, stale scopes and malformed cursors', async () => {
  const f = fixture(); const spaceId = await f.enter('alice'); const other = await f.enter('bob');
  const image = await f.photo(other, 'bob', 'bob');
  assert.equal((await f.actual(spaceId, { images: [image] })).code, 'FORBIDDEN');
  const ordinary = await f.photo(spaceId, 'alice', 'ordinary');
  await f.repository.set('media', hash(ordinary), { fileId: ordinary, userId: hash('alice'), familyId: spaceId, confirmed: true });
  assert.equal((await f.actual(spaceId, { images: [ordinary] })).code, 'FORBIDDEN');
  assert.equal((await f.actual(spaceId, { date: '2026-11-06' })).code, 'INVALID');
  assert.equal((await f.actual(spaceId, { date: '2026-02-30' })).code, 'INVALID');
  assert.equal((await f.call('mealFeed', { spaceId: other })).code, 'CONFLICT');
  assert.equal((await f.call('mealFeed', { spaceId, cursor: { id: 'bad', createdAt: 1 } })).code, 'INVALID');
});

test('private meal photos cannot be saved into a family recipe, even by their uploader', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  const fileId = await f.photo(spaceId);
  const recipe = { ...createSeed().recipes[0], image: fileId };
  const saved = await f.call('command', { name: 'saveRecipe', args: [recipe], revision: 0, familyId: spaceId, requestId: 'recipe-request-0001' });
  assert.equal(saved.code, 'FORBIDDEN');
  assert.deepEqual(await f.repository.list('recipes', { familyId: spaceId }), []);
});

test('feed pagination has no gaps or duplicates when timestamps are tied and omits private rows', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  const base = (await f.actual(spaceId, { visibility: 'public' })).data.post;
  const source = await f.repository.get('meal_posts', base.id);
  const expected = [base.id];
  for (let i = 0; i < 46; i += 1) {
    const id = `meal-${hash(`pagination-${i}`)}`;
    await f.repository.set('meal_posts', id, { ...source, id, visibility: i < 42 ? 'public' : 'private' });
    if (i < 42) expected.push(id);
  }
  const seen = []; let cursor;
  for (let page = 0; page < 4; page += 1) {
    const result = await f.call('mealFeed', { spaceId, cursor });
    assert.equal(result.ok, true); assert.ok(result.data.posts.length <= 20);
    seen.push(...result.data.posts.map(post => post.id)); cursor = result.data.cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, expected.sort((a, b) => b.localeCompare(a)));
  assert.equal(new Set(seen).size, expected.length); assert.equal(cursor, null);
});

test('family renames reach existing public and diary posts without rewriting snapshots or exposing family details', async () => {
  const f = fixture();
  const created = await f.call('createFamily', { name: 'Alice', familyName: '旧家庭名' });
  const spaceId = created.data.familyId;
  const first = await f.actual(spaceId, { visibility: 'public' });
  const second = await f.actual(spaceId, { visibility: 'public', requestId: 'meal-request-0002', images: [await f.photo(spaceId, 'alice', 'second')] });
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  const stored = await f.repository.get('meal_posts', first.data.post.id);
  const current = await f.call('bootstrap');
  const renamed = await f.call('command', { name: 'customizeFamily', familyId: spaceId, revision: current.data.revision, requestId: 'rename-family-0001', args: [{ name: '新的家庭名', cover: '', coverTitle: '' }] });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  const mine = await f.call('myMealPosts', { spaceId });
  assert.ok(mine.data.posts.every(post => post.author.name === '新的家庭名'));
  const otherSpace = await f.enter('bob');
  let familyReads = 0;
  const get = f.repository.get;
  f.repository.get = (...args) => { if (args[0] === 'families' && args[1] === spaceId) familyReads++; return get(...args); };
  const feed = await f.call('mealFeed', { spaceId: otherSpace }, 'bob');
  assert.equal(feed.ok, true);
  assert.equal(familyReads, 1, 'one household lookup for all of its posts in the same page');
  assert.equal(feed.data.posts.length, 2);
  for (const post of feed.data.posts) {
    assert.deepEqual(post.author, { ...stored.author, name: '新的家庭名' });
    assert.equal('spaceId' in post, false);
    assert.equal('authorId' in post, false);
    assert.equal('members' in post.author, false);
    assert.equal('ownerId' in post.author, false);
  }
  assert.deepEqual(await f.repository.get('meal_posts', first.data.post.id), stored);
  const liked = await f.call('setMealLike', { spaceId: otherSpace, postId: first.data.post.id, selected: true }, 'bob');
  assert.equal(liked.data.post.author.name, '新的家庭名');
});

test('family name projection preserves historical identity for missing, deleted or mismatched households', async () => {
  for (const state of ['missing', 'deleted', 'personal', 'left', 'mismatched']) {
    const f = fixture();
    const spaceId = (await f.call('createFamily', { name: 'Alice', familyName: '原来的小家' })).data.familyId;
    const published = await f.actual(spaceId, { visibility: 'public' });
    const otherSpace = await f.enter('bob');
    const family = await f.repository.get('families', spaceId);
    if (state === 'missing') await f.repository.remove('families', spaceId);
    else await f.repository.set('families', spaceId, {
      ...family, name: '不应展示的名称',
      ...(state === 'deleted' ? { deletedAt: 1 } : {}),
      ...(state === 'personal' ? { kind: 'personal' } : {}),
      ...(state === 'left' ? { members: [] } : {}),
      ...(state === 'mismatched' ? { id: 'another-space' } : {}),
    });
    const feed = await f.call('mealFeed', { spaceId: otherSpace }, 'bob');
    assert.equal(feed.ok, true, state);
    assert.deepEqual(feed.data.posts[0].author, published.data.post.author, state);
  }
});

test('personal meal identity never uses the private workspace title as a family name', async () => {
  const f = fixture();
  const spaceId = await f.enter('alice');
  const published = await f.actual(spaceId, { visibility: 'public' });
  const workspace = await f.repository.get('families', spaceId);
  await f.repository.set('families', spaceId, { ...workspace, name: '私人的空间名称' });
  const otherSpace = await f.enter('bob');
  const feed = await f.call('mealFeed', { spaceId: otherSpace }, 'bob');
  assert.deepEqual(feed.data.posts[0].author, published.data.post.author);
  assert.equal(feed.data.posts[0].author.mode, 'personal');
  assert.equal(feed.data.posts[0].author.name, 'alice');
});

test('profile updates reach the personal workspace without changing preserved family membership', async () => {
  const f = fixture();
  const familyId = (await f.call('createFamily', { name: 'Alice', familyName: '小家' })).data.familyId;
  const personal = await f.enter('alice');
  const list = await f.call('listFamilies');
  assert.equal(list.ok, true);
  assert.equal(list.data.families.find(row => row.id === familyId).current, false);
  assert.equal(list.data.families.some(row => row.id === personal), false);
  assert.equal((await f.call('updateProfile', { name: '新昵称' })).ok, true);
  assert.equal((await f.repository.get('families', personal)).members[0].name, '新昵称');
  assert.equal((await f.repository.get('families', familyId)).members[0].name, '新昵称');
  assert.deepEqual((await f.repository.get('users', hash('alice'))).familyIds, [familyId]);
  // Legacy create-family retry must restore family mode, not return personal data.
  const restored = await f.call('createFamily', { name: '新昵称', familyName: '小家' });
  assert.equal(restored.ok, true); assert.equal(restored.data.familyId, familyId);
});

test('household deletion retains public meal identity and assets while clearing private actual records', async () => {
  const f = fixture();
  const spaceId = (await f.call('createFamily', { name: 'Alice', familyName: '一起吃饭' })).data.familyId;
  const publicImage = await f.photo(spaceId, 'alice', 'public-meal');
  const privateImage = await f.photo(spaceId, 'alice', 'private-meal');
  const publicPost = await f.actual(spaceId, { images: [publicImage], visibility: 'public' });
  const privatePost = await f.actual(spaceId, { images: [privateImage], requestId: 'meal-request-0002' });
  assert.equal(publicPost.ok, true); assert.equal(privatePost.ok, true);
  let deletion = await f.call('deleteFamily', { familyId: spaceId, confirmName: '一起吃饭' });
  assert.equal(deletion.ok, true, JSON.stringify(deletion));
  for (let i = 0; deletion.data.deletion?.status === 'pending' && i < 30; i += 1) deletion = await f.call('continueFamilyDeletion', { familyId: spaceId });
  assert.equal(deletion.data.deletion.status, 'complete');
  const preserved = await f.repository.get('meal_posts', publicPost.data.post.id);
  assert.equal(preserved.status, 'published'); assert.equal(preserved.author.name, '一起吃饭');
  const retired = await f.repository.get('meal_posts', privatePost.data.post.id);
  assert.equal(retired.status, 'deleted'); assert.equal(retired.images, undefined); assert.equal(retired.author, undefined);
  assert.ok(f.removed.includes(privateImage)); assert.equal(f.removed.includes(publicImage), false);
  const other = await f.enter('bob');
  const feed = await f.call('mealFeed', { spaceId: other }, 'bob');
  assert.deepEqual(feed.data.posts.map(post => post.id), [publicPost.data.post.id]);
  assert.equal((await f.call('mediaContent', { fileId: publicImage }, 'bob')).ok, true);
  assert.equal((await f.call('mediaContent', { fileId: privateImage }, 'bob')).ok, false);
});

test('fixed meal moods are validated, projected and included in the idempotency fingerprint', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  for (const moodIds of [['made-up'], ['home', 'care', 'clean', 'solo'], 'home']) {
    const result = await f.actual(spaceId, { moodIds });
    assert.equal(result.code, 'INVALID');
  }
  const result = await f.actual(spaceId, { moodIds: ['home', 'care'], visibility: 'public', text: 'ignored freeform' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.post.moods, MEAL_MOODS.filter(tag => ['home', 'care'].includes(tag.id)));
  assert.equal(result.data.post.text, undefined);
  assert.equal((await f.actual(spaceId, { moodIds: ['care', 'home'], visibility: 'public' })).data.replay, true);
  assert.equal((await f.actual(spaceId, { moodIds: ['clean'], visibility: 'public' })).code, 'CONFLICT');
});

test('actual meal photos retain only the linked meal dish snapshot and deduplicate its diary entry', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  const order = { id: 'dinner', date: '2026-11-05', meal: '晚餐', status: 'accepted', note: 'PRIVATE_NOTE', items: [{ recipe: { title: '番茄炒蛋', image: '/static/food.png', ingredients: [{ name: 'PRIVATE_INGREDIENT' }] } }] };
  await f.repository.set('orders', hash(`${spaceId}:dinner`), { familyId: spaceId, value: order });
  const result = await f.actual(spaceId, { orderId: 'dinner', visibility: 'public', moodIds: ['healed', 'after-work', 'one-pot'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.post.kind, 'actual');
  assert.equal(result.data.post.sourceOrderId, 'dinner');
  assert.deepEqual(result.data.post.images, ['cloud://env/photo']);
  assert.deepEqual(result.data.post.dishes, [{ title: '番茄炒蛋', image: '/static/food.png' }]);
  assert.equal(JSON.stringify(result.data.post).includes('PRIVATE_'), false);
  assert.ok(result.data.post.moods.every(tag => tag.emoji && tag.tone));
  assert.equal(mealTimeline([order], [result.data.post]).length, 1);
  assert.equal(mealCheckinDays([result.data.post]), 1);
  const replay = await f.actual(spaceId, { orderId: 'dinner', visibility: 'public', moodIds: ['one-pot', 'healed', 'after-work'] });
  assert.equal(replay.data.replay, true);
  assert.equal((await f.actual(spaceId, { orderId: 'changed', visibility: 'public', moodIds: ['healed', 'after-work', 'one-pot'] })).code, 'CONFLICT');
  const otherSpace = await f.enter('bob');
  const publicPost = (await f.call('mealFeed', { spaceId: otherSpace }, 'bob')).data.posts[0];
  assert.equal('sourceOrderId' in publicPost, false);
  const other = await f.actual(otherSpace, { orderId: 'dinner' }, 'bob');
  assert.equal(other.ok, false);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
});

async function arranged(f, spaceId, extra = {}) {
  const order = { id: 'dinner', date: '2026-11-05', meal: '晚餐', status: 'accepted', items: [{ recipe: { id: 'tomato', title: '番茄炒蛋', image: '/static/food.png' } }], ...extra };
  await f.repository.set('orders', hash(`${spaceId}:${order.id}`), { familyId: spaceId, value: order });
  return { spaceId, requestId: 'finish-request-0001', kind: 'plan', orderId: order.id, visibility: 'public' };
}
test('finishMeal atomically records opening, public post and revision; exact replay changes nothing', async () => {
  const f = fixture(), spaceId = await f.enter('alice');
  const event = await arranged(f, spaceId);
  const before = await f.repository.get('families', spaceId);
  const result = await f.call('finishMeal', event);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.post.mealStarted, true);
  assert.equal(result.data.post.visibility, 'public');
  const row = await f.repository.get('orders', hash(`${spaceId}:dinner`));
  assert.equal(row.value.status, 'completed');
  assert.equal(row.value.mealPostId, result.data.post.id);
  assert.equal(row.value.completedAt, '2026-11-05T08:00:00.000Z');
  assert.equal((await f.repository.get('families', spaceId)).revision, before.revision + 1);
  assert.equal((await f.call('myMealPosts', { spaceId })).data.posts[0].sourceOrderId, 'dinner');
  assert.equal((await f.call('mealFeed', { spaceId })).data.posts.length, 1);
  const replay = await f.call('finishMeal', event);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.post.id, result.data.post.id);
  assert.equal((await f.repository.get('families', spaceId)).revision, before.revision + 1);
  assert.equal((await f.call('finishMeal', { ...event, requestId: 'finish-request-0002' })).code, 'ALREADY_FINISHED');
  assert.equal(mealCheckinDays([result.data.post]), 0, 'recipe covers are not actual photo check-ins');
});
test('different family members racing to finish one meal produce only one post', async () => {
  const f = fixture();
  const spaceId = (await f.call('createFamily', { name: 'Alice', familyName: '小家' })).data.familyId;
  const invite = await f.call('prepareInvite');
  await f.call('joinFamily', { name: 'Bob', token: invite.data.token }, 'bob');
  const event = await arranged(f, spaceId);
  const results = await Promise.all([f.call('finishMeal', event), f.call('finishMeal', { ...event, requestId: 'bob-finish-request' }, 'bob')]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => !r.ok).code, 'ALREADY_FINISHED');
  assert.equal((await f.repository.list('meal_posts')).length, 1);
});
test('failed completion rolls back photo bindings, order, family revision and post', async () => {
  const f = fixture(), spaceId = await f.enter('alice');
  const event = await arranged(f, spaceId);
  const image = await f.photo(spaceId);
  const before = await f.repository.get('families', spaceId);
  const result = await f.call('finishMeal', { ...event, kind: 'actual', date: '2026-11-05', meal: '晚餐', images: [image, 'cloud://foreign'] });
  assert.equal(result.code, 'FORBIDDEN');
  assert.equal((await f.repository.get('media', hash(image))).mealPostId, undefined);
  assert.deepEqual(await f.repository.get('families', spaceId), before);
  assert.equal((await f.repository.get('orders', hash(`${spaceId}:dinner`))).value.status, 'accepted');
  assert.equal((await f.repository.list('meal_posts')).length, 0);
  const transaction = f.repository.transaction.bind(f.repository);
  f.repository.transaction = callback => transaction(db => callback({ ...db, set: async (collection, ...args) => { if (collection === 'meal_posts') throw new Error('write failed'); return db.set(collection, ...args); } }));
  assert.equal((await f.call('finishMeal', event)).ok, false);
  assert.deepEqual(await f.repository.get('families', spaceId), before);
  assert.equal((await f.repository.get('orders', hash(`${spaceId}:dinner`))).value.status, 'accepted');
  assert.equal((await f.repository.list('requests', { kind: 'meal_post_v1' })).length, 0);
});
test('completion rejects past/future/cancelled/mismatched records without publishing', async () => {
  for (const [extra, patch, code] of [
    [{ date: '2026-11-04' }, {}, 'MEAL_DATE'], [{ date: '2026-11-06' }, {}, 'MEAL_DATE'],
    [{ status: 'cancelled' }, {}, 'INVALID'], [{ status: 'completed' }, {}, 'ALREADY_FINISHED'],
    [{}, { orderId: undefined }, 'INVALID'],
    [{}, { kind: 'actual', date: '2026-11-05', meal: '午餐', images: ['cloud://photo'] }, 'INVALID'],
  ]) {
    const f = fixture(), spaceId = await f.enter('alice');
    const event = await arranged(f, spaceId, extra);
    const result = await f.call('finishMeal', { ...event, ...patch });
    assert.equal(result.code, code, JSON.stringify({extra,patch,result}));
    assert.equal((await f.repository.list('meal_posts')).length, 0);
  }
});
test('old published arrangement can still be finished without overwriting its snapshot', async () => {
  const f = fixture(), spaceId = await f.enter('alice');
  const event = await arranged(f, spaceId);
  const old = await f.call('publishMeal', event);
  assert.equal(old.ok, true);
  assert.equal((await f.call('finishMeal', event)).code, 'CONFLICT', 'same request ID cannot change semantics');
  const done = await f.call('finishMeal', { ...event, requestId: 'new-finish-request' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await f.repository.get('meal_posts', old.data.post.id)).mealStarted, undefined);
  assert.equal(done.data.post.mealStarted, true);
});

test('China midnight expires unconfirmed meals but preserves a successful completion replay', async () => {
  let time = Date.parse('2026-11-05T15:59:59Z');
  const f = fixture(() => time), spaceId = await f.enter('alice');
  const confirmedEvent = await arranged(f, spaceId);
  const waitingEvent = await arranged(f, spaceId, { id: 'waiting', meal: '午餐' });
  waitingEvent.requestId = 'waiting-finish-request';
  const confirmed = await f.call('finishMeal', confirmedEvent);
  assert.equal(confirmed.ok, true);
  time = Date.parse('2026-11-05T16:00:00Z');
  const replay = await f.call('finishMeal', confirmedEvent);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.post.id, confirmed.data.post.id);
  assert.equal((await f.call('finishMeal', waitingEvent)).code, 'MEAL_DATE');
  assert.equal((await f.repository.get('orders', hash(`${spaceId}:waiting`))).value.status, 'accepted');
  assert.equal((await f.repository.list('meal_posts')).length, 1);
});

test('publication age uses elapsed publishing time at exact minute/hour/day boundaries', () => {
  const now = 1800000000000;
  for (const [age, expected] of [[0, '1分钟前'], [59000, '1分钟前'], [120000, '2分钟前'], [3599999, '59分钟前'], [3600000, '1小时前'], [86399999, '23小时前'], [86400000, '昨天'], [172799999, '昨天'], [172800000, '2天前'], [259200000, '3天前']]) {
    assert.equal(mealPublicationAge(now - age, now), expected);
  }
  assert.equal(mealPublicationAge(now + 10000, now), '1分钟前');
  assert.equal(mealPublicationAge(undefined, now), '');
  assert.equal(mealPublicationAge(0, now), '');
});

 test('private completion stays out of discovery', async () => {
  const f = fixture(), spaceId = await f.enter('alice');
  const event = await arranged(f, spaceId);
  const result = await f.call('finishMeal', { ...event, visibility: 'private' });
  assert.equal(result.ok, true);
  assert.equal(result.data.post.visibility, 'private');
  const feed = await f.call('mealFeed', { spaceId });
  assert.equal(feed.data.posts.some(post => post.id === result.data.post.id), false);
});

test('meal like names resolve current profiles, cancel cleanly and preserve old clients', async () => {
  const f = fixture(); const spaceId = await f.enter('alice'); const other = await f.enter('bob');
  const postId = (await f.actual(spaceId, { visibility: 'public' })).data.post.id;
  const like = await f.call('setMealLike', { spaceId: other, postId, selected: true, mealLikesVersion: 1 }, 'bob');
  assert.equal(like.ok, true, JSON.stringify(like));
  assert.deepEqual(like.data.post.likeUsers.map(({ name, self }) => ({ name, self })), [{ name: 'bob', self: true }]);
  await f.call('setMealLike', { spaceId, postId, selected: true });
  await f.call('updateProfile', { name: '新昵称' }, 'bob');
  const feed = (await f.call('mealFeed', { spaceId, mealLikesVersion: 1 })).data.posts[0];
  assert.equal(feed.likeUsers.length, 2);
  assert.ok(feed.likeUsers.some(user => user.name === '新昵称' && !user.self));
  assert.ok(feed.likeUsers.every(user => Object.keys(user).sort().join() === 'key,name,self'));
  const diary = (await f.call('myMealPosts', { spaceId, mealLikesVersion: 1 })).data.posts.find(post => post.id === postId);
  assert.deepEqual(diary.likeUsers, feed.likeUsers, 'diary and discovery resolve the same current liker names');
  assert.equal(diary.likeCount, feed.likeCount);
  assert.equal('likeUsers' in (await f.call('mealFeed', { spaceId })).data.posts[0], false);
  const off = await f.call('setMealLike', { spaceId: other, postId, selected: false, mealLikesVersion: 1 }, 'bob');
  assert.equal(off.data.post.likeUsers.length, 1);
  const diaryAfterCancel = (await f.call('myMealPosts', { spaceId, mealLikesVersion: 1 })).data.posts.find(post => post.id === postId);
  assert.equal(diaryAfterCancel.likeUsers.length, 1);
  assert.equal(diaryAfterCancel.likeCount, 1);
  await f.call('setMealVisibility', { spaceId, postId, visibility: 'private' });
  const privateDiary = (await f.call('myMealPosts', { spaceId, mealLikesVersion: 1 })).data.posts.find(post => post.id === postId);
  assert.equal(privateDiary.likeUsers.length, 1, 'making a record private preserves existing likes in its diary');
  assert.equal((await f.call('mealFeed', { spaceId: other, mealLikesVersion: 1 }, 'bob')).data.posts.length, 0);
  assert.equal((await f.call('setMealLike', { spaceId: other, postId, selected: true, mealLikesVersion: 1 }, 'bob')).ok, false);
});

test('compact likes commit before acknowledgement and survive fresh feed and diary reads', async () => {
  const f = fixture(); const spaceId = await f.enter('alice');
  const published = await f.actual(spaceId, { visibility: 'public' });
  const postId = published.data.post.id;
  for (const selected of [true, true, false, false]) {
    const result = await f.call('setMealLike', { spaceId, postId, selected, mealReactionVersion: 1, mealLikesVersion: 1 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { reaction: { id: postId, liked: selected, likeCount: Number(selected) }, mealReactionVersion: 1 });
    for (const action of ['mealFeed', 'myMealPosts']) {
      const read = await f.call(action, { spaceId, mealLikesVersion: 1 });
      assert.equal(read.data.posts[0].liked, selected);
      assert.equal(read.data.posts[0].likeUsers.length, Number(selected));
    }
  }
});
