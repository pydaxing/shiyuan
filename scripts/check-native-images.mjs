import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformSync } from '@babel/core';
import { emptySnapshot } from '../src/domain/empty.js';

const directory = resolve(process.argv[2] || 'dist/build/mp-weixin');
const modules = new Map();
const calls = [];
const copies = [];
const uploadedPaths = new Map();
const photoInfo = new Map();
let cancelled = false;
let denied = false;
let rejectUpload = false;
let selected = ['first.jpg'];
let commandResponse;
let sourceIndex = 1;
let sourceCancelled = false;
const selectionRequests = [];
const storage = new Map();
const native = {
  async showActionSheet(options) {
    assert.deepEqual(Array.from(options.itemList), ['拍照', '从相册选择']);
    if (sourceCancelled) throw { errMsg: 'showActionSheet:fail cancel' };
    return { tapIndex: sourceIndex };
  },
  async chooseImage(options) {
    selectionRequests.push(options);
    if (cancelled) throw { errMsg: 'chooseImage:fail cancel' };
    if (denied) throw { errMsg: 'chooseImage:fail auth deny' };
    return { tempFilePaths: selected };
  },
  async getImageInfo({ src }) { return photoInfo.get(src) || { width: 2800, height: 1800, type: 'jpeg' }; },
  async getFileInfo({ filePath }) { return { size: photoInfo.get(filePath)?.size || 120000 }; },
  async compressImage({ src, compressedWidth, compressedHeight }) {
    const tempFilePath = `${src}-${compressedWidth}-compressed.jpg`;
    photoInfo.set(tempFilePath, { width: compressedWidth, height: compressedHeight, type: 'jpeg', size: Math.min(120000, Math.ceil(compressedWidth * compressedHeight / 7)) });
    return { tempFilePath };
  },
  async saveFile({ tempFilePath }) { return { savedFilePath: `/saved/${tempFilePath}` }; },
};
const wechat = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  env: { USER_DATA_PATH: '/private-test' },
  getFileSystemManager: () => ({
    readFile() { assert.fail('照片不可通过 base64 云函数参数上传'); },
    readdirSync: () => [],
    stat: options => options.success({ stats: { size: 120000 } }),
    copyFile(options) { copies.push(options.srcPath); options.success(); },
    unlink: options => options.success(),
  }),
  cloud: {
    init() {},
    async uploadFile({ cloudPath, filePath }) { const fileID = `cloud://test/${cloudPath}`; uploadedPaths.set(fileID, filePath); calls.push({ action: 'uploadFile', filePath }); return { fileID }; },
    async callFunction({ data }) {
      calls.push(data);
      if (data.action === 'command') {
        assert.equal(data.responseMode, 'changes');
        return { result: { ok: true, data: commandResponse } };
      }
      assert.ok(Buffer.byteLength(JSON.stringify(data)) < 1024);
      assert.equal(data.base64, undefined);
      if (['mediaTicket', 'profileMediaTicket'].includes(data.action)) return { result: { ok: true, data: { id: 'test-ticket', path: `private/test-${calls.length}.jpg` } } };
      if (['mediaConfirm', 'profileMediaConfirm'].includes(data.action)) return { result: rejectUpload
        ? { ok: false, code: 'IMAGE_FORMAT', message: '图片格式不支持' }
        : { ok: true, data: { fileId: `cloud://test/approved/${uploadedPaths.get(data.fileId)}`, protected: true } } };
      throw new Error(`Unexpected cloud request: ${data.action}`);
    },
  },
};
const vendor = { index: native, wx$1: wechat, ref: value => ({ value }) };
function load(file) {
  if (file === resolve(directory, 'common/vendor.js')) return vendor;
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const { code } = transformSync(readFileSync(file, 'utf8'), { presets: [['@babel/preset-env', { targets: { ie: '11' } }]], babelrc: false, configFile: false });
  runInNewContext(code, { module, exports: module.exports, require: specifier => load(resolve(dirname(file), specifier)), wx: wechat, structuredClone, setTimeout, clearTimeout }, { filename: file });
  return module.exports;
}
const cloud = load(resolve(directory, 'services/cloud.js'));
cloud.cloudStatus.value = { phase: 'ready', familyId: 'test-family' };
const images = load(resolve(directory, 'services/images.js'));
sourceIndex = 0;
assert.deepEqual(Array.from(await images.selectImagePaths(9)), ['first.jpg']);
assert.deepEqual(Array.from(selectionRequests.at(-1).sourceType), ['camera']);
assert.deepEqual(Array.from(selectionRequests.at(-1).sizeType), ['original']);
assert.equal(selectionRequests.at(-1).count, 1);
sourceIndex = 1;
assert.deepEqual(Array.from(await images.selectImagePaths(3)), ['first.jpg']);
assert.deepEqual(Array.from(selectionRequests.at(-1).sourceType), ['album']);
assert.equal(selectionRequests.at(-1).count, 3);
sourceCancelled = true;
const selectedBeforeCancel = selectionRequests.length;
assert.deepEqual(Array.from(await images.selectImagePaths()), []);
assert.equal(selectionRequests.length, selectedBeforeCancel);
sourceCancelled = false;
const expected = name => cloud.cloudMode ? `cloud://test/approved/${name}` : `/saved/${name}-1400-compressed.jpg`;
assert.equal(await images.chooseLocalImage(), expected('first.jpg'));
selected = ['second.jpg', 'third.jpg', 'fourth.jpg'];
assert.deepEqual(Array.from(await images.chooseLocalImages(2)), [expected('second.jpg'), expected('third.jpg')]);
if (cloud.cloudMode) {
  assert.equal(copies.length, 6);
  assert.ok(copies.every(path => photoInfo.get(path).width <= 960));
  assert.ok(copies.filter(path => photoInfo.get(path).width <= 480).length === 3);
  assert.ok(calls.filter(call => call.action === 'uploadFile').every(call => !call.filePath.includes('compressed')));
  assert.match(cloud.resolveImage(expected('first.jpg')), /^\/private-test\/shiyuan-cache-photo-/);
  rejectUpload = true;
  await assert.rejects(images.chooseLocalImage(), /图片格式不支持/);
  assert.equal(copies.length, 6);
}
const previousCalls = calls.length;
cancelled = true;
assert.equal(await images.chooseLocalImage(), '');
assert.deepEqual(Array.from(await images.chooseLocalImages()), []);
cancelled = false;
denied = true;
await assert.rejects(images.chooseLocalImage(), /权限/);
assert.equal(calls.length, previousCalls);
if (cloud.cloudMode) {
  const recipes = [{ id: 'kept-recipe' }];
  const initial = emptySnapshot();
  initial.family = { ...initial.family, id: 'test-family', name: '原名称', members: [{ id: 'me', name: '我' }] };
  const state = { value: { ...initial, activeMemberId: 'me', recipes } };
  cloud.bindCloudState(state);
  cloud.cloudStatus.value = { phase: 'ready', familyId: 'test-family', userId: 'me', revision: 1, busy: false };
  commandResponse = { familyId: 'test-family', userId: 'me', revision: 2, baseRevision: 1, changes: { family: { ...initial.family, name: '已保存' } }, value: 'saved' };
  assert.equal(await cloud.remoteAction('customizeFamily', [{ name: '已保存', cover: '', coverTitle: initial.family.coverTitle }]), 'saved');
  assert.equal(state.value.family.name, '已保存');
  assert.equal(state.value.recipes, recipes);
  assert.equal(cloud.cloudStatus.value.revision, 2);
}
denied = false;
rejectUpload = false;
selected = ['large-camera.png'];
let canvasExport;
const cropDraws = [];
const canvas = {
  width: 1, height: 1,
  createImage: () => ({ width: 4032, height: 3024, set src(value) { const info = photoInfo.get(value); if (info) { this.width = info.width; this.height = info.height; } queueMicrotask(() => this.onload()); } }),
  getContext: () => ({ fillRect() {}, drawImage(...args) { cropDraws.push(args.slice(1)); } }),
};
wechat.createOffscreenCanvas = () => canvas;
wechat.canvasToTempFilePath = options => {
  canvasExport = options;
  const tempFilePath = `resized-camera-${options.destWidth}.jpg`;
  photoInfo.set(tempFilePath, { width: options.destWidth, height: options.destHeight, type: 'jpeg', size: 40000 });
  options.success({ tempFilePath });
};
native.compressImage = async () => { throw { errMsg: 'compressImage:fail' }; };
native.getImageInfo = async ({ src }) => photoInfo.get(src) || { width: 4032, height: 3024, type: 'png' };
assert.equal(await images.chooseLocalImage(), cloud.cloudMode ? 'cloud://test/approved/large-camera.png' : '/saved/resized-camera-1400.jpg');
assert.equal(canvasExport.destWidth, cloud.cloudMode ? 480 : 1400);
assert.equal(canvasExport.destHeight, cloud.cloudMode ? 360 : 1050);
assert.equal(canvasExport.fileType, 'jpg');
assert.equal(canvas.width, 1);
const crop = load(resolve(directory, 'services/image-crop.js'));
const preparedCrop = await crop.prepareCropSource('large-camera.png');
assert.equal(preparedCrop.original, 'large-camera.png');
assert.equal(preparedCrop.width, 1400);
assert.equal(preparedCrop.height, 1050);
assert.equal(await crop.renderImageCrop(preparedCrop, { x: 0, y: .2, width: 1, height: 2 / 3 }), 'resized-camera-960.jpg');
assert.equal(canvasExport.destWidth, 960);
assert.equal(canvasExport.destHeight, 480);
assert.deepEqual(cropDraws.at(-1), [0, 210, 1400, 700, 0, 0, 960, 480]);
assert.equal(canvas.width, 1);
if (cloud.cloudMode) {
  cloud.cloudStatus.value = { phase: 'onboarding', userId: 'me', familyId: '' };
  assert.equal(await cloud.uploadProfileAvatar('avatar.jpg'), 'cloud://test/approved/avatar.jpg');
  assert.deepEqual(calls.slice(-3).map(item => item.action), ['profileMediaTicket', 'uploadFile', 'profileMediaConfirm']);
}
console.log(`微信图片产物经 ES5 二次转译后验证通过：${cloud.cloudMode ? '云端上传、上传失败、私有缓存' : '本机持久化'}、单图、多图、取消、权限失败及拖动取景导出。`);
