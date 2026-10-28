import assert from 'node:assert/strict';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

assert.equal(process.argv[2], '--live', '传入 --live 才会上传合成测试图；不会保存家庭设置、头像或菜品');
const project = resolve('dist/release');
const recover = process.argv.includes('--recover');
const directory = resolve(process.argv.slice(3).find(value => !value.startsWith('--')) || 'artifacts/deployment/photo-transport-20260914');
const receipt = resolve(directory, 'live-upload-readback.json');
const imageSource = await readFile(resolve('src/services/images.js'), 'utf8');
const targetBytes = Number(imageSource.match(/export const PHOTO_TARGET_BYTES = (\d+) \* 1024;/)?.[1]) * 1024;
assert.ok(targetBytes > 0);
try { await access(receipt); throw new Error('已有测试回执，禁止重复上传，请先检查已有结果'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(directory, { recursive: true });
const probe = async function() {
  const cloud = require('services/cloud.js');
  const images = require('services/images.js');
  if (/mediaUpload|base64/.test(cloud.uploadCloudImage.toString())) throw new Error('模拟器仍是旧版上传，请重新编译');
  if (cloud.cloudStatus.value.phase !== 'ready') throw new Error('需要已登录家庭，但本测试不会创建家庭');
  const call = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: 4032, height: 3024 });
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(4032, 3024);
  let seed = 31;
  for (let index = 0; index < pixels.data.length; index += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  const original = (await call('canvasToTempFilePath', { canvas, fileType: 'jpg', quality: 1, destWidth: 4032, destHeight: 3024 })).tempFilePath;
  canvas.width = 1; canvas.height = 1;
  const ledger = { startedAt: new Date().toISOString(), scope: 'synthetic image uploads only; no family, recipe or profile changes', files: [] };
  getApp().__photoTransportVerification = ledger;
  let compressed;
  try {
    ledger.originalBytes = (await call('getFileInfo', { filePath: original })).size;
    compressed = await images.compressNativePhoto(original);
    ledger.compressedBytes = (await call('getFileInfo', { filePath: compressed })).size;
    for (const kind of ['family', 'profile']) {
      const started = Date.now();
      const fileId = kind === 'family' ? await cloud.uploadCloudImage(compressed) : await cloud.uploadProfileAvatar(compressed);
      const entry = { kind, fileId, uploadMs: Date.now() - started };
      ledger.files.push(entry);
      const preview = await cloud.loadImage(fileId, 'detail');
      const info = await call('getImageInfo', { src: preview });
      entry.previewBytes = (await call('getFileInfo', { filePath: preview })).size;
      entry.previewWidth = info.width; entry.previewHeight = info.height;
      entry.previewVerified = entry.previewBytes > 0 && entry.previewBytes <= 120000 && Math.max(info.width, info.height) <= 960;
    }
  } catch (error) { ledger.error = { code: error.code, message: error.message || error.errMsg }; }
  finally {
    for (const path of [...new Set([original, compressed].filter(Boolean))]) wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
    ledger.finishedAt = new Date().toISOString();
  }
  return ledger;
};
function evaluate(source) {
  const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', project, '--fn-source', source], { encoding: 'utf8', timeout: 60000, maxBuffer: 1000000 });
  const response = JSON.parse(output.slice(output.indexOf('{')));
  assert.ok(response.ok, JSON.stringify(response));
  return response.result?.result?.result;
}
const readLedger = 'function(){return getApp().__photoTransportVerification || null}';
let result = evaluate(readLedger);
if (recover) assert.ok(result, '没有运行中的测试记录，不能恢复');
else {
  assert.ok(!result, '模拟器中已有测试记录，请用 --recover 读取，禁止重复上传');
  await writeFile(resolve(directory, 'live-upload-readback-probe.js'), probe.toString());
  evaluate(`function(){(${probe.toString()})().catch(error => { getApp().__photoTransportVerification = { finishedAt: new Date().toISOString(), error: { message: error.message || error.errMsg } }; }); return { started: true };}`);
}
for (let attempt = 0; attempt < 30 && !result?.finishedAt; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  result = evaluate(readLedger);
}
const verified = !result?.error && Boolean(result?.finishedAt) && result?.compressedBytes > 0 && result.compressedBytes <= targetBytes && result.files?.length === 2
  && ['family', 'profile'].every(kind => result.files.some(item => item.kind === kind && item.fileId?.startsWith('cloud://') && item.previewVerified && item.previewBytes > 0 && item.previewBytes <= 120000 && Math.max(item.previewWidth, item.previewHeight) <= 960));
const verification = { verified, targetBytes, recovered: recover, observed: result };
await writeFile(receipt, JSON.stringify(verification, null, 2));
assert.ok(verified, JSON.stringify(verification));
console.log(JSON.stringify(verification, null, 2));
