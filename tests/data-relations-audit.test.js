import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditDataRelations } from '../scripts/audit-data-relations.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const entity = (familyId, value) => ({ _id: hash(`${familyId}:${value.id}`), familyId, value });
const fixture = () => ({ completeCollections: ['users', 'families', 'recipes', 'meal_sets', 'orders', 'meal_posts', 'media'], collections: {
  users: [{ _id: 'u1', name: 'private-name', avatar: '', familyId: 'f1', familyIds: ['f1'] }],
  families: [{ _id: 'f1', id: 'f1', ownerId: 'u1', name: 'private-family', members: [{ id: 'u1', name: 'private-name', avatar: '', membershipId: 'm1' }] }],
  recipes: [entity('f1', { id: 'r1' })], meal_sets: [entity('f1', { id: 's1', recipeIds: ['r1'] })],
  orders: [], meal_posts: [], media: [],
} });
test('offline audit accepts canonical IDs and leaves its input unchanged', () => {
  const source = fixture(), before = structuredClone(source);
  const report = auditDataRelations(source);
  assert.equal(report.summary.byLevel.error, 0);
  assert.equal(report.summary.byLevel.warning, 0);
  assert.deepEqual(source, before);
  assert.equal(report.readOnly, true);
});
test('same names never join unrelated identities or spaces', () => {
  const source = fixture();
  source.collections.users.push({ _id: 'u2', name: 'private-name' });
  source.collections.meal_sets[0].value.recipeIds = ['r2'];
  source.collections.recipes.push(entity('other-space', { id: 'r2' }));
  const report = auditDataRelations(source);
  assert.equal(report.summary.byCode.MEAL_SET_RECIPE_UNRESOLVED, 1);
});
test('partial exports do not claim absent references are database corruption', () => {
  const source = { meal_sets: [entity('f1', { id: 's1', recipeIds: ['r1'] })] };
  const result = auditDataRelations(source);
  assert.equal(result.summary.byLevel.error, 0);
  assert.ok(result.summary.byLevel.unverified > 0);
});
test('membership and profile disagreements are detected without leaking names or tokens', () => {
  const source = fixture();
  source.collections.families[0].members[0].name = 'stale-private-name';
  source.collections.users[0].familyId = 'missing-private-id';
  source.collections.users[0].familyIds = [];
  source.collections.shares = [{ _id: 'secret-token', familyId: 'f1', post: { title: 'secret-title' } }];
  const report = auditDataRelations(source), output = JSON.stringify(report);
  assert.equal(report.summary.byCode.MEMBER_PROFILE_DIFFERS, 1);
  assert.equal(report.summary.byCode.FAMILY_MEMBERSHIP_DISAGREES, 1);
  for (const sensitive of ['private-name', 'private-family', 'missing-private-id', 'secret-token', 'secret-title']) assert.equal(output.includes(sensitive), false);
});
test('historical order snapshots remain valid after recipe removal', () => {
  const source = fixture();
  source.collections.orders = [entity('f1', { id: 'o1', status: 'completed', items: [{ recipe: { id: 'removed-recipe', title: 'old meal' } }] })];
  assert.equal(auditDataRelations(source).summary.byLevel.error, 0);
});
test('invalid visibility, cross-post comments and incorrect meal-photo ownership are found', () => {
  const source = fixture();
  source.collections.meal_posts = [{ _id: 'p1', id: 'p1', spaceId: 'f1', authorId: 'u1', status: 'published', visibility: 'unknown', assetIds: [] }];
  source.collections.comments = [{ _id: 'c1', postId: 'post1' }, { _id: 'c2', postId: 'post2', parentId: 'c1' }];
  source.collections.media = [{ _id: 'media1', confirmed: true, mealPostId: 'p1', mealPostOwnerId: 'u2', familyId: 'f1', fileId: 'cloud://secret-photo' }];
  const report = auditDataRelations(source);
  assert.equal(report.summary.byCode.MEAL_VISIBILITY_INVALID, 1);
  assert.equal(report.summary.byCode.COMMENT_PARENT_CROSSES_POST, 1);
  assert.equal(report.summary.byCode.MEAL_MEDIA_OWNER_DISAGREES, 1);
  assert.equal(JSON.stringify(report).includes('cloud://'), false);
});
test('legacy missing membership generations and dish sources are not hard errors', () => {
  const source = fixture(); delete source.collections.families[0].members[0].membershipId;
  source.collections.meal_posts = [{ _id: 'p1', id: 'p1', spaceId: 'f1', authorId: 'u1', status: 'published', visibility: 'public', dishes: [{ title: 'snapshot' }] }];
  const report = auditDataRelations(source);
  assert.equal(report.summary.byLevel.error, 0);
  assert.equal(report.summary.byCode.MEMBERSHIP_GENERATION_MISSING, 1);
  assert.equal(report.summary.byCode.MEAL_DISH_SOURCE_REFERENCE_MISSING, 1);
});
test('an absent collection cannot be declared a complete empty collection', () => {
  assert.throws(() => auditDataRelations({ collections: {}, completeCollections: ['users'] }));
});
