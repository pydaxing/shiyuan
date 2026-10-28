import fs from 'node:fs/promises';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const destination = new URL('../src/static/', import.meta.url);
await fs.mkdir(destination, { recursive: true });
let seed = 83;
function random() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}
const circle = (centerX, centerY, radius, color, extra = '') => `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="${color}" ${extra}/>`;
const ellipse = (centerX, centerY, radiusX, radiusY, color, extra = '') => `<ellipse cx="${centerX}" cy="${centerY}" rx="${radiusX}" ry="${radiusY}" fill="${color}" ${extra}/>`;

function food(kind) {
  let shapes = '';
  if (kind === 'soup' || kind === 'pumpkin') shapes += ellipse(320, 220, 182, 137, kind === 'soup' ? '#d8aa50' : '#d38c36');
  if (kind === 'rice') shapes += ellipse(320, 220, 169, 131, '#e5ce8d');
  const count = kind === 'rice' ? 200 : 44;
  for (let index = 0; index < count; index++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random());
    const centerX = 320 + Math.cos(angle) * distance * 157;
    const centerY = 220 + Math.sin(angle) * distance * 111;
    const rotate = `transform="rotate(${random() * 160} ${centerX} ${centerY})"`;
    if (kind === 'tomato') {
      shapes += index % 2 === 0
        ? `<g ${rotate}><path d="M ${centerX - 27} ${centerY - 15} Q ${centerX} ${centerY - 36} ${centerX + 28} ${centerY - 7} Q ${centerX + 15} ${centerY + 29} ${centerX - 27} ${centerY - 15}" fill="#d94b32" stroke="#b83e29" stroke-width="3"/><path d="M ${centerX - 14} ${centerY - 11} Q ${centerX + 3} ${centerY - 22} ${centerX + 18} ${centerY - 5}" fill="none" stroke="#ee8b59" stroke-width="5"/></g>`
        : `<path ${rotate} d="M ${centerX - 22} ${centerY - 13} q 12 -13 24 -2 q 20 -5 21 10 q 3 18 -20 15 q -25 5 -25 -11 Z" fill="${index % 3 ? '#f6c957' : '#ffe5a0'}" stroke="#dfad42" stroke-width="2"/>`;
    } else if (kind === 'broccoli') {
      shapes += `<g ${rotate}><path d="M ${centerX} ${centerY + 25} l -5 -28 l 16 0 l -3 28 Z" fill="#92b363"/>${circle(centerX - 12, centerY - 4, 15, '#497749')}${circle(centerX + 12, centerY - 5, 18, '#416f41')}${circle(centerX, centerY - 16, 19, '#5b8950')}${circle(centerX - 4, centerY - 24, 6, '#78a162')}</g>`;
    } else if (kind === 'rice') {
      shapes += ellipse(centerX, centerY, 7, 2.8, index % 3 ? '#f9e9ba' : '#cfb874', rotate);
      if (index % 9 === 0) shapes += `<rect x="${centerX}" y="${centerY}" width="11" height="10" rx="2" fill="#d9853d" ${rotate}/>`;
      if (index % 12 === 0) shapes += circle(centerX, centerY, 6, '#6b8a43');
    } else if (kind === 'soup' || kind === 'pumpkin') {
      if (index % 4 === 0) shapes += `<g ${rotate}><rect x="${centerX - 21}" y="${centerY - 17}" width="42" height="32" rx="10" fill="${kind === 'soup' ? '#f5cf54' : '#eead51'}" stroke="#d09d34" stroke-width="2"/><path d="M ${centerX - 10} ${centerY - 15} v 28 M ${centerX} ${centerY - 15} v 28 M ${centerX + 10} ${centerY - 15} v 28" stroke="#e6b33e" stroke-width="3"/></g>`;
      else if (index % 5 === 0) shapes += `<rect x="${centerX - 14}" y="${centerY - 12}" width="30" height="26" rx="8" fill="#b99b70" ${rotate}/>`;
    } else if (kind === 'tofu') {
      shapes += `<rect x="${centerX - 18}" y="${centerY - 14}" width="36" height="29" rx="5" fill="${index % 4 ? '#f5e7b5' : '#bf8b55'}" stroke="#dac593" stroke-width="2" ${rotate}/>`;
    } else {
      shapes += `<rect x="${centerX - 22}" y="${centerY - 13}" width="44" height="27" rx="10" fill="${kind === 'beef' ? '#925431' : '#c69052'}" stroke="${kind === 'beef' ? '#7b442d' : '#ac7540'}" stroke-width="2" ${rotate}/>`;
      if (kind === 'chicken' && index % 4 === 0) shapes += `<g ${rotate}>${ellipse(centerX, centerY, 22, 15, '#715341')}<path d="M ${centerX - 15} ${centerY} Q ${centerX} ${centerY - 17} ${centerX + 15} ${centerY}" fill="none" stroke="#b79a74" stroke-width="3"/></g>`;
      if (kind === 'beef' && index % 3 === 0) shapes += `<path ${rotate} d="M ${centerX - 19} ${centerY - 15} q 32 -12 34 18" fill="none" stroke="${index % 2 ? '#c55432' : '#6d8b45'}" stroke-width="13" stroke-linecap="round"/>`;
    }
  }
  for (let index = 0; index < 26; index++) {
    const centerX = 320 + (random() - 0.5) * 260;
    const centerY = 220 + (random() - 0.5) * 175;
    shapes += `<rect x="${centerX}" y="${centerY}" width="9" height="4" rx="1" fill="#608145" transform="rotate(${random() * 160} ${centerX} ${centerY})"/>`;
  }
  return shapes;
}

