import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageStorage } from '../src/services/image-storage.js';

const photo = { base64: 'cGhvdG8=', contentType: 'image/jpeg' };
function fixture(overrides = {}) {
  const disk = new Map([['/private/shiyuan-photo-123-1.jpg', 6], ['/private/user-draft.jpg', 100]]);
  const metadata = new Map();
  const files = {
    readdirSync: () => [...disk.keys()].map(path => path.slice('/private/'.length)),
    unlink: ({ filePath, success, fail }) => {
      setImmediate(() => disk.delete(filePath) ? success() : fail({ errMsg: 'unlink:fail no such file or directory' }));
    },
    stat: ({ path, success }) => success({ stats: { size: disk.get(path) } }),
    statSync: path => { if (!disk.has(path)) throw new Error('ENOENT'); return { size: disk.get(path) }; },
    writeFile: ({ filePath, data, success }) => { disk.set(filePath, Buffer.from(data, 'base64').length); success(); },
    copyFile: ({ srcPath, destPath, success }) => { disk.set(destPath, disk.get(srcPath)); success(); },
    ...overrides,
  };
  const platform = () => ({ env: { USER_DATA_PATH: '/private' }, getFileSystemManager: () => files, getStorageSync: key => metadata.get(key), setStorageSync: (key, value) => metadata.set(key, value), removeStorageSync: key => metadata.delete(key) });
  return { ...createImageStorage(platform), restart: () => createImageStorage(platform), disk, files, metadata };
}

test('signed files download as binary, are length-checked, then copied and cleaned up', async () => {
  const disk = new Map();
  const urls = [];
  const platform = {
    env: { USER_DATA_PATH: '/private' },
    downloadFile(options) { urls.push(options.url); disk.set('/tmp/download.jpg', 8); options.success({ statusCode: 200, tempFilePath: '/tmp/download.jpg' }); },
    getFileSystemManager: () => ({
      readdirSync: () => [], stat: options => options.success({ stats: { size: disk.get(options.path) } }),
      copyFile: options => { disk.set(options.destPath, disk.get(options.srcPath)); options.success(); },
      unlink: options => { disk.delete(options.filePath); options.success(); },
    }),
  };
  const storage = createImageStorage(() => platform);
  const manifest = { url: 'https://storage.example.test/signed', urlExpiresAt: Date.now() + 300000, bytes: 8, contentType: 'image/jpeg' };
  const image = await storage.prepareImage(manifest);
  const saved = await storage.writeImage(image);
  await storage.releaseImage(image);
  assert.equal(disk.get(saved), 8);
  assert.equal(disk.has('/tmp/download.jpg'), false);
  assert.equal(urls.length, 1);
  await assert.rejects(storage.prepareImage({ ...manifest, bytes: 9 }), /不完整/);
  assert.equal(disk.has('/tmp/download.jpg'), false);
  await assert.rejects(storage.prepareImage({ ...manifest, url: 'http://storage.example.test/photo' }), { code: 'IMAGE_URL' });
  await assert.rejects(storage.prepareImage({ ...manifest, urlExpiresAt: 1 }), { code: 'IMAGE_URL' });
  assert.equal(urls.length, 2);
});

test('startup waits for old image cache cleanup and never deletes user drafts or new files', async () => {
  const storage = fixture();
  const write = storage.files.writeFile;
  storage.files.writeFile = options => { assert.ok(!storage.disk.has('/private/shiyuan-photo-123-1.jpg')); write(options); };
  const paths = await Promise.all(Array.from({ length: 6 }, () => storage.writeImage(photo)));
  assert.equal(new Set(paths).size, 6);
  assert.ok(paths.every(path => storage.disk.get(path) === 5));
  assert.equal(storage.disk.get('/private/user-draft.jpg'), 100);
  assert.equal(storage.disk.size, 7);
});

test('cache accounts for decoded bytes and measures a local photo before copying', async () => {
  const storage = fixture();
  assert.equal(storage.imageSize(photo), 5);
  assert.equal(storage.imageSize({ ...photo, base64: 'YQ==' }), 1);
  assert.equal(storage.imageSize({ ...photo, base64: 'YWJj' }), 3);
  assert.equal(await storage.imageSize({ localPath: '/private/user-draft.jpg' }), 100);
  assert.equal(storage.disk.get(await storage.writeImage({ localPath: '/private/user-draft.jpg' })), 100);
});

