import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildStagedRecipe, assertStagedRecipe, documentDigest, materializeStagedRecipe, selectMissingDocuments, unwrapIdeResult, insertCommand, splitInsertBatches, verifyInsertResult, decodeDatabaseJson } from '../scripts/admin-recipe-import.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const target = { appid: 'wx-test', env: 'test-env' };
const sourceHash = digest('image');
const imageValue = 'data:image/jpeg;base64,aW1hZ2U=';
const image = { url: 'https://images.example.test/recipe.jpg', alt: '原作者图片' };
const sourceUrl = 'https://www.xiachufang.com/recipe/12345/';
const assetId = `sha256:${sourceHash}`;

function fixture() {
  const raw = {
    source: '下厨房', sourceUrl, title: '凉拌黄瓜', author: '原作者', authorUrl: 'https://www.xiachufang.com/cook/12345/',
    fetchedAt: '2026-09-10T01:00:00Z', authorizationId: 'auth-test', sourceHtml: '<div>原文</div>',
    description: '原文说明', tips: '', cover: image,
    ingredients: [{ name: '黄瓜', amountText: '1根' }, { name: '盐', amountText: '适量' }],
    steps: [{ text: '拍碎黄瓜，拌匀。', images: [image, image] }, { text: '调味。', images: [] }],
  };
  const review = { sourceUrl, sourceHtmlFingerprint: digest(raw.sourceHtml), approved: true, category: '素菜', reviewedAt: '2026-09-10T02:00:00Z', notes: '来源文字复核；未逐图视觉检查' };
  return {
    raw, review,
    assets: { [image.url]: { path: '/local/archive/image.jpg', sha256: sourceHash, width: 100, height: 90, bytes: 5, fileId: imageValue } },
    files: new Map([[sourceHash, { uploadHash: sourceHash }]]),
    normalized: {
      ready: true, sourceReview: { matched: true }, completeness: { imageBytesVerified: true },
      recipe: { title: raw.title, category: '素菜', servings: 2, minutes: null, image: imageValue,
        ingredients: [{ name: '黄瓜', quantity: 1, unit: '根' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }],
        steps: raw.steps.map(step => ({ title: '', text: step.text, images: step.images.map(() => imageValue) })),
        provenance: { source: '下厨房', url: sourceUrl, license: 'User authorized; not public domain', attribution: '原作者', note: '保留原文用量' },
      },
    },
  };
}

const makeDocument = () => buildStagedRecipe(fixture(), {}, target);

test('staging preserves all text, image positions, original quantities and attribution without pretending to publish', () => {
  const document = makeDocument();
  assert.equal(document.assets.length, 1);
  assert.deepEqual(document.recipeDraft.steps[0].imageAssetIds, [assetId, assetId]);
  assert.deepEqual(document.recipeDraft.steps[1].imageAssetIds, []);
  assert.equal(document.recipeDraft.ingredients[1].amountText, '适量');
  assert.equal(document.source.ingredients[1].amountText, '适量');
  assert.equal(document.source.author, '原作者');
  assert.equal(document.recipeDraft.provenance.attribution, '原作者');
  assert.equal(document.publiclyPublished, false);
  assert.equal(document.moderation.status, 'not_completed');
  assert.equal(document.assets[0].fileId, null);
  assert.ok(!JSON.stringify(document).includes('base64'));
  assert.ok(!JSON.stringify(document).includes('/local/archive'));
  assert.deepEqual(document, makeDocument());
});

test('the admin stage cannot be prepared from unvalidated or stale source content', () => {
  for (const mutate of [
    prepared => { prepared.normalized.ready = false; },
    prepared => { prepared.normalized.sourceReview.matched = false; },
    prepared => { prepared.normalized.completeness.imageBytesVerified = false; },
    prepared => { prepared.review.sourceHtmlFingerprint = 'stale'; },
    prepared => { prepared.review.category = '不存在的分类'; },
    prepared => { prepared.raw.steps[0].images.pop(); },
  ]) {
    const prepared = fixture();
    mutate(prepared);
    assert.throws(() => buildStagedRecipe(prepared, {}, target));
  }
});

test('reuse requires an upload receipt from the same environment and exact image content', () => {
  const uploaded = { sourceHash, uploadHash: sourceHash, protected: true, fileId: 'cloud://test-env.bucket/approved/file.bin' };
  const document = buildStagedRecipe(fixture(), { [sourceHash]: uploaded }, target);
  assert.equal(document.assets[0].cloudReferenceStatus, 'receipt_available_not_reverified');
  for (const change of [{ sourceHash: 'other' }, { uploadHash: 'other' }, { protected: false }, { fileId: 'cloud://another-env.bucket/approved/file.bin' }]) {
    assert.throws(() => buildStagedRecipe(fixture(), { [sourceHash]: { ...uploaded, ...change } }, target));
  }
});

