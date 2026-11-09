import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMealAutoArchive, captureOrderDiaryParticipants, automaticMealId, legacyCompletedMealId } from '../server/meal-auto-archive.mjs';
import { createApplication } from '../server/application.mjs';
import { mealPostMedia } from '../src/domain/meal-post-media.js';
import { memoryRepository } from './helpers/memory-repository.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const uid = name => hash(name);
const familyId = 'archive-family';
const chinaMidnight = Date.parse('2026-11-08T00:00:00+08:00');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

async function fixture() {
  const repository = memoryRepository();
  let time = chinaMidnight;
  const now = () => time;
  const family = { id: familyId, name: '一起吃饭', ownerId: uid('alice'), revision: 0, members: ['alice', 'bob'].map(name => ({ id: uid(name), name })) };
  for (const name of ['alice', 'bob', 'carol']) await repository.set('users', uid(name), { id: uid(name), name, familyId: name === 'carol' ? '' : familyId, familyIds: name === 'carol' ? [] : [familyId], activeMode: 'family' });
  await repository.set('families', familyId, family);
  const service = createMealAutoArchive({ repository, now });
  const errors = [];
  const app = createApplication({ repository, now, signFiles: async () => ({}), storeImage: async id => id, readImage: async () => ({ base64: 'cGhvdG8=', contentType: 'image/jpeg' }), onError: error => errors.push(error.stack) });
  async function order(patch = {}, snapshot = true, spaceId = familyId) {
    const source = await repository.get('families', spaceId);
    const base = { id: 'dinner', memberId: uid('alice'), memberName: 'alice', status: 'accepted', date: '2026-11-07', meal: '晚餐', items: [{ recipe: { id: 'tomato', title: '番茄炒蛋', image: '/static/tomato.png' }, quantity: 1 }], ...patch };
    const value = snapshot ? captureOrderDiaryParticipants(base, source, now() - 3600000) : base;
    await repository.set('orders', hash(`${spaceId}:${value.id}`), { familyId: spaceId, value });
    return value;
  }
  async function personal(name) {
    const id = `personal-${uid(name)}`;
    await repository.set('families', id, { id, name: `${name}的个人厨房`, kind: 'personal', ownerId: uid(name), revision: 0, members: [{ id: uid(name), name }] });
    const user = await repository.get('users', uid(name));
    await repository.set('users', uid(name), { ...user, personalSpaceId: id, activeMode: 'personal' });
    return id;
  }
  return { repository, family, service, order, personal, now, errors, setTime: value => { time = value; }, call: (action, payload, who = 'alice') => app({ action, ...payload }, { OPENID: who }) };
}

test('automatic diary rollover uses China midnight and excludes future, cancelled and empty arrangements', async () => {
  const f = await fixture();
  await f.order();
  await f.order({ id: 'today', date: '2026-11-08' });
  await f.order({ id: 'tomorrow', date: '2026-11-09' });
  await f.order({ id: 'cancelled', status: 'cancelled' });
  await f.order({ id: 'empty', items: [] });
  await f.order({ id: 'bad-date', date: '2026-02-31' });
  f.setTime(chinaMidnight - 1);
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 0);
  f.setTime(chinaMidnight);
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 1);
  const posts = await f.repository.list('meal_posts');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, automaticMealId(familyId, 'dinner'));
  assert.equal(posts[0].visibility, 'public');
  assert.deepEqual(posts[0].participantUserIds.sort(), [uid('alice'), uid('bob')].sort());
  const storedOrder = await f.repository.get('orders', hash(`${familyId}:dinner`));
  assert.equal(storedOrder.value.status, 'accepted', 'archive must not forge a manual opening');
});

test('timer and two user diary reconciliations create one canonical meal transactionally', async () => {
  const f = await fixture();
  await f.order();
  const outcomes = await Promise.all([f.service.runScheduled(), f.service.archiveForUser(uid('alice'), familyId), f.service.archiveForUser(uid('bob'), familyId)]);
  assert.equal(outcomes.reduce((sum, item) => sum + item.created, 0), 1);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 0);
});

