import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { mealDiaryRelationId } from '../server/meal-diary-management.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
const today = '2026-11-05';
function fixture() {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => Date.parse(`${today}T08:00:00Z`), signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async id => id, readImage: async () => ({ base64: 'AAAA', contentType: 'image/jpeg' }), onError: error => { if (!error.code) throw error; } });
  const call = (action, values = {}, who = 'alice') => app({ action, ...values }, { OPENID: who });
  const family = async () => ok(await call('createFamily', { name: 'Alice', familyName: '一起吃饭' })).familyId;
  const join = async who => {
    const invitation = ok(await call('prepareInvite'));
    return ok(await call('joinFamily', { name: who, token: invitation.token }, who));
  };
  const personal = async who => {
    ok(await call('updateProfile', { name: who }, who));
    return ok(await call('switchWorkspace', { mode: 'personal' }, who)).familyId;
  };
  let sequence = 0;
  const publish = async (spaceId, patch = {}, who = 'alice') => {
    const n = ++sequence, image = `cloud://env/diary-photo-${n}`;
    await repository.set('media', hash(image), { fileId: image, confirmed: true, mealPhoto: true, familyId: spaceId, userId: hash(who) });
    return ok(await call('publishMeal', { spaceId, requestId: `diary-management-${n}`, kind: 'actual', date: today, meal: '晚餐', images: [image], visibility: 'family', mealSharingVersion: 2, ...patch }, who)).post;
  };
  const diary = async (spaceId, who = 'alice', patch = {}) => ok(await call('myMealPosts', { spaceId, mealSharingVersion: 2, diaryManagementVersion: 1, ...patch }, who));
  const remove = async (spaceId, postId, who = 'alice', patch = {}) => call('deleteMealPost', { spaceId, postId, diaryManagementVersion: 1, ...patch }, who);
  const visibility = async (spaceId, postId, value, who = 'alice') => call('setMealVisibility', { spaceId, postId, visibility: value, diaryManagementVersion: 1 }, who);
  return { repository, call, family, join, personal, publish, diary, remove, visibility };
}

test('family diary grants every current member menu actions without changing old protocol ownership', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = await f.publish(spaceId);
  const result = await f.diary(spaceId, 'bob');
  assert.equal(result.diaryManagementVersion, 1);
  assert.equal(result.posts[0].isOwner, false);
  assert.deepEqual([result.posts[0].canDelete, result.posts[0].canChangeVisibility, result.posts[0].deleteScope], [true, true, 'shared']);
  const legacy = await f.diary(spaceId, 'bob', { diaryManagementVersion: undefined });
  assert.equal(legacy.diaryManagementVersion, undefined);
  assert.equal(legacy.posts[0].canDelete, undefined);
  assert.equal((await f.call('deleteMealPost', { spaceId, postId: post.id }, 'bob')).code, 'FORBIDDEN');
});

test('personal deletion of authored family meal persists only own diary exclusion', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = await f.publish(spaceId, { visibility: 'public' });
  const alicePersonal = await f.personal('alice');
  const relationKey = mealDiaryRelationId(post.id, hash('alice'));
  await f.repository.set('meal_reactions', relationKey, { postId: post.id, userId: hash('alice'), liked: true, tags: ['good'] });
  assert.equal((await f.diary(alicePersonal)).posts[0].deleteScope, 'personal');
  assert.equal(ok(await f.remove(alicePersonal, post.id)).deleteScope, 'personal');
  assert.deepEqual((await f.diary(alicePersonal)).posts, []);
  assert.deepEqual((await f.diary(alicePersonal, 'alice', { diaryManagementVersion: undefined })).posts, [], 'personal hide survives older v2 client reads');
  assert.equal((await f.repository.get('meal_posts', post.id)).status, 'published');
  const hidden = await f.repository.get('meal_reactions', relationKey);
  assert.ok(hidden.diaryHiddenAt);
  assert.equal(hidden.liked, true);
  assert.deepEqual(hidden.tags, ['good']);
  assert.equal(ok(await f.call('mealFeed', { spaceId: alicePersonal })).posts[0].id, post.id, 'hiding own diary must not remove discovery');
  assert.equal((await f.diary(spaceId, 'bob')).posts[0].id, post.id);
  assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, 'bob')).ok, true, 'hiding a personal reference keeps shared photos readable');
  const bobPersonal = await f.personal('bob');
  assert.equal((await f.diary(bobPersonal, 'bob')).posts[0].id, post.id);
  ok(await f.remove(alicePersonal, post.id));
  assert.equal((await f.repository.get('meal_reactions', relationKey)).diaryHiddenAt, hidden.diaryHiddenAt);
  ok(await f.call('switchWorkspace', { mode: 'family' }));
  assert.equal((await f.diary(spaceId)).posts[0].id, post.id, 'own family view remains visible after a personal hide');
});

