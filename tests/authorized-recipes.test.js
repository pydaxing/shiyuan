import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { normalizeAuthorizedRecipe } from '../scripts/normalize-authorized-recipes.mjs';
import { titleKey, aliasKey } from '../scripts/recipe-discovery.mjs';
import { validateRecipe } from '../src/domain/kitchen.js';
import { normalizeCommand, normalizeImportedRecipe } from '../server/validation.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const imageFixtures = await Promise.all(['calendar', 'camera', 'chef'].map(async name => {
  const path = fileURLToPath(new URL(`../src/static/icon-${name}.png`, import.meta.url));
  const bytes = await readFile(path);
  const { width, height } = await sharp(bytes).metadata();
  return { path, sha256: digest(bytes), width, height };
}));

function rawRecipe(overrides = {}) {
  return {
    source: '下厨房', sourceUrl: 'https://www.xiachufang.com/recipe/100001/',
    title: '番茄炒蛋🍅', author: '原作者', authorUrl: 'https://www.xiachufang.com/cook/100/',
    authorizationId: 'auth-local-test', fetchedAt: '2026-09-09T09:00:00+08:00',
    description: '  原文介绍\n第二行。 ', tips: '先尝再调味。\n请保留这段提醒。',
    cover: { url: 'https://images.example.test/cover.jpg', alt: '原作成品🍅' },
    ingredients: [{ name: '番茄', amountText: '500克' }, { name: '鸡蛋', amountText: '1/2个' }],
    steps: [
      { text: '  切好番茄。\n鸡蛋打散。 ', images: [{ url: 'https://images.example.test/step-a.jpg', alt: '切番茄' }, { url: 'https://images.example.test/step-b.jpg', alt: '打鸡蛋' }] },
      { text: '炒熟后盛出🍅。', images: [] },
    ],
    sourceHtml: '<html><body>完整留档原文 &amp; 图片链接🍅</body></html>', ...overrides,
  };
}

function mappedAssets(raw = rawRecipe()) {
  const images = [raw.cover, ...raw.steps.flatMap(step => step.images)];
  return Object.fromEntries(images.map((image, index) => [image.url, {
    ...imageFixtures[index % imageFixtures.length], fileId: `cloud://test-environment/authorized/mock-${index}.png`,
  }]));
}

function reviewFor(raw = rawRecipe()) {
  return { sourceUrl: raw.sourceUrl, sourceHtmlFingerprint: digest(raw.sourceHtml), approved: true, reviewedAt: '2026-09-09T10:00:00+08:00', notes: '测试用人工核对记录。' };
}

function normalize(raw = rawRecipe(), options = {}) {
  return normalizeAuthorizedRecipe(raw, { category: '素菜', authorizationId: 'auth-local-test', assets: mappedAssets(), review: reviewFor(raw), ...options });
}

const hasIssue = (report, code, path) => report.issues.some(issue => issue.code === code && (path === undefined || issue.path === path));

test('unknown minutes stay null while fixed technical servings never claim source portions', async () => {
  const raw = rawRecipe({ description: '先烤 20 分钟，再焯水 2 分钟。' });
  const report = await normalize(raw);
  assert.equal(report.recipe.minutes, null);
  assert.equal(report.recipe.servings, 2);
  assert.match(report.recipe.provenance.note, /原文用量未缩放/);
  assert.match(report.recipe.provenance.note, /技术字段，不代表原文人数/);
  assert.equal(hasIssue(report, 'missing_minutes'), false);
  assert.equal(hasIssue(report, 'missing_servings'), false);
  assert.equal(report.ready, true);
  assert.deepEqual(report.issues, []);
  assert.doesNotThrow(() => validateRecipe(report.recipe));
  assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
});

test('source-bound review can preserve missing amounts, group labels and a shortened display title', async () => {
  const raw = rawRecipe({ title: '这是一个非常非常长的番茄炒蛋菜谱名称以及一些多余的描述文字', ingredients: [{ name: '配料', amountText: '' }, { name: '番茄', amountText: '' }, { name: '鸡蛋', amountText: '2' }] });
  const review = { ...reviewFor(raw), importOverrides: { displayTitle: '番茄炒蛋', allowMissingAmounts: true, ingredientGroupIndices: [0], textAmountIndices: [2] } };
  const report = await normalize(raw, { review });
  assert.equal(report.ready, true, JSON.stringify(report.issues));
  assert.equal(report.recipe.title, '番茄炒蛋');
  assert.deepEqual(report.recipe.ingredients, [{ name: '番茄', quantity: null, unit: '', amountText: '原文未注明' }, { name: '鸡蛋', quantity: null, unit: '', amountText: '2（原文未注明单位）' }]);
  assert.ok(report.recipe.provenance.note.includes(raw.title));
  assert.deepEqual(report.raw, raw);
  const stale = await normalize(raw, { review: { ...review, sourceHtmlFingerprint: 'stale' } });
  assert.equal(stale.ready, false);
  assert.equal(stale.recipe.title, raw.title);
  const invalidIndex = await normalize(raw, { review: { ...review, importOverrides: { ...review.importOverrides, ingredientGroupIndices: [99] } } });
  assert.equal(invalidIndex.ready, false);
});

