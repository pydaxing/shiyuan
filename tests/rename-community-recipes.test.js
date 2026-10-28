import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildStagedRecipe, assertStagedRecipe } from '../scripts/admin-recipe-import.mjs';
import { parseTitleReview, retainOriginalTitle, renamedReview, renameDocument, makeTitleOperation, applyTitleFields, reconcileOperation, titleUpdateCommand, splitTitleUpdates, verifyTitleUpdateResult } from '../scripts/rename-community-recipes.mjs';

const sourceUrl = 'https://www.xiachufang.com/recipe/12345/';
const originalTitle = '超级好吃又方便的一餐';
const note = '原文用量未缩放\n授权：auth-test\n采集：2026-09-10T01:00:00Z\n作者链接：https://www.xiachufang.com/cook/12345/\n介绍：\n原文介绍\n原文用量：\n黄瓜：1根';
const image = 'cloud://test-env.bucket/approved/photo.bin';
const hash = value => createHash('sha256').update(value).digest('hex');
const raw = { source: '下厨房', sourceUrl, title: originalTitle, author: '原作者', authorUrl: 'https://www.xiachufang.com/cook/12345/', fetchedAt: '2026-09-10T01:00:00Z', authorizationId: 'auth-test', sourceHtml: '<div>原文</div>', description: '原文介绍', tips: '', cover: { url: 'https://images.example.test/photo.jpg', alt: '图' }, ingredients: [{ name: '黄瓜', amountText: '1根' }], steps: [{ text: '拍碎黄瓜，拌匀。', images: [{ url: 'https://images.example.test/photo.jpg', alt: '图' }] }] };
const review = { sourceUrl, sourceHtmlFingerprint: hash(raw.sourceHtml), approved: true, category: '素菜', reviewedAt: '2026-09-10T02:00:00Z', notes: '配料及做法核对', importOverrides: { supplementaryVideo: true } };
const recipe = { id: 'shared-dish', title: originalTitle, category: '素菜', servings: 2, minutes: null, image, ingredients: [{ name: '黄瓜', quantity: 1, unit: '根' }], steps: [{ title: '', text: '拍碎黄瓜，拌匀。', images: [image] }], provenance: { source: '下厨房', url: sourceUrl, license: 'User authorized', attribution: '原作者', note } };
const entry = { sourceId: '12345', sourceUrl, kind: 'published', documentId: 'post-test', currentTitle: originalTitle, originalTitle, title: '拍黄瓜', basis: '黄瓜拍碎后加蒜及调味汁凉拌' };

function postFixture() {
  return { _id: 'post-test', id: 'post-test', kind: 'dish', title: originalTitle, status: 'published', recipes: [structuredClone(recipe)], card: { title: originalTitle, recipes: [{ id: recipe.id, title: originalTitle, category: '素菜', image }], importedFamilyCount: 3 }, categories: ['素菜'], importedFamilyCount: 3, familyId: 'family-test', publisherId: 'publisher-test', createdAt: 123, assetIds: [image], search: JSON.stringify([originalTitle, [originalTitle, ['黄瓜']]]) };
}

function stageFixture() {
  const assetHash = hash('image');
  return buildStagedRecipe({ raw: structuredClone(raw), review: structuredClone(review), assets: { [raw.cover.url]: { sha256: assetHash, width: 100, height: 100, bytes: 5, fileId: image } }, files: new Map([[assetHash, { uploadHash: assetHash }]]), normalized: { ready: true, sourceReview: { matched: true }, completeness: { imageBytesVerified: true }, recipe: structuredClone(recipe) } }, {}, { appid: 'wx-test', env: 'test-env' });
}

test('review requires exact source coverage and allows common names shared by different methods', () => {
  const input = [entry, { ...entry, sourceId: '12346' }];
  const rows = parseTitleReview('sourceId\ttitle\tbasis\n12345\t拍黄瓜\t黄瓜拍碎后加调料凉拌\n12346\t拍黄瓜\t黄瓜拍碎后加蒜末凉拌\n', input);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].originalTitle, originalTitle);
  assert.equal(rows[0].title, rows[1].title);
  for (const text of [
    'sourceId\ttitle\tbasis\n12345\t拍黄瓜\t黄瓜拍碎后加调料凉拌',
    'sourceId\ttitle\tbasis\n12345\t拍黄瓜\t黄瓜拍碎后加调料凉拌\n12345\t拍黄瓜\t黄瓜拍碎后加蒜末凉拌',
    'sourceId\ttitle\tbasis\n99999\t拍黄瓜\t黄瓜拍碎后加调料凉拌',
    'sourceId\ttitle\tbasis\n12345\t<script>\t黄瓜拍碎后加调料凉拌',
    'sourceId\ttitle\tbasis\n12345\t拍黄瓜\t猜测',
  ]) assert.throws(() => parseTitleReview(text, input));
});

