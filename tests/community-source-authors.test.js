import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { communityPublisherName, canDeleteCommunityPost, OFFICIAL_PUBLISHER_ID } from '../src/domain/community-policy.js';
import { planSourceAuthors, verifySourceAuthorChanges } from '../scripts/migrate-community-source-authors.mjs';
import { applyTitleFields } from '../scripts/rename-community-recipes.mjs';

function fixture() {
  const sourceUrl = 'https://www.xiachufang.com/recipe/1234/';
  const post = { _id: 'post-1', id: 'post-1', familyId: 'family-1', kind: 'dish', status: 'published', author: '食愿小灶', publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official', card: { id: 'post-1', author: '食愿小灶', publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official' }, recipes: [{ title: '熊猫吐司', author: '我家厨房', provenance: { attribution: '小美好曾曾', url: sourceUrl, source: '下厨房', note: '原文', license: '授权' }, steps: [{ text: '制作', images: ['cloud://image'] }] }], importedFamilyCount: 12 };
  const receipt = { familyId: 'family-1', recipes: { [sourceUrl]: { postId: post.id, stage: 'published_verified' } } };
  return { post, receipt };
}

test('official detail uses original attribution and compact cards keep the migrated author', () => {
  const { post } = fixture();
  assert.equal(communityPublisherName(post), '小美好曾曾');
  assert.equal(communityPublisherName({ ...post.card, author: '小美好曾曾' }), '小美好曾曾');
  assert.equal(canDeleteCommunityPost(post, 'me'), false);
  assert.equal(canDeleteCommunityPost(post, OFFICIAL_PUBLISHER_ID), false);
  const personal = { ...post, publisherType: 'user', publisherId: 'me', author: '我家的分享' };
  assert.equal(communityPublisherName(personal), '我家的分享');
  assert.equal(canDeleteCommunityPost(personal, 'me', 'family-1'), true);
  assert.equal(communityPublisherName({ ...post, recipes: [{ provenance: { attribution: ' ' } }] }), '食愿小灶');
});

test('author migration updates only three name fields, preserves provenance and permissions, and is idempotent', () => {
  const { post, receipt } = fixture();
  const personal = { ...structuredClone(post), _id: 'user-post', id: 'user-post', author: '我家', publisherId: 'me', publisherType: 'user' };
  const before = structuredClone([post, personal]);
  const plan = planSourceAuthors(before, receipt);
  assert.equal(plan.updates.length, 1);
  const update = plan.updates[0];
  assert.deepEqual(update.u.$set, { author: '小美好曾曾', 'card.author': '小美好曾曾', 'recipes.0.author': '小美好曾曾' });
  assert.equal(update.q.publisherId, OFFICIAL_PUBLISHER_ID);
  assert.equal(update.q['recipes.0.provenance.attribution'], '小美好曾曾');
  assert.equal(update.upsert, false);
  assert.equal(update.multi, false);
  const after = [applyTitleFields(post, update.u.$set), personal];
  assert.doesNotThrow(() => verifySourceAuthorChanges(before, after, plan));
  assert.deepEqual(planSourceAuthors(after, receipt).updates, []);
  assert.deepEqual(before, [post, personal]);
  after[0].importedFamilyCount += 1;
  assert.throws(() => verifySourceAuthorChanges(before, after, plan), /作者之外/);
});

test('migration skips deleted posts and rejects missing attribution or untrusted ownership and receipts', () => {
  const { post, receipt } = fixture();
  assert.deepEqual(planSourceAuthors([{ ...post, status: 'deleted' }], receipt).skippedDeleted, [post.id]);
  for (const changed of [
    { publisherId: 'me' }, { familyId: 'other' }, { card: {} }, { status: 'pending' },
    { recipes: [{ provenance: { url: post.recipes[0].provenance.url } }] },
    { recipes: [{ provenance: { ...post.recipes[0].provenance, url: 'different' } }] },
  ]) assert.throws(() => planSourceAuthors([{ ...post, ...changed }], receipt));
  assert.throws(() => planSourceAuthors([post, { ...post, _id: 'unknown', id: 'unknown' }], receipt), /没有对应发布回执/);
  assert.throws(() => planSourceAuthors([], receipt));
  assert.throws(() => planSourceAuthors([post], { ...receipt, recipes: { ...receipt.recipes, duplicate: Object.values(receipt.recipes)[0] } }), /重复/);
});

test('recipe details no longer render the source module and public caches use updated namespaces', () => {
  const component = readFileSync(new URL('../src/components/RecipeContent.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /来源与改编|recipe-source|sourceOpen|copySource/);
  assert.match(component, /recipe\.steps/);
  assert.match(component, /recipe\.ingredients/);
  assert.match(readFileSync(new URL('../src/services/community-feed.js', import.meta.url), 'utf8'), /shiyuan-feed-v3/);
  assert.match(readFileSync(new URL('../src/services/cloud.js', import.meta.url), 'utf8'), /shiyuan-details-v3/);
});
