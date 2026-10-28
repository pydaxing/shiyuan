import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Documentation artwork only. This script never builds or deploys the app.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs/images/readme');
await mkdir(path.join(out, 'badges'), { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const icon = (await readFile(path.join(root, 'assets/brand/shiyuan-icon-v2-1024.png'))).toString('base64');
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function cover(dark, compact = false) {
  const c = dark
    ? { bg: '#182b31', ink: '#f4f6f4', muted: '#aec2c7', line: '#3b555e', soft: '#213a42' }
    : { bg: '#f5f7f8', ink: '#24363f', muted: '#61767f', line: '#ccd9de', soft: '#e8eef1' };
  if (compact) return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="900" height="900" viewBox="0 0 900 900">
    <defs><clipPath id="logo"><rect x="305" y="400" width="290" height="290" rx="66"/></clipPath></defs>
    <rect width="900" height="900" rx="28" fill="${c.bg}"/>
    <circle cx="830" cy="50" r="230" fill="${c.soft}"/>
    <circle cx="830" cy="50" r="190" fill="none" stroke="${c.line}"/>
    <g text-anchor="middle">
      <text x="450" y="77" fill="${c.muted}" font-family="'Avenir Next', Helvetica, sans-serif" font-size="23" font-weight="600" letter-spacing="7">SHIYUAN</text>
      <g fill="${c.ink}" font-family="'Songti SC', 'STSong', serif">
        <text x="450" y="235" font-size="132" font-weight="700">食愿</text>
        <text x="450" y="316" font-size="45" font-weight="600">把想吃的，变成一起吃的。</text>
      </g>
      <text x="450" y="364" fill="${c.muted}" font-family="'PingFang SC', 'Heiti SC', sans-serif" font-size="28">属于一家人的菜单、厨房与餐桌。</text>
      <text x="450" y="787" fill="${c.ink}" font-family="'PingFang SC', 'Heiti SC', sans-serif" font-size="29">一起点菜 · 一起备餐 · 一起开饭</text>
      <text x="450" y="841" fill="${c.muted}" font-family="'Avenir Next', Helvetica, sans-serif" font-size="18" letter-spacing="4">MADE FOR YOUR FAMILY</text>
    </g>
    <image x="305" y="400" width="290" height="290" clip-path="url(#logo)" xlink:href="data:image/png;base64,${icon}"/>
  </svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1600" height="720" viewBox="0 0 1600 720">
    <defs><clipPath id="logo"><rect x="1030" y="135" width="440" height="440" rx="98"/></clipPath></defs>
    <rect width="1600" height="720" rx="28" fill="${c.bg}"/>
    <circle cx="1470" cy="110" r="340" fill="${c.soft}"/>
    <circle cx="1470" cy="110" r="282" fill="none" stroke="${c.line}"/>
    <g font-family="'Avenir Next', Helvetica, sans-serif">
      <text x="80" y="100" fill="${c.muted}" font-size="22" font-weight="600" letter-spacing="7">SHIYUAN</text>
      <text x="80" y="639" fill="${c.muted}" font-size="16" letter-spacing="3">A LITTLE KITCHEN. A SHARED EVERYDAY.</text>
    </g>
    <g fill="${c.ink}" font-family="'Songti SC', 'STSong', serif">
      <text x="74" y="265" font-size="136" font-weight="700">食愿</text>
      <text x="78" y="371" font-size="52" font-weight="600">把想吃的，变成一起吃的。</text>
    </g>
    <g font-family="'PingFang SC', 'Heiti SC', sans-serif">
      <text x="80" y="428" fill="${c.muted}" font-size="29">属于一家人的菜单、厨房与餐桌。</text>
      <g fill="${c.ink}" font-size="25">
        <text x="80" y="553">一起点菜</text><text x="313" y="553">一起备餐</text><text x="548" y="553">一起开饭</text>
      </g>
      <g stroke="${c.line}" stroke-width="2"><path d="M202 544h83"/><path d="M435 544h83"/></g>
    </g>
    <image x="1030" y="135" width="440" height="440" clip-path="url(#logo)" xlink:href="data:image/png;base64,${icon}"/>
    <text x="1250" y="619" text-anchor="middle" fill="${c.muted}" font-family="'Avenir Next', Helvetica, sans-serif" font-size="17" letter-spacing="4">MADE FOR YOUR FAMILY</text>
  </svg>`;
}

for (const compact of [false, true]) {
  for (const dark of [false, true]) {
    const name = `cover${compact ? '-compact' : ''}${dark ? '-dark' : ''}.png`;
    await sharp(Buffer.from(cover(dark, compact))).png({ compressionLevel: 9 }).toFile(path.join(out, name));
  }
}

function badge(label, value, color, left, right) {
  const width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="24" viewBox="0 0 ${width} 24" role="img" aria-label="${escape(label)}: ${escape(value)}">
  <title>${escape(label)}: ${escape(value)}</title>
  <defs><clipPath id="r"><rect width="${width}" height="24" rx="4"/></clipPath></defs>
  <g clip-path="url(#r)"><rect width="${left}" height="24" fill="#344951"/><rect x="${left}" width="${right}" height="24" fill="${color}"/></g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="${left / 2}" y="16">${escape(label)}</text><text x="${left + right / 2}" y="16">${escape(value)}</text>
  </g></svg>\n`;
}

const badges = [
  ['version', 'version', pkg.version, '#4f7565', 58, 54],
  ['wechat', 'WeChat', 'Mini Program', '#41775b', 60, 94],
  ['vue', 'Vue', pkg.dependencies.vue.split('.')[0], '#437665', 39, 25],
  ['cloudbase', 'cloud', 'CloudBase', '#426d88', 48, 80],
];
for (const [name, label, value, color, left, right] of badges) {
  await writeFile(path.join(out, 'badges', `${name}.svg`), badge(label, value, color, left, right));
}
console.log('README cover and badges generated in docs/images/readme. Screenshots are maintained separately.');