test('reviewed ingredient instructions stay complete in steps and provenance, not shopping items', async () => {
  const instruction = '菜少用咖啡勺，菜多用汤勺，先把酱料混合均匀，再适量倒入蔬菜里。';
  const raw = rawRecipe({ ingredients: [{ name: '番茄', amountText: '100g' }, { name: instruction, amountText: '' }] });
  const review = { ...reviewFor(raw), importOverrides: { ingredientInstructionIndices: [1], textAmountIndices: [0] } };
  const report = await normalize(raw, { review });
  assert.equal(report.ready, true, JSON.stringify(report.issues));
  assert.deepEqual(report.recipe.ingredients, [{ name: '番茄', quantity: 100, unit: 'g' }]);
  assert.deepEqual(report.recipe.steps.at(-1), { title: '原料表补充说明', text: instruction, images: [] });
  assert.ok(report.recipe.provenance.note.includes(instruction));
  assert.deepEqual(report.raw, raw);
  for (const importOverrides of [{ ingredientInstructionIndices: [0] }, { ingredientInstructionIndices: [1], ingredientGroupIndices: [1] }, { ingredientInstructionIndices: [99] }]) {
    assert.equal((await normalize(raw, { review: { ...review, importOverrides } })).ready, false);
  }
  const stale = await normalize(raw, { review: { ...review, sourceHtmlFingerprint: 'stale' } });
  assert.equal(stale.ready, false);
  assert.equal(stale.recipe.ingredients.length, 2);
});

test('reviewed supplementary video does not block independent complete text, while video-only still fails', async () => {
  const raw = rawRecipe({ videos: [{ url: 'https://www.xiachufang.com/video/1/' }] });
  const review = { ...reviewFor(raw), importOverrides: { supplementaryVideo: true } };
  assert.equal((await normalize(raw, { review })).ready, true);
  assert.equal((await normalize({ ...raw, steps: [] }, { review })).ready, false);
  const long = rawRecipe({ steps: Array.from({ length: 31 }, (_, index) => ({ text: `完整步骤${index}`, images: [] })) });
  const report = await normalize(long);
  assert.equal(report.ready, true);
  assert.equal(report.recipe.steps.length, 31);
});

test('explicit quantities with supported units normalize exactly without a text amount', async () => {
  const cases = [
    ['1/2个', 0.5, '个'], ['500克', 500, 'g'], ['0.5千克', 0.5, 'kg'],
    ['2公斤', 2, 'kg'], ['250毫升', 250, 'ml'], ['1升', 1, 'L'], ['半个', 0.5, '个'],
    ['１／２ 个', 0.5, '个'], ['½个', 0.5, '个'], [' 500 g ', 500, 'g'], ['2KG', 2, 'kg'],
    ['3根', 3, '根'], ['2只', 2, '只'], ['1盒', 1, '盒'], ['2袋', 2, '袋'], ['2张', 2, '张'],
    ['二个', 2, '个'], ['两只', 2, '只'], ['十二个', 12, '个'], ['二十三个', 23, '个'],
    ['.5L', 0.5, 'L'], ['0.001克', 0.001, 'g'], ['100000克', 100000, 'g'],
    ['半勺', 0.5, '勺'], ['半茶匙', 0.5, '茶匙'], ['2斤', 2, '斤'], ['3片', 3, '片'],
    ['2块', 2, '块'], ['一把', 1, '把'], ['2杯', 2, '杯'], ['3颗', 3, '颗'], ['半瓶', 0.5, '瓶'],
  ];
  for (const [amountText, quantity, unit] of cases) {
    const report = await normalize(rawRecipe({ ingredients: [{ name: '原食材', amountText }] }));
    assert.deepEqual(report.recipe.ingredients, [{ name: '原食材', quantity, unit }], amountText);
    assert.equal(report.ingredientAmounts[0].amountText, amountText);
    assert.ok(report.recipe.provenance.note.includes(`原食材：${amountText}`));
    assert.equal(Object.hasOwn(report.recipe.ingredients[0], 'amountText'), false, amountText);
    assert.deepEqual(report.ingredientAmounts[0].parsed, { quantity, unit });
    assert.deepEqual(report.issues, [], amountText);
    assert.equal(report.ready, true, amountText);
  }
});