test('original image cache keeps the content format in its filename and restores it across restarts', async () => {
  const storage = fixture();
  for (const format of ['png', 'webp', 'heic']) {
    const path = await storage.writeImage({ localPath: '/private/user-draft.jpg', contentType: `image/${format}` });
    assert.ok(path.endsWith(`.${format}`));
    storage.saveEntries('family-a', [{ fileId: `cloud://original-${format}`, path, bytes: 100, expiresAt: Date.now() + 300000 }]);
    storage.flushCache();
    assert.equal(storage.restart().readEntries('family-a')[0].path, path);
  }
});

test('native quota errors retain diagnostics and failed partial files are deleted', async () => {
  const storage = fixture();
  storage.files.writeFile = ({ filePath, fail }) => {
    storage.disk.set(filePath, 1);
    fail({ errMsg: 'writeFile:fail the maximum size of the file storage limit is exceeded' });
  };
  await assert.rejects(storage.writeImage(photo), error => error.code === 'CACHE_QUOTA' && /maximum size/.test(error.detail));
  assert.deepEqual([...storage.disk.keys()], ['/private/user-draft.jpg']);
});

test('cleanup failures remain errors and are retried on the next write', async () => {
  const storage = fixture();
  const unlink = storage.files.unlink;
  storage.files.unlink = ({ fail }) => fail({ errMsg: 'unlink:fail permission denied' });
  await assert.rejects(storage.writeImage(photo), error => error.code === 'CACHE_IO' && /permission/.test(error.detail));
  storage.files.unlink = unlink;
  assert.ok(await storage.writeImage(photo));
  assert.equal(storage.disk.size, 2);
});

test('unsupported or oversized image payloads do not delete or write any files', async () => {
  const storage = fixture();
  for (const image of [{ ...photo, contentType: 'text/html' }, { ...photo, base64: '' }, { ...photo, base64: 'x'.repeat(1400001) }]) {
    await assert.rejects(storage.writeImage(image), /图片格式无效/);
  }
  assert.equal(storage.disk.size, 2);
});

test('restart restores the scoped image index and preserves only indexed photos during cleanup', async () => {
  const storage = fixture();
  const path = await storage.writeImage(photo);
  const orphan = await storage.writeImage(photo);
  const entry = { fileId: 'cloud://photo', path, bytes: 5, expiresAt: Date.now() + 300000 };
  storage.saveEntries('alice:family', [entry]);
  storage.flushCache();
  const restarted = storage.restart();
  assert.deepEqual(restarted.readEntries('alice:family'), [entry]);
  assert.deepEqual(restarted.readEntries('bob:family'), []);
  await restarted.writeImage(photo);
  assert.equal(storage.disk.has(path), true);
  assert.equal(storage.disk.has(orphan), false);
  assert.equal(storage.disk.has('/private/user-draft.jpg'), true);
});

test('restore reads only metadata and checks owned file bytes asynchronously on demand', async () => {
  const storage = fixture();
  const path = await storage.writeImage(photo);
  storage.saveEntries('scope', [null, { path, fileId: 'photo', bytes: 4, expiresAt: 1 }, { path: '/private/user-draft.jpg', fileId: 'photo', bytes: 100, expiresAt: 1 }, { path: '/private/shiyuan-cache-photo-1-1.jpg', fileId: 'photo', bytes: 5, expiresAt: 1 }]);
  storage.flushCache();
  storage.files.statSync = () => assert.fail('restoring metadata must not block the JS thread on file IO');
  const restarted = storage.restart();
  const candidates = restarted.readEntries('scope');
  assert.equal(candidates.length, 2);
  assert.deepEqual(await Promise.all(candidates.map(entry => restarted.checkImage(entry.path, entry.bytes))), [false, false]);
  assert.equal(await restarted.checkImage(path, 5), true);
  assert.equal(await restarted.checkImage('/private/user-draft.jpg', 100), false);
});

test('corrupt image index does not prevent writing new photos', async () => {
  const storage = fixture();
  storage.metadata.set('shiyuan-image-index-v1', JSON.stringify({ version: 1, entries: [['current', { savedAt: Date.now(), value: { scope: 'scope', entries: {} } }]] }));
  const restarted = storage.restart();
  assert.deepEqual(restarted.readEntries('scope'), []);
  assert.ok(await restarted.writeImage(photo));
});
