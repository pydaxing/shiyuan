import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { indexRecipeContent, recipeContentFingerprints, RECIPE_CONTENT_DEDUPE_VERSION } from '../scripts/recipe-content-dedupe.mjs';
import { reindexRecipeContent } from '../scripts/reindex-recipe-content.mjs';
import { prepareAuthorizedRecipeBatch } from '../scripts/prepare-authorized-recipe-batch.mjs';
import { archiveAuthorizedRecipe } from '../scripts/archive-authorized-recipe.mjs';

const sourceUrl = number => `https://www.xiachufang.com/recipe/${number}/`;
const saveJson = (file, value) => writeFile(file, JSON.stringify(value));
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const recipe = (number, overrides = {}) => ({
  sourceUrl: sourceUrl(number), title: '同名菜', author: '原作者', authorizationId: 'test-auth',
  cover: { url: 'https://i2.chuimg.com/test.jpg' },
  ingredients: [{ name: '土豆', amountText: '300克' }, { name: '盐', amountText: '2克' }],
  steps: [
    { text: '先将土豆清洗干净并削去外皮，切成大小均匀的块状，放入清水中浸泡10分钟，充分洗去表面淀粉后沥干。', images: [] },
    { text: '将土豆块放入干净的容器中，加入盐并用筷子仔细翻拌均匀，让每一块土豆的表面都均匀裹上调味料后备用。', images: [] },
    { text: '烤箱提前预热至180℃，将土豆均匀铺在烤盘上烘烤20分钟，中途翻面一次，待表面金黄后取出装盘食用。', images: [] },
  ], ...overrides,
});
const indexed = raws => indexRecipeContent(raws.map(raw => ({ sourceUrl: raw.sourceUrl, raw, fullContentCollected: true })));