test('family deletion by another member removes canonical meal from all diaries and public feed', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const post = await f.publish(spaceId, { visibility: 'public' });
  const result = ok(await f.remove(spaceId, post.id, 'bob'));
  assert.equal(result.deleteScope, 'shared');
  const stored = await f.repository.get('meal_posts', post.id);
  assert.equal(stored.status, 'deleted');
  assert.equal(stored.authorId, hash('alice'), 'deleting member must not replace original author ID');
  assert.equal(stored.deletedByUserId, hash('bob'));
  assert.deepEqual(new Set(stored.participantUserIds), new Set([hash('alice'), hash('bob')]));
  assert.deepEqual((await f.diary(spaceId)).posts, []);
  assert.deepEqual(ok(await f.call('mealFeed', { spaceId })).posts, []);
  for (const user of ['alice', 'bob']) assert.equal((await f.call('mediaContent', { fileId: post.images[0] }, user)).code, 'FORBIDDEN');
  for (const user of ['alice', 'bob']) {
    const personal = await f.personal(user);
    assert.deepEqual((await f.diary(personal, user)).posts, []);
  }
  assert.equal(ok(await f.remove(`personal-${hash('bob')}`, post.id, 'bob')).deleteScope, 'personal');
});

test('own personal meal deletion is canonical rather than an exclusion', async () => {
  const f = fixture();
  const spaceId = await f.personal('alice');
  const post = await f.publish(spaceId, { visibility: 'private' });
  assert.equal((await f.diary(spaceId)).posts[0].deleteScope, 'own');
  assert.equal(ok(await f.remove(spaceId, post.id)).deleteScope, 'own');
  assert.equal((await f.repository.get('meal_posts', post.id)).status, 'deleted');
  assert.equal(await f.repository.get('meal_reactions', mealDiaryRelationId(post.id, hash('alice'))), null);
});

test('deletion retains order suppression while preserving completed arrangement state', async () => {
  const f = fixture(), spaceId = await f.family();
  await f.join('bob');
  const orderId = 'my-order', orderKey = hash(`${spaceId}:${orderId}`);
  await f.repository.set('orders', orderKey, { familyId: spaceId, value: { id: orderId, date: today, meal: '晚餐', memberId: hash('alice'), memberName: 'Alice', status: 'accepted', items: [{ quantity: 1, recipe: { id: 'rice', title: '米饭', category: '主食', image: '/static/food.png', ingredients: [], steps: [] } }] } });
  const post = ok(await f.call('finishMeal', { spaceId, orderId, kind: 'plan', requestId: 'finish-diary-order-1', visibility: 'family', mealSharingVersion: 2 })).post;
  const result = ok(await f.remove(spaceId, post.id, 'bob'));
  assert.deepEqual(result.suppressedOrderIds, [orderId]);
  const tombstone = await f.repository.get('meal_posts', post.id);
  assert.equal(tombstone.orderId, orderId);
  const order = (await f.repository.get('orders', orderKey)).value;
  assert.equal(order.status, 'completed');
  assert.equal(order.mealPostId, post.id);
  assert.ok(order.diaryDeletedAt);
  assert.equal(tombstone.images, undefined, 'deleted meal assets no longer grant access');
  assert.deepEqual(ok(await f.remove(spaceId, post.id, 'bob')).suppressedOrderIds, [orderId]);
});

