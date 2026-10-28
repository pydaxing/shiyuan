import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { createDisplayImage } from '../server/image-processing.mjs';
import { imageVersion, imageRequest } from '../src/domain/image-variants.js';
import { createMediaBatch } from '../src/services/media-batch.js';
import { COVER_RATIOS } from '../src/domain/image-crop.js';

test('image variants have separate immutable cache versions and originals retain the legacy key', () => {
  for (const variant of ['original', 'card', 'detail', 'avatar']) {
    const key = imageVersion('cloud://env/photo.bin', variant);
    assert.deepEqual(imageRequest(key), { fileId: 'cloud://env/photo.bin', variant });
  }
  assert.equal(imageVersion('cloud://env/photo.bin'), 'cloud://env/photo.bin');
});

test('display images respect dimensions, strip EXIF and never enlarge small recipe step images', async () => {
  const source = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#587040' } }).jpeg().withMetadata().toBuffer();
  for (const [variant, edge] of [['card', 480], ['detail', 960]]) {
    const image = await createDisplayImage(source, variant);
    const meta = await sharp(image.bytes).metadata();
    assert.equal(meta.width, edge);
    assert.equal(meta.height, edge * 2 / 3);
    assert.equal(meta.exif, undefined);
    assert.ok(image.size < source.length);
  }
  const small = await sharp(source).resize(300).jpeg().toBuffer();
  const display = await createDisplayImage(small, 'detail');
  assert.equal(display.width, 300);
  assert.equal(display.height, 200);
});

test('display image processing rejects invalid bytes and invalid variants', async () => {
  await assert.rejects(createDisplayImage(Buffer.from('not an image'), 'card'));
  await assert.rejects(createDisplayImage(Buffer.from('not an image'), 'original'));
});

test('card and detail previews preserve the same golden cover crop instead of generating square thumbnails', async () => {
  const width = 1600;
  const height = Math.round(width / COVER_RATIOS.recipe);
  const source = await sharp({ create: { width, height, channels: 3, background: '#304d60' } }).jpeg().toBuffer();
  for (const variant of ['card', 'detail']) {
    const preview = await createDisplayImage(source, variant);
    assert.ok(Math.abs(preview.width / preview.height - COVER_RATIOS.recipe) < .005);
    assert.ok(preview.width > preview.height);
  }
});

test('high-detail camera photos still produce bounded previews instead of failing an otherwise valid upload', async () => {
  const original = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).jpeg({ quality: 60 }).toBuffer();
  assert.ok(original.length < 480 * 1024);
  const display = await createDisplayImage(original, 'detail');
  assert.ok(display.size <= 120000);
  assert.ok(display.width >= 480);
});

test('simultaneous thumbnail reads share requests with at most six images per batch', async () => {
  const calls = [];
  const fetch = createMediaBatch(async (action, payload) => {
    calls.push({ action, payload });
    return { images: payload.images.map(request => ({ ok: true, data: { version: request.fileId } })) };
  });
  const results = await Promise.all(Array.from({ length: 14 }, (_, index) => fetch({ fileId: `image-${index}`, variant: 'card' })));
  assert.deepEqual(calls.map(call => call.payload.images.length), [6, 6, 2]);
  assert.ok(calls.every(call => call.action === 'mediaBatch'));
  assert.deepEqual(results.map(result => result.version), Array.from({ length: 14 }, (_, index) => `image-${index}`));
});

test('one forbidden image does not prevent other images in the batch from loading', async () => {
  const fetch = createMediaBatch(async () => ({ images: [{ ok: false, code: 'FORBIDDEN', message: '无权查看图片' }, { ok: true, data: { base64: 'good' } }] }));
  const result = await Promise.allSettled([fetch({ fileId: 'private', variant: 'card' }), fetch({ fileId: 'public', variant: 'card' })]);
  assert.equal(result[0].reason.code, 'FORBIDDEN');
  assert.equal(result[1].value.base64, 'good');
});

test('malformed batch responses fail all requests rather than leaving loading promises pending', async () => {
  const fetch = createMediaBatch(async () => ({ images: [] }));
  await assert.rejects(fetch({ fileId: 'image', variant: 'card' }), /响应不完整/);
});

test('only transient thumbnail failures retry once; successful and forbidden images are not refetched', async () => {
  const calls = [];
  const fetch = createMediaBatch(async (action, payload) => {
    calls.push(payload.images.map(image => image.fileId));
    return calls.length === 1 ? { images: [{ ok: false, code: 'ECONNRESET' }, { ok: true, data: 'cached' }, { ok: false, code: 'FORBIDDEN', message: 'denied' }] } : { images: [{ ok: true, data: 'recovered' }] };
  }, { wait: async () => {} });
  const results = await Promise.allSettled(['transient', 'public', 'private'].map(fileId => fetch({ fileId, variant: 'card' })));
  assert.deepEqual(calls, [['transient', 'public', 'private'], ['transient']]);
  assert.equal(results[0].value, 'recovered');
  assert.equal(results[1].value, 'cached');
  assert.equal(results[2].reason.code, 'FORBIDDEN');
});

test('a WeChat transport failure retries the whole batch once without losing individual results', async () => {
  let calls = 0;
  const fetch = createMediaBatch(async () => {
    calls += 1;
    if (calls === 1) throw { errCode: -1, errMsg: 'cloud.callFunction:fail network error' };
    return { images: [{ ok: true, data: 'photo' }] };
  }, { wait: async () => {} });
  assert.equal(await fetch({ fileId: 'photo', variant: 'card' }), 'photo');
  assert.equal(calls, 2);
});

test('transport retries are bounded and never retry explicit permission failures', async () => {
  for (const code of ['NETWORK_ERROR', 'FORBIDDEN']) {
    let calls = 0;
    const fetch = createMediaBatch(async () => { calls += 1; throw Object.assign(new Error(code), { code }); }, { wait: async () => {} });
    await assert.rejects(fetch({ fileId: 'photo', variant: 'card' }));
    assert.equal(calls, code === 'NETWORK_ERROR' ? 2 : 1);
  }
});


test('avatars are bounded to 192 pixels and 20 KB even for high-detail large uploads', async () => {
  const source = await sharp(randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).png().toBuffer();
  const avatar = await createDisplayImage(source, 'avatar');
  assert.ok(avatar.width <= 192 && avatar.height <= 192);
  assert.ok(avatar.size <= 20000);
  assert.ok(avatar.size < source.length / 20);
});