async function temporaryRoot(context) {
  const root = await mkdtemp(path.join(tmpdir(), 'recipe-content-dedupe-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('same title with different methods stays; different titles with identical content merge', () => {
  const first = recipe(1);
  const otherMethod = recipe(2, { steps: [{ text: '放入蒸锅蒸熟，取出装盘', images: [] }] });
  const otherTitle = recipe(3, { title: '另一名字', cover: { url: 'different-image' } });
  const results = indexed([first, otherMethod, otherTitle]);
  assert.equal(results[1].duplicateOf, null);
  assert.equal(results[2].duplicateOf, first.sourceUrl);
  assert.equal(results[2].candidateEligible, false);
  assert.equal(results[2].duplicateReason, 'normalized_ingredients_and_steps_equal');
  assert.equal(results[2].dedupeVersion, RECIPE_CONTENT_DEDUPE_VERSION);
});

test('whitespace, fullwidth characters, simple punctuation and step labels normalize', () => {
  const first = recipe(1);
  const formatted = recipe(2, {
    ingredients: [{ amountText: ' ３００ 克 ', name: ' 土 豆 ' }, { name: '盐', amountText: '２ 克' }],
    steps: first.steps.map((step, index) => ({ text: `第 ${index + 1} 步：\n ${step.text.replaceAll('，', '；').replaceAll('。', '！')} `, images: [] })),
  });
  assert.equal(indexed([first, formatted])[1].duplicateOf, first.sourceUrl);
  for (const prefix of ['1. ', '１、', '步骤1：', 'Step 1: ', '(1)', '①', '一、']) {
    const numbered = recipe(2);
    numbered.steps[0].text = prefix + numbered.steps[0].text;
    assert.equal(indexed([first, numbered])[1].duplicateOf, first.sourceUrl, prefix);
  }
});

test('temperatures, durations, decimals, fractions, ranges and numeric separators never disappear', () => {
  for (const [firstText, secondText] of [['180℃烤20分钟', '190℃烤20分钟'], ['烤20分钟', '烤30分钟'], ['1.5克盐拌匀', '5克盐拌匀'], ['加.5克盐', '加5克盐'], ['加1/2勺', '加12勺'], ['烤10-15分钟', '烤1015分钟'], ['按1:2配比', '按12配比'], ['加1,000克', '加1000克'], ['加1 2克', '加12克'], ['加半勺', '加一勺']]) {
    const results = indexed([recipe(1, { steps: [{ text: firstText }] }), recipe(2, { steps: [{ text: secondText }] })]);
    assert.equal(results[1].duplicateOf, null, `${firstText} / ${secondText}`);
    assert.equal(results[1].suspectedDuplicateOf, null);
  }
  const changedAmount = recipe(2);
  changedAmount.ingredients[0].amountText = '301克';
  assert.equal(indexed([recipe(1), changedAmount])[1].duplicateOf, null);
  assert.equal(indexed([recipe(1), changedAmount])[1].suspectedDuplicateOf, null);
  assert.equal(indexed([recipe(1, { steps: [{ text: '步骤1 .5克盐拌匀' }] }), recipe(2, { steps: [{ text: '步骤1 5克盐拌匀' }] })])[1].duplicateOf, null);
});

test('only small seasoning differences with long identical steps produce review hints', () => {
  const changed = recipe(2);
  changed.ingredients[1].amountText = '2.2克';
  const result = indexed([recipe(1), changed])[1];
  assert.equal(result.duplicateOf, null);
  assert.equal(result.suspectedDuplicateOf, sourceUrl(1));
  assert.equal(result.requiresDuplicateReview, true);
  assert.equal(result.candidateEligible, true);
  changed.ingredients[1].amountText = '20克';
  assert.equal(indexed([recipe(1), changed])[1].suspectedDuplicateOf, null);
  const short = recipe(1, { steps: ['洗净', '切块', '炒熟'].map(text => ({ text })) });
  changed.steps = short.steps;
  changed.ingredients[1].amountText = '2.2克';
  assert.equal(indexed([short, changed])[1].suspectedDuplicateOf, null);
  assert.equal(indexed([short, changed])[1].duplicateOf, null);
  assert.equal(recipeContentFingerprints(recipe(1, { steps: [] })).textFingerprint, null);
  assert.equal(indexed([recipe(1, { steps: [] }), recipe(2, { steps: [] })])[1].duplicateOf, null);
});

test('prepare merges all three inputs by URL and preserves paused checkpoints byte-for-byte when unchanged', async context => {
  const root = await temporaryRoot(context);
  const folder = path.join(root, 'artifacts/recipe-full');
  const crawl = path.join(root, 'artifacts/recipe-crawl');
  await mkdir(folder, { recursive: true });
  await mkdir(crawl, { recursive: true });
  await saveJson(path.join(folder, 'authorization.json'), { id: 'test-auth', basis: 'user_confirmation_in_current_conversation', sourceWebsites: ['https://www.xiachufang.com/', 'https://home.meishichina.com/recipe.html'] });
  const link = number => ({ sourceUrl: sourceUrl(number), title: '同名菜' });
  await saveJson(path.join(crawl, 'source-links.json'), [link(1), link(2)]);
  await saveJson(path.join(crawl, 'duplicates.json'), [link(3), { ...link(2), sourceUrl: `${sourceUrl(2)}?ref=duplicate` }]);
  await saveJson(path.join(crawl, 'near-duplicates.json'), [link(4), { sourceUrl: 'https://home.meishichina.com/recipe-5.html', title: '同名菜' }, { sourceUrl: 'https://example.com/recipe/6/', title: '无授权' }]);
  const initial = await prepareAuthorizedRecipeBatch(root);
  assert.equal(initial.addedEntries, 5);
  assert.equal(initial.rejectedLinks, 1);
  const file = path.join(folder, 'queue.json');
  const paused = await readJson(file);
  assert.equal(paused.entries.every(entry => entry.status === 'pending_detail'), true);
  paused.state = 'paused_for_human_verification';
  paused.collectionPolicy = { databaseWrites: false };
  paused.pause = { reason: 'captcha', sourceUrl: sourceUrl(1) };
  paused.entries[0].status = 'published';
  paused.entries[0].publishedPostId = 'keep-receipt';
  await saveJson(file, paused);
  await saveJson(path.join(crawl, 'duplicates.json'), [link(6)]);
  assert.equal((await prepareAuthorizedRecipeBatch(root)).addedEntries, 1);
  const resumed = await readJson(file);
  assert.deepEqual(resumed.entries.slice(0, 5), paused.entries);
  for (const key of ['state', 'collectionPolicy', 'pause']) assert.deepEqual(resumed[key], paused[key]);
  const before = await readFile(file, 'utf8');
  assert.equal((await prepareAuthorizedRecipeBatch(root)).addedEntries, 0);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('offline reindex prefers published canonical, restores false duplicates, keeps source/images and is idempotent', async context => {
  const root = await temporaryRoot(context);
  const raws = [recipe(1), recipe(2), recipe(3, { steps: [{ text: '完全不同的蒸煮做法' }] })];
  const entries = [];
  const originals = [];
  for (const raw of raws) {
    const directory = path.join(root, 'recipes', new URL(raw.sourceUrl).pathname.split('/').filter(Boolean).at(-1));
    await mkdir(path.join(directory, 'images'), { recursive: true });
    await saveJson(path.join(directory, 'source.json'), raw);
    await writeFile(path.join(directory, 'images/original.jpg'), 'original-image-bytes');
    await saveJson(path.join(directory, 'manifest.json'), { sourceUrl: raw.sourceUrl, authorizationId: 'test-auth', archivedAt: '2026-09-01', fullContentCollected: true, assets: { untouched: true }, duplicateOf: sourceUrl(1), contentFingerprint: 'legacy', textFingerprint: 'legacy' });
    entries.push({ sourceUrl: raw.sourceUrl, authorizationId: 'test-auth', archiveDirectory: directory, status: 'duplicate_content' });
    for (const name of ['source.json', 'images/original.jpg']) originals.push([path.join(directory, name), await readFile(path.join(directory, name), 'utf8')]);
  }
  entries.push({ ...entries[1], sourceUrl: `${sourceUrl(2)}?ref=alias` });
  await saveJson(path.join(root, 'publication-receipt.json'), { recipes: { [sourceUrl(2)]: { stage: 'published_verified', postId: 'published-id' } } });
  const queuePath = path.join(root, 'queue.json');
  const pause = { reason: 'captcha' };
  await saveJson(queuePath, { authorizationId: 'test-auth', state: 'paused_for_human_verification', pause, collectionPolicy: { publish: false }, entries });
  const beforeDryRun = await readFile(queuePath, 'utf8');
  assert.ok((await reindexRecipeContent(root, { dryRun: true })).changedFiles > 0);
  assert.equal(await readFile(queuePath, 'utf8'), beforeDryRun);
  await reindexRecipeContent(root);
  const queue = await readJson(queuePath);
  assert.equal(queue.entries[0].duplicateOf, sourceUrl(2));
  assert.equal(queue.entries[1].duplicateOf, null);
  assert.equal(queue.entries[1].publishedPostId, 'published-id');
  assert.equal(queue.entries[2].duplicateOf, null);
  assert.equal(queue.entries[2].status, 'collected_pending_review');
  assert.equal(queue.entries[3].duplicateReason, 'same_source_url');
  assert.equal(queue.entries[3].candidateEligible, false);
  assert.equal((await readJson(path.join(entries[1].archiveDirectory, 'manifest.json'))).duplicateOf, null);
  assert.equal(queue.state, 'paused_for_human_verification');
  assert.deepEqual(queue.pause, pause);
  assert.deepEqual(queue.collectionPolicy, { publish: false });
  for (const [file, bytes] of originals) assert.equal(await readFile(file, 'utf8'), bytes);
  const beforeRepeat = await readFile(queuePath, 'utf8');
  assert.equal((await reindexRecipeContent(root)).changedFiles, 0);
  assert.equal(await readFile(queuePath, 'utf8'), beforeRepeat);
});

test('archive skips an already complete URL without replacing its original source or clearing pause', async context => {
  const root = await temporaryRoot(context);
  const raw = recipe(1);
  const imagePath = path.join(root, 'image.jpg');
  await writeFile(imagePath, await sharp({ create: { width: 2, height: 3, channels: 3, background: '#abccba' } }).jpeg().toBuffer());
  await saveJson(path.join(root, 'queue.json'), { authorizationId: 'test-auth', state: 'paused_for_human_verification', pause: { reason: 'captcha' }, entries: [{ sourceUrl: raw.sourceUrl, authorizationId: 'test-auth', status: 'pending_detail' }] });
  const bundle = { assets: [{ url: raw.cover.url, path: imagePath, contentType: 'image/jpeg' }] };
  const first = await archiveAuthorizedRecipe(root, raw, bundle);
  assert.equal(first.dedupeVersion, RECIPE_CONTENT_DEDUPE_VERSION);
  const original = await readFile(path.join(root, 'recipes/1/source.json'), 'utf8');
  const repeated = await archiveAuthorizedRecipe(root, { ...raw, sourceUrl: `${raw.sourceUrl}?ref=again`, title: '不覆盖原文' }, { assets: [] });
  assert.equal(repeated.skipped, true);
  assert.equal(repeated.skipReason, 'same_source_url');
  assert.equal(await readFile(path.join(root, 'recipes/1/source.json'), 'utf8'), original);
  assert.equal((await readJson(path.join(root, 'queue.json'))).state, 'paused_for_human_verification');
});
