import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Presentation assets only; never builds, previews, or changes the application.
// Download the standard iPhone 17 frame using the source page's download button:
// https://www.webmobilefirst.com/en/mockups/apple-iphone-17-2025/
// Its license permits composed screenshots, but not redistribution of the frame.
// Keep --frame outside Git. Do not label another iPhone model as iPhone 17.
//
// node scripts/build-readme-phones.mjs --frame /local/iphone17.png \
//   --source-dir docs/images/readme --output-dir artifacts/readme-showcase-v2-20261028 discover
// Optional --geometry /local/geometry.json uses frame-native coordinates:
// { screen: {left,top,width,height}, safe: {left,top,width,height},
//   clock: {left,top}, indicators: {right,top}, home: {centerX,top,width,height} }
// Optional --scale 2 changes export resolution, not the screenshot's aspect ratio.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Missing value for ' + flag);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}
const frameArgument = option('--frame');
if (!frameArgument) throw new Error('Provide --frame /path/to/standard-iphone17.png; keep this licensed source outside Git.');
const framePath = path.resolve(frameArgument);
const sourceDirectory = path.resolve(option('--source-dir', path.join(root, 'docs/images/readme')));
const outputDirectory = path.resolve(option('--output-dir', path.join(root, 'docs/images/readme')));
const geometryPath = option('--geometry');
const scale = Number(option('--scale', '2'));
if (!Number.isFinite(scale) || scale < 0.25 || scale > 4) throw new Error('--scale must be between 0.25 and 4.');
const names = args.length ? args : ['family-cover', 'discover', 'menu', 'kitchen', 'preparation', 'shopping', 'fridge', 'family-diary'];
if (names.some((name) => !/^[a-z][a-z0-9-]*$/.test(name))) throw new Error('Invalid screenshot basename.');
await mkdir(outputDirectory, { recursive: true });