test('original title is inserted in the normalizer header without losing attribution or descriptive text', () => {
  const expected = note.replace('\n介绍：', `\n原文标题：${originalTitle}\n介绍：`);
  assert.equal(retainOriginalTitle(note, originalTitle), expected);
  assert.equal(retainOriginalTitle(expected, originalTitle), expected);
  assert.throws(() => retainOriginalTitle(expected, '另外一个原名'), /不一致/);
  assert.throws(() => retainOriginalTitle('无来源', originalTitle), /作者链接/);
  assert.throws(() => retainOriginalTitle(`${note}${'长'.repeat(1500)}`, originalTitle), /超限/);
});

test('published rename keeps feed, detail and search consistent and preserves the complete recipe', () => {
  const before = postFixture();
  const frozen = structuredClone(before);
  const after = renameDocument(before, entry, review);
  assert.deepEqual(before, frozen);
  for (const title of [after.title, after.card.title, after.recipes[0].title, after.card.recipes[0].title]) assert.equal(title, '拍黄瓜');
  assert.deepEqual(JSON.parse(after.search), ['拍黄瓜', ['拍黄瓜', ['黄瓜']]]);
  assert.deepEqual(after.recipes[0].ingredients, before.recipes[0].ingredients);
  assert.deepEqual(after.recipes[0].steps, before.recipes[0].steps);
  assert.deepEqual(after.assetIds, before.assetIds);
  assert.deepEqual(after.categories, before.categories);
  assert.equal(after.importedFamilyCount, 3);
  const operation = makeTitleOperation(before, after, entry);
  assert.equal(operation.collection, 'posts');
  assert.deepEqual(applyTitleFields(before, operation.set), after);
  assert.ok(!Object.hasOwn(operation.set, 'recipes'));
  assert.ok(!Object.hasOwn(operation.set, 'card'));
});

test('unsafe recipe replacement, wrong source and bundles are rejected rather than renamed heuristically', () => {
  for (const mutate of [
    document => { document.kind = 'set'; },
    document => { document.status = 'deleted'; },
    document => { document.recipes.push(structuredClone(recipe)); },
    document => { document.recipes[0].provenance.url = 'https://other.test/'; },
  ]) {
    const document = postFixture();
    mutate(document);
    assert.throws(() => renameDocument(document, entry, review));
  }
  const before = postFixture();
  const after = renameDocument(before, entry, review);
  after.recipes[0].ingredients[0].quantity = 2;
  assert.throws(() => makeTitleOperation(before, after, entry), /名称以外/);
});

test('staged rename refreshes digest, keeps original source and never promotes publication or moderation', () => {
  const before = stageFixture();
  const stagedEntry = { ...entry, kind: 'staged', documentId: before._id };
  const after = renameDocument(before, stagedEntry, review);
  assert.equal(after.recipeDraft.title, '拍黄瓜');
  assert.equal(after.sourceReview.importOverrides.displayTitle, '拍黄瓜');
  assert.equal(after.sourceReview.importOverrides.supplementaryVideo, true);
  assert.deepEqual(after.source, before.source);
  assert.deepEqual(after.moderation, before.moderation);
  assert.equal(after.publiclyPublished, false);
  assert.deepEqual(after.assets, before.assets);
  assert.notEqual(after.contentDigest, before.contentDigest);
  assertStagedRecipe(after);
  const operation = makeTitleOperation(before, after, stagedEntry);
  const result = reconcileOperation(operation, before);
  assert.equal(result.update.q.contentDigest, before.contentDigest);
  assert.equal(result.update.upsert, false);
  assert.equal(result.update.multi, false);
  assert.equal(reconcileOperation(operation, after).alreadyApplied, true);
  assert.throws(() => renameDocument(before, stagedEntry, { ...review, category: '荤菜' }), /不一致/);
});