test('personal deletion of a family order never suppresses unrelated local order with same ID', async () => {
  const f = fixture(), familyId = await f.family();
  const post = await f.publish(familyId);
  const source = await f.repository.get('meal_posts', post.id);
  await f.repository.set('meal_posts', post.id, { ...source, orderId: 'same-id' });
  const personal = await f.personal('alice');
  const result = ok(await f.remove(personal, post.id));
  assert.equal(result.suppressedOrderIds, undefined);
  assert.equal((await f.repository.get('meal_posts', post.id)).status, 'published');
});

test('current family member can change canonical visibility from either diary while former member can only hide', async () => {
  const f = fixture(), familyId = await f.family();
  await f.join('bob');
  const post = await f.publish(familyId);
  const publicPost = ok(await f.visibility(familyId, post.id, 'public', 'bob')).post;
  assert.equal(publicPost.visibility, 'public');
  assert.equal(publicPost.canChangeVisibility, true);
  const personal = await f.personal('bob');
  const familyPost = ok(await f.visibility(personal, post.id, 'family', 'bob')).post;
  assert.equal(familyPost.deleteScope, 'personal');
  assert.equal(familyPost.canChangeVisibility, true);
  assert.equal((await f.visibility(personal, post.id, 'private', 'bob')).ok, false, 'new clients cannot cut out the family with author-private mode');
  ok(await f.call('leaveFamily', { familyId, expectedCurrentFamilyId: personal }, 'bob'));
  const archive = (await f.diary(personal, 'bob')).posts[0];
  assert.deepEqual([archive.canDelete, archive.canChangeVisibility, archive.deleteScope], [true, false, 'personal']);
  assert.equal((await f.visibility(personal, post.id, 'public', 'bob')).code, 'FORBIDDEN');
  ok(await f.remove(personal, post.id, 'bob'));
  assert.equal((await f.diary(familyId)).posts[0].id, post.id);
});

test('outsiders and unrelated active workspaces cannot manage guessed public meal IDs', async () => {
  const f = fixture(), familyId = await f.family();
  const post = await f.publish(familyId, { visibility: 'public' });
  const outsider = await f.personal('stranger');
  assert.equal((await f.remove(outsider, post.id, 'stranger')).code, 'FORBIDDEN');
  assert.equal((await f.visibility(outsider, post.id, 'family', 'stranger')).code, 'FORBIDDEN');
  assert.equal((await f.remove(familyId, post.id, 'stranger')).code, 'CONFLICT');
  assert.equal((await f.remove(familyId, post.id, 'alice', { diaryManagementVersion: 9 })).ok, false);
});