const frame = await readFile(framePath);
const { data: pixels, info } = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const base = { width: info.width, height: info.height };
const ratio = info.width / 388;
if (!geometryPath && Math.abs(info.height / ratio - 800) > 1) {
  throw new Error('This frame needs an explicit --geometry; the default is the 388 × 800 standard iPhone 17 frame.');
}
const defaultGeometry = {
  screen: { left: 16, top: 7, width: 356, height: 786 },
  // This rectangle lies entirely below the island and inside all four corners.
  // The application, including its navigation and tab labels, is contained here.
  safe: { left: 24, top: 64, width: 340, height: 672 },
  clock: { left: 39, top: 35 },
  indicators: { right: 348, top: 35 },
  home: { centerX: 194, top: 770, width: 101, height: 4 },
};
const geometry = geometryPath ? JSON.parse(await readFile(path.resolve(geometryPath), 'utf8'))
  : Object.fromEntries(Object.entries(defaultGeometry).map(([name, values]) => [name,
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value * ratio)]))]));
for (const name of ['screen', 'safe', 'clock', 'indicators', 'home']) {
  if (!geometry[name] || Object.values(geometry[name]).some((n) => !Number.isFinite(n))) throw new Error('Invalid geometry.' + name);
}
const device = { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
const padding = Math.round(14 * ratio * scale);
const canvas = { width: device.width + padding * 2, height: device.height + padding * 2 };
const atScale = (n) => Math.round(n * scale);
const transparent = (size) => sharp({ create: { ...size, channels: 4, background: '#00000000' } });

// Trace only the connected screen opening. The exterior and camera remain apart.
const count = base.width * base.height;
const opening = new Uint8Array(count);
const queue = new Uint32Array(count);
queue[0] = Math.floor(base.height / 2) * base.width + Math.floor(base.width / 2);
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
if (tail < count * 0.70 || tail > count * 0.95) throw new Error('Unexpected screen opening: ' + tail + ' pixels.');
// A geometry mismatch fails instead of silently clipping text under hardware.
for (let y = geometry.safe.top; y < geometry.safe.top + geometry.safe.height; y++) {
  for (let x = geometry.safe.left; x < geometry.safe.left + geometry.safe.width; x++) {
    const p = y * base.width + x;
    if (!opening[p] || pixels[p * 4 + 3] !== 0) throw new Error('The application safe rectangle overlaps the frame at ' + x + ',' + y);
  }
}
const maskPixels = Buffer.alloc(count * 4);
for (let p = 0; p < count; p++) if (opening[p]) maskPixels.fill(255, p * 4, p * 4 + 4);
const mask = await sharp(maskPixels, { raw: { ...base, channels: 4 } }).resize(device.width, device.height).png().toBuffer();

// Remove very faint exterior color specks present in the low-resolution source.
// All actual metal, buttons, glass and island pixels retain the source's geometry.
const cleanedFrame = Buffer.from(pixels);
let removedSpecks = 0;
for (let p = 0; p < count; p++) {
  const a = cleanedFrame[p * 4 + 3];
  if (a > 0 && a < 80) { cleanedFrame.fill(0, p * 4, p * 4 + 4); removedSpecks++; }
}
const scaledFrame = await sharp(cleanedFrame, { raw: { ...base, channels: 4 } })
  .resize(device.width, device.height, { kernel: 'lanczos3' }).png().toBuffer();
const reports = [];

for (const name of names) {
  const inputPath = path.join(sourceDirectory, name + '.png');
  const { data, info: source } = await sharp(inputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const supported = (source.width === 591 && source.height === 1280)
    || (source.width === 640 && source.height === 1386);
  if (!supported) throw new Error(name + ': expected a preserved 591 × 1280 or 640 × 1386 WeChat screenshot.');
  const sourceRatio = source.width / 591;
  const sourceTop = Math.round(68 * sourceRatio);
  const sourceBottom = source.height - Math.round(54 * sourceRatio);
  const bodyRegion = { left: 0, top: sourceTop, width: source.width, height: sourceBottom - sourceTop };
  const rawSource = () => sharp(data, { raw: { width: source.width, height: source.height, channels: 3 } });
  // Retain every application row as a single image. No redrawing, stretching,
  // rounding, clipping, or replacement of the application UI is allowed.
  const body = await rawSource().extract(bodyRegion).raw().toBuffer();
  const fit = Math.min(atScale(geometry.safe.width) / bodyRegion.width, atScale(geometry.safe.height) / bodyRegion.height);
  const bodyWidth = Math.floor(bodyRegion.width * fit);
  const bodyHeight = Math.floor(bodyRegion.height * fit);
  const bodyLeft = atScale(geometry.safe.left) + Math.floor((atScale(geometry.safe.width) - bodyWidth) / 2);
  const bodyTop = atScale(geometry.safe.top) + Math.floor((atScale(geometry.safe.height) - bodyHeight) / 2);
  const resizedBody = await sharp(body, { raw: { width: bodyRegion.width, height: bodyRegion.height, channels: 3 } })
    .resize(bodyWidth, bodyHeight, { kernel: 'lanczos3' }).png().toBuffer();
  const firstPixel = (Math.round(61 * sourceRatio) * source.width + Math.floor(source.width / 2)) * 3;
  const topColor = { r: data[firstPixel], g: data[firstPixel + 1], b: data[firstPixel + 2], alpha: 1 };
  const finalPixel = ((sourceBottom - 1) * source.width + Math.floor(source.width / 2)) * 3;
  const bottomColor = { r: data[finalPixel], g: data[finalPixel + 1], b: data[finalPixel + 2], alpha: 1 };
  // Screen background extends only the narrow outside gutters, never app pixels.
  // Use edge colors row by row so full-bleed cover images do not gain white rails.
  const { data: bodyPixels } = await sharp(resizedBody).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const screenPixels = Buffer.alloc(device.width * device.height * 3);
  const edgeSkip = Math.max(1, Math.round(2 * sourceRatio * fit));
  const edgeWindow = Math.max(5, Math.round(10 * sourceRatio * fit));
  const edgeMedian = (row, start) => {
    const channels = [[], [], []];
    for (let x = start; x < start + edgeWindow; x++) {
      const offset = (row * bodyWidth + x) * 3;
      for (let channel = 0; channel < 3; channel++) channels[channel].push(bodyPixels[offset + channel]);
    }
    return channels.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
  };
  for (let y = 0; y < device.height; y++) {
    const bodyY = y - bodyTop;
    const withinBody = bodyY >= 0 && bodyY < bodyHeight;
    // A near-edge median avoids stretching a single simulator-border, capsule,
    // scrollbar, or antialias pixel into a visible rail. Application pixels are
    // still copied verbatim; only pixels outside its rectangle use these colors.
    const leftColor = withinBody ? edgeMedian(bodyY, edgeSkip) : null;
    const rightColor = withinBody ? edgeMedian(bodyY, bodyWidth - edgeSkip - edgeWindow) : null;
    for (let x = 0; x < device.width; x++) {
      const dst = (y * device.width + x) * 3;
      if (withinBody) {
        const outsideLeft = x < bodyLeft;
        const outsideRight = x >= bodyLeft + bodyWidth;
        if (outsideLeft || outsideRight) {
          const color = outsideLeft ? leftColor : rightColor;
          screenPixels[dst] = color[0]; screenPixels[dst + 1] = color[1]; screenPixels[dst + 2] = color[2];
        } else {
          const src = (bodyY * bodyWidth + x - bodyLeft) * 3;
          bodyPixels.copy(screenPixels, dst, src, src + 3);
        }
      } else {
        const c = bodyY < 0 ? topColor : bottomColor;
        screenPixels[dst] = c.r; screenPixels[dst + 1] = c.g; screenPixels[dst + 2] = c.b;
      }
    }
  }
  // Transfer original time and status indicators to the device's system safe area.
  // The simulator's old notch, rounded corners, and home indicator are excluded.
  const extractSystem = async (left, top, width, height) => {
    const crop = { left: Math.round(left * sourceRatio), top: Math.round(top * sourceRatio),
      width: Math.round(width * sourceRatio), height: Math.round(height * sourceRatio) };
    const widthOut = Math.round(crop.width * fit);
    return rawSource().extract(crop).resize({ width: widthOut }).png().toBuffer();
  };
  const clock = await extractSystem(12, 26, 72, 26);
  const indicators = await extractSystem(511, 26, 72, 26);
  const indicatorsSize = await sharp(indicators).metadata();
  const home = geometry.home;
  const homeCapture = await rawSource().extract({
    left: Math.round(source.width / 2 - 100 * sourceRatio),
    top: source.height - Math.round(30 * sourceRatio),
    width: Math.round(200 * sourceRatio), height: Math.round(22 * sourceRatio),
  }).resize({ width: Math.round(200 * sourceRatio * fit) }).png().toBuffer();
  const homeSize = await sharp(homeCapture).metadata();
  const fullScreen = await sharp(screenPixels, { raw: { ...device, channels: 3 } }).ensureAlpha().composite([
    { input: clock, left: atScale(geometry.clock.left), top: atScale(geometry.clock.top) },
    { input: indicators, left: atScale(geometry.indicators.right) - indicatorsSize.width, top: atScale(geometry.indicators.top) },
    { input: homeCapture, left: atScale(home.centerX) - Math.floor(homeSize.width / 2),
      top: atScale(home.top) - Math.round(5 * sourceRatio * fit) },
  ]).png().toBuffer();
  const clipped = await sharp(fullScreen).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  const composed = await sharp(clipped).composite([{ input: scaledFrame }]).png().toBuffer();
  // Verify the hardware and screen mask leave the entire resized app unchanged.
  const composedBody = await sharp(composed).extract({ left: bodyLeft, top: bodyTop, width: bodyWidth, height: bodyHeight }).removeAlpha().raw().toBuffer();
  if (!composedBody.equals(bodyPixels)) throw new Error(name + ': hardware or screen clipping changed application pixels.');

  const alpha = await sharp(composed).extractChannel('alpha').raw().toBuffer();
  const shadowDevice = await sharp({ create: { ...device, channels: 3, background: '#182b31' } })
    .joinChannel(alpha, { raw: { ...device, channels: 1 } }).png().toBuffer();
  const shadowCanvas = await transparent(canvas).composite([{ input: shadowDevice, left: padding, top: padding + Math.round(4 * ratio * scale) }])
    .blur(Math.max(0.3, 4.5 * ratio * scale)).png().toBuffer();
  const { data: shadowPixels, info: shadowInfo } = await sharp(shadowCanvas).raw().toBuffer({ resolveWithObject: true });
  for (let p = 3; p < shadowPixels.length; p += 4) shadowPixels[p] = Math.round(shadowPixels[p] * 0.12);
  const outputPath = path.join(outputDirectory, name + '-phone.png');
  await sharp(shadowPixels, { raw: shadowInfo }).composite([{ input: composed, left: padding, top: padding }])
    .png({ compressionLevel: 9 }).toFile(outputPath);
  reports.push({ name, source: path.relative(root, inputPath), output: path.relative(root, outputPath),
    sourceSize: { width: source.width, height: source.height }, sourceApplicationRows: [sourceTop, sourceBottom - 1],
    applicationSourceSha256: createHash('sha256').update(body).digest('hex'),
    applicationOutput: { left: bodyLeft + padding, top: bodyTop + padding, width: bodyWidth, height: bodyHeight },
    completeApplicationPreserved: true, frameOrMaskChangedApplicationPixels: 0 });
  console.log(path.relative(root, outputPath) + ' — app fully visible, ' + canvas.width + ' × ' + canvas.height);
}
await writeFile(path.join(outputDirectory, 'phone-composition-report.json'), JSON.stringify({
  frame: { basename: path.basename(framePath), ...base, sourceSha256: createHash('sha256').update(frame).digest('hex'),
    removedFaintPixels: removedSpecks, upscaleDoesNotAddHardwareDetail: scale > 1 },
  geometry, canvas, images: reports,
}, null, 2) + '\n');
