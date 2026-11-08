import test from 'node:test';
import assert from 'node:assert/strict';
import { SELECTABLE_UNITS, STOCK_LOCATIONS } from '../src/domain/kitchen.js';
import { COMMON_INGREDIENTS, ingredientSuggestions } from '../src/domain/ingredient-catalog.js';

test('common ingredients provide valid defaults without requiring a custom form', () => {
  assert.ok(COMMON_INGREDIENTS.length >= 1000);
  for (const entry of COMMON_INGREDIENTS) {
    assert.ok(entry.name);
    assert.ok(SELECTABLE_UNITS.includes(entry.unit), entry.name);
    assert.ok(STOCK_LOCATIONS.includes(entry.location), entry.name);
  }
  const suggestions = ingredientSuggestions();
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.some(entry => entry.name === '番茄'));
  assert.ok(suggestions.some(entry => entry.name === '鸡蛋'));
});

test('search finds canonical names and aliases without duplicating choices', () => {
  assert.equal(ingredientSuggestions('西红柿')[0].name, '番茄');
  assert.equal(ingredientSuggestions('马铃薯')[0].name, '土豆');
  assert.equal(ingredientSuggestions('青葱')[0].name, '小葱');
  assert.deepEqual(ingredientSuggestions('不存在的冷门食材'), []);
});

test('family recipes and inventory prioritize familiar ingredients without mutating sources', () => {
  const source = {
    recipes: [{ ingredients: [{ name: '牛肉' }, { name: '牛肉' }] }],
    inventory: [{ name: '牛肉' }, { name: '番茄' }],
  };
  const before = structuredClone(source);
  const suggestions = ingredientSuggestions('', source);
  assert.equal(suggestions[0].name, '牛肉');
  assert.deepEqual(source, before);
  const entry = suggestions[0];
  assert.notEqual(entry, COMMON_INGREDIENTS.find(item => item.name === '牛肉'));
});

test('aliases prioritize familiar ingredients without equating distinct cuts or seasonings', () => {
  assert.equal(ingredientSuggestions('', { inventory: [{ name: '西红柿' }, { name: '西红柿' }] })[0].name, '番茄');
  assert.equal(ingredientSuggestions('鸡肉')[0].name, '鸡肉');
  assert.equal(ingredientSuggestions('酱油')[0].name, '酱油');
  assert.ok(!ingredientSuggestions('酱油').some(item => item.name === '生抽'));
});

test('every common ingredient has a valid quantity and a bundled small image, including aliases', async () => {
  const { stat } = await import('node:fs/promises');
  const { ingredientImage, validateImage } = await import('../src/domain/presentation.js');
  const { ingredientFieldErrors } = await import('../src/domain/kitchen.js');
  let total = 0; const images = new Set();
  for (const entry of COMMON_INGREDIENTS) {
    assert.deepEqual(ingredientFieldErrors(entry), {});
    assert.equal(ingredientImage(entry.name), entry.image);
    for (const alias of entry.aliases) assert.equal(ingredientImage(alias), entry.image);
    assert.doesNotThrow(() => validateImage(entry.image));
    const file = await stat(new URL(`../src${entry.image}`, import.meta.url));
    assert.ok(file.size < 20000, `${entry.name} must remain a thumbnail`);
    if (!images.has(entry.image)) total += file.size;
    images.add(entry.image);
  }
  assert.ok(total < 350000);
});