test('personal diary reconciliation also archives genuine family spaces and never a forged family ID', async () => {
  const f = await fixture();
  await f.order();
  const personalId = await f.personal('alice');
  await f.order({ id: 'solo' }, true, personalId);
  const user = await f.repository.get('users', uid('alice'));
  await f.repository.set('users', uid('alice'), { ...user, familyIds: [familyId, 'foreign'] });
  await f.repository.set('families', 'foreign', { id: 'foreign', revision: 0, members: [{ id: uid('carol') }] });
  await f.order({ id: 'foreign-meal', memberId: uid('carol') }, true, 'foreign');
  const result = await f.service.archiveForUser(uid('alice'), personalId);
  assert.equal(result.created, 2);
  const posts = await f.repository.list('meal_posts');
  assert.equal(posts.find(post => post.spaceId === personalId).visibility, 'public');
  assert.deepEqual(posts.find(post => post.spaceId === personalId).participantUserIds, [uid('alice')]);
  assert.equal(posts.some(post => post.spaceId === 'foreign'), false);
  await assert.rejects(f.service.archiveForUser(uid('alice'), familyId), { code: 'CONFLICT' });
});

test('a later family member sees the family archive without receiving false personal history', async () => {
  const f = await fixture();
  await f.order();
  await f.repository.set('families', familyId, { ...f.family, members: [...f.family.members, { id: uid('carol'), name: 'carol' }], revision: 1 });
  await f.service.archiveForUser(uid('alice'), familyId);
  const post = (await f.repository.list('meal_posts'))[0];
  assert.equal(post.participantUserIds.includes(uid('carol')), false);
  const personalId = await f.personal('carol');
  const user = await f.repository.get('users', uid('carol'));
  await f.repository.set('users', uid('carol'), { ...user, familyId, familyIds: [familyId] });
  assert.deepEqual(ok(await f.call('myMealPosts', { spaceId: personalId, mealSharingVersion: 2 }, 'carol')).posts, []);
});

test('legacy arrangements infer only proven selectors, not all current members', async () => {
  const f = await fixture();
  await f.order({}, false);
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 1);
  const post = (await f.repository.list('meal_posts'))[0];
  assert.deepEqual(post.participantUserIds, [uid('alice')]);
});

test('source pointers, existing posts, canonical tombstones and source deletion markers are never recreated', async () => {
  const f = await fixture();
  const existingId = `meal-${hash('manual')}`;
  await f.repository.set('meal_posts', existingId, { id: existingId, spaceId: familyId, orderId: 'manual', kind: 'plan', status: 'published', visibility: 'private' });
  await f.order({ id: 'manual' });
  await f.order({ id: 'pointer', mealPostId: `meal-${hash('gone')}` });
  await f.order({ id: 'deleted', diaryDeletedAt: f.now() });
  await f.order({ id: 'tombstone' });
  await f.repository.set('meal_posts', automaticMealId(familyId, 'tombstone'), { id: automaticMealId(familyId, 'tombstone'), spaceId: familyId, status: 'deleted' });
  const result = await f.service.archiveForUser(uid('alice'), familyId);
  assert.equal(result.created, 0);
  assert.deepEqual(new Set(result.suppressedOrderIds), new Set(['pointer', 'deleted', 'tombstone']));
  assert.equal((await f.repository.list('meal_posts')).length, 2);
});

test('the exact legacy backfill ID identifies a minimal old tombstone without hiding other arrangements', async () => {
  const f = await fixture();
  await f.order({ id: 'old', status: 'completed' }, false);
  const id = legacyCompletedMealId(familyId, 'old');
  await f.repository.set('meal_posts', id, { id, spaceId: familyId, authorId: uid('alice'), kind: 'plan', status: 'deleted', deletedAt: f.now() - 100 });
  await f.order({ id: 'other' }, false);
  const result = await f.service.archiveForUser(uid('alice'), familyId);
  assert.equal(result.created, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(result.suppressedOrderIds, ['old']);
  assert.equal((await f.repository.get('meal_posts', id)).status, 'deleted');
});

test('unresolvable legacy tombstones retain an incomplete reconciliation instead of inventing a new meal', async () => {
  const f = await fixture();
  await f.order({}, false);
  await f.repository.set('meal_posts', `meal-${hash('unresolvable')}`, { id: `meal-${hash('unresolvable')}`, spaceId: familyId, kind: 'plan', status: 'deleted', deletedAt: f.now() });
  const result = await f.service.archiveForUser(uid('alice'), familyId);
  assert.equal(result.created, 0);
  assert.equal(result.complete, false);
  assert.equal(result.skipped.legacy_history_ambiguous, 1);
});

test('new completed arrangements also archive; historical explicit private intent stays unchanged', async () => {
  const f = await fixture();
  await f.order({ id: 'completed', status: 'completed' });
  await f.order({ id: 'legacy-private', status: 'completed', visibility: 'private' }, false);
  const result = await f.service.archiveForUser(uid('alice'), familyId);
  assert.equal(result.created, 1);
  assert.equal(result.skipped.legacy_private, 1);
  assert.equal(result.complete, false);
});

test('automatic public default never changes existing public, family or private posts', async () => {
  const f = await fixture();
  const before = [];
  for (const visibility of ['public', 'family', 'private']) {
    const id = `meal-${hash(`chosen-${visibility}`)}`;
    await f.order({ id: visibility });
    await f.repository.set('meal_posts', id, { id, spaceId: familyId, orderId: visibility, kind: 'plan', status: 'published', visibility, createdAt: f.now() - 3600000, moodIds: ['comfort'] });
    before.push(await f.repository.get('meal_posts', id));
  }
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 0);
  assert.equal((await f.service.runScheduled()).created, 0);
  for (const post of before) assert.deepEqual(await f.repository.get('meal_posts', post.id), post);
});