test('newly supported household units retain quantities without invented capacity conversions', async () => {
  for (const [amountText, quantity, unit] of [[' １／２ 小勺 ', 0.5, '小勺'], ['2大勺', 2, '大勺'], ['3滴', 3, '滴'], ['一撮', 1, '撮']]) {
    const report = await normalize(rawRecipe({ ingredients: [{ name: '原食材', amountText }] }));
    assert.deepEqual(report.recipe.ingredients, [{ name: '原食材', quantity, unit }]);
    assert.deepEqual(report.ingredientAmounts[0].parsed, { quantity, unit });
    assert.equal(report.ingredientAmounts[0].amountText, amountText);
    assert.equal(report.raw.ingredients[0].amountText, amountText);
    assert.deepEqual(report.issues, [], amountText);
    assert.equal(report.ready, true, amountText);
    assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
  }
});

test('meaningful vague, ranged, approximate and compound amounts remain usable unscaled text', async () => {
  const amounts = ['适量', '少许', '若干', ' 按口味添加 ', '1-2个', '１～２ 个', '1至2个', '1到2个', '1/2-1个', '二三个', '一小把', '约半勺', '1个（约50克）', '约500克', '500克左右', '1克+2克', '盐1克', '1g盐', '2 × 100克', '1克，2克分次添加', '2oz', '  少许  ', '少'.repeat(60)];
  for (const amountText of amounts) {
    const raw = rawRecipe({ servings: 6, ingredients: [{ name: '盐', amountText }] });
    const report = await normalize(raw);
    assert.deepEqual(report.recipe.ingredients, [{ name: '盐', quantity: null, unit: '', amountText: amountText.trim() }], amountText);
    assert.equal(report.ingredientAmounts[0].parsed, null, amountText);
    assert.equal(report.ingredientAmounts[0].amountText, amountText);
    assert.deepEqual(report.raw, raw);
    assert.ok(report.recipe.provenance.note.includes(`盐：${amountText}`));
    assert.equal(report.recipe.servings, 2);
    assert.equal(report.raw.servings, 6);
    assert.equal(report.ready, true, amountText);
    assert.deepEqual(report.issues, [], amountText);
    assert.doesNotThrow(() => validateRecipe(report.recipe));
    assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
    assert.deepEqual(report.validation.server.changedFields, []);
    assert.throws(() => normalizeCommand('addStock', [report.recipe.ingredients[0]]));
    assert.throws(() => normalizeCommand('recordPurchase', [report.recipe.ingredients[0]]));
  }
});

test('missing, non-string and malformed amounts remain blocked without fabricated text', async () => {
  const amounts = [
    '', ' ', '　', undefined, null, 500, 0, false, {}, [], ['适量'], Infinity, NaN,
    '500', '1/2', '半', '二三', '1-2', '克', 'g', '片', '未知', 'N/A', '---',
    '1,000克', '1_000克', '十十个', '一二三片', '-1克', '−1片', '+1克', '0克', '０片', '零克', '0/2个', '1/0个', '1/0片',
    '1e3克', '1e309片', 'Infinity克', '-Infinity片', 'NaN克', '∞克', '1.2.3克', '1..2片', '1//2克', '1/2/3片', '1/片', '1./2克', '1 2克',
    '1克+', '约-1克', '约0克', '约1/0勺', '1克+-2克', '0-2个', '1-0片', '1×0克',
    '9007199254740992克', '1/9007199254740992片', `${'9'.repeat(310)}克`,
  ];
  for (const amountText of amounts) {
    const report = await normalize(rawRecipe({ ingredients: [{ name: '盐', amountText }] }));
    assert.equal(report.recipe.ingredients[0].quantity, null, String(amountText));
    assert.equal(report.recipe.ingredients[0].unit, null, String(amountText));
    assert.equal(report.ingredientAmounts[0].parsed, null, String(amountText));
    assert.equal(Object.hasOwn(report.recipe.ingredients[0], 'amountText'), false, String(amountText));
    assert.equal(hasIssue(report, 'unresolved_amount', 'ingredients.0.amountText'), true, String(amountText));
    assert.equal(report.ready, false);
    assert.deepEqual(report.raw.ingredients[0].amountText, amountText);
  }
  const raw = rawRecipe({ ingredients: [{ name: '盐' }] });
  const missing = await normalize(raw);
  assert.equal(hasIssue(missing, 'unresolved_amount', 'ingredients.0.amountText'), true);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.raw, raw);
});