test('materialization refuses missing or unverified images and returns schema-valid recipes only', () => {
  const document = makeDocument();
  assert.throws(() => materializeStagedRecipe(document, {}), /图片须上传/);
  const proof = { fileId: 'cloud://test-env.bucket/approved/file.bin', uploadHash: sourceHash, confirmed: true };
  assert.throws(() => materializeStagedRecipe(document, { [assetId]: { ...proof, confirmed: false } }));
  assert.throws(() => materializeStagedRecipe(document, { [assetId]: { ...proof, uploadHash: 'changed' } }));
  const recipe = materializeStagedRecipe(document, { [assetId]: proof });
  assert.deepEqual(recipe.steps[0].images, [proof.fileId, proof.fileId]);
  assert.equal(recipe.image, proof.fileId);
  assert.equal(recipe.ingredients[1].amountText, '适量');
  assert.equal(document.publiclyPublished, false);
});

test('batch replay inserts missing records only and never overwrites conflicting cloud data', () => {
  const document = makeDocument();
  assert.deepEqual(selectMissingDocuments([document], []), [document]);
  assert.deepEqual(selectMissingDocuments([document], [{ ...document, _openid: '' }]), []);
  const changed = structuredClone(document);
  changed.recipeDraft.title = '已被别人修改';
  assert.throws(() => selectMissingDocuments([document], [changed]), /内容不同/);
  assert.throws(() => selectMissingDocuments([document, document], []), /重复来源/);
});

test('digest detects mutations and safety fields cannot be promoted even with a new digest', () => {
  const document = makeDocument();
  document.recipeDraft.category = '荤菜';
  assert.throws(() => assertStagedRecipe(document), /摘要/);
  for (const mutate of [
    entry => { entry.publiclyPublished = true; },
    entry => { entry.status = 'published'; },
    entry => { entry.moderation.status = 'passed'; },
    entry => { entry.recipeDraft.imageAssetId = 'missing'; },
  ]) {
    const entry = makeDocument();
    mutate(entry);
    entry.contentDigest = documentDigest(entry);
    assert.throws(() => assertStagedRecipe(entry));
  }
});

test('official confirmation and partial failures never become reported batch success', () => {
  for (const response of [{ pending: true, taskId: 'pending-1' }, { ok: true, result: { pending: true, taskId: 'pending-2' } }]) {
    assert.throws(() => unwrapIdeResult(response), { code: 'IDE_CONFIRMATION' });
  }
  assert.throws(() => unwrapIdeResult({ ok: true, result: { success: false, inserted: 3 } }));
  assert.deepEqual(unwrapIdeResult({ ok: true, result: { success: true, inserted: 192 } }), { success: true, inserted: 192 });
});

test('the single logical import uses byte-bounded insert-only chunks without losing documents', () => {
  const document = makeDocument();
  const documents = Array.from({ length: 10 }, () => structuredClone(document));
  const maxBytes = Buffer.byteLength(insertCommand(documents.slice(0, 2)));
  const batches = splitInsertBatches(documents, maxBytes);
  assert.equal(batches.length, 5);
  assert.deepEqual(batches.flat(), documents);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(insertCommand(batch)) <= maxBytes);
    const command = JSON.parse(insertCommand(batch))[0];
    assert.equal(command.CommandType, 'INSERT');
    assert.equal(command.TableName, 'imports');
    assert.equal(JSON.parse(command.Command).ordered, true);
  }
  assert.throws(() => splitInsertBatches([document], 100), /单条记录/);
});

test('CloudBase extended JSON receipts require full insert count with no partial write errors', () => {
  const response = { data: { requestId: 'verified-request', results: [[{ ok: { $numberDouble: '1.0' }, n: { $numberInt: '8' } }]] } };
  assert.equal(verifyInsertResult(response, 8), 'verified-request');
  assert.throws(() => verifyInsertResult(response, 9), /数量不一致/);
  assert.throws(() => verifyInsertResult({ data: { results: [[{ ok: 1, n: 8, writeErrors: [{ code: 11000 }] }]] } }, 8), /部分插入失败/);
  assert.throws(() => verifyInsertResult({ data: { results: [[{ ok: 0, n: 0 }]] } }, 0), /插入失败/);
});

test('CloudBase full readback decodes numeric quantities without changing source text or asset IDs', () => {
  assert.deepEqual(decodeDatabaseJson({ ingredients: [{ name: '盐', quantity: null, amountText: '适量' }, { name: '黄瓜', quantity: { $numberDouble: '0.5' } }], version: { $numberInt: '1' }, bytes: { $numberLong: '32768' }, source: '100g' }), {
    ingredients: [{ name: '盐', quantity: null, amountText: '适量' }, { name: '黄瓜', quantity: 0.5 }], version: 1, bytes: 32768, source: '100g',
  });
  assert.throws(() => decodeDatabaseJson({ $numberLong: '9223372036854775807' }));
});