test('explicit private choices on old personal and family arrangements are not made public', async () => {
  const f = await fixture();
  await f.order({ id: 'old-family', visibility: 'family' }, false);
  await f.order({ id: 'old-private', visibility: 'private' }, false);
  await f.order({ id: 'old-unlisted', public: false }, false);
  const personalId = await f.personal('alice');
  await f.order({ id: 'old-solo', visibility: 'private' }, false, personalId);
  const result = await f.service.archiveForUser(uid('alice'), personalId);
  assert.equal(result.created, 0);
  assert.equal(result.skipped.legacy_private, 4);
  assert.deepEqual(await f.repository.list('meal_posts'), []);
});

test('timer pagination checkpoints finish more than one page without duplicate records', async () => {
  const f = await fixture();
  for (let i = 0; i < 105; i += 1) await f.order({ id: `meal-${i}` });
  const first = await f.service.runScheduled({ limit: 100 });
  const second = await f.service.runScheduled({ limit: 100 });
  assert.equal(first.scanned, 100);
  assert.equal(first.complete, false);
  assert.equal(second.scanned, 5);
  assert.equal(second.complete, true);
  assert.equal(first.created + second.created, 105);
  assert.equal((await f.service.runScheduled({ limit: 100 })).created, 0);
});

test('a failed archive write rolls the whole meal back and the next retry succeeds', async () => {
  const f = await fixture();
  await f.order();
  let fail = true;
  const repository = { ...f.repository, transaction: callback => f.repository.transaction(db => callback({ ...db, set: async (collection, id, value) => { if (collection === 'orders' && fail) { fail = false; throw new Error('write failed'); } return db.set(collection, id, value); } })) };
  const service = createMealAutoArchive({ repository, now: f.now });
  await assert.rejects(service.archiveOrder(familyId, 'dinner'), /write failed/);
  assert.equal((await f.repository.list('meal_posts')).length, 0);
  assert.equal((await service.archiveOrder(familyId, 'dinner')).created, true);
});

test('managed diary reads automatically reconcile public records with the same identity in discovery and each diary', async () => {
  const f = await fixture();
  await f.order();
  const result = ok(await f.call('myMealPosts', { spaceId: familyId, mealSharingVersion: 2, diaryManagementVersion: 1 }));
  assert.equal(result.diaryArchiveComplete, true);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].visibility, 'public');
  assert.deepEqual(ok(await f.call('mealFeed', { spaceId: familyId })).posts.map(post => post.id), result.posts.map(post => post.id));
  const bobPersonal = await f.personal('bob');
  assert.deepEqual(ok(await f.call('myMealPosts', { spaceId: bobPersonal, mealSharingVersion: 2, diaryManagementVersion: 1 }, 'bob')).posts.map(post => post.id), result.posts.map(post => post.id));
});