function plate(kind) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="460" viewBox="0 0 640 460"><defs><filter id="shadow"><feGaussianBlur stdDeviation="10"/></filter></defs>${ellipse(323, 262, 227, 153, '#44503b', 'opacity=".13" filter="url(#shadow)"')}${ellipse(320, 230, 223, 175, '#dadbce')}${ellipse(320, 220, 223, 172, '#fffdf3')}${ellipse(320, 220, 194, 146, '#f2efe1')}${ellipse(320, 220, 185, 138, '#e9e5cf')}${food(kind)}<path d="M 130 295 Q 163 357 230 372" fill="none" stroke="#ffffff" stroke-width="5" opacity=".8"/></svg>`;
}

for (const kind of ['tomato', 'chicken', 'broccoli', 'soup', 'rice', 'beef', 'tofu', 'pumpkin']) {
  await sharp(Buffer.from(plate(kind))).png().toFile(fileURLToPath(new URL(`${kind}.png`, destination)));
}

const prep = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#eee9dc"/><rect x="107" y="52" width="420" height="250" rx="26" fill="#be915d"/><rect x="122" y="67" width="390" height="220" rx="20" fill="#d2ad78"/><path d="M 145 85 v 185 M 170 85 v 185 M 195 85 v 185 M 220 85 v 185 M 245 85 v 185 M 270 85 v 185" stroke="#c49b69" stroke-width="2" opacity=".5"/>${circle(240, 157, 48, '#cb5135')}${circle(229, 143, 10, '#e46d44')}<path d="M 235 117 l 5 25 l 20 -10 l -12 -7 l 5 -17 l -15 9 l -13 -10 Z" fill="#577d46"/><path d="M 321 128 l 31 -12 l 64 125 l -36 18 Z" fill="#e6e3d6"/><path d="M 310 76 l 21 -11 l 33 64 l -23 12 Z" fill="#3d5946"/><path d="M 237 232 l 40 -30 l 24 25 Z M 294 250 l 24 -44 l 26 41 Z" fill="#dc6340"/></svg>`;
const cook = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#e6e9dd"/><rect x="455" y="164" width="131" height="28" rx="13" fill="#9e7a4c"/><ellipse cx="306" cy="198" rx="169" ry="111" fill="#374c41"/><ellipse cx="306" cy="181" rx="163" ry="104" fill="#56685a"/><ellipse cx="306" cy="180" rx="144" ry="86" fill="#bd9550"/>${circle(242, 180, 28, '#d47842')}${circle(324, 162, 27, '#f0c45c')}${circle(358, 204, 28, '#719253')}${circle(277, 218, 23, '#e4b453')}<path d="M 249 83 q -16 -22 0 -40 M 305 76 q -16 -22 0 -40 M 361 83 q -16 -22 0 -40" fill="none" stroke="#a6b29d" stroke-width="7" stroke-linecap="round"/></svg>`;
await sharp(Buffer.from(prep)).png().toFile(fileURLToPath(new URL('step-prep.png', destination)));
await sharp(Buffer.from(cook)).png().toFile(fileURLToPath(new URL('step-cook.png', destination)));
console.log('Generated 10 original food and cooking illustrations.');
