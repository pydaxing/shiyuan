import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';

const destination = new URL('../src/static/', import.meta.url);
const icons = {
  menu: '<path d="M4 13h24c-1 9-5 12-12 12S5 22 4 13Z"/><path d="M10 28h12M10 8V4m6 4V2m6 6V4"/>',
  'meal-set': '<rect x="3" y="5" width="26" height="22" rx="4"/><path d="M18 5v22M18 16h11"/><circle cx="10.5" cy="16" r="4"/>',
  community: '<rect x="4" y="4" width="9" height="9" rx="3"/><rect x="19" y="4" width="9" height="9" rx="3"/><rect x="4" y="19" width="9" height="9" rx="3"/><path d="m23.5 17 1.8 4.7 4.7 1.8-4.7 1.8-1.8 4.7-1.8-4.7-4.7-1.8 4.7-1.8Z"/>',
  inventory: '<rect x="7" y="3" width="18" height="25" rx="3"/><path d="M7 13h18M11 7v3m0 7v5M11 28v2m10-2v2"/>',
  shopping: '<path d="M3 5h4l4 16h14l3-11H8.25"/><circle cx="13" cy="27" r="2"/><circle cx="24" cy="27" r="2"/>',
  family: '<path d="m3 14 13-11 13 11M7 12v16h18V12"/><path d="M16 16c-5-6-10 2 0 7 10-5 5-13 0-7Z"/>',
  chef: '<path d="M9 19a6 6 0 0 1-2-11 6 6 0 0 1 11-3 6 6 0 0 1 9 8 6 6 0 0 1-4 6v9H9v-9Z"/><path d="M9 23h14m-10-7v3m6-3v3"/>',
  camera: '<path d="M4 9h6l2-4h8l2 4h6v18H4V9Z"/><circle cx="16" cy="17" r="5"/>',
  calendar: '<rect x="5" y="6" width="22" height="23" rx="3"/><path d="M10 3v6m12-6v6M5 13h22m-16 6h3m5 0h3m-11 5h3"/>',
  plus: '<path d="M16 7v18M7 16h18"/>',
  'plus-inverse': '<path d="M16 7v18M7 16h18"/>',
  minus: '<path d="M7 16h18"/>',
  'arrow-up': '<path d="M16 26V6m-8 8 8-8 8 8"/>',
  'arrow-down': '<path d="M16 6v20m-8-8 8 8 8-8"/>',
  check: '<path d="m7 16 6 6L26 9"/>',
  'check-inverse': '<path d="m7 16 6 6L26 9"/>',
  arrow: '<path d="M6 16h20m-8-8 8 8-8 8"/>',
  'arrow-inverse': '<path d="M6 16h20m-8-8 8 8-8 8"/>',
  clock: '<circle cx="16" cy="16" r="12"/><path d="M16 8v8l5 3"/>',
  'alert-danger': '<circle cx="16" cy="16" r="12"/><path d="M16 9v8m0 6h.01"/>',
  crown: '<path d="m5 10 6 5 5-10 5 10 6-5-3 14H8L5 10Zm4 18h14"/>',
  exit: '<path d="M14 5H6v22h8M13 16h16m-6-6 6 6-6 6"/>',
  trash: '<path d="M5 9h22M12 5h8M8 9l1 19h14l1-19M13 14v9m6-9v9"/>',
  edit: '<path d="m7 21-2 7 7-2L26 12l-5-5L7 21Zm11-11 5 5M7 21l5 5"/><path d="m21 7 2-2a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-2 2"/>',
  share: '<path d="m20 5 9 9-9 9v-6C12 17 7 20 4 27v-5C4 13 10 10 20 10V5Z"/>',
  'share-feed': '<path d="m20.8 5.8 7.7 7.9q.7.8 0 1.6l-7.7 7.9q-1.3 1.3-1.3-.5v-4.4C12.4 17.9 7.4 20.3 4 25.3c-.5.7-1 .4-.9-.5C4 16.8 9.2 11.4 19.5 10.6V6.3q0-1.8 1.3-.5Z"/>',
  close: '<path d="m9 9 14 14M23 9 9 23"/>',
  cancel: '<circle cx="16" cy="16" r="11"/><path d="m8 8 16 16"/>',
  restore: '<path d="M6 12a10 10 0 1 1 0 8M6 5v7h7"/>',
  'restore-inverse': '<path d="M6 12a10 10 0 1 1 0 8M6 5v7h7"/>',
  thumb: '<path d="M11 14 17 5c1-2 4-1 4 1v7h5c2 0 3 2 2 4l-2 9c0 1-1 2-3 2H11V14Z"/><rect x="4" y="14" width="7" height="14" rx="2"/>',
  chevron: '<path d="m12 8 8 8-8 8"/>',
  'detail-collapse': '<path d="m7.5 12 8.5 8.5 8.5-8.5"/>',
  'detail-share': '<path d="M17.5 5.4c0-1.6 1-2 2.2-.9l8 7.5c1.1 1 1.1 2.5 0 3.5l-8.1 8.1c-1.2 1.2-2.4.7-2.3-.9l.2-3.7c-5.6-.4-9.4 1.9-12.5 4.8-1.3 1.2-2.1.7-1.7-1.1 1.4-7.6 6.1-11.8 14.2-12.3V5.4Z"/>',
  search: '<circle cx="14" cy="14" r="9"/><path d="m21 21 7 7"/>',
  grid: '<rect x="5" y="5" width="8" height="22" rx="2"/><rect x="19" y="5" width="8" height="22" rx="2"/>',
  list: '<rect x="5" y="5" width="22" height="8" rx="2"/><rect x="5" y="19" width="22" height="8" rx="2"/>',
};
const navigationIcons = new Set(['menu', 'community', 'inventory', 'shopping', 'family']);
for (const name of ['edit', 'trash', 'menu', 'chef', 'camera', 'close', 'clock', 'shopping']) icons[`${name}-inverse`] = icons[name];
icons['menu-photo'] = icons.menu;
icons['trash-danger'] = icons.trash;
icons['arrow-left'] = '<path d="M26 16H6m8-8-8 8 8 8"/>';
const photoIconsOnly = process.argv.includes('--photo-icons-only');
const selectedIcon = process.argv.find(argument => argument.startsWith('--icon='))?.slice(7);
if (selectedIcon && !icons[selectedIcon]) throw new Error(`Unknown icon: ${selectedIcon}`);
for (const [name, paths] of Object.entries(icons)) {
  if (selectedIcon && name !== selectedIcon) continue;
  if (photoIconsOnly && !['menu-photo', 'clock-inverse'].includes(name)) continue;
  for (const active of [false, true]) {
    const color = name.endsWith('-inverse') || name === 'menu-photo' ? '#ffffff' : name.endsWith('-danger') ? NATIVE_UI_COLORS.danger : (active ? NATIVE_UI_COLORS.primary : NATIVE_UI_COLORS.muted);
    const strokeWidth = name.startsWith('detail-') ? 2.6 : name === 'share-feed' ? 2 : navigationIcons.has(name) && active ? 2.2 : 1.8;
    const shadow = name === 'menu-photo' ? `<g stroke="#000000" opacity=".55" fill="none" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 .7)">${paths}</g>` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 32 32">${shadow}<g stroke="${color}" fill="none" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(`icon-${name}${active ? '-active' : ''}.png`, destination)));
  }
}

