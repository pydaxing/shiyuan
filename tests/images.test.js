import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseLocalImage, chooseLocalImages, compressNativePhoto, PHOTO_TARGET_BYTES, persistSelectedImages, previewImages, imageUploadLabel } from '../src/services/images.js';

test('photo preview opens only the tapped full-size image and never waits for the rest of the step', async () => {
  const calls = [];
  globalThis.uni = { previewImage: options => calls.push(options), showToast: options => calls.push(options) };
  await previewImages(['/static/tofu.png', '/static/egg.png'], '/static/egg.png');
  assert.deepEqual(calls[0], { current: '/static/egg.png', urls: ['/static/egg.png'] });
  await previewImages([''], '');
  assert.equal(calls[1].icon, 'none');
  assert.match(calls[1].title, /无法预览/);
});

test('native full-image viewer failures give feedback instead of becoming unhandled taps', async () => {
  const notices = [];
  globalThis.uni = { previewImage: async () => { throw new Error('当前设备无法打开这张原图'); }, showToast: notice => notices.push(notice) };
  await previewImages(['/static/tofu.png'], '/static/tofu.png');
  assert.equal(notices[0].title, '当前设备无法打开这张原图');
  assert.equal(notices[0].icon, 'none');
});

test('large portrait photos shrink the longest edge and retry using measured bytes', async () => {
  const attempts = [];
  globalThis.uni = {
    getImageInfo: async ({ src }) => src === 'original' ? { width: 1400, height: 6000, type: 'png' } : { width: 233, height: 1000, type: 'jpeg' },
    compressImage: async options => { attempts.push(options); return { tempFilePath: `compressed-${attempts.length}` }; },
    getFileInfo: async () => ({ size: attempts.length < 3 ? 1600000 : PHOTO_TARGET_BYTES }),
  };
  assert.equal(await compressNativePhoto('original'), 'compressed-3');
  assert.equal(attempts[0].compressedHeight, 1400);
  assert.equal(attempts[0].compressedWidth, 327);
  assert.deepEqual(attempts.map(item => item.src), ['original', 'original', 'original']);
  globalThis.uni.getFileInfo = async () => ({ size: 2000000 });
  await assert.rejects(compressNativePhoto('original'), /照片处理失败/);
});

for (const failure of ['oversized', 'dimensions-ignored', 'unsupported-format', 'api-failure']) {
  test(`native photo fallback re-encodes to a bounded JPEG when ${failure}`, async context => {
    const previousWechat = globalThis.wx;
    context.after(() => { globalThis.wx = previousWechat; });
    const original = 'camera.heic';
    const exports = [];
    const discarded = [];
    let nativeCalls = 0;
    const canvas = {
      width: 1, height: 1,
      createImage: () => ({ width: 4032, height: 3024, set src(value) { assert.equal(value, original); queueMicrotask(() => this.onload()); } }),
      getContext: () => ({ fillRect() {}, drawImage() {} }),
    };
    globalThis.wx = {
      createOffscreenCanvas: () => canvas,
      canvasToTempFilePath: options => { exports.push(options); options.success({ tempFilePath: `canvas-${exports.length}.jpg` }); },
      getFileSystemManager: () => ({ unlink: ({ filePath }) => discarded.push(filePath) }),
    };
    globalThis.uni = {
      getImageInfo: async ({ src }) => {
        if (src.startsWith('canvas-')) { const rendered = exports[Number(src.match(/\d+/)[0]) - 1]; return { width: rendered.destWidth, height: rendered.destHeight, type: 'jpeg' }; }
        if (src === original || failure === 'dimensions-ignored') return { width: 4032, height: 3024, type: 'jpeg' };
        return { width: 1400, height: 1050, type: failure === 'unsupported-format' ? 'heic' : 'jpeg' };
      },
      compressImage: async () => { nativeCalls += 1; if (failure === 'api-failure') throw { errMsg: 'compressImage:fail' }; return { tempFilePath: 'native.jpg' }; },
      getFileInfo: async ({ filePath }) => ({ size: filePath === 'canvas-1.jpg' || (filePath === 'native.jpg' && failure === 'oversized') ? 4000000 : PHOTO_TARGET_BYTES }),
    };
    assert.equal(await compressNativePhoto(original), 'canvas-2.jpg');
    assert.equal(nativeCalls, 1);
    assert.equal(exports.length, 2);
    assert.equal(exports[0].destWidth, 1400);
    assert.equal(exports[0].destHeight, 1050);
    assert.equal(exports[1].destWidth, 1200);
    assert.ok(exports.every(item => item.fileType === 'jpg' && item.width === item.destWidth && item.height === item.destHeight && item.quality <= 1));
    assert.ok(discarded.includes('canvas-1.jpg'));
    assert.ok(!discarded.includes(original));
    assert.ok(!discarded.includes('canvas-2.jpg'));
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);
  });
}

