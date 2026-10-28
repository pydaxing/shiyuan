import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { buildStagedRecipe } from '../scripts/admin-recipe-import.mjs';
import { sourceDigest, assertOwnerReview, missingExactRecords, verifyStoredFiles, prepareEncryptedMedia, ownerReviewedPost } from '../scripts/publish-owner-reviewed.mjs';
import { decryptImage } from '../server/media-encryption.mjs';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { emptySnapshot } from '../src/domain/empty.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const config = { appid: 'wx-test', env: 'test-env' };

function fixture() {
  const image = 'data:image/jpeg;base64,aW1hZ2U=';
  const sourceUrl = 'https://www.xiachufang.com/recipe/1234/';
  const sourceHash = hash('image');
  const raw = { sourceUrl, sourceHtml: 'original', authorizationId: 'auth', cover: { url: 'https://example.test/image.jpg' }, steps: [{ text: '切块拌匀', images: [{ url: 'https://example.test/image.jpg' }] }] };
  const recipe = { title: '凉拌黄瓜', category: '素菜', servings: 2, minutes: null, image, ingredients: [{ name: '黄瓜', quantity: 1, unit: '根' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }], steps: [{ title: '拌匀', text: '切块拌匀', images: [image] }], provenance: { source: '下厨房', url: sourceUrl, license: '用户授权', attribution: '作者', note: '' } };
  const sourceReview = { sourceUrl, sourceHtmlFingerprint: hash('original'), category: '素菜', approved: true };
  const document = buildStagedRecipe({ raw, review: sourceReview, assets: { 'https://example.test/image.jpg': { sha256: sourceHash, fileId: image } }, files: new Map([[sourceHash, { uploadHash: sourceHash }]]), normalized: { ready: true, sourceReview: { matched: true }, completeness: { imageBytesVerified: true }, recipe } }, {}, config);
  const review = { _id: 'owner-review-test', kind: 'owner_reviewed_import_v1', method: 'user_confirmation', platformCheck: 'not_performed_for_this_import', confirmation: '用户确认本批内容', recordedAt: new Date(1789090000000).toISOString(), authorizationId: 'auth', ...config, sourceCount: 1, sourceDigest: sourceDigest([document]) };
  const plan = { review, config, documents: [document], family: { id: 'family', ownerId: 'owner', name: '我的家', members: [{ id: 'owner', name: '我' }] }, createdAt: 1789090000000 };
  const files = { [`sha256:${sourceHash}`]: { confirmed: true, uploadHash: sourceHash, fileId: 'cloud://test-env.bucket/approved/photo.bin' } };
  return { document, review, plan, files, recipe };
}

test('owner confirmation is bound to this exact batch and target without claiming platform approval', () => {
  const { document, review } = fixture();
  assertOwnerReview(review, [document], config);
  for (const patch of [{ env: 'other' }, { appid: 'other' }, { method: 'platform' }, { platformCheck: 'passed' }, { sourceCount: 2 }, { sourceDigest: 'changed' }, { confirmation: '' }, { authorizationId: '' }]) {
    assert.throws(() => assertOwnerReview({ ...review, ...patch }, [document], config));
  }
  const changed = structuredClone(document);
  changed.recipeDraft.title = '其他菜';
  assert.throws(() => assertOwnerReview(review, [changed], config), /摘要/);
});

test('batch digest is stable across database ordering and detects changed identities or versions', () => {
  const documents = [{ _id: 'second', contentDigest: 'digest-2' }, { _id: 'first', contentDigest: 'digest-1' }];
  assert.equal(sourceDigest(documents), sourceDigest([...documents].reverse()));
  assert.notEqual(sourceDigest(documents), sourceDigest([{ ...documents[0], contentDigest: 'different' }, documents[1]]));
});

test('insert-only reconciliation resumes missing rows but never overwrites unrelated or modified data', () => {
  const rows = [{ _id: 'one', nested: { value: 1 } }, { _id: 'two', nested: { value: 2 } }];
  assert.deepEqual(missingExactRecords(rows, [{ ...rows[0], serverOnly: true }, { _id: 'unrelated' }]), [rows[1]]);
  assert.deepEqual(missingExactRecords(rows, [...rows].reverse()), []);
  assert.throws(() => missingExactRecords(rows, [{ _id: 'one', nested: { value: 3 } }]), /不覆盖/);
  assert.throws(() => missingExactRecords([rows[0], rows[0]], []), /重复/);
});

test('storage confirmation requires every ciphertext byte count and checksum to match', () => {
  const files = [{ cloudPath: 'prefix/image.bin', size: 42, md5: 'abcd' }];
  const object = { key: files[0].cloudPath, size: '42', eTag: '"ABCD"' };
  verifyStoredFiles(files, [object]);
  assert.throws(() => verifyStoredFiles(files, []), /缺少/);
  assert.throws(() => verifyStoredFiles(files, [{ ...object, size: '41' }]), /大小/);
  assert.throws(() => verifyStoredFiles(files, [{ ...object, eTag: 'different' }]), /字节/);
});

