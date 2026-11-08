import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { completedMealPlan } from '../scripts/backfill-completed-meals.mjs';
import { mealPostView } from '../server/meal-posts.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
function fixture() {
  return { families: [{ id: 'space', name: '小屋', cover: 'cloud://cover', members: [{ id: 'member', name: '甲', avatar: 'cloud://avatar' }] }], meal_posts: [], orders: [{ _id: hash('space:order'), familyId: 'space', value: { id: 'order', status: 'completed', date: '2026-11-05', meal: '晚餐', memberId: 'member', completedAt: '2026-11-05T11:30:00.000Z', note: 'private note', items: [{ recipe: { title: '白菜', image: 'cloud://dish', ingredients: ['private'] } }] } }] };
}
test('legacy completion produces a deterministic public snapshot at its original date without private order data', () => {
  const snapshot = fixture(), before = structuredClone(snapshot);
  const plan = completedMealPlan(snapshot), post = plan.posts[0];
  assert.equal(plan.completed, 1); assert.equal(plan.posts.length, 1);
  assert.match(post.id, /^meal-[a-f0-9]{64}$/);
  assert.equal(post.createdAt, Date.parse(snapshot.orders[0].value.completedAt));
  assert.equal(post.authorId, 'member'); assert.equal(post.author.name, '小屋');
  assert.equal(post.kind, 'plan'); assert.equal(post.visibility, 'public');
  assert.deepEqual(post.assetIds, ['cloud://dish', 'cloud://cover']);
  assert.equal(JSON.stringify(post).includes('private'), false);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(completedMealPlan(snapshot), plan);
  const publicView = mealPostView(post, null, 'visitor');
  assert.equal(publicView.authorId, undefined); assert.equal(publicView.sourceOrderId, undefined);
  assert.equal(mealPostView(post, null, 'member').sourceOrderId, 'order');
  assert.equal(completedMealPlan({ ...snapshot, meal_posts: [post] }).posts.length, 0);
});
test('uncompleted, private, deleted, already-linked, missing owner and invalid completion records are never republished', () => {
  for (const change of [
    s => { s.orders[0].value.status = 'accepted'; },
    s => { s.orders[0].value.status = 'cancelled'; },
    s => { s.orders[0].value.visibility = 'private'; },
    s => { s.orders[0].value.mealPostId = 'deleted-id'; },
    s => { s.meal_posts.push({ spaceId: 'space', orderId: 'order', visibility: 'private' }); },
    s => { s.meal_posts.push({ spaceId: 'space', authorId: 'member', status: 'deleted' }); },
    s => { s.families = []; },
    s => { s.families[0].members = []; },
    s => { s.orders[0].value.completedAt = ''; },
    s => { s.orders[0].value.items = []; },
    s => { s.orders[0]._id = 'mismatched'; },
  ]) {
    const snapshot = fixture(); change(snapshot);
    assert.equal(completedMealPlan(snapshot).posts.length, 0);
  }
});
test('personal authors use member identity and only cloud or HTTPS images are accepted', () => {
  const snapshot = fixture(); snapshot.families[0].kind = 'personal';
  snapshot.orders[0].value.items[0].recipe.image = 'file:///private/photo';
  const post = completedMealPlan(snapshot).posts[0];
  assert.equal(post.author.name, '甲'); assert.equal(post.author.mode, 'personal');
  assert.deepEqual(post.images, []); assert.deepEqual(post.assetIds, ['cloud://avatar']);
});

test('legacy late-night meals retain their original slot and are also eligible', () => {
  const snapshot = fixture(); snapshot.orders[0].value.meal = '宵夜';
  assert.equal(completedMealPlan(snapshot).posts[0].meal, '宵夜');
});
