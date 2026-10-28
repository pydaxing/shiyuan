import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { archiveAuthorizedRecipe } from '../scripts/archive-authorized-recipe.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'recipe-archive-'));
  try {
    const sourceUrl = 'https://www.xiachufang.com/recipe/106695285/';
    const imageUrl = 'https://i2.chuimg.com/photo.jpg';
    const imagePath = path.join(root, 'image.jpg');
    await writeFile(imagePath, await sharp({ create: { width: 2, height: 3, channels: 3, background: '#abccba' } }).jpeg().toBuffer());
    await writeFile(path.join(root, 'queue.json'), JSON.stringify({ authorizationId: 'test-auth', entries: [{ sourceUrl, authorizationId: 'test-auth', publishedPostId: null }] }));
    const raw = { sourceUrl, title: '测试菜', author: '原作者', authorizationId: 'test-auth', fetchedAt: new Date().toISOString(), cover: { url: imageUrl }, ingredients: [{ name: '菜', amountText: '适量' }], steps: [{ text: '原文步骤', images: [{ url: imageUrl }] }] };
    await run({ root, raw, bundle: { assets: [{ url: imageUrl, path: imagePath, contentType: 'image/jpeg' }], failures: [] } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('archive preserves source quantities and deduplicates actual image bytes', async () => fixture(async ({ root, raw, bundle }) => {
  const result = await archiveAuthorizedRecipe(root, raw, bundle);
  assert.equal(result.fullContentCollected, true);
  assert.equal(result.imageRefs.length, 2);
  assert.equal(Object.keys(result.assets).length, 1);
  assert.equal(result.assets[raw.cover.url].width, 2);
  assert.equal(result.assets[raw.cover.url].height, 3);
  assert.match(result.assets[raw.cover.url].sha256, /^[a-f0-9]{64}$/);
  const saved = JSON.parse(await readFile(path.join(root, 'recipes/106695285/source.json'), 'utf8'));
  assert.deepEqual(saved.ingredients, raw.ingredients);
  assert.equal(JSON.parse(await readFile(path.join(root, 'queue.json'), 'utf8')).entries[0].status, 'collected_pending_review');
}));

test('missing and corrupted images cannot be marked complete', async () => fixture(async ({ root, raw, bundle }) => {
  assert.equal((await archiveAuthorizedRecipe(root, raw, { assets: [], failures: [] })).fullContentCollected, false);
  await writeFile(bundle.assets[0].path, '<html>challenge</html>');
  const result = await archiveAuthorizedRecipe(root, raw, bundle);
  assert.equal(result.fullContentCollected, false);
  assert.equal(result.failures.length, 1);
}));

test('pure videos remain incomplete and unrelated authorization is rejected', async () => fixture(async ({ root, raw, bundle }) => {
  const result = await archiveAuthorizedRecipe(root, { ...raw, ingredients: [], steps: [], videos: ['https://www.xiachufang.com/vod_video/1/'] }, bundle);
  assert.equal(result.fullContentCollected, false);
  assert.equal(result.structureIssues.length, 2);
  await assert.rejects(archiveAuthorizedRecipe(root, { ...raw, authorizationId: 'another' }, bundle), /授权记录/);
  await assert.rejects(archiveAuthorizedRecipe(root, { ...raw, sourceUrl: 'https://www.xiachufang.com/recipe/123456/' }, bundle), /来源不在/);
}));

test('re-archiving does not erase a publication receipt', async () => fixture(async ({ root, raw, bundle }) => {
  const file = path.join(root, 'queue.json');
  const queue = JSON.parse(await readFile(file, 'utf8'));
  queue.entries[0].publishedPostId = 'published-id';
  await writeFile(file, JSON.stringify(queue));
  await archiveAuthorizedRecipe(root, raw, bundle);
  const entry = JSON.parse(await readFile(file, 'utf8')).entries[0];
  assert.equal(entry.status, 'published');
  assert.equal(entry.publishedPostId, 'published-id');
}));

test('unstructured video pages are not duplicates merely because both have empty steps', async () => fixture(async ({ root, raw, bundle }) => {
  const empty = { ...raw, ingredients: [], steps: [], videos: ['https://www.xiachufang.com/vod_video/1/'] };
  await archiveAuthorizedRecipe(root, empty, bundle);
  const queuePath = path.join(root, 'queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const sourceUrl = 'https://www.xiachufang.com/recipe/123456/';
  queue.entries.push({ sourceUrl, authorizationId: 'test-auth' });
  await writeFile(queuePath, JSON.stringify(queue));
  const second = await archiveAuthorizedRecipe(root, { ...empty, sourceUrl, title: '不同的视频菜谱' }, bundle);
  assert.equal(second.duplicateOf, null);
  assert.equal(JSON.parse(await readFile(queuePath, 'utf8')).entries[1].status, 'source_missing_structure');
}));
