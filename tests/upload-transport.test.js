import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext, constants } from 'node:vm';
import { build } from 'esbuild';
import sharp from 'sharp';
import { decryptImage } from '../server/media-encryption.mjs';

const backend = await build({ entryPoints: ['server/wechat.mjs'], bundle: true, platform: 'node', target: 'node18', format: 'cjs', write: false, external: ['wx-server-sdk', 'sharp', '@cloudbase/node-sdk'] });
const frontend = await build({ stdin: { contents: "export * from './src/services/images.js'; export * from './src/services/cloud.js';", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_DATA_MODE: 'cloud', VITE_CLOUD_ENV: 'test-only' }) } });
const nodeRequire = createRequire(import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

test('original photos and bounded previews travel as files through the full client, SDK and private storage', async context => {
  const previous = { wx: globalThis.wx, uni: globalThis.uni };
  context.after(() => Object.assign(globalThis, previous));
  let openid = 'transport-test-user';
  const userId = hash(openid);
  const rows = new Map([
    [`users:${userId}`, { familyId: 'test-family' }],
    ['families:test-family', { id: 'test-family', members: [{ id: userId }] }],
  ]);
  const storedFiles = new Map();
  const temporaryFiles = new Map();
  const calls = [];
  const transfers = [];
  const signedFiles = new Map();
  const downloadedFiles = [];
  const progress = [];
  const uploadProgress = [];
  let savedCount = 0;
  const database = {
    collection(name) {
      return {
        where: query => ({ limit: () => ({ get: async () => ({ data: rows.has(`${name}:${query._id}`) ? [rows.get(`${name}:${query._id}`)] : [] }) }) }),
        doc: id => ({ set: async ({ data }) => rows.set(`${name}:${id}`, data), remove: async () => rows.delete(`${name}:${id}`) }),
      };
    },
    runTransaction: callback => callback(database),
  };
  const sdk = {
    init() {}, getWXContext: () => ({ OPENID: openid }), database: () => database,
    uploadFile: async ({ fileContent, cloudPath }) => { const fileID = `cloud://test/${cloudPath}`; storedFiles.set(fileID, fileContent); savedCount += 1; return { fileID }; },
    downloadFile: async ({ fileID }) => { assert.ok(storedFiles.has(fileID), 'uploaded file must exist'); return { fileContent: storedFiles.get(fileID) }; },
    deleteFile: async ({ fileList }) => { fileList.forEach(fileId => storedFiles.delete(fileId)); },
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map(({ fileID, maxAge }) => {
      assert.ok(storedFiles.has(fileID));
      const tempFileURL = `https://private.example.test/photo-${signedFiles.size}`;
      signedFiles.set(tempFileURL, fileID);
      return { fileID, maxAge, tempFileURL, status: 0 };
    }) }),
  };
  const module = { exports: {} };
  runInNewContext(backend.outputFiles[0].text, { module, exports: module.exports, process: { env: { IMAGE_DELIVERY_PRIVATE: '1' } }, console, Buffer, setTimeout, require: name => name === 'wx-server-sdk' ? sdk : nodeRequire(name) }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  globalThis.wx = {
    env: { USER_DATA_PATH: '/test-device' },
    downloadFile: options => {
      const fileId = signedFiles.get(options.url);
      assert.ok(fileId, 'downloads require a server-signed URL');
      const tempFilePath = `/download-${downloadedFiles.length}`;
      temporaryFiles.set(tempFilePath, storedFiles.get(fileId));
      downloadedFiles.push(fileId);
      options.success({ statusCode: 200, tempFilePath });
    },
    getFileSystemManager: () => ({
      readFile() { assert.fail('file bytes must not be embedded into RPC data'); },
      readdirSync: () => [],
      stat: options => options.success({ stats: { size: temporaryFiles.get(options.path)?.length || 0 } }),
      statSync: path => ({ size: temporaryFiles.get(path)?.length || 0 }),
      copyFile: options => { temporaryFiles.set(options.destPath, temporaryFiles.get(options.srcPath)); options.success(); },
      unlink: options => { temporaryFiles.delete(options.filePath); options.success?.(); },
    }),
    cloud: {
      init() {},
      callFunction: async ({ data }) => {
        if (Buffer.byteLength(JSON.stringify(data)) > 100 * 1024) throw new Error('cloud.callFunction:fail Error: data exceed max size');
        calls.push(data);
        return { result: await module.exports.main(data) };
      },
      uploadFile: ({ filePath, cloudPath, success }) => {
        const bytes = temporaryFiles.get(filePath);
        assert.ok(bytes);
        const fileID = `cloud://test/${cloudPath}`;
        storedFiles.set(fileID, bytes);
        transfers.push({ fileID, filePath, bytes: bytes.length });
        queueMicrotask(() => success({ fileID }));
        return { onProgressUpdate(callback) { uploadProgress.push(callback); callback({ progress: 50 }); } };
      },
    },
  };
  const image = await sharp(randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).jpeg({ quality: 50 }).toBuffer();
  assert.ok(image.length > 100 * 1024 && image.length < 480 * 1024);
  for (const path of ['album-cover.jpg', 'album-step-1.jpg', 'album-step-2.jpg', 'avatar.jpg']) temporaryFiles.set(path, image);
  globalThis.uni = {
    chooseImage: async options => { assert.deepEqual(options.sizeType, ['original']); return { tempFilePaths: ['album-cover.jpg'] }; },
    getImageInfo: async ({ src }) => { const meta = await sharp(temporaryFiles.get(src)).metadata(); return { width: meta.width, height: meta.height, type: meta.format }; },
    compressImage: async ({ src, compressedWidth, quality }) => {
      const path = `${src}-${compressedWidth}-${quality}.jpg`;
      temporaryFiles.set(path, await sharp(temporaryFiles.get(src)).resize({ width: compressedWidth }).jpeg({ quality }).toBuffer());
      return { tempFilePath: path };
    },
    getFileInfo: async ({ filePath }) => ({ size: temporaryFiles.get(filePath).length }),
  };
  const app = await import(`data:text/javascript;base64,${Buffer.from(frontend.outputFiles[0].text).toString('base64')}`);
  app.cloudStatus.value = { phase: 'ready', familyId: 'test-family', userId };
  await assert.rejects(wx.cloud.callFunction({ data: { action: 'mediaUpload', base64: image.toString('base64') } }), /data exceed max size/);
  const cover = await app.chooseLocalImage(['album'], state => progress.push(state));
  const steps = await app.persistSelectedImages(['album-step-1.jpg', 'album-step-2.jpg'], state => progress.push(state));
  assert.ok(progress.some(state => state.items.some(item => item.status === 'uploading' && item.preview && item.preview !== item.path)));
  assert.ok(progress.some(state => state.items.some(item => item.status === 'saving')));
  assert.ok(progress.some(state => state.items.some(item => item.progress === 50)));
  const progressCount = progress.length;
  uploadProgress.forEach(callback => callback({ progress: 90 }));
  assert.equal(progress.length, progressCount, 'late SDK progress must not resurrect a completed picker or move saving back to uploading');
  for (const item of progress.flatMap(state => state.items).filter(item => item.status === 'done')) {
    assert.ok(item.preview.startsWith('/test-device/shiyuan-cache-photo-'));
    assert.ok(temporaryFiles.has(item.preview), 'completed previews must survive compressed temporary file cleanup');
  }
  for (const fileId of [cover, ...steps]) {
    const record = rows.get(`media:${hash(fileId)}`);
    assert.equal(record.familyId, 'test-family');
    assert.equal(record.confirmed, true);
    assert.deepEqual(decryptImage(storedFiles.get(fileId), record.encryptionKey), image);
    const response = await module.exports.main({ action: 'mediaContent', fileId, variant: 'detail' });
    assert.equal(response.ok, true);
    assert.ok(Buffer.from(response.data.base64, 'base64').length <= 120000);
    assert.equal(record.delivery, undefined, 'ordinary display never prepares the original download');
  }
  const cardPath = await app.loadImage(cover, 'card', { force: true });
  assert.ok(temporaryFiles.get(cardPath).length <= 80000);
  assert.equal(downloadedFiles.length, 1);
  assert.equal(await app.loadImage(cover, 'card'), cardPath);
  assert.equal(downloadedFiles.length, 1, 'repeat display uses the authorized local thumbnail');
  const originalPath = await app.loadImage(cover, 'original');
  assert.deepEqual(temporaryFiles.get(originalPath), image);
  assert.equal(downloadedFiles.length, 2, 'only explicit original requests download full image bytes');
  const heic = readFileSync('tests/fixtures/image-upload.heic');
  const compatible = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#658365' } }).jpeg().toBuffer();
  temporaryFiles.set('ios-original.heic', heic);
  temporaryFiles.set('ios-preview.jpg', compatible);
  const heicId = await app.uploadCloudImage('ios-original.heic', { previewPath: 'ios-preview.jpg', cardPath: 'ios-preview.jpg' });
  const heicRecord = rows.get(`media:${hash(heicId)}`);
  assert.deepEqual(decryptImage(storedFiles.get(heicId), heicRecord.encryptionKey), heic);
  assert.equal(heicRecord.contentType, 'image/heic');
  const heicPath = await app.loadImage(heicId, 'original');
  assert.ok(heicPath.endsWith('.heic'));
  assert.deepEqual(temporaryFiles.get(heicPath), heic);
  const legacyHeic = await module.exports.main({ action: 'mediaContent', fileId: heicId, variant: 'original' });
  assert.equal(legacyHeic.ok, true);
  assert.equal(legacyHeic.data.contentType, 'image/jpeg', 'older clients receive a compatible thumbnail rather than unrenderable HEIC');
  const croppedPreview = await sharp(image).extract({ left: 0, top: 500, width: 1000, height: 500 }).jpeg({ quality: 65 }).toBuffer();
  temporaryFiles.set('selected-family-crop.jpg', croppedPreview);
  const croppedId = await app.chooseLocalImage(['album'], () => {}, async original => {
    assert.equal(original, 'album-cover.jpg');
    return { previewPath: 'selected-family-crop.jpg' };
  });
  const croppedRecord = rows.get(`media:${hash(croppedId)}`);
  assert.deepEqual(decryptImage(storedFiles.get(croppedId), croppedRecord.encryptionKey), image, 'cropping must not replace the original');
  for (const variant of ['card', 'detail']) {
    const response = await module.exports.main({ action: 'mediaContent', fileId: croppedId, variant });
    assert.equal(response.ok, true);
    const croppedMeta = await sharp(Buffer.from(response.data.base64, 'base64')).metadata();
    assert.equal(croppedMeta.width / croppedMeta.height, 2, `${variant} must preserve the selected family framing`);
  }
  openid = 'new-profile-user';
  app.cloudStatus.value = { phase: 'onboarding', userId: hash(openid), familyId: '' };
  const avatar = await app.uploadProfileAvatar('avatar.jpg', { cardPath: await app.compressNativePhoto('avatar.jpg', 'card') });
  const avatarRecord = rows.get(`media:${hash(avatar)}`);
  assert.equal(avatarRecord.profile, true);
  assert.equal(avatarRecord.userId, hash(openid));
  assert.equal((await module.exports.main({ action: 'mediaContent', fileId: avatar, variant: 'card' })).ok, true);
  const denied = await module.exports.main({ action: 'mediaContent', fileId: cover, variant: 'original', transport: 'url' });
  assert.equal(denied.ok, false, 'another user cannot sign a private family original');
  assert.equal(transfers.length, 12);
  assert.ok(transfers.every(item => !storedFiles.has(item.fileID)), 'server removes temporary unencrypted originals');
  assert.equal(savedCount, 34); // profile avatar adds encrypted and private delivery thumbnails
  assert.ok(avatarRecord.variants.avatar.bytes <= 20000);
  assert.ok(avatarRecord.variants.avatar.width <= 192);
  assert.equal((await module.exports.main({ action: 'mediaContent', fileId: avatar, variant: 'avatar' })).ok, true);
  assert.ok(calls.some(call => call.transport === 'url'));
  assert.ok(calls.every(item => !('base64' in item) && Buffer.byteLength(JSON.stringify(item)) < 1024));
  assert.equal(rows.get(`users:${userId}`).familyId, 'test-family');
  assert.equal(rows.has(`users:${hash(openid)}`), false, 'upload does not create or modify an account');
});

test('every image entry uses the shared picker or the compressed profile uploader', () => {
  for (const component of ['FamilyEditor', 'RecipeEditor', 'SetEditor', 'StockEditor', 'InventoryView']) {
    assert.match(readFileSync(`src/components/${component}.vue`, 'utf8'), /<ImagePicker\b/);
  }
  assert.match(readFileSync('src/components/RecipeEditor.vue', 'utf8'), /<StepImagePicker\b/);
  assert.match(readFileSync('src/components/ImagePicker.vue', 'utf8'), /chooseLocalImage/);
  assert.match(readFileSync('src/components/StepImagePicker.vue', 'utf8'), /chooseLocalImages/);
  const profile = readFileSync('src/components/ProfileFields.vue', 'utf8');
  assert.match(profile, /compressNativePhoto/);
  assert.match(profile, /uploadProfileAvatar/);
});