test('owner-reviewed publication preserves complete recipe and attribution with truthful review provenance', () => {
  const { document, plan, files, recipe } = fixture();
  const baseline = structuredClone(plan);
  const post = ownerReviewedPost(document, files, plan);
  assert.equal(post.status, 'published');
  assert.equal(post.contentReview.method, 'user_confirmation');
  assert.equal(post.contentReview.platformCheck, 'not_performed_for_this_import');
  assert.equal(post.contentReview.sourceDigest, document.contentDigest);
  assert.deepEqual(post.recipes[0].ingredients, recipe.ingredients);
  assert.deepEqual(post.recipes[0].provenance, recipe.provenance);
  assert.deepEqual(post.recipes[0].steps.map(({ title, text }) => ({ title, text })), recipe.steps.map(({ title, text }) => ({ title, text })));
  assert.equal(post.card.title, recipe.title);
  assert.deepEqual(post.categories, ['素菜']);
  assert.deepEqual(post.assetIds, ['cloud://test-env.bucket/approved/photo.bin']);
  assert.deepEqual(ownerReviewedPost(document, files, plan), post);
  assert.deepEqual(plan, baseline);
  assert.equal(document.publiclyPublished, false);
  assert.equal(document.moderation.status, 'not_completed');
  assert.throws(() => ownerReviewedPost(document, {}, plan), /图片/);
  const emptyPlan = { ...plan, documents: [], review: { ...plan.review, sourceCount: 0, sourceDigest: sourceDigest([]) } };
  assert.throws(() => ownerReviewedPost(document, files, emptyPlan), /不属于/);
});

test('bulk posts work through ordinary category/search feeds, details and authorized images for another family', async () => {
  const { document, plan, files } = fixture();
  const post = ownerReviewedPost(document, files, plan);
  const repository = memoryRepository();
  const viewerId = hash('viewer-openid');
  await repository.set('users', viewerId, { familyId: 'viewer-family' });
  await repository.set('families', 'viewer-family', { ...emptySnapshot().family, id: 'viewer-family', ownerId: viewerId, members: [{ id: viewerId, name: '我' }] });
  await repository.set('posts', post.id, post);
  await repository.set('media', hash(post.image), { fileId: post.image, familyId: plan.family.id, confirmed: true, encryptionKey: 'private-key' });
  const requests = [];
  const app = createApplication({ repository, signFiles: async () => ({}), readImage: async (fileId, media, variant) => { requests.push({ fileId, variant }); return { dataUrl: 'data:image/jpeg;base64,aW1hZ2U=' }; } });
  const call = event => app(event, { OPENID: 'viewer-openid' });
  const feed = await call({ action: 'feed', compact: true, category: '素菜', type: '菜品', search: '黄瓜' });
  assert.equal(feed.ok, true);
  assert.equal(feed.data.posts.length, 1);
  assert.equal(feed.data.posts[0].title, post.title);
  assert.equal(feed.data.posts[0].recipes[0].steps, undefined);
  assert.equal((await call({ action: 'feed', compact: true, category: '荤菜' })).data.posts.length, 0);
  const details = await call({ action: 'readPost', postId: post.id, paginateComments: true });
  assert.equal(details.ok, true);
  assert.deepEqual(details.data.post.recipes[0].steps, post.recipes[0].steps);
  assert.equal(details.data.post.assetIds, undefined);
  const image = await call({ action: 'mediaBatch', images: [{ fileId: post.image, variant: 'card' }, { fileId: post.image, variant: 'detail' }] });
  assert.ok(image.data.images.every(result => result.ok));
  assert.equal(JSON.stringify(image).includes('private-key'), false);
  assert.deepEqual(requests.map(request => request.variant), ['card', 'detail']);
  await repository.set('posts', post.id, { ...post, status: 'deleted' });
  assert.equal((await call({ action: 'mediaContent', fileId: post.image })).code, 'FORBIDDEN');
});

test('admin media produces decryptable original and bounded card/detail images with private keys', async () => {
  const bytes = await sharp({ create: { width: 1200, height: 1600, channels: 3, background: '#bf7842' } }).jpeg().toBuffer();
  const asset = { uploadHash: hash(bytes) };
  const context = { cloudPrefix: 'approved/family/owner-review-test', storageOrigin: 'cloud://test-env.bucket', userId: 'owner', familyId: 'family', createdAt: 1789090000000, reviewId: 'owner-review-test' };
  const { record, files } = await prepareEncryptedMedia(bytes, asset, context);
  assert.equal(files.length, 3);
  assert.equal(record._id, hash(record.fileId));
  assert.equal(record.contentReview.platformCheck, 'not_performed_for_this_import');
  assert.deepEqual(decryptImage(files[0].bytes, record.encryptionKey), bytes);
  for (const [index, variant, edge, maxBytes] of [[1, 'card', 480, 80000], [2, 'detail', 960, 120000]]) {
    const display = record.variants[variant];
    const decrypted = decryptImage(files[index].bytes, display.encryptionKey);
    const metadata = await sharp(decrypted).metadata();
    assert.ok(metadata.width <= edge && metadata.height <= edge && decrypted.length <= maxBytes);
    assert.equal(display.width, metadata.width);
    assert.equal(display.height, metadata.height);
    assert.equal(display.bytes, decrypted.length);
    assert.equal(display.fileId, `${context.storageOrigin}/${files[index].cloudPath}`);
  }
  assert.equal(new Set([record.encryptionKey, record.variants.card.encryptionKey, record.variants.detail.encryptionKey]).size, 3);
  verifyStoredFiles(files, files.map(file => ({ key: file.cloudPath, size: file.size, eTag: createHash('md5').update(file.bytes).digest('hex') })));
  await assert.rejects(prepareEncryptedMedia(Buffer.from('changed'), asset, context), /摘要/);
});