test('automatic public archives reuse dish provenance, recipe details and scoped image authorization', async () => {
  const f = await fixture();
  const viewerSpace = await f.personal('carol');
  const cover = 'cloud://env/archive-community-cover';
  const customCover = 'cloud://env/archive-custom-cover';
  const stepImage = 'cloud://env/archive-published-step';
  const privateStep = 'cloud://env/archive-private-step';
  const community = { id: 'community-rice', title: '米饭', image: cover, identityVersion: 2, recipeOrigin: 'community', communityRecipeId: 'community-rice', category: '主食', minutes: 20, servings: 2, ingredients: [{ name: '米', quantity: 1, unit: '碗' }], steps: [{ title: '蒸煮', text: '蒸熟', images: [stepImage, privateStep] }] };
  const custom = { ...community, id: 'custom-rice', title: '自家米饭', image: customCover, recipeOrigin: 'custom', forkedFromRecipeId: community.id };
  const textOnly = { ...community, id: 'legacy-text', title: '旧菜品', image: '' };
  for (const fileId of [cover, customCover, stepImage, privateStep]) await f.repository.set('media', hash(fileId), { fileId, familyId, userId: uid('alice'), confirmed: true });
  await f.repository.set('posts', 'public-rice', { id: 'public-rice', status: 'published', familyId: 'recipe-source', recipes: [community], assetIds: [cover, stepImage] });
  await f.order({ items: [community, custom, textOnly].map(recipe => ({ recipe, quantity: 1 })) });
  assert.equal((await f.service.runScheduled()).created, 1);
  const post = ok(await f.call('mealFeed', { spaceId: viewerSpace }, 'carol')).posts[0];
  assert.equal(post.kind, 'plan');
  assert.equal(post.visibility, 'public');
  assert.deepEqual(post.dishes.map(dish => dish.sourceKind), ['community', 'custom', 'community']);
  assert.deepEqual(mealPostMedia(post).map(({ sourceLabel, canOpenRecipe, image }) => ({ sourceLabel, canOpenRecipe, image })), [
    { sourceLabel: '美食', canOpenRecipe: true, image: cover },
    { sourceLabel: '自建', canOpenRecipe: false, image: customCover },
    { sourceLabel: '美食', canOpenRecipe: false, image: '' },
  ]);
  const recipe = ok(await f.call('mealDishDetail', { postId: post.id, dishIndex: 0 }, 'carol')).recipe;
  assert.equal(recipe.id, community.id);
  assert.equal(recipe.image, cover);
  assert.deepEqual(recipe.ingredients, community.ingredients);
  assert.deepEqual(recipe.steps[0].images, [stepImage]);
  for (const fileId of [cover, customCover, stepImage]) {
    assert.equal(ok(await f.call('mediaContent', { fileId, variant: 'original' }, 'carol')).contentType, 'image/jpeg');
    const batch = ok(await f.call('mediaBatch', { images: [{ fileId, variant: 'detail' }] }, 'carol'));
    assert.equal(batch.images[0].ok, true);
  }
  assert.equal((await f.call('mediaContent', { fileId: privateStep, variant: 'original' }, 'carol')).code, 'FORBIDDEN', JSON.stringify(f.errors));
  assert.equal(JSON.stringify(post).includes(uid('alice')), false, 'the public projection must not leak participant IDs');
});

test('legacy midnight snack and completed orders keep their source meal identity while archiving', async () => {
  const f = await fixture();
  await f.order({ meal: '宵夜', status: 'completed' }, false);
  assert.equal((await f.service.archiveForUser(uid('alice'), familyId)).created, 1);
  const post = (await f.repository.list('meal_posts'))[0];
  assert.equal(post.meal, '宵夜', 'legacy source matching must remain exact');
  assert.equal(post.visibility, 'public');
});

test('member removal committed during the scan prevents a stale diary read from archiving that family', async () => {
  const f = await fixture();
  await f.order();
  let interrupted = false;
  const repository = { ...f.repository, list: async (collection, where, options) => {
    const rows = await f.repository.list(collection, where, options);
    if (collection === 'orders' && !interrupted) {
      interrupted = true;
      await f.repository.transaction(async db => {
        const family = await db.get('families', familyId);
        await db.set('families', familyId, { ...family, members: family.members.filter(member => member.id !== uid('alice')), revision: 1 });
      });
    }
    return rows;
  } };
  const result = await createMealAutoArchive({ repository, now: f.now }).archiveForUser(uid('alice'), familyId);
  assert.equal(result.complete, false);
  assert.equal(result.created, 0);
  assert.equal((await f.repository.list('meal_posts')).length, 0);
});

test('a cancellation committed before the archive transaction is excluded even if the scan saw an accepted order', async () => {
  const f = await fixture();
  await f.order();
  let interrupted = false;
  const repository = { ...f.repository, list: async (collection, where, options) => {
    const rows = await f.repository.list(collection, where, options);
    if (collection === 'orders' && !interrupted) {
      interrupted = true;
      await f.repository.transaction(async db => {
        const row = await db.get('orders', hash(`${familyId}:dinner`));
        await db.set('orders', hash(`${familyId}:dinner`), { ...row, value: { ...row.value, status: 'cancelled' } });
      });
    }
    return rows;
  } };
  assert.equal((await createMealAutoArchive({ repository, now: f.now }).archiveForUser(uid('alice'), familyId)).created, 0);
  assert.equal((await f.repository.list('meal_posts')).length, 0);
});

