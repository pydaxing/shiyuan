import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { recipeFieldErrors, validateRecipe, validateSnapshot } from '../src/domain/kitchen.js';
import { DEFAULT_DISH_COVER, DEFAULT_SET_COVER, hasRecipeCover } from '../src/domain/presentation.js';
import { normalizeCommand, normalizeImportedRecipe } from '../server/validation.mjs';

const recipe = () => ({ ...structuredClone(createSeed().recipes[0]), steps: [{ title: '煮熟', text: '小火煮熟。' }] });
test('new recipe cover must be an image, never a display fallback', () => {
  for (const image of [undefined, null, '', '   ', DEFAULT_DISH_COVER, DEFAULT_SET_COVER, 'not-an-image']) {
    assert.equal(hasRecipeCover(image), false);
    assert.equal(recipeFieldErrors({ ...recipe(), image }, { requireCover: true }).image, '请先添加菜品封面图');
    assert.throws(() => normalizeCommand('saveRecipe', [{ ...recipe(), image }]), /封面图/);
    assert.throws(() => normalizeCommand('saveRecipe', [{ ...recipe(), image }, 'existing-recipe']), /封面图/);
  }
});
test('image cover validation cannot be bypassed by client options', () => {
  assert.throws(() => normalizeCommand('saveRecipe', [{ ...recipe(), image: '', requireCover: false }]), /封面图/);
  for (const image of ['/static/tomato-eggs.png', 'cloud://test-env/recipes/cover.jpg']) {
    assert.equal(hasRecipeCover(image), true);
    assert.equal(normalizeCommand('saveRecipe', [{ ...recipe(), image }])[0].image, image);
  }
});
test('legacy image-less recipes and archived orders remain readable', () => {
  const oldRecipe = { ...recipe(), image: '' };
  assert.doesNotThrow(() => validateRecipe(oldRecipe));
  assert.doesNotThrow(() => normalizeImportedRecipe(oldRecipe));
  const snapshot = createSeed();
  snapshot.recipes[0].image = '';
  assert.doesNotThrow(() => validateSnapshot(snapshot));
});