test('unsupported canvas APIs retain the native compression fallback without deleting the selected file', async context => {
  const previousWechat = globalThis.wx;
  context.after(() => { globalThis.wx = previousWechat; });
  let attempts = 0;
  const discarded = [];
  globalThis.wx = { createOffscreenCanvas() { throw new Error('not supported'); }, canvasToTempFilePath() {}, getFileSystemManager: () => ({ unlink: ({ filePath }) => discarded.push(filePath) }) };
  globalThis.uni = {
    getImageInfo: async () => ({ width: 1000, height: 700, type: 'jpeg' }),
    compressImage: async () => { attempts += 1; return { tempFilePath: attempts === 1 ? 'original.jpg' : 'compressed.jpg' }; },
    getFileInfo: async () => ({ size: attempts === 1 ? 2000000 : 300000 }),
  };
  assert.equal(await compressNativePhoto('original.jpg'), 'compressed.jpg');
  assert.equal(attempts, 2);
  assert.deepEqual(discarded, []);
});

test('multiple pickers share upload concurrency and failed paths can retry independently', async () => {
  let active = 0;
  let maximum = 0;
  let fail = true;
  const statuses = [];
  globalThis.uni = {
    getImageInfo: async () => ({ width: 1000, height: 1200, type: 'jpeg' }),
    getFileInfo: async () => ({ size: 100000 }),
    compressImage: async ({ src }) => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1; return { tempFilePath: src }; },
    saveFile: async ({ tempFilePath }) => { if (fail && tempFilePath === 'failed') throw new Error('network'); return { savedFilePath: tempFilePath }; },
  };
  const first = persistSelectedImages(['first', 'failed'], status => statuses.push(status));
  const second = persistSelectedImages(['third', 'fourth']);
  let failedPaths;
  await assert.rejects(first, error => { assert.deepEqual(error.images, ['first']); failedPaths = error.failedPaths; return true; });
  assert.deepEqual(await second, ['third', 'fourth']);
  assert.equal(maximum, 2);
  assert.equal(statuses[0].items[0].path, 'first');
  assert.equal(statuses.at(-1).completed, 1);
  assert.equal(statuses.at(-1).items.find(item => item.status === 'failed').preview, '');
  fail = false;
  assert.deepEqual(await persistSelectedImages(failedPaths), ['failed']);
});

test('photo selection cancellation leaves current photo unchanged', async () => {
  globalThis.uni = { showActionSheet: async () => ({ tapIndex: 1 }), chooseImage: async () => { throw { errMsg: 'chooseImage:fail cancel' }; } };
  assert.equal(await chooseLocalImage(), '');
});
test('photo permission failures are explicit', async () => {
  globalThis.uni = { showActionSheet: async () => ({ tapIndex: 1 }), chooseImage: async () => { throw { errMsg: 'permission denied' }; } };
  await assert.rejects(chooseLocalImage(), /权限/);
});
test('mini-program photos are compressed and saved, never stored as temp paths', async () => {
  const calls = [];
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 1 }),
    chooseImage: async () => ({ tempFilePaths: ['wxfile://tmp/example.jpg'] }),
    getImageInfo: async ({ src }) => ({ width: src.endsWith('small.jpg') ? 1400 : 2800, height: src.endsWith('small.jpg') ? 900 : 1800, type: 'jpeg' }),
    getFileInfo: async () => ({ size: 120000 }),
    compressImage: async (options) => { calls.push(options); return { tempFilePath: 'wxfile://tmp/small.jpg' }; },
    saveFile: async (options) => { calls.push(options); return { savedFilePath: 'wxfile://usr/saved.jpg' }; },
  };
  assert.equal(await chooseLocalImage(), 'wxfile://usr/saved.jpg');
  assert.equal(calls[0].quality, 76);
  assert.equal(calls[1].tempFilePath, 'wxfile://tmp/small.jpg');
});
test('mini-program disk failures do not return unusable temporary paths', async () => {
  globalThis.uni.saveFile = async () => { throw new Error('disk full'); };
  await assert.rejects(chooseLocalImage(), /保存失败/);
});
test('H5 photo processing constrains dimensions and persists JPEG instead of blob URL', async () => {
  const drawn = [];
  const canvas = { getContext: () => ({ fillRect() {}, drawImage(photo, left, top, width, height) { drawn.push({ width, height }); } }), toDataURL: (format) => { assert.equal(format, 'image/jpeg'); return 'data:image/jpeg;base64,YWJj'; } };
  globalThis.uni = { showActionSheet: async () => ({ tapIndex: 1 }), chooseImage: async () => ({ tempFilePaths: ['blob:test-photo'] }) };
  globalThis.document = { createElement: () => canvas };
  globalThis.Image = class { naturalWidth = 2800; naturalHeight = 1800; set src(value) { assert.equal(value, 'blob:test-photo'); queueMicrotask(() => this.onload()); } };
  try {
    assert.equal(await chooseLocalImage(), 'data:image/jpeg;base64,YWJj');
    assert.deepEqual(drawn[0], { width: 1400, height: 900 });
    assert.equal(canvas.width, 1);
    assert.equal(canvas.height, 1);
    canvas.toDataURL = () => 'data:image/jpeg;base64,' + 'A'.repeat(canvas.width > 1000 ? 500000 : 100000);
    assert.equal((await chooseLocalImage()).length, 100023);
    assert.deepEqual(drawn.slice(1).map(item => item.width), [1400, 1200, 1000]);
    canvas.toDataURL = () => 'data:image/jpeg;base64,' + 'A'.repeat(500000);
    await assert.rejects(chooseLocalImage(), /照片处理失败/);
    canvas.toDataURL = () => 'data:,';
    await assert.rejects(chooseLocalImage(), /照片处理失败/);
  } finally { delete globalThis.document; delete globalThis.Image; }
});

