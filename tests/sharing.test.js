import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { portableShare } from '../src/services/sharing.js';
import { parseShare } from '../src/domain/sharing.js';

test('share export removes UI-only fields and includes only the selected recipe', async () => {
  const recipes = createSeed().recipes;
  const item = { ...recipes[0], recipes, key: 'tomato', kind: 'dish' };
  const exported = parseShare(await portableShare(item, recipes, '我', 'dish', {}));
  assert.equal(exported.recipes.length, 1);
  assert.equal(exported.recipes[0].recipes, undefined);
  assert.equal(exported.recipes[0].key, undefined);
  assert.equal(exported.recipes[0].sourceId, undefined);
});
test('native local photos become portable embedded images in covers and steps', async () => {
  const recipe = { ...createSeed().recipes[0], image: 'wxfile://usr/cover.jpg', steps: [{ title: '切菜', image: 'wxfile://usr/step.png' }] };
  const platform = { getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: 'YWJj' }) }) };
  const exported = parseShare(await portableShare(recipe, [recipe], '我', 'dish', platform));
  assert.equal(exported.image, 'data:image/jpeg;base64,YWJj');
  assert.equal(exported.recipes[0].steps[0].image, 'data:image/png;base64,YWJj');
});
test('unreadable native images fail instead of sharing broken local paths', async () => {
  const recipe = { ...createSeed().recipes[0], image: 'wxfile://usr/missing.jpg' };
  const platform = { getFileSystemManager: () => ({ readFile: ({ fail }) => fail() }) };
  await assert.rejects(portableShare(recipe, [recipe], '我', 'dish', platform), /图片读取失败/);
});
test('oversized embedded images fail before producing an unimportable share', async () => {
  const recipe = { ...createSeed().recipes[0], image: 'wxfile://usr/large.jpg' };
  const platform = { getFileSystemManager: () => ({ readFile: ({ success }) => success({ data: 'A'.repeat(500000) }) }) };
  await assert.rejects(portableShare(recipe, [recipe], '我', 'dish', platform), /图片无效/);
});

test('optional recipe guide survives share export without becoming a cooking step', async () => {
  const recipe = { ...createSeed().recipes[0], guideImage: '/static/guide.png' };
  const exported = parseShare(await portableShare(recipe, [recipe], '我', 'dish', {}));
  assert.equal(exported.recipes[0].guideImage, recipe.guideImage);
  assert.deepEqual(exported.recipes[0].steps, recipe.steps);
  assert.throws(() => parseShare(JSON.stringify({ ...exported, recipes: [{ ...exported.recipes[0], guideImage: { image: 'bad' } }] })), /图片/);
});
