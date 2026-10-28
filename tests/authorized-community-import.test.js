import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { prepareSource, assertSavedRecipe, uploadArchivedImage, sameRecipeMethod, materializePreparedSource } from '../scripts/import-authorized-community.mjs';
import { reviewedIngredientEntry } from '../scripts/reviewed-ingredient-imports.mjs';
import { cleanSteps } from '../src/domain/presentation.js';

const hash = value => createHash('sha256').update(value).digest('hex');
async function withSource(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'authorized-import-'));
  try {
    const directory = path.join(root, 'recipes/12345');
    await mkdir(directory, { recursive: true });
    const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#dcccab' } }).jpeg().toBuffer();
    const file = path.join(directory, 'photo.jpg');
    await writeFile(file, bytes);
    const image = { url: 'https://i2.chuimg.com/photo.jpg', alt: '测试图' };
    const raw = { source: '下厨房', sourceUrl: 'https://www.xiachufang.com/recipe/12345/', title: '测试菜', author: '作者', authorUrl: 'https://www.xiachufang.com/cook/12345/', fetchedAt: '2026-09-09T10:00:00Z', description: '', tips: '', sourceHtml: '<div>原文</div>', authorizationId: 'test-auth', cover: image, ingredients: [{ name: '面粉', amountText: '100克' }], steps: [{ text: '按步骤制作', images: [image] }] };
    const review = { sourceUrl: raw.sourceUrl, sourceHtmlFingerprint: hash(raw.sourceHtml), approved: true, reviewedAt: '2026-09-09T11:00:00Z', category: '主食', notes: '测试用逐项核对' };
    const manifest = { fullContentCollected: true, duplicateOf: null, assets: { [image.url]: { path: file, sha256: hash(bytes), width: 2, height: 3 } } };
    for (const [name, value] of Object.entries({ source: raw, review, manifest })) await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value));
    await writeFile(path.join(root, 'authorization.json'), JSON.stringify({ id: 'test-auth' }));
    await run({ root, directory, raw, file });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('offline import preparation verifies real images without network writes', async () => withSource(async ({ root, raw }) => {
  const result = await prepareSource(root, '12345');
  assert.equal(result.normalized.ready, true);
  assert.equal(result.files.size, 1);
  assert.equal(result.normalized.recipe.minutes, null);
  assert.equal(result.normalized.recipe.provenance.url, raw.sourceUrl);
  assert.match(result.assets[raw.cover.url].fileId, /^data:image\/jpeg;base64,/);
  assert.deepEqual(cleanSteps(result.normalized.recipe.steps), result.normalized.recipe.steps);
}));

test('altered image bytes and stale source review stop before any cloud call', async () => withSource(async ({ root, directory, raw, file }) => {
  const original = await readFile(file);
  await writeFile(file, 'corrupted');
  await assert.rejects(prepareSource(root, '12345'), /图片摘要/);
  await writeFile(file, original);
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({ ...raw, sourceHtml: '<div>改动</div>' }));
  await assert.rejects(prepareSource(root, '12345'));
}));

test('approved canonical amounts survive image rematerialization and never modify the original archive', async () => withSource(async ({ root, directory, raw }) => {
  const ingredients = [{ name: '面粉', quantity: 0.1, unit: 'kg' }];
  await writeFile(path.join(root, 'ingredient-standardization.json'), JSON.stringify({ version: 1, recipes: { [raw.sourceUrl]: reviewedIngredientEntry(raw, ingredients) } }));
  const prepared = await prepareSource(root, '12345');
  assert.deepEqual(prepared.normalized.recipe.ingredients, ingredients);
  const assets = Object.fromEntries(Object.entries(prepared.assets).map(([url, asset]) => [url, { ...asset, fileId: 'cloud://test-environment/approved-image' }]));
  const materialized = await materializePreparedSource(prepared, assets);
  assert.equal(materialized.publicPublishingAllowed, true);
  assert.deepEqual(materialized.recipe.ingredients, ingredients);
  assert.equal(materialized.recipe.image, 'cloud://test-environment/approved-image');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8')), raw);
}));

