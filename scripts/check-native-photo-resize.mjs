import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const project = resolve(process.argv[2] || 'dist/release');
const output = resolve(process.argv[3] || 'artifacts/deployment/photo-upload-20260914');
const source = await readFile('src/services/images.js', 'utf8');
const photoCode = source.slice(source.indexOf('export const PHOTO_TARGET_BYTES'), source.indexOf('export async function chooseLocalImage')).replaceAll('export ', '');
const probe = `async function() {
  const call = (name, options) => new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
  const uni = { getImageInfo: options => call('getImageInfo', options), getFileInfo: options => call('getFileInfo', options), compressImage: options => call('compressImage', { src: options.src, quality: options.quality, compressWidth: options.compressedWidth, compressHeight: options.compressedHeight }) };
  ${photoCode}
  const results = [];
  for (const spec of [{ width: 2400, height: 3200, format: 'png' }, { width: 4032, height: 3024, format: 'jpg' }]) {
    const canvas = wx.createOffscreenCanvas({ type: '2d', width: spec.width, height: spec.height });
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(spec.width, spec.height);
    let seed = 31;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const original = (await call('canvasToTempFilePath', { canvas, fileType: spec.format, quality: 1, destWidth: spec.width, destHeight: spec.height })).tempFilePath;
    canvas.width = 1; canvas.height = 1;
    let compressed;
    try {
      const before = await call('getFileInfo', { filePath: original });
      const started = Date.now();
      compressed = await compressNativePhoto(original);
      const after = await call('getFileInfo', { filePath: compressed });
      const info = await call('getImageInfo', { src: compressed });
      results.push({ input: spec, inputBytes: before.size, outputBytes: after.size, width: info.width, height: info.height, format: info.type, elapsedMs: Date.now() - started, pass: after.size <= PHOTO_TARGET_BYTES && Math.max(info.width, info.height) <= 1400 && info.type === 'jpeg' });
    } finally { discardPhoto(compressed); discardPhoto(original); }
  }
  return { scope: 'synthetic local photos only; no uploads or family writes', results };
}`;
await mkdir(output, { recursive: true });
const fnSourceFile = resolve(output, 'native-photo-probe.js');
await writeFile(fnSourceFile, probe);
const result = spawnSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', project, '--fn-source', probe], { encoding: 'utf8', timeout: 120000 });
if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
await writeFile(resolve(output, 'native-photo-probe.json'), result.stdout);
const response = JSON.parse(result.stdout);
const report = response.result?.result?.result;
if (!response.ok || !report?.results?.length || report.results.some(item => !item.pass)) throw new Error(`Native photo resize failed: ${result.stdout}`);
console.log(JSON.stringify(report, null, 2));
