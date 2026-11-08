import test from 'node:test';
import assert from 'node:assert/strict';
import { mealPostMedia } from '../src/domain/meal-post-media.js';

test('planned meals keep every dish, without substituting stock images for missing covers', () => {
  const media = mealPostMedia({ kind: 'plan', images: ['cloud://shared'], dishes: [{ title: '汤', image: '' }, { title: '饭', image: 'cloud://shared' }, { title: '菜', image: 'cloud://shared' }] });
  assert.deepEqual(media.map(item => item.dishIndex), [0, 1, 2]);
  assert.equal(media[0].image, '');
  assert.equal(media[0].defaultCover, true);
  assert.equal(media[1].defaultCover, false);
  assert.equal(media[2].isDish, true);
});
test('actual photos never become recipe links even when dishes are attached', () => {
  assert.deepEqual(mealPostMedia({ kind: 'actual', images: ['photo-a', 'photo-b'], dishes: [{ title: '饭', image: 'photo-a', sourceKind: 'community' }] }), [{ image: 'photo-a', isDish: false, sourceLabel: '实拍' }, { image: 'photo-b', isDish: false, sourceLabel: '实拍' }]);
});
test('old image-only meals remain previewable without guessing a dish association', () => {
  assert.deepEqual(mealPostMedia({ kind: 'plan', images: ['old-photo'] }), [{ image: 'old-photo', isDish: false }]);
  assert.deepEqual(mealPostMedia({}), []);
});

test('dish badges use the server source enum for both images and name-only entries', () => {
  const result = mealPostMedia({ kind: 'plan', dishes: [
    { title: '同名菜', image: 'cloud://cover', sourceKind: 'community' },
    { title: '同名菜', image: 'cloud://cover', sourceKind: 'custom' },
    { title: '汤', image: '', sourceKind: 'community' },
    { title: '饭', image: '   ', sourceKind: 'custom' },
  ] });
  assert.deepEqual(result.map(item => item.sourceLabel), ['美食', '自建', '美食', '自建']);
  assert.deepEqual(result.map(item => item.dishIndex), [0, 1, 2, 3]);
  assert.deepEqual(result.map(item => item.defaultCover), [false, false, true, true]);
  assert.deepEqual(result.map(item => item.canOpenRecipe), [true, false, false, false]);
});

test('unknown legacy provenance is not guessed from recipe names, image addresses or ID prefixes', () => {
  const result = mealPostMedia({ kind: 'plan', dishes: [
    { title: '美食菜品', image: '/static/public-dish.png', recipeId: 'community-dish' },
    { title: '家庭自建', image: 'cloud://dish', sourceKind: 'unknown' },
    { title: '实拍', image: 'cloud://photo', sourceKind: 'actual' },
  ] });
  assert.deepEqual(result.map(item => item.sourceLabel), ['', '', '']);
  assert.ok(result.every(item => item.isDish));
  assert.ok(result.every(item => item.canOpenRecipe === false));
});