test('cloud readback equality covers source, every step and every image', () => {
  const recipe = { title: '菜', category: '主食', minutes: null, image: 'cloud://env/cover.jpg', ingredients: [{ name: '面粉', quantity: 100, unit: 'g' }], steps: [{ text: '步骤', images: ['cloud://env/step.jpg'] }], provenance: { source: '下厨房', url: 'https://www.xiachufang.com/recipe/12345/' } };
  assert.doesNotThrow(() => assertSavedRecipe({ ...recipe, id: 'saved' }, recipe));
  for (const key of ['title', 'category', 'minutes', 'image', 'ingredients', 'steps', 'provenance']) assert.throws(() => assertSavedRecipe({ ...recipe, [key]: undefined }, recipe));
});

test('large images use bounded IDE transfers and the normal cloud media API', async () => {
  const app = {};
  const base64 = Buffer.alloc(100000, 42).toString('base64');
  const calls = [];
  const cloud = { cloudStatus: { value: { familyId: 'family-test' } }, invokeCloud: async (action, args) => { calls.push({ action, base64: args.base64 }); return { fileId: 'cloud://env/image', protected: true }; } };
  const evaluate = async (source, args) => {
    assert.ok(JSON.stringify(args).length < 49000);
    return runInNewContext(`(${source})`, { require: () => cloud, getApp: () => app })(...args);
  };
  const result = await uploadArchivedImage(evaluate, { base64, uploadHash: hash(base64) }, 'family-test');
  assert.equal(result.fileId, 'cloud://env/image');
  assert.deepEqual(calls, [{ action: 'mediaUpload', base64 }]);
  assert.equal(Object.keys(app.__authorizedRecipeImages).length, 0);
  await assert.rejects(uploadArchivedImage(evaluate, { base64, uploadHash: hash(base64) }, 'other-family'), /家庭已变更/);
  assert.equal(calls.length, 1);
});

test('interleaved uploads retain independent buffers and exact image contents', async () => {
  const app = {};
  const received = [];
  const cloud = { cloudStatus: { value: { familyId: 'family-test' } }, invokeCloud: async (action, args) => { received.push(args.base64); return { fileId: 'cloud://env/image' }; } };
  const evaluate = async (source, args) => {
    await new Promise(resolve => setImmediate(resolve));
    return runInNewContext(`(${source})`, { require: () => cloud, getApp: () => app })(...args);
  };
  const contents = [Buffer.alloc(130000, 23).toString('base64'), Buffer.alloc(170000, 42).toString('base64')];
  await Promise.all(contents.map(base64 => uploadArchivedImage(evaluate, { base64, uploadHash: hash(base64) }, 'family-test')));
  assert.deepEqual(received.sort(), contents.sort());
  assert.equal(Object.keys(app.__authorizedRecipeImages).length, 0);
});

test('incomplete IDE transfers cannot upload partial images', async () => {
  const evaluate = async () => 1;
  await assert.rejects(uploadArchivedImage(evaluate, { base64: 'abcd', uploadHash: hash('abcd') }, 'family-test'), /图片分段传输不完整/);
});

test('cloud deduplication preserves same-title variants but rejects identical methods', () => {
  const recipe = { title: '番茄炒蛋', ingredients: [{ name: '鸡蛋', quantity: 2, unit: '个' }], steps: [{ text: '炒三分钟。' }] };
  assert.equal(sameRecipeMethod(recipe, { ...recipe, title: '家常炒蛋' }), true);
  assert.equal(sameRecipeMethod(recipe, { ...recipe, steps: [{ text: '蒸十分钟。' }] }), false);
  assert.equal(sameRecipeMethod(recipe, { ...recipe, ingredients: [{ name: '鸡蛋', quantity: 3, unit: '个' }] }), false);
  assert.equal(sameRecipeMethod({ ...recipe, steps: [{ text: '', images: ['first'] }] }, { ...recipe, steps: [{ text: '', images: ['second'] }] }), false);
});