test('server command snapshots all authenticated family IDs and ignores client participant injection', async () => {
  const f = await fixture();
  const recipe = { id: 'rice', title: '米饭', image: '/static/rice.png', category: '主食', minutes: 15, servings: 2, ingredients: [{ name: '米', quantity: 1, unit: '碗' }], steps: [{ title: '蒸熟', text: '蒸熟米饭' }] };
  await f.repository.set('recipes', hash(`${familyId}:rice`), { familyId, value: recipe });
  const event = { name: 'submitOrder', requestId: 'archive-order-snapshot', familyId, revision: 0, responseMode: 'changes', args: [{ rice: 1 }, { date: '2026-11-08', meal: '午餐' }, ''], diaryParticipantUserIds: [uid('carol')] };
  ok(await f.call('command', event));
  const order = (await f.repository.list('orders'))[0].value;
  assert.equal(order.diaryParticipantsVersion, 1);
  assert.deepEqual(order.diaryParticipantUserIds.sort(), [uid('alice'), uid('bob')].sort());
  assert.equal(order.diaryParticipantUserIds.includes(uid('carol')), false);
  assert.equal(order.diaryParticipantsCapturedAt, f.now());
  f.setTime(chinaMidnight + 86400000);
  const results = await Promise.all([f.service.archiveForUser(uid('alice'), familyId), f.service.archiveForUser(uid('bob'), familyId)]);
  assert.equal(results.reduce((sum, result) => sum + result.created, 0), 1);
});

test('timer releases its lease on failure and resumes from its last committed order', async () => {
  const f = await fixture();
  await f.order({ id: 'first' });
  await f.order({ id: 'second' });
  let attempts = 0;
  const repository = { ...f.repository, transaction: callback => f.repository.transaction(db => callback({ ...db, set: async (collection, id, value) => {
    if (collection === 'meal_posts' && ++attempts === 2) throw new Error('temporary database error');
    return db.set(collection, id, value);
  } })) };
  const service = createMealAutoArchive({ repository, now: f.now });
  await assert.rejects(service.runScheduled(), /temporary database error/);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
  const retry = await service.runScheduled();
  assert.equal(retry.created, 1);
  assert.equal(retry.complete, true);
  assert.equal((await f.repository.list('meal_posts')).length, 2);
});

test('all lazy diary spaces share a ten-second budget and the timer completes the remaining meals', async () => {
  const f = await fixture();
  const personalId = await f.personal('alice');
  await f.order({ id: 'solo' }, true, personalId);
  await f.order({ id: 'family-one' });
  await f.order({ id: 'family-two' });
  let elapsed = 0;
  const repository = { ...f.repository, transaction: callback => f.repository.transaction(async db => {
    const result = await callback(db);
    if (result?.created) elapsed += 11000;
    return result;
  }) };
  const service = createMealAutoArchive({ repository, now: f.now, clock: () => elapsed });
  const partial = await service.archiveForUser(uid('alice'), personalId);
  assert.equal(partial.created, 1);
  assert.equal(partial.complete, false);
  assert.equal(partial.skipped.budget_exceeded > 0, true);
  assert.equal((await f.repository.list('meal_posts')).length, 1);
  assert.equal(await f.repository.get('requests', hash(`meal-auto-space-v1:${familyId}`)), null, 'a partial family scan must not be checkpointed as complete');
  const completed = await service.runScheduled();
  assert.equal(completed.created, 2);
  assert.equal(completed.complete, true);
  assert.equal((await f.repository.list('meal_posts')).length, 3);
  assert.equal((await service.archiveForUser(uid('alice'), personalId)).created, 0);
});

test('automatic archive retains recipe details independently of the arrangement', async () => {
  const f = await fixture();
  const order = await f.order({ items: [{ recipe: { id: 'tomato', title: '番茄炒蛋', image: '/static/tomato.png', ingredients: [{ name: '番茄' }], steps: [{ text: '炒熟' }] }, quantity: 1 }] });
  await f.service.archiveForUser(uid('alice'), familyId);
  await f.repository.remove('orders', hash(`${familyId}:${order.id}`));
  const postId = automaticMealId(familyId, order.id);
  const detail = ok(await f.call('mealDishDetail', { postId, dishIndex: 0 }));
  assert.equal(detail.recipe.steps[0].text, '炒熟');
});
