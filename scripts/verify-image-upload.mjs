import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

assert.equal(process.argv[2], '--live', '传入 --live 才会上传合成测试图，不会创建或编辑菜品');
const label = process.argv[3] || 'image-upload-fix';
assert.match(label, /^[a-z-]+$/);
const directory = `${process.cwd()}/artifacts/deployment/${label}`;
const receipt = `${directory}/live-result.json`;
await mkdir(directory, { recursive: true });
assert.equal(await access(receipt).then(() => true, () => false), false, '已有本次验收回执，请先检查，避免重复上传');
const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#efb775' } }).jpeg().toBuffer();
const argsPath = `${directory}/test-image-args.json`;
await writeFile(argsPath, JSON.stringify([image.toString('base64')]));
const callback = function(base64) {
  const app = getApp();
  if (app.__imageUploadVerification) return { started: true };
  const progress = { done: false, ok: false, results: [] };
  app.__imageUploadVerification = progress;
  void (async function() {
  const cloud = require('services/cloud.js');
  const images = require('services/images.js');
  const vendor = require('common/vendor.js');
  const originalIndex = vendor.index;
  const files = wx.getFileSystemManager();
  const sourcePath = `${wx.env.USER_DATA_PATH}/shiyuan-upload-fix-test.jpg`;
  const results = progress.results;
  const selectionApi = Object.create(originalIndex);
  let count = 1;
  Object.defineProperty(selectionApi, 'chooseImage', { value: async function() { return { tempFilePaths: Array.from({ length: count }, () => sourcePath) }; } });
  try {
    for (let attempt = 0; attempt < 80 && cloud.cloudStatus.value.phase === 'connecting'; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
    if (cloud.cloudStatus.value.phase !== 'ready') throw new Error('需要已登录并加入家庭的真实云端状态');
    files.writeFileSync(sourcePath, base64, 'base64');
    vendor.index = selectionApi;
    const cover = await images.chooseLocalImage();
    results.push({ kind: 'cover', fileId: cover, localPreview: Boolean(cloud.resolveImage(cover)) });
    count = 2;
    const steps = await images.chooseLocalImages(2);
    for (const fileId of steps) results.push({ kind: 'step', fileId, localPreview: Boolean(cloud.resolveImage(fileId)) });
    const content = await cloud.invokeCloud('mediaContent', { fileId: cover });
    Object.assign(progress, { ok: true, contentType: content.contentType, decryptedImageAvailable: content.base64.length > 0 });
  } catch (error) { Object.assign(progress, { message: error.message, stack: error.stack }); }
  finally { vendor.index = originalIndex; progress.done = true; try { files.unlinkSync(sourcePath); } catch {} }
  })().catch(error => { Object.assign(progress, { done: true, message: error.message }); });
  return { started: true };
};
const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', callback.toString(), '--args-file', argsPath], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
let envelope = JSON.parse(output.slice(output.indexOf('{')));
assert.equal(envelope.ok, true, JSON.stringify(envelope));
let result;
for (let attempt = 0; attempt < 24; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  const status = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', 'function(){ return getApp().__imageUploadVerification; }'], { encoding: 'utf8', timeout: 30000 });
  envelope = JSON.parse(status.slice(status.indexOf('{')));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  result = envelope.result?.result?.result;
  await writeFile(receipt, JSON.stringify(envelope, null, 2));
  if (result?.done) break;
}
assert.equal(result?.ok, true, JSON.stringify(result));
assert.equal(result.results.length, 3);
assert.ok(result.results.every(photo => photo.localPreview && photo.fileId.startsWith('cloud://') && photo.fileId.endsWith('.bin')));
assert.equal(result.contentType, 'image/jpeg');
assert.equal(result.decryptedImageAvailable, true);
console.log(JSON.stringify({ singlePhoto: 'passed', multiplePhotos: 'passed', encryptedUploadAndPreview: 'passed', authenticatedDownload: 'passed', receipt }));