test('text amounts reject excessive length and all source control characters without trimming them away', async () => {
  for (const amountText of ['少'.repeat(61), '  ' + '少'.repeat(61) + '  ', ...['\u0000', '\t', '\n', '\r', '\u001f', '\u007f', '\u0085', '\u009f'].flatMap(control => [`${control}适量`, `少${control}许`, `适量${control}`, `${control}1克`])]) {
    const raw = rawRecipe({ ingredients: [{ name: '盐', amountText }] });
    const report = await normalize(raw);
    assert.equal(hasIssue(report, 'unresolved_amount', 'ingredients.0.amountText'), true, JSON.stringify(amountText));
    assert.equal(report.ready, false);
    assert.equal(Object.hasOwn(report.recipe.ingredients[0], 'amountText'), false);
    assert.equal(report.ingredientAmounts[0].amountText, amountText);
    assert.deepEqual(report.raw, raw);
  }
});

test('out of schema numeric quantities never fall back to text even for unsupported units', async () => {
  for (const [amountText, quantity] of [['100001克', 100001], ['0.0001克', 0.0001], ['1/10000个', 0.0001], ['100001勺', 100001], ['0.0001片', 0.0001], ['1/10000块', 0.0001], ['100001颗', 100001], ['9007199254740991克', Number.MAX_SAFE_INTEGER]]) {
    const report = await normalize(rawRecipe({ ingredients: [{ name: '盐', amountText }] }));
    assert.equal(report.recipe.ingredients[0].quantity, quantity);
    assert.equal(hasIssue(report, 'schema_field_invalid', 'ingredients.0.quantity'), true);
    assert.equal(Object.hasOwn(report.recipe.ingredients[0], 'amountText'), false);
    assert.equal(report.raw.ingredients[0].amountText, amountText);
    assert.equal(report.ready, false);
  }
  for (const amountText of ['约100001克', '约0.0001勺', '1-100001片', '0.0001-1个', '1克+100001克', '2×100001克', '0.0001oz']) {
    const report = await normalize(rawRecipe({ ingredients: [{ name: '盐', amountText }] }));
    assert.equal(report.ready, false, amountText);
    assert.equal(hasIssue(report, 'unresolved_amount', 'ingredients.0.amountText'), true, amountText);
    assert.equal(Object.hasOwn(report.recipe.ingredients[0], 'amountText'), false);
  }
});

test('text amounts do not bypass authorization, manual review, image or source structure gates', async () => {
  const raw = rawRecipe({ ingredients: [{ name: '盐', amountText: '适量' }] });
  const cases = [
    [raw, { review: undefined }, 'manual_required'],
    [raw, { review: { ...reviewFor(raw), approved: false } }, 'manual_required'],
    [raw, { review: { ...reviewFor(raw), sourceHtmlFingerprint: 'a'.repeat(64) } }, 'manual_required'],
    [raw, { authorizationId: 'different-auth' }, 'authorization_mismatch'],
    [raw, { assets: undefined }, 'missing_image_asset'],
    [{ ...raw, steps: [] }, {}, 'missing_steps'],
    [{ ...raw, ingredients: [...raw.ingredients, { name: '水' }] }, {}, 'unresolved_amount'],
    [{ ...raw, videos: [{ url: 'https://example.test/source.mp4' }] }, {}, 'unsupported_video_content'],
  ];
  for (const [source, options, code] of cases) {
    const report = await normalize(source, options);
    assert.deepEqual(report.recipe.ingredients[0], { name: '盐', quantity: null, unit: '', amountText: '适量' });
    assert.equal(hasIssue(report, code), true, code);
    assert.equal(report.ready, false, code);
    assert.equal(report.publicPublishingAllowed, false, code);
    assert.equal(report.requiresApplicationModeration, true);
    assert.deepEqual(report.raw, source);
  }
});

test('ingredient names, repeated rows and amount text never merge or disappear', async () => {
  const raw = rawRecipe({ ingredients: [{ name: ' 西红柿 ', amountText: '500克' }, { name: '番茄', amountText: '1个' }, { name: '番茄', amountText: '少许' }] });
  const report = await normalize(raw);
  assert.deepEqual(report.recipe.ingredients.map(item => item.name), raw.ingredients.map(item => item.name));
  assert.deepEqual(report.ingredientAmounts.map(item => item.amountText), raw.ingredients.map(item => item.amountText));
  assert.equal(report.ingredientText, ' 西红柿 ：500克\n番茄：1个\n番茄：少许');
  assert.equal(report.completeness.ingredientCount, 3);
  assert.equal(report.completeness.parsedAmountCount, 2);
});

