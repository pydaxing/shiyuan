import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

const directory = `${process.cwd()}/artifacts/deployment/performance`;
const optimized = process.argv.includes('--optimized');
const receipt = `${directory}/${optimized ? 'optimized' : 'diagnosis'}-photo-compression.json`;
assert.equal(await access(receipt).then(() => true, () => false), false, '已有测量回执，请勿覆盖');
await mkdir(directory, { recursive: true });
const results = [];
const callback = function(label, optimized) {
  const progress = { label, done: false };
  getApp().__photoCompressionDiagnosis = progress;
  void (async function() {
    const files = wx.getFileSystemManager();
    const source = `${wx.env.USER_DATA_PATH}/shiyuan-compression-diagnosis-${label}`;
    let compressed;
    const cloud = require('services/cloud.js');
    const originalUpload = cloud.uploadCloudImage;
    try {
      const started = Date.now();
      if (optimized) {
        cloud.uploadCloudImage = async function(path) { compressed = { tempFilePath: path }; return 'compression-test-only'; };
        await require('services/images.js').persistSelectedImages([source]);
      } else compressed = await new Promise((resolve, reject) => wx.compressImage({ src: source, quality: 70, compressedWidth: 1400, success: resolve, fail: reject }));
      progress.compressMs = Date.now() - started;
      const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: compressed.tempFilePath, success: resolve, fail: reject }));
      const size = await new Promise((resolve, reject) => files.getFileInfo({ filePath: compressed.tempFilePath, success: resolve, fail: reject }));
      Object.assign(progress, { width: info.width, height: info.height, type: info.type, outputBytes: size.size, overServerLimit: size.size > 1024 * 1024, usesLongUploadPath: size.size > 525000, ok: true });
    } catch (error) { progress.error = error.errMsg || error.message; }
    finally {
      cloud.uploadCloudImage = originalUpload;
      for (const path of new Set([source, compressed?.tempFilePath].filter(Boolean))) try { files.unlinkSync(path); } catch {}
      progress.done = true;
    }
  })();
  return { started: true };
};
function evaluate(source, args = []) {
  const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', source, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  const envelope = JSON.parse(output.slice(output.indexOf('{')));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope.result?.result?.result;
}
for (const height of [2100, 6000]) {
  const format = 'png';
  const width = 1400;
  const pixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) for (let channel = 0; channel < 3; channel += 1) pixels[(row * width + column) * 3 + channel] = ((row % 8) * 137 + (column % 8) * 173 + channel * 73) % 256;
  const image = sharp(pixels, { raw: { width, height, channels: 3 } });
  const bytes = await image.png().toBuffer();
  const label = `synthetic-texture-${height}.${format}`;
  const argsFile = `${tmpdir()}/shiyuan-compression-${format}-args.json`;
  const base64 = bytes.toString('base64');
  const copyChunk = function(label, chunk, first) {
    const files = wx.getFileSystemManager();
    const source = `${wx.env.USER_DATA_PATH}/shiyuan-compression-diagnosis-${label}`;
    if (first) files.writeFileSync(source, chunk, 'base64');
    else files.appendFileSync(source, chunk, 'base64');
    return { written: true };
  };
  for (let offset = 0; offset < base64.length; offset += 65536) {
    await writeFile(argsFile, JSON.stringify([label, base64.slice(offset, offset + 65536), offset === 0]));
    evaluate(copyChunk.toString(), ['--args-file', argsFile]);
  }
  await writeFile(argsFile, JSON.stringify([label, optimized]));
  evaluate(callback.toString(), ['--args-file', argsFile]);
  let result;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2500));
    result = evaluate('function(){ return getApp().__photoCompressionDiagnosis; }');
    if (result?.done) break;
  }
  results.push({ ...result, inputBytes: bytes.length, inputWidth: width, inputHeight: height, environment: 'WeChat IDE; synthetic texture, not phone camera' });
  await writeFile(receipt, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(result?.ok, true, JSON.stringify(result));
}