test('multiple photos are bounded by remaining slots and persisted in selection order', async () => {
  let requested;
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 1 }),
    chooseImage: async (options) => { requested = options.count; return { tempFilePaths: ['first', 'second', 'third'] }; },
    getImageInfo: async () => ({ width: 1400, height: 900, type: 'jpeg' }),
    getFileInfo: async () => ({ size: 120000 }),
    compressImage: async ({ src }) => ({ tempFilePath: `${src}-compressed` }),
    saveFile: async ({ tempFilePath }) => ({ savedFilePath: `wxfile://usr/${tempFilePath}.jpg` }),
  };
  assert.deepEqual(await chooseLocalImages(2), ['wxfile://usr/first-compressed.jpg', 'wxfile://usr/second-compressed.jpg']);
  assert.equal(requested, 2);
});

test('cancelling multi-photo selection preserves the current photo list', async () => {
  globalThis.uni = { showActionSheet: async () => ({ tapIndex: 1 }), chooseImage: async () => { throw { errMsg: 'chooseImage:fail cancel' }; } };
  assert.deepEqual(await chooseLocalImages(4), []);
});

test('multi-photo processing uses at most two workers, preserves order and reports completion', async () => {
  let active = 0;
  let maximum = 0;
  const progress = [];
  globalThis.uni = {
    chooseImage: async () => ({ tempFilePaths: ['first', 'second', 'third'] }),
    getImageInfo: async () => ({ width: 1400, height: 900, type: 'jpeg' }),
    getFileInfo: async () => ({ size: 120000 }),
    compressImage: async ({ src }) => {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, src === 'first' ? 20 : 1));
      active -= 1;
      return { tempFilePath: src };
    },
    saveFile: async ({ tempFilePath }) => ({ savedFilePath: tempFilePath }),
  };
  assert.deepEqual(await chooseLocalImages(3, ['album'], status => progress.push(status)), ['first', 'second', 'third']);
  assert.equal(maximum, 2);
  assert.deepEqual([...new Set(progress.map(item => item.completed))], [0, 1, 2, 3]);
  assert.ok(progress.every(item => item.total === 3));
  assert.ok(progress.every(item => item.completed === item.items.filter(photo => photo.status === 'done').length));
});

test('photo progress is percentage-only and reaches 100 only after server confirmation', () => {
  for (const status of ['waiting', 'processing', 'failed']) assert.equal(imageUploadLabel({ status }), '0%');
  assert.equal(imageUploadLabel(), '0%');
  assert.equal(imageUploadLabel({ status: 'uploading', progress: 42.4 }), '42%');
  assert.equal(imageUploadLabel({ status: 'uploading', progress: '68' }), '68%');
  for (const progress of [-1, NaN, Infinity, undefined]) assert.equal(imageUploadLabel({ status: 'uploading', progress }), '0%');
  for (const progress of [99.8, 100, 101]) assert.equal(imageUploadLabel({ status: 'uploading', progress }), '99%');
  assert.equal(imageUploadLabel({ status: 'saving' }), '99%');
  assert.equal(imageUploadLabel({ status: 'done' }), '100%');
});

test('partial image failure retains successful uploads for the editor instead of discarding them', async () => {
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 1 }),
    chooseImage: async () => ({ tempFilePaths: ['first', 'failed', 'third'] }),
    getImageInfo: async () => ({ width: 1400, height: 900, type: 'jpeg' }),
    getFileInfo: async () => ({ size: 120000 }),
    compressImage: async ({ src }) => ({ tempFilePath: src }),
    saveFile: async ({ tempFilePath }) => { if (tempFilePath === 'failed') throw new Error('failed'); return { savedFilePath: tempFilePath }; },
  };
  await assert.rejects(chooseLocalImages(3), error => {
    assert.deepEqual(error.images, ['first', 'third']);
    return true;
  });
});