test('source text, title emojis, attribution and compact note survive normal server validation', async () => {
  const raw = rawRecipe({ sourceUrl: 'https://www.xiachufang.com/recipe/100001/?ref=home#detail' });
  const report = await normalize(raw);
  const provenance = report.recipe.provenance;
  assert.equal(provenance.source, raw.source);
  assert.equal(provenance.url, raw.sourceUrl);
  assert.equal(provenance.attribution, raw.author);
  assert.match(provenance.license, /user authorized/i);
  assert.match(provenance.license, /not public domain/i);
  for (const field of ['authorUrl', 'fetchedAt', 'description', 'tips', 'authorizationId']) assert.ok(provenance.note.includes(raw[field]), field);
  assert.equal(provenance.note.includes(raw.cover.url), false);
  assert.equal(provenance.note.includes(raw.sourceHtml), false);
  assert.equal(report.recipe.title, raw.title);
  assert.deepEqual(report.recipe.steps.map(step => step.text), raw.steps.map(step => step.text));
  assert.deepEqual(report.imageReferences.map(reference => reference.source), [raw.cover, ...raw.steps[0].images]);
  assert.deepEqual(report.raw, raw);
  assert.equal(report.sourceHtmlFingerprint, digest(raw.sourceHtml));
  assert.equal(report.canonicalSourceUrl, 'https://www.xiachufang.com/recipe/100001/');
  assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
  assert.equal(report.validation.recipe.valid, true);
  assert.equal(report.validation.server.valid, true);
  assert.deepEqual(report.validation.server.changedFields, []);
  assert.equal(report.ready, true);
});

test('source-provided portions remain evidence, not a request to scale original amounts', async () => {
  const report = await normalize(rawRecipe({ servings: 4, minutes: 20 }));
  assert.equal(report.recipe.servings, 2);
  assert.equal(report.raw.servings, 4);
  assert.equal(report.recipe.minutes, 20);
  assert.match(report.recipe.provenance.note, /原文人数：4/);
  assert.equal(report.recipe.ingredients[0].quantity, 500);
  assert.equal(report.ready, true);
});

test('known total minutes still require a valid source number and real schema validation', async () => {
  for (const minutes of [0, 601, 1.5]) {
    const report = await normalize(rawRecipe({ minutes }));
    assert.equal(report.recipe.minutes, minutes);
    assert.equal(hasIssue(report, 'schema_field_invalid', 'minutes'), true);
    assert.equal(report.validation.recipe.valid, false);
  }
  assert.equal(hasIssue(await normalize(rawRecipe({ minutes: '20' })), 'invalid_source_number', 'minutes'), true);
});

test('no review or any mismatching approval keeps even a schema-valid recipe out of ready', async () => {
  const raw = rawRecipe();
  for (const review of [undefined, null, { ...reviewFor(raw), approved: false }, { ...reviewFor(raw), sourceUrl: `${raw.sourceUrl}?different` }, { ...reviewFor(raw), sourceHtmlFingerprint: 'a'.repeat(64) }, { ...reviewFor(raw), reviewedAt: 'today' }, { ...reviewFor(raw), notes: undefined }]) {
    const report = await normalize(raw, { review });
    assert.equal(report.validation.recipe.valid, true);
    assert.equal(hasIssue(report, 'manual_required'), true);
    assert.equal(report.ready, false);
    assert.equal(report.completeness.sourceVerified, false);
  }
  const changed = rawRecipe({ sourceHtml: `${raw.sourceHtml}\n` });
  assert.equal(hasIssue(await normalize(changed, { review: reviewFor(raw) }), 'manual_required'), true);
  const approved = await normalize(raw);
  assert.equal(approved.completeness.sourceVerified, true);
  assert.equal(approved.ready, true);
  assert.equal(approved.requiresApplicationModeration, true);
});

test('authorization must match raw evidence and does not add an unrelated scope reapproval gate', async () => {
  for (const options of [{ authorizationId: '' }, { authorizationId: 'different-auth' }]) {
    const report = await normalize(rawRecipe(), options);
    assert.equal(report.ready, false);
    assert.ok(report.issues.some(issue => ['missing_authorization', 'authorization_mismatch'].includes(issue.code)));
  }
  assert.equal(hasIssue(await normalize(rawRecipe({ authorizationId: undefined })), 'authorization_mismatch'), true);
  assert.deepEqual((await normalize()).issues, []);
});

test('missing assets are explicit and never drop cover or step image positions', async () => {
  const raw = rawRecipe();
  const report = await normalize(raw, { assets: undefined });
  assert.equal(hasIssue(report, 'missing_assets'), true);
  assert.equal(report.issues.filter(issue => issue.code === 'missing_image_asset').length, 3);
  assert.equal(report.recipe.image, null);
  assert.deepEqual(report.recipe.steps[0].images, [null, null]);
  assert.equal(report.imageReferences.length, 3);
  assert.equal(report.completeness.mappedImageCount, 0);
  assert.equal(report.ready, false);
});