if (process.argv.includes('--icons-only') || photoIconsOnly || selectedIcon) {
  console.log(`Generated ${selectedIcon ? 2 : photoIconsOnly ? 4 : Object.keys(icons).length * 2} icons.`);
  process.exit(0);
}

const illustrations = {
  tomato: '<ellipse cx="238" cy="275" rx="145" ry="20" fill="#d7c8b4" opacity=".5"/><path d="M133 150c18-40 80-44 105-8 38-37 103-25 110 34 18 110-106 139-151 107-50-18-89-87-64-133Z" fill="#ce654c"/><path d="M209 152c-5-32 4-48 16-62l12 39 46-10-28 25 29 22-52-11-31 21 8-24Z" fill="#597d50"/><path d="M157 172c-12 27-7 52 2 65" fill="none" stroke="#e99478" stroke-width="13" stroke-linecap="round"/><path d="M290 269c16-25 26-45 31-65" fill="none" stroke="#b85643" stroke-width="5"/>',
  eggs: '<rect x="93" y="211" width="296" height="80" rx="25" fill="#c5b89d"/><ellipse cx="155" cy="213" rx="47" ry="64" fill="#ead5b5"/><ellipse cx="244" cy="201" rx="48" ry="76" fill="#f4e6cb"/><ellipse cx="329" cy="220" rx="43" ry="61" fill="#dcbf96"/><path d="M121 203c0-20 9-39 18-42m72 19c0-23 11-43 22-47m66 80c0-21 8-34 14-42" stroke="#fff2da" stroke-width="9" stroke-linecap="round" fill="none"/><path d="M108 275h264" stroke="#ab9c80" stroke-width="6"/>',
  meat: '<rect x="80" y="111" width="322" height="189" rx="37" fill="#e0e7e1"/><rect x="96" y="127" width="289" height="151" rx="28" fill="#f6f7ec"/><path d="M129 221c-9-34 34-73 90-60 40-58 135-30 134 28 0 59-82 77-136 50-37 29-83 21-88-18Z" fill="#c98574" stroke="#ebc6af" stroke-width="9"/><path d="m216 180 16 45m28-56 18 62m24-64 17 45" stroke="#e9b5a3" stroke-width="9" stroke-linecap="round"/><path d="m129 108 25-25m-10 39 35-5" stroke="#789b7d" stroke-width="9" stroke-linecap="round"/>',
  bottle: '<path d="M173 103h73v45c0 20 28 27 28 53v88H145v-88c0-26 28-33 28-53v-45Z" fill="#d6ad57"/><rect x="171" y="76" width="77" height="34" rx="8" fill="#668265"/><rect x="156" y="190" width="106" height="60" rx="4" fill="#f7eccf"/><path d="M208 203c-22 24-20 32 0 36 20-4 22-12 0-36Z" fill="#91a06a"/><path d="M295 147h40v29c0 12 20 18 20 35v78h-80v-78c0-17 20-23 20-35v-29Z" fill="#8e6b47"/><rect x="291" y="128" width="48" height="24" rx="5" fill="#484d3b"/><rect x="282" y="210" width="66" height="45" rx="3" fill="#e5d4ae"/>',
  jar: '<rect x="118" y="115" width="230" height="181" rx="32" fill="#d7ddd0"/><path d="M133 214q82-30 199 0v54a12 12 0 0 1-12 12H145a12 12 0 0 1-12-12Z" fill="#f7f0da"/><rect x="111" y="90" width="243" height="41" rx="13" fill="#a89774"/><path d="M132 105h200" stroke="#c5b691" stroke-width="6"/><rect x="183" y="171" width="104" height="70" rx="10" fill="#faf8ef"/><path d="M212 192h44m-22-9v43m-18-20h36" stroke="#789371" stroke-width="5" stroke-linecap="round"/>',
  greens: '<path d="M218 284 161 189l39-19 39 68 50-85 33 18-64 113Z" fill="#a9b77b"/><circle cx="149" cy="164" r="49" fill="#6a9061"/><circle cx="202" cy="136" r="58" fill="#709767"/><circle cx="251" cy="149" r="54" fill="#527e54"/><circle cx="299" cy="145" r="40" fill="#86a271"/><circle cx="323" cy="179" r="40" fill="#648a5f"/><path d="M141 149c8-14 20-18 30-15m18-22c8-13 22-17 35-12m58 38 12-8" stroke="#a0b88b" stroke-width="8" fill="none" stroke-linecap="round"/>',
};
for (const [name, art] of Object.entries(illustrations)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><ellipse cx="240" cy="290" rx="158" ry="15" fill="#c4c4ad" opacity=".23"/>${art}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(`ingredient-${name}.png`, destination)));
}
const familyPortraits = {
  garden: ['#e8eddf', '<circle cx="172" cy="58" r="23" fill="#d8bc75"/><path d="m44 125 75-64 75 64" fill="#7c946d"/><rect x="60" y="119" width="118" height="77" rx="8" fill="#fff5db"/><path d="M100 196v-48h39v48" fill="#8fa77e"/><path d="M29 195v-49m0 24c-24-30-29-55-5-52 24 10 22 32 5 52m169 25v-39m0 16c-20-28-18-44 4-40 20 14 12 31-4 40" fill="#95ab7d"/>'],
  sunrise: ['#f2e7d4', '<circle cx="120" cy="85" r="43" fill="#d9a363"/><path d="M12 181q67-77 124 0t110 0v59H0Z" fill="#b1b995"/><path d="m62 138 55-47 57 47" fill="#b57e62"/><rect x="73" y="137" width="90" height="65" rx="6" fill="#fff4dc"/><rect x="108" y="159" width="25" height="43" rx="4" fill="#85987c"/>'],
  table: ['#e9e5d8', '<ellipse cx="120" cy="148" rx="95" ry="60" fill="#ac8666"/><ellipse cx="120" cy="141" rx="94" ry="58" fill="#d7b88f"/><circle cx="88" cy="141" r="29" fill="#fff5dc"/><circle cx="88" cy="141" r="20" fill="#9fae7d"/><circle cx="162" cy="145" r="22" fill="#fff5dc"/><circle cx="162" cy="145" r="14" fill="#cb8b62"/><path d="M72 82c-17-21 16-22 0-43m51 40c-17-21 16-22 0-43m50 46c-17-21 16-22 0-43" fill="none" stroke="#9aab89" stroke-width="6" stroke-linecap="round"/>'],
  orchard: ['#e5ebdf', '<path d="M120 202V104" stroke="#98785a" stroke-width="14" stroke-linecap="round"/><circle cx="121" cy="91" r="55" fill="#829b70"/><circle cx="77" cy="120" r="38" fill="#8ea87b"/><circle cx="162" cy="121" r="37" fill="#97ad7d"/><circle cx="93" cy="105" r="14" fill="#daa064"/><circle cx="141" cy="75" r="14" fill="#dfb274"/><circle cx="154" cy="133" r="14" fill="#d39464"/><ellipse cx="120" cy="207" rx="67" ry="9" fill="#c4cdb4"/>'],
  moon: ['#dee5e4', '<path d="M167 39c-56 2-53 70-1 73-21 27-64 6-64-29 0-35 40-56 65-44" fill="#f1d69b"/><path d="m42 144 73-59 73 59" fill="#6d8986"/><rect x="59" y="140" width="112" height="63" rx="7" fill="#f4eddb"/><rect x="102" y="157" width="30" height="46" rx="4" fill="#b6aa89"/><path d="M50 57v12m-6-6h12m138 30v12m-6-6h12" stroke="#9eb3ab" stroke-width="4" stroke-linecap="round"/>'],
  tea: ['#eee7d9', '<ellipse cx="120" cy="195" rx="76" ry="13" fill="#cfc1a4"/><path d="M169 128c52-17 44 45-4 32" fill="none" stroke="#8ea481" stroke-width="13"/><path d="M55 117h123v23c0 35-17 53-61 53s-62-18-62-53Z" fill="#8ea481"/><ellipse cx="116" cy="117" rx="61" ry="14" fill="#eef0d6"/><ellipse cx="116" cy="117" rx="51" ry="8" fill="#b59c71"/><path d="M96 90c-16-22 15-26 2-46m40 46c-16-22 15-26 2-46" fill="none" stroke="#acb59a" stroke-width="6" stroke-linecap="round"/>'],
};
for (const [name, [background, art]] of Object.entries(familyPortraits)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="${background}"/>${art}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(`family-${name}.png`, destination)));
}
console.log(`Generated ${Object.keys(icons).length * 2} icons, 6 ingredient illustrations and 6 family portraits.`);
