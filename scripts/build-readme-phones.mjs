import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Presentation assets only. This script never builds or modifies the app.
// Download the standard iPhone 17 PNG using the source page's download button:
// https://www.webmobilefirst.com/en/mockups/apple-iphone-17-2025/
// Keep the standalone frame outside Git. Only composed screenshots may be shared.
// Usage: node scripts/build-readme-phones.mjs --frame /path/to/iphone17.png
// Optionally append screenshot basenames, e.g. discover recipe.
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'docs/images/readme');
const args = process.argv.slice(2);
const frameIndex = args.indexOf('--frame');
if (frameIndex < 0 || !args[frameIndex + 1] || args[frameIndex + 1].startsWith('--')) {
  throw new Error('Provide --frame /path/to/the/388x800/iphone17.png (see docs/项目首页维护.md).');
}
const framePath = path.resolve(args[frameIndex + 1]);
args.splice(frameIndex, 2);
const names = args.length ? args : ['discover', 'recipe', 'ingredients', 'steps', 'menu', 'kitchen'];
if (names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error('Invalid screenshot basename.');
await mkdir(directory, { recursive: true });

const frame = await readFile(framePath);
const { data: pixels, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
if (info.width !== 388 || info.height !== 800) throw new Error('Expected the standard iPhone 17 front frame at 388 × 800.');
const base = { width: info.width, height: info.height };
const scale = 2;
const device = { width: base.width * scale, height: base.height * scale };
// Fit screenshots without stretching. Tiny remaining height uses the system color.
const screen = { left: 16, top: 13, width: 356, height: 774 };
const padding = 28;
const canvas = { width: device.width + padding * 2, height: device.height + padding * 2 };

// Find only the connected inner opening, excluding the exterior and camera island.
// Extend by one pixel underneath the opaque bezel to avoid antialiasing gaps.
const count = base.width * base.height;
const opening = new Uint8Array(count);
const queue = new Uint32Array(count);
queue[0] = 400 * base.width + 194;
opening[queue[0]] = 1;
let head = 0;
let tail = 1;
while (head < tail) {
  const p = queue[head++];
  const x = p % base.width;
  const y = Math.floor(p / base.width);
  const neighbors = [x > 0 ? p - 1 : -1, x + 1 < base.width ? p + 1 : -1,
    y > 0 ? p - base.width : -1, y + 1 < base.height ? p + base.width : -1];
  for (const next of neighbors) {
    if (next < 0 || opening[next] || pixels[next * 4 + 3] >= 250) continue;
    opening[next] = 1;
    queue[tail++] = next;
  }
}
if (tail < 265_000 || tail > 275_000) throw new Error('Unexpected screen opening: ' + tail + ' pixels.');
const maskPixels = Buffer.alloc(count * 4);
for (let p = 0; p < count; p++) {
  if (!opening[p]) continue;
  const x = p % base.width;
  const y = Math.floor(p / base.width);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (x + dx < 0 || x + dx >= base.width || y + dy < 0 || y + dy >= base.height) continue;
    const offset = ((y + dy) * base.width + x + dx) * 4;
    maskPixels.fill(255, offset, offset + 4);
  }
}
const mask = await sharp(maskPixels, { raw: { ...base, channels: 4 } }).resize(device.width, device.height).png().toBuffer();
const scaledFrame = await sharp(frame).resize(device.width, device.height).png().toBuffer();
const transparent = (size) => sharp({ create: { ...size, channels: 4, background: '#00000000' } });

for (const name of names) {
  const inputPath = path.join(directory, name + '.png');
  const { data, info: source } = await sharp(inputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const supported = (source.width === 591 && source.height === 1280)
    || (source.width === 640 && source.height === 1386);
  if (!supported) throw new Error(name + ': expected a preserved 591 × 1280 or 640 × 1386 WeChat screenshot.');
  const adjusted = Buffer.from(data);
  const ratio = source.width / 591;
  const offset = (Math.round(59 * ratio) * source.width + Math.floor(source.width / 2)) * 3;
  const background = { r: data[offset], g: data[offset + 1], b: data[offset + 2], alpha: 1 };
  const statusEnd = Math.round(53 * ratio);
  // Replace only the old simulator's system cutout with adjacent status-bar color.
  // Keep the time, battery, navigation, and every application pixel.
  const center = (Math.round(20 * ratio) * source.width + Math.floor(source.width / 2)) * 3;
  if (Math.max(data[center], data[center + 1], data[center + 2]) < 90) {
    for (let y = 0; y < statusEnd; y++) {
      for (let x = Math.floor(135 * ratio); x < Math.ceil(457 * ratio); x++) {
        const p = (y * source.width + x) * 3;
        adjusted[p] = background.r;
        adjusted[p + 1] = background.g;
        adjusted[p + 2] = background.b;
      }
    }
  }
  if (!adjusted.subarray(statusEnd * source.width * 3).equals(data.subarray(statusEnd * source.width * 3))) {
    throw new Error(name + ': application pixels changed during cutout adaptation.');
  }
  const fitted = await sharp(adjusted, { raw: { width: source.width, height: source.height, channels: 3 } })
    .resize(screen.width * scale, screen.height * scale, { fit: 'contain', background, position: 'centre' })
    .png().toBuffer();
  const fullScreen = await transparent(device)
    .composite([{ input: fitted, left: screen.left * scale, top: screen.top * scale }]).png().toBuffer();
  const clipped = await sharp(fullScreen).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const composed = await sharp(clipped).composite([{ input: scaledFrame }]).png().toBuffer();

  // A restrained shadow keeps the metal outline legible in both GitHub themes.
  const alpha = await sharp(composed).extractChannel('alpha').raw().toBuffer();
  const shadowDevice = await sharp({ create: { ...device, channels: 3, background: '#182b31' } })
    .joinChannel(alpha, { raw: { ...device, channels: 1 } }).png().toBuffer();
  const shadowCanvas = await transparent(canvas)
    .composite([{ input: shadowDevice, left: padding, top: padding + 8 }]).blur(9).png().toBuffer();
  const { data: shadowPixels, info: shadowInfo } = await sharp(shadowCanvas).raw().toBuffer({ resolveWithObject: true });
  for (let p = 3; p < shadowPixels.length; p += 4) shadowPixels[p] = Math.round(shadowPixels[p] * 0.12);
  const shadow = await sharp(shadowPixels, { raw: shadowInfo }).png().toBuffer();
  const outputPath = path.join(directory, name + '-phone.png');
  await sharp(shadow).composite([{ input: composed, left: padding, top: padding }])
    .png({ compressionLevel: 9 }).toFile(outputPath);
  console.log(path.relative(root, inputPath) + ' → ' + path.relative(root, outputPath) + ' (' + canvas.width + ' × ' + canvas.height + ')');
}