test('verified local archives without fileIds produce only upload issues and no fabricated IDs', async () => {
  const assets = mappedAssets();
  for (const asset of Object.values(assets)) delete asset.fileId;
  const report = await normalize(rawRecipe(), { assets });
  assert.deepEqual(report.issues.map(issue => issue.code), Array(3).fill('image_not_uploaded'));
  assert.equal(report.recipe.image, null);
  assert.deepEqual(report.recipe.steps[0].images, [null, null]);
  assert.equal(report.completeness.imageBytesVerified, true);
  assert.equal(report.completeness.verifiedImageCount, 3);
  assert.equal(report.ready, false);
  assert.equal(report.publicPublishingAllowed, false);
  assert.equal(report.validation.recipe.valid, false);
  assert.equal((await normalize()).ready, true);
});

test('partial mappings leave holes visible rather than borrowing adjacent or cover images', async () => {
  const raw = rawRecipe();
  const assets = mappedAssets(raw);
  delete assets[raw.steps[0].images[0].url];
  const report = await normalize(raw, { assets });
  assert.deepEqual(report.recipe.steps[0].images, [null, assets[raw.steps[0].images[1].url].fileId]);
  assert.equal(hasIssue(report, 'missing_image_asset', 'steps.0.images.0'), true);
  assert.equal(report.completeness.mappedImageCount, 2);
  assert.deepEqual(report.raw.steps[0].images, raw.steps[0].images);
});

test('multiple and repeated step images preserve order, alt text and all occurrences', async () => {
  const raw = rawRecipe();
  raw.steps[0].images.push(structuredClone(raw.steps[0].images[0]));
  const assets = mappedAssets(raw);
  const report = await normalize(raw, { assets });
  assert.deepEqual(report.recipe.steps[0].images, raw.steps[0].images.map(image => assets[image.url].fileId));
  assert.equal(report.recipe.steps[0].images.length, 3);
  assert.equal(report.imageReferences.length, 4);
  assert.equal(report.imageSourceUrls.length, 3);
  assert.deepEqual(report.imageHashes, [...new Set(Object.values(assets).map(asset => asset.sha256))]);
  assert.equal(report.completeness.verifiedImageCount, 4);
  assert.equal(report.ready, true);
});

test('local file existence, bytes, dimensions and decoding are verified even with a fileId', async () => {
  const nonImagePath = fileURLToPath(import.meta.url);
  const nonImageHash = digest(await readFile(nonImagePath));
  const cases = [
    [{ path: `${imageFixtures[0].path}.missing` }, 'image_file_missing'],
    [{ sha256: 'f'.repeat(64) }, 'image_hash_mismatch'],
    [{ width: 999 }, 'image_dimensions_mismatch'],
    [{ path: nonImagePath, sha256: nonImageHash, width: 1, height: 1 }, 'invalid_image_file'],
  ];
  for (const [changes, code] of cases) {
    const assets = mappedAssets();
    Object.assign(assets[rawRecipe().cover.url], changes);
    const report = await normalize(rawRecipe(), { assets });
    assert.equal(hasIssue(report, code, 'cover'), true, code);
    assert.equal(report.imageReferences[0].verified, false);
    assert.equal(report.ready, false);
  }
});

test('malformed archive metadata, remote paths and invalid image IDs cannot pass', async () => {
  for (const changes of [{ sha256: 'bad' }, { width: 0 }, { height: 0.5 }, { width: '640' }, { path: '' }, { path: 'https://example.test/image.png' }, { path: 'cloud://environment/file.png' }]) {
    const assets = mappedAssets();
    Object.assign(assets[rawRecipe().cover.url], changes);
    const report = await normalize(rawRecipe(), { assets });
    assert.equal(hasIssue(report, 'invalid_image_asset', 'cover'), true, JSON.stringify(changes));
    assert.equal(report.ready, false);
  }
  for (const fileId of ['https://example.test/image.png', 'cloud://test/../bad.png', 'data:text/html;base64,YWJj', '/tmp/staging.jpg']) {
    const assets = mappedAssets();
    assets[rawRecipe().cover.url].fileId = fileId;
    const report = await normalize(rawRecipe(), { assets });
    assert.equal(hasIssue(report, 'invalid_image_file_id', 'cover'), true, fileId);
    assert.equal(report.ready, false);
  }
});

