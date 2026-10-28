import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_PUBLISHER_ID, OFFICIAL_PUBLISHER_NAME, isOfficialPost, communityPublisherName, canDeleteCommunityPost, editableCommunityEntry } from '../src/domain/community-policy.js';
import { planOfficialPublishers, officialPublisherFields } from '../scripts/migrate-official-publishers.mjs';
import { applyTitleFields } from '../scripts/rename-community-recipes.mjs';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot } from '../src/domain/kitchen.js';

test('only the actual member publisher can delete, never official or ownerless posts', () => {
  for (const post of [undefined, {}, { publisherId: '' }, { publisherId: 'other' }, { publisherId: 'me', publisherType: 'official' }, { publisherId: OFFICIAL_PUBLISHER_ID }]) {
    assert.equal(canDeleteCommunityPost(post, 'me', 'home'), false);
  }
  assert.equal(canDeleteCommunityPost({ publisherId: undefined }, undefined), false);
  assert.equal(canDeleteCommunityPost({ publisherId: OFFICIAL_PUBLISHER_ID }, OFFICIAL_PUBLISHER_ID), false);
  assert.equal(canDeleteCommunityPost({ publisherId: 'me', familyId: 'home' }, 'me', 'home'), true);
  assert.equal(canDeleteCommunityPost({ publisherId: 'me', publisherType: 'user', familyId: 'home' }, 'me', 'home'), true);
  assert.equal(isOfficialPost({ author: OFFICIAL_PUBLISHER_NAME, publisherId: 'me' }), false);
  assert.equal(communityPublisherName({ publisherType: 'official' }), OFFICIAL_PUBLISHER_NAME);
  assert.equal(communityPublisherName({ author: '原作者', publisherType: 'official' }), '原作者');
  assert.equal(communityPublisherName({ author: '我家' }), '我家');
});

test('domain actions cannot delete or overwrite official or ownerless shares', () => {
  for (const publisher of [{ publisherType: 'official' }, { publisherId: OFFICIAL_PUBLISHER_ID }, { publisherId: undefined }]) {
    let state = normalizeSnapshot(createSeed());
    const actions = createKitchenActions({ getState: () => state, commit: value => { state = value; }, newId: prefix => `${prefix}-${state.posts.length}` });
    const dishId = state.recipes[0].id;
    const postId = actions.publishToCommunity(dishId);
    Object.assign(state.posts[0], publisher);
    if (state.posts[0].publisherId === undefined) delete state.posts[0].publisherId;
    const before = structuredClone(state);
    assert.throws(() => actions.deleteCommunityPost(postId), /只能删除自己/);
    assert.deepEqual(state, before);
    assert.throws(() => actions.publishToCommunity(dishId), error => error.code === 'ALREADY_SHARED');
    assert.deepEqual(state, before);
  }
});

test('detail editing only opens an owned share linked to a still-present dish or set in the active family', () => {
  const state = { family: { id: 'home', name: '我家' }, activeMemberId: 'me', recipes: [{ id: 'dish', title: '我家菜品' }], mealSets: [{ id: 'set', title: '我家套餐' }] };
  for (const [kind, familyItemId, expectedKind] of [['dish', 'dish', 'dish'], ['menu', 'set', 'set']]) {
    const post = { publisherId: 'me', familyId: 'home', kind, familyItemId };
    const before = structuredClone(state);
    const entry = editableCommunityEntry(post, state);
    assert.equal(entry.id, familyItemId);
    assert.equal(entry.kind, expectedKind);
    for (const override of [{ familyId: 'other' }, { familyId: undefined }, { publisherId: 'other' }, { publisherType: 'official' }, { familyItemId: 'deleted' }, { familyItemId: undefined }, { kind: 'unknown' }]) assert.equal(editableCommunityEntry({ ...post, ...override }, state), null);
    assert.equal(editableCommunityEntry(post, { ...state, activeMemberId: 'other-member' }), null);
    assert.equal(editableCommunityEntry(post, { ...state, recipes: [], mealSets: [] }), null);
    assert.deepEqual(state, before);
  }
  assert.equal(editableCommunityEntry(null, state), null);
  assert.equal(editableCommunityEntry({}, undefined), null);
});

function migrationFixture() {
  const sourceUrl = 'https://www.xiachufang.com/recipe/1234/';
  const post = { _id: 'post-1', id: 'post-1', familyId: 'family-1', status: 'published', kind: 'dish', author: '我家', publisherId: 'owner', card: { id: 'post-1', author: '我家', publisherId: 'owner', title: '凉拌黄瓜' }, recipes: [{ provenance: { url: sourceUrl, attribution: '原作者' }, steps: ['拌匀'] }], importedFamilyCount: 3, assetIds: ['cloud://photo'] };
  const receipt = { familyId: 'family-1', recipes: { [sourceUrl]: { postId: 'post-1', stage: 'published_verified' } } };
  return { post, receipt };
}

test('official migration targets exact receipted IDs and changes only publisher metadata', () => {
  const { post, receipt } = migrationFixture();
  const personal = { ...post, _id: 'personal', id: 'personal' };
  const before = structuredClone(post);
  const plan = planOfficialPublishers([post, personal], receipt);
  assert.equal(plan.updates.length, 1);
  const update = plan.updates[0];
  assert.equal(update.q._id, post.id);
  assert.equal(update.q.publisherId, 'owner');
  assert.equal(update.q['recipes.0.provenance.url'], post.recipes[0].provenance.url);
  assert.deepEqual(update.q.publisherType, { $exists: false });
  assert.deepEqual(update.u.$set, { ...officialPublisherFields, author: '原作者', 'card.author': '原作者' });
  assert.equal(update.multi, false);
  assert.equal(update.upsert, false);
  const after = applyTitleFields(post, update.u.$set);
  assert.deepEqual(after.recipes, before.recipes);
  assert.deepEqual(after.assetIds, before.assetIds);
  assert.equal(after.importedFamilyCount, 3);
  assert.deepEqual(planOfficialPublishers([after, personal], receipt).updates, []);
  assert.deepEqual(post, before);
});

test('migration never resurrects deleted posts or promotes mismatched/unknown records', () => {
  const { post, receipt } = migrationFixture();
  const deleted = planOfficialPublishers([{ ...post, status: 'deleted' }], receipt);
  assert.deepEqual(deleted.skippedDeleted, [post.id]);
  assert.equal(deleted.updates.length, 0);
  for (const changed of [{ familyId: 'other' }, { status: 'pending' }, { recipes: [{ provenance: { url: 'different' } }] }, { card: {} }]) {
    assert.throws(() => planOfficialPublishers([{ ...post, ...changed }], receipt));
  }
  assert.throws(() => planOfficialPublishers([], receipt));
  assert.throws(() => planOfficialPublishers([post], { ...receipt, recipes: { ...receipt.recipes, duplicate: Object.values(receipt.recipes)[0] } }));
});


test('same-name families and reused member IDs never confer share ownership', () => {
  const post = { id: 'post', author: '我家', familyId: 'home-a', publisherId: 'me' };
  assert.equal(canDeleteCommunityPost(post, 'me', 'home-a'), true);
  for (const familyId of ['home-b', '', undefined]) assert.equal(canDeleteCommunityPost(post, 'me', familyId), false);
  assert.equal(canDeleteCommunityPost({ ...post, familyId: undefined }, 'me', 'home-a'), false);
});