test('hidden diary pagination does not lose visible meals behind more than one page of exclusions', async () => {
  const f = fixture(), familyId = await f.family();
  await f.join('bob');
  const personal = await f.personal('bob');
  const visible = [];
  for (let n = 0; n < 80; n += 1) {
    const id = `meal-${n.toString(16).padStart(64, '0')}`;
    await f.repository.set('meal_posts', id, { id, spaceId: familyId, authorId: hash('alice'), kind: 'actual', images: [], status: 'published', visibility: 'family', createdAt: 1000000 - n, date: today, meal: '晚餐', mealSharingVersion: 2, mealContext: 'family', participantUserIds: [hash('alice'), hash('bob')], author: { name: 'Alice', avatar: '' } });
    if (n < 39 || n % 4 === 0) await f.repository.set('meal_reactions', mealDiaryRelationId(id, hash('bob')), { postId: id, userId: hash('bob'), diaryHiddenAt: 1 });
    else visible.push(id);
  }
  const seen = [];
  let cursor;
  do {
    const page = await f.diary(personal, 'bob', { cursor });
    seen.push(...page.posts.map(post => post.id));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(seen, visible);
  assert.equal(new Set(seen).size, seen.length);
});

test('legacy global delete also writes order tombstone metadata but remains author-only', async () => {
  const f = fixture(), familyId = await f.family();
  const post = await f.publish(familyId, { mealSharingVersion: undefined, visibility: 'public' });
  const source = await f.repository.get('meal_posts', post.id);
  await f.repository.set('meal_posts', post.id, { ...source, orderId: 'legacy-order' });
  await f.repository.set('orders', hash(`${familyId}:legacy-order`), { familyId, value: { id: 'legacy-order', status: 'accepted' } });
  const result = ok(await f.call('deleteMealPost', { spaceId: familyId, postId: post.id }));
  assert.equal(result.deleteScope, undefined);
  assert.equal((await f.repository.get('meal_posts', post.id)).orderId, 'legacy-order');
  assert.ok((await f.repository.get('orders', hash(`${familyId}:legacy-order`))).value.diaryDeletedAt);
});

async function previousArrangement(f, familyId) {
  const id = 'yesterday-shared-meal';
  const value = { id, date: '2026-11-04', meal: '晚餐', status: 'accepted', memberId: hash('alice'), memberName: 'Alice', diaryParticipantsVersion: 1, diaryParticipantUserIds: [hash('alice'), hash('bob')], items: [{ quantity: 1, recipe: { id: 'rice', title: '米饭', category: '主食', image: '/static/food.png', minutes: 10, servings: 2, ingredients: [{ name: '大米', quantity: 1, unit: '碗' }], steps: [{ title: '煮饭', text: '煮熟' }] } }] };
  await f.repository.set('orders', hash(`${familyId}:${id}`), { familyId, value });
  return id;
}

test('automatic shared diary deletion stays removed through repeated archival and every participant diary', async () => {
  const f = fixture(), familyId = await f.family();
  await f.join('bob');
  const orderId = await previousArrangement(f, familyId);
  const page = await f.diary(familyId);
  assert.equal(page.diaryArchiveComplete, true);
  assert.equal(page.diaryArchiveVersion, 1);
  assert.equal(page.posts.length, 1);
  const post = page.posts[0];
  assert.equal(post.visibility, 'public');
  assert.equal(post.sourceOrderId, orderId);
  assert.equal(post.deleteScope, 'shared');
  ok(await f.remove(familyId, post.id, 'bob'));
  const after = await f.diary(familyId);
  assert.deepEqual(after.posts, []);
  assert.deepEqual(after.suppressedOrderIds, [orderId]);
  for (const user of ['alice', 'bob']) {
    const personal = await f.personal(user);
    assert.deepEqual((await f.diary(personal, user)).posts, []);
  }
  assert.equal((await f.repository.get('meal_posts', post.id)).status, 'deleted');
  assert.equal((await f.repository.get('orders', hash(`${familyId}:${orderId}`))).value.status, 'accepted', 'automatic archival and diary deletion must not claim manual completion');
});

test('automatic shared diary personal hide survives archive reads without affecting the canonical meal', async () => {
  const f = fixture(), familyId = await f.family();
  await f.join('bob');
  await previousArrangement(f, familyId);
  const personal = await f.personal('bob');
  const page = await f.diary(personal, 'bob');
  assert.equal(page.posts.length, 1, 'opening personal diary also archives joined families');
  const post = page.posts[0];
  assert.equal(post.deleteScope, 'personal');
  assert.equal(post.sourceOrderId, undefined, 'family-local order IDs do not leak into a personal order fallback');
  ok(await f.remove(personal, post.id, 'bob'));
  assert.deepEqual((await f.diary(personal, 'bob')).posts, []);
  assert.equal((await f.diary(familyId)).posts[0].id, post.id);
  assert.equal((await f.repository.get('meal_posts', post.id)).status, 'published');
});