test('real data URIs pass offline validation while public readiness still requires uploaded cloud IDs', async () => {
  const assets = mappedAssets();
  for (const asset of Object.values(assets)) {
    const bytes = await sharp(await readFile(asset.path)).jpeg().toBuffer();
    asset.fileId = `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }
  const report = await normalize(rawRecipe(), { assets });
  assert.equal(report.ready, true);
  assert.deepEqual(report.issues, []);
  assert.equal(report.publicPublishingAllowed, false);
  assert.equal(report.completeness.imageBytesVerified, true);
  assert.doesNotThrow(() => validateRecipe(report.recipe));
  assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
  const uploaded = await normalize();
  assert.equal(uploaded.ready, true);
  assert.equal(uploaded.publicPublishingAllowed, true);
});

test('empty or video-only instructions cannot pass as a complete text and image recipe', async () => {
  const empty = await normalize(rawRecipe({ steps: [] }));
  assert.equal(empty.validation.recipe.valid, true);
  assert.equal(hasIssue(empty, 'missing_steps'), true);
  assert.equal(empty.ready, false);
  const video = await normalize(rawRecipe({ videos: [{ url: 'https://example.test/source.mp4' }] }));
  assert.equal(hasIssue(video, 'unsupported_video_content'), true);
  assert.equal(video.ready, false);
  assert.equal(video.raw.videos.length, 1);
});

test('excessive ingredient counts, steps and step images are retained and separately flagged', async () => {
  const raw = rawRecipe({ ingredients: Array.from({ length: 31 }, (_, index) => ({ name: `食材${index}`, amountText: '1克' })), steps: Array.from({ length: 61 }, (_, index) => ({ text: `步骤${index}`, images: [] })) });
  raw.steps[0].images = Array.from({ length: 10 }, (_, index) => ({ url: `https://images.example.test/${index}.jpg`, alt: `图片${index}` }));
  const report = await normalize(raw, { assets: mappedAssets(raw) });
  assert.equal(report.recipe.ingredients.length, 31);
  assert.equal(report.recipe.steps.length, 61);
  assert.equal(report.recipe.steps[0].images.length, 10);
  assert.equal(report.imageReferences.length, 11);
  for (const path of ['ingredients', 'steps', 'steps.0.images']) assert.equal(hasIssue(report, 'schema_limit_exceeded', path), true, path);
  assert.deepEqual(report.raw, raw);
  assert.equal(report.ready, false);
});

test('oversized names, step text and provenance never get silently sliced', async () => {
  const raw = rawRecipe({ title: '菜'.repeat(31), author: '人'.repeat(301), description: '介'.repeat(1600), tips: '提'.repeat(1600), ingredients: [{ name: '料'.repeat(31), amountText: '1克' }], steps: [{ text: '步'.repeat(1001), images: [] }] });
  const report = await normalize(raw);
  assert.equal(report.recipe.title, raw.title);
  assert.equal(report.recipe.ingredients[0].name, raw.ingredients[0].name);
  assert.equal(report.recipe.steps[0].text, raw.steps[0].text);
  assert.equal(report.recipe.provenance.attribution, raw.author);
  assert.ok(report.recipe.provenance.note.includes(raw.description));
  assert.ok(report.recipe.provenance.note.includes(raw.tips));
  for (const path of ['title', 'ingredients.0.name']) assert.equal(hasIssue(report, 'schema_field_invalid', path), true);
  for (const path of ['steps.0.text', 'provenance.attribution', 'provenance.note']) assert.equal(hasIssue(report, 'schema_limit_exceeded', path), true);
  assert.equal(report.ready, false);
});

test('1500-character provenance boundary uses the real validator and keeps overflow text', async () => {
  const raw = rawRecipe();
  const noteLength = (await normalize(raw)).recipe.provenance.note.length;
  assert.ok(noteLength < 1500);
  raw.tips += '提'.repeat(1500 - noteLength);
  const boundary = await normalize(raw);
  assert.equal(boundary.recipe.provenance.note.length, 1500);
  assert.equal(boundary.ready, true);
  raw.tips += '醒';
  const exceeded = await normalize(raw);
  assert.equal(exceeded.recipe.provenance.note.length, 1501);
  assert.equal(exceeded.validation.recipe.valid, false);
  assert.equal(hasIssue(exceeded, 'schema_limit_exceeded', 'provenance.note'), true);
  assert.ok(exceeded.recipe.provenance.note.includes(raw.tips));
});

test('missing provenance, source evidence and category require explicit repair', async () => {
  for (const [field, value, code] of [['source', '其他站点', 'unsupported_source'], ['sourceUrl', 'http://www.xiachufang.com/recipe/100001/', 'invalid_source_url'], ['sourceUrl', 'https://www.xiachufang.com.evil.test/recipe/100001/', 'invalid_source_url'], ['author', '', 'invalid_source_text'], ['authorUrl', '', 'invalid_author_url'], ['fetchedAt', 'today', 'invalid_fetched_at'], ['sourceHtml', '', 'invalid_source_text']]) {
    const report = await normalize(rawRecipe({ [field]: value }));
    assert.equal(hasIssue(report, code, field), true, field);
    assert.equal(report.raw[field], value);
    assert.equal(report.ready, false);
  }
  assert.equal(hasIssue(await normalize(rawRecipe(), { category: undefined }), 'schema_field_invalid', 'category'), true);
});

test('malformed raw structures report issues without dropping evidence or throwing', async () => {
  for (const raw of [null, undefined, [], 'not a recipe', {}, rawRecipe({ ingredients: [null, 3], steps: [null, { text: '', images: null }], cover: null })]) {
    const report = await normalizeAuthorizedRecipe(raw);
    assert.equal(report.ready, false);
    assert.ok(report.issues.length > 0);
    assert.deepEqual(report.raw, raw);
  }
});

test('title aliases match discovery while repeated content remains identifiable after renaming', async () => {
  const first = await normalize();
  const alias = await normalize(rawRecipe({ title: '西红柿炒鸡蛋' }));
  assert.equal(first.titleKey, titleKey('番茄炒蛋🍅'));
  assert.equal(first.aliasKey, aliasKey('番茄炒蛋🍅'));
  assert.equal(first.titleFingerprint, alias.titleFingerprint);
  assert.equal(first.contentFingerprint, alias.contentFingerprint);
  const renamed = await normalize(rawRecipe({ title: '原作者改过名字' }));
  assert.notEqual(first.titleFingerprint, renamed.titleFingerprint);
  assert.equal(first.contentFingerprint, renamed.contentFingerprint);
  for (const fingerprint of [first.titleFingerprint, first.textFingerprint, first.contentFingerprint, first.sourceHtmlFingerprint]) assert.match(fingerprint, /^[a-f\d]{64}$/);
});

test('content hashes ignore source metadata, archive fileIds and insignificant whitespace', async () => {
  const first = await normalize();
  const changed = rawRecipe({ author: '另一署名', authorUrl: 'https://www.xiachufang.com/cook/200/', sourceUrl: 'https://www.xiachufang.com/recipe/200002/', fetchedAt: '2026-09-09T10:00:00+08:00', sourceHtml: '<html>不同页面模板</html>', description: '原文介绍 第二行。', tips: '先尝再调味。 请保留这段提醒。' });
  const assets = mappedAssets(changed);
  assets[changed.cover.url].fileId = 'cloud://test-environment/another-file.png';
  const second = await normalize(changed, { assets, category: '其他' });
  assert.equal(first.textFingerprint, second.textFingerprint);
  assert.equal(first.contentFingerprint, second.contentFingerprint);
  assert.notEqual(first.sourceHtmlFingerprint, second.sourceHtmlFingerprint);
});

test('body, quantities, ordering, images and meaningful punctuation change content hashes', async () => {
  const first = await normalize();
  const variants = [
    rawRecipe({ ingredients: [{ name: '番茄', amountText: '501克' }, { name: '鸡蛋', amountText: '1/2个' }] }),
    rawRecipe({ ingredients: rawRecipe().ingredients.toReversed() }), rawRecipe({ steps: rawRecipe().steps.toReversed() }),
    rawRecipe({ description: '不同的介绍。' }), rawRecipe({ tips: '不同的提醒。' }),
    rawRecipe({ cover: { ...rawRecipe().cover, alt: '不同的图片说明' } }),
  ];
  const changedImage = rawRecipe();
  changedImage.steps[0].images[0].url = 'https://images.example.test/different.jpg';
  variants.push(changedImage);
  for (const raw of variants) assert.notEqual((await normalize(raw)).contentFingerprint, first.contentFingerprint);
  assert.notEqual((await normalize(rawRecipe({ tips: '放盐，不放糖' }))).textFingerprint, (await normalize(rawRecipe({ tips: '放盐不放糖' }))).textFingerprint);
  assert.equal((await normalize(changedImage)).textFingerprint, first.textFingerprint);
});

test('reports clone input, serialize deterministically and never trust source ready flags', async () => {
  const raw = rawRecipe({ ready: true, fullContentCollected: true, sourceCompletenessVerified: true });
  const assets = mappedAssets(raw);
  const review = reviewFor(raw);
  const before = structuredClone({ raw, assets, review });
  const first = await normalize(raw, { assets, review });
  const second = await normalize(raw, { assets, review });
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  first.raw.steps[0].images[0].alt = '修改报告';
  first.imageReferences[0].asset.width = 1;
  first.recipe.ingredients[0].quantity = 1;
  first.sourceReview.record.notes = '修改记录';
  assert.deepEqual({ raw, assets, review }, before);
  const unreviewed = await normalize(raw, { review: undefined });
  assert.equal(unreviewed.ready, false);
  assert.equal(hasIssue(unreviewed, 'manual_required'), true);
});


test('archived import validation preserves missing titles without bypassing direct save validation', async () => {
  const report = await normalize();
  assert.ok(report.recipe.steps.some(step => !step.title));
  assert.deepEqual(normalizeImportedRecipe(report.recipe), report.recipe);
  assert.throws(() => normalizeCommand('saveRecipe', [report.recipe]), /步骤标题/);
  assert.throws(() => normalizeCommand('saveRecipe', [{ ...report.recipe, requireStepTitles: false }]), /步骤标题/);
});
