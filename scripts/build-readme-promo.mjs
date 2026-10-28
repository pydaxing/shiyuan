import { mkdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Documentation and promotion artwork only; never builds or deploys the app.
// Keep the original mini-program code intact. It is resized as a complete square.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'docs/images/promotion');
await mkdir(out, { recursive: true });
const asset = async (file, mime = 'image/png') => `data:${mime};base64,${(await readFile(path.join(root, file))).toString('base64')}`;
const qr = await asset('docs/images/promotion/mini-program-code-1280.jpg', 'image/jpeg');
const icon = await asset('assets/brand/shiyuan-icon-v2-1024.png');
const phones = Object.fromEntries(await Promise.all(['discover', 'menu', 'kitchen'].map(async name => [name, await asset(`docs/images/readme/${name}-phone.png`)])));
const C = { bg: '#f5f7f8', ink: '#24363f', muted: '#61767f', line: '#ccd9de', soft: '#e8eef1', green: '#2f624d' };
const sans = "'PingFang SC','Heiti SC',sans-serif";
const serif = "'Songti SC','STSong',serif";
const text = (s, x, y, size, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${s}</text>`;
const img = (src, x, y, w, h = w) => `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${src}"/>`;
const base = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="28" fill="${C.bg}"/><g font-family="${sans}" fill="${C.ink}">${body}</g></svg>`;
function ornament(w, h) { return `<circle cx="${w-15}" cy="50" r="${h*.7}" fill="${C.soft}"/><circle cx="${w-15}" cy="50" r="${h*.58}" fill="none" stroke="${C.line}" stroke-width="2"/>`; }
function code(x, y, size) { return `<rect x="${x-12}" y="${y-12}" width="${size+24}" height="${size+24}" rx="22" fill="#fff"/>${img(qr,x,y,size)}`; }
function search(x, y, w, h, size = 30) { return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h/2}" fill="${C.green}"/><circle cx="${x+36}" cy="${y+h/2-3}" r="10" fill="none" stroke="#fff" stroke-width="3"/><path d="M${x+44},${y+h/2+5}l9,9" stroke="#fff" stroke-width="3" stroke-linecap="round"/>${text('微信搜索  食愿小灶',x+70,y+h/2+size*.34,size,'fill="#fff" font-weight="600"')}`; }
function top(compact) {
  if (compact) return base(900,1080,`${ornament(900,620)}${img(icon,70,58,74)}${text('食愿小灶 · 微信小程序',166,107,31,`fill="${C.muted}"`)}${text('今天吃什么？',450,240,88,`text-anchor="middle" font-family="${serif}" font-weight="700"`)}${text('把想吃的，变成一起吃的。',450,310,38,'text-anchor="middle"')}${search(175,365,550,78,32)}${code(215,498,470)}${text('打开微信扫一扫 · 或搜索「食愿小灶」',450,1030,28,`text-anchor="middle" fill="${C.muted}"`)}`);
  return base(1600,640,`${ornament(1600,640)}${img(icon,78,58,74)}${text('食愿小灶 · 微信小程序',176,106,29,`fill="${C.muted}"`)}${text('今天吃什么？',76,250,100,`font-family="${serif}" font-weight="700"`)}${text('把想吃的，变成一起吃的。',80,335,47)}${text('收藏想吃的 · 一起点菜 · 安排下厨',82,396,28,`fill="${C.muted}"`)}${search(80,456,600,82,33)}${text('属于一家人的菜单、厨房与餐桌',82,590,24,`fill="${C.muted}"`)}${code(1060,54,480)}${text('打开微信扫一扫',1300,594,29,'text-anchor="middle"')}`);
}
function bottom(compact) {
  if(compact) return base(900,1060,`${ornament(900,620)}${text('今晚想吃什么，',450,132,66,`text-anchor="middle" font-family="${serif}" font-weight="700"`)}${text('先选起来。',450,221,80,`text-anchor="middle" font-family="${serif}" font-weight="700"`)}${text('和家人一起，把每天的饭好好安排。',450,287,32,`text-anchor="middle" fill="${C.muted}"`)}${search(175,342,550,78,32)}${code(215,480,470)}${text('扫码体验食愿小灶',450,1011,32,'text-anchor="middle"')}`);
  return base(1600,560,`${ornament(1600,560)}${text('今晚想吃什么，先选起来。',78,142,66,`font-family="${serif}" font-weight="700"`)}${text('和家人一起，把每天的饭好好安排。',82,216,34,`fill="${C.muted}"`)}${search(80,279,600,82,33)}${text('打开微信扫一扫，或者搜索「食愿小灶」',82,435,27)}${text('一起点菜 · 一起备餐 · 一起开饭',82,492,24,`fill="${C.muted}"`)}${code(1094,50,420)}${text('食愿小灶',1304,520,27,'text-anchor="middle"')}`);
}
function social() {
  return base(1280,640,`${ornament(1280,640)}${img(icon,62,46,64)}${text('食愿小灶',149,90,32,`fill="${C.muted}"`)}${text('把「今天吃什么」',58,195,58,`font-family="${serif}" font-weight="700"`)}${text('变成一家人的菜单。',58,272,58,`font-family="${serif}" font-weight="700"`)}${text('收藏想吃的 · 一起点菜 · 安排下厨',64,327,25,`fill="${C.muted}"`)}${code(67,373,200)}${text('微信小程序',301,418,24,`fill="${C.muted}"`)}${text('搜索 食愿小灶',301,468,32,'font-weight="600"')}${text('或打开微信扫一扫',301,513,23,`fill="${C.muted}"`)}${img(phones.discover,727,53,272,541.4)}${img(phones.menu,975,104,245,487.6)}`);
}
function poster() {
  return base(1080,1440,`${ornament(1080,900)}${img(icon,64,52,64)}${text('食愿小灶 · 微信小程序',151,97,30,`fill="${C.muted}"`)}${text('今天吃什么？',62,216,91,`font-family="${serif}" font-weight="700"`)}${text('把想吃的，变成一起吃的。',66,287,45)}${text('从一家人的心愿菜单，到热气腾腾的一餐。',67,341,29,`fill="${C.muted}"`)}${img(phones.discover,60,392,300,597.1)}${img(phones.menu,390,392,300,597.1)}${img(phones.kitchen,720,392,300,597.1)}${text('发现想吃的',210,1034,30,'text-anchor="middle"')}${text('一起定菜单',540,1034,30,'text-anchor="middle"')}${text('下厨有安排',870,1034,30,'text-anchor="middle"')}<path d="M65 1091h950" stroke="${C.line}" stroke-width="2"/>${text('让「随便吃点」',67,1163,39,`font-family="${serif}" font-weight="600"`)}${text('变成「一起好好吃饭」。',67,1220,39,`font-family="${serif}" font-weight="600"`)}${search(65,1273,565,75,31)}${code(742,1123,264)}${text('扫码体验',874,1414,23,'text-anchor="middle"')}`);
}
const jobs = [
  ['readme-cta-top.png',top(false)],['readme-cta-top-compact.png',top(true)],
  ['readme-cta-bottom.png',bottom(false)],['readme-cta-bottom-compact.png',bottom(true)],
  ['social-preview.jpg',social()],['poster.png',poster()]
];
for(const [name, svg] of jobs) {
  const p=sharp(Buffer.from(svg));
  if(name.endsWith('.jpg')) await p.flatten({background:C.bg}).jpeg({quality:92,mozjpeg:true,chromaSubsampling:'4:4:4'}).toFile(path.join(out,name));
  else await p.png({compressionLevel:9,palette:false}).toFile(path.join(out,name));
  const m=await sharp(path.join(out,name)).metadata();const s=await stat(path.join(out,name));
  console.log(`${name}: ${m.width}×${m.height}, ${Math.round(s.size/1024)} KiB`);
}