test('empty override objects are added without losing earlier source review metadata', () => {
  const withoutOverrides = { ...review };
  delete withoutOverrides.importOverrides;
  const next = renamedReview(withoutOverrides, '拍黄瓜');
  assert.equal(next.reviewedAt, withoutOverrides.reviewedAt);
  assert.deepEqual(next.importOverrides, { displayTitle: '拍黄瓜' });
  assert.ok(!withoutOverrides.importOverrides);
});

test('resuming is idempotent and accepts new counters without overwriting them', () => {
  const before = postFixture();
  const after = renameDocument(before, entry, review);
  const operation = makeTitleOperation(before, after, entry);
  const current = structuredClone(before);
  current.importedFamilyCount = 8;
  current.card.importedFamilyCount = 8;
  const result = reconcileOperation(operation, current);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.expected.importedFamilyCount, 8);
  assert.equal(result.expected.card.importedFamilyCount, 8);
  assert.equal(result.update.upsert, false);
  assert.equal(result.update.multi, false);
  assert.deepEqual(result.update.q.recipes, before.recipes);
  assert.ok(!Object.hasOwn(result.update.u.$set, 'card.importedFamilyCount'));
  assert.equal(reconcileOperation(operation, result.expected).alreadyApplied, true);
});

test('a concurrent content edit or deletion stops both first writes and resumption', () => {
  const before = postFixture();
  const after = renameDocument(before, entry, review);
  const operation = makeTitleOperation(before, after, entry);
  for (const baseline of [before, after]) for (const mutate of [
    document => { document.title = '其他人改的名字'; },
    document => { document.recipes[0].steps[0].text = '新做法'; },
    document => { document.recipes[0].ingredients[0].quantity = 2; },
    document => { document.status = 'deleted'; },
    document => { document.card.recipes[0].title = '未同步'; },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => reconcileOperation(operation, changed), /已变更/);
  }
  assert.throws(() => reconcileOperation(operation, null), /缺失/);
});

test('renaming emits byte-bounded UPDATE commands without replacement, upsert or family writes', () => {
  const before = postFixture();
  const operation = makeTitleOperation(before, renameDocument(before, entry, review), entry);
  const update = reconcileOperation(operation, before).update;
  const updates = Array.from({ length: 7 }, () => structuredClone(update));
  const maxBytes = Buffer.byteLength(titleUpdateCommand('posts', updates.slice(0, 2)));
  const batches = splitTitleUpdates('posts', updates, maxBytes);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.flat(), updates);
  for (const batch of batches) {
    const serialized = titleUpdateCommand('posts', batch);
    assert.ok(Buffer.byteLength(serialized) <= maxBytes);
    const command = JSON.parse(serialized)[0];
    assert.equal(command.CommandType, 'UPDATE');
    const payload = JSON.parse(command.Command);
    assert.equal(payload.ordered, true);
    assert.ok(payload.updates.every(item => !item.upsert && !item.multi && Object.keys(item.u).join() === '$set'));
  }
  assert.throws(() => titleUpdateCommand('families', [update]));
  assert.throws(() => splitTitleUpdates('posts', [update], 10), /过大/);
});

test('update success requires all matched and modified documents without any write error', () => {
  const response = { data: { requestId: 'request-test', results: [[{ ok: { $numberDouble: '1.0' }, n: { $numberInt: '3' }, nModified: { $numberInt: '3' } }]] } };
  assert.equal(verifyTitleUpdateResult(response, 3), 'request-test');
  assert.throws(() => verifyTitleUpdateResult(response, 4), /匹配数/);
  for (const result of [{ ok: 1, n: 3, nModified: 2 }, { ok: 1, n: 3 }, { ok: 1, n: 3, nModified: 3, writeErrors: [{ code: 1 }] }, { ok: 0, n: 0, nModified: 0 }]) assert.throws(() => verifyTitleUpdateResult({ data: { results: [[result]] } }, 3));
});

test('opaque database cluster signatures remain strings and never block a valid update receipt', () => {
  const response = { data: { requestId: 'cluster-request', results: [[{ ok: { $numberDouble: '1.0' }, n: { $numberInt: '13' }, nModified: { $numberInt: '13' }, $clusterTime: { signature: { keyId: { $numberLong: '7638976734712299522' } } } }]] } };
  assert.equal(verifyTitleUpdateResult(response, 13), 'cluster-request');
  assert.equal(response.data.results[0][0].$clusterTime.signature.keyId.$numberLong, '7638976734712299522');
  response.data.results[0][0].n = { $numberLong: '7638976734712299522' };
  assert.throws(() => verifyTitleUpdateResult(response, 13));
});
