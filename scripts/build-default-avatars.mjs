// Original food illustrations. Local assets only; no remote art or user photos.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_AVATARS, DEFAULT_NICKNAMES } from '../src/domain/default-profile.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, 'src/static/default-avatars');
const review = resolve(root, 'docs/design');
await mkdir(output, { recursive: true });
await mkdir(review, { recursive: true });
const backgrounds = ['#E5EEE2', '#F3EADB', '#F7E5DE', '#F4EBDD', '#E7ECE6', '#ECE5D9', '#F8E8E8', '#E6ECDF', '#EAE7DB', '#F2E4DF', '#EBE8DE', '#DFEAE8', '#F4E9D9', '#E5E9E1', '#F0ECD7', '#E8ECDD', '#F5E6D6', '#E4EAE5', '#E2EBDE', '#E9E6DB'];
const face = (x = 128, y = 142, span = 18) => `<g stroke="#5C5045" stroke-width="4.2" stroke-linecap="round" fill="none"><path d="M${x-span} ${y}v3 M${x+span} ${y}v3"/><path d="M${x-6} ${y+12}q6 7 12 0"/></g><g fill="#DB9A8D" opacity=".58"><ellipse cx="${x-span-11}" cy="${y+10}" rx="7" ry="3.5"/><ellipse cx="${x+span+11}" cy="${y+10}" rx="7" ry="3.5"/></g>`;
const steam = `<g fill="none" stroke="#ABB1A0" stroke-width="4" stroke-linecap="round" opacity=".75"><path d="M99 65q-10-12 1-23"/><path d="M128 60q-10-12 1-23"/><path d="M157 65q-10-12 1-23"/></g>`;
const art = [
  `<ellipse cx="128" cy="116" rx="69" ry="38" fill="#F9F7EC"/><path d="M58 118h140q-4 69-70 72-66-3-70-72" fill="#729884"/><path d="M66 123h124" stroke="#AEC7B2" stroke-width="8" stroke-linecap="round"/><g fill="#DEDCCC"><ellipse cx="93" cy="106" rx="7" ry="3" transform="rotate(-20 93 106)"/><ellipse cx="147" cy="101" rx="7" ry="3" transform="rotate(30 147 101)"/><ellipse cx="124" cy="113" rx="7" ry="3"/></g>${face(128,145)}${steam}`,
  `<path d="M69 166Q51 132 78 98q18-21 50-35 31 14 50 35 27 34 9 68-14 28-59 28-45 0-59-28" fill="#FAF4E7"/><g fill="none" stroke="#DED1B8" stroke-width="4" stroke-linecap="round"><path d="M128 69q-10 18-9 37M127 69q14 18 21 28M127 69q-25 15-34 32"/></g>${face(128,141)}`,
  `<path d="M128 87q-50-20-65 21-20 63 39 84 26 10 52-1 59-25 40-81-15-43-66-23" fill="#DA7966"/><path d="m128 95-30-17 26 0 9-21 7 23 25-7-21 22" fill="#708E62"/><path d="M80 116q-9 16-5 29" stroke="#ECA591" stroke-width="8" fill="none" stroke-linecap="round"/>${face(128,139)}`,
  `<g transform="rotate(13 128 132)"><path d="M96 94q31-22 64 0 7 17-10 62-12 32-23 53-15-18-27-52-16-44-4-63" fill="#D99B65"/><g fill="none" stroke="#7C996B" stroke-width="12" stroke-linecap="round"><path d="M125 88q-4-21-22-27M129 86q-2-25 10-40M135 88q15-17 28-17"/></g><path d="m100 120 10 3m38 34 9-3" stroke="#BC7D50" stroke-width="4" stroke-linecap="round"/>${face(128,125,15)}</g>`,
  `<path d="M65 139q-18-26 9-47 6-29 35-28 20-17 42-1 33-7 38 25 27 13 15 42 16 34-15 45-17 32-50 17-27 16-47-6-35 3-39-27z" fill="#FFFCF1"/><circle cx="131" cy="126" r="43" fill="#EAC274"/><path d="M105 98q11-10 22-9" stroke="#F5DDA5" stroke-width="6" stroke-linecap="round"/>${face(131,123,15)}`,
  `<path d="M79 105q-22-27 0-46 22-17 50-4 33-12 52 9 18 20-5 42v91H80z" fill="#C59561"/><path d="M89 109q-20-25-1-41 18-13 41-3 30-10 44 10 10 14-9 34v76H92z" fill="#F1DCAE"/>${face(127,132)}`,
  `<path d="M128 90q-33-32-58-3-29 36-4 70 26 29 62 45 37-16 64-46 26-34-3-69-27-29-61 3" fill="#E8A6A4"/><path d="M128 90q-6 44 0 84" fill="none" stroke="#D58F90" stroke-width="3"/><path d="M130 78q8-27 37-24-6 25-37 24" fill="#83A179"/><path d="M126 81q-3-19-10-24" stroke="#847354" stroke-width="5" fill="none" stroke-linecap="round"/>${face(128,131,24)}`,
  `<path d="m111 151-6 45q23 14 45 0l-8-49" fill="#A7B482"/><path d="m128 169-27-34m27 34 28-29" stroke="#84996B" stroke-width="7" stroke-linecap="round"/><path d="M75 148q-29-2-21-29-10-26 18-34 4-27 32-21 21-25 44-4 27-10 37 19 32 3 25 32 9 26-18 34-23 21-44 5-35 21-73-2" fill="#719471"/>${face(126,114)}`,
  `<path d="M50 153q7-43 45-68 43-28 83 7 26 23 31 61-76 43-159 0" fill="#F6EAD4"/><path d="M53 153q9-15 18-4 8-20 18-8 7-22 19-8 9-22 20-8 11-17 20-4 12-13 20 1 13-9 19 4 12-5 18 8" stroke="#D5BD96" stroke-width="5" fill="none" stroke-linecap="round"/>${face(126,109)}`,
  `<path d="M83 93q44-24 88 0 24 13 14 50-21 37-57 64-36-27-57-64-11-37 12-50" fill="#D87979"/><path d="m95 91 8-24 22 13 19-21 9 26 26-5-15 21-28-7-21 8z" fill="#7C9B6E"/><g fill="#F1C99B"><ellipse cx="87" cy="123" rx="2" ry="4"/><ellipse cx="106" cy="164" rx="2" ry="4"/><ellipse cx="152" cy="170" rx="2" ry="4"/><ellipse cx="173" cy="125" rx="2" ry="4"/><ellipse cx="128" cy="187" rx="2" ry="4"/></g>${face(130,127)}`,
  `<path d="m104 130-12 55q34 24 72-1l-13-54" fill="#F3E9D4"/><path d="M55 126q10-64 73-66 64 2 74 66-4 15-75 14-69 2-72-14" fill="#B98470"/><g fill="#EFD9C5"><ellipse cx="100" cy="94" rx="12" ry="8"/><ellipse cx="153" cy="95" rx="10" ry="7"/><ellipse cx="176" cy="120" rx="6" ry="4"/></g>${face(128,158,15)}`,
  `<path d="M105 73h46v26q21 12 21 35v56q-44 21-88 0v-56q0-23 21-35z" fill="#F9F6ED"/><path d="M103 54h50v24h-50z" fill="#89AAA7"/><path d="M92 126h72v51H92z" fill="#DCEBE5"/>${face(128,141,15)}`,
  `<ellipse cx="128" cy="138" rx="75" ry="56" fill="#CD985B"/><ellipse cx="128" cy="140" rx="52" ry="57" fill="#DEA86A"/><ellipse cx="128" cy="140" rx="27" ry="57" fill="#E7B57A"/><path d="M128 90q-10-25 8-32" fill="none" stroke="#7A865A" stroke-width="13" stroke-linecap="round"/><path d="M135 79q16-22 38-14-10 22-38 14" fill="#8B9A67"/>${face(128,138)}`,
  `<ellipse cx="128" cy="117" rx="70" ry="32" fill="#EED7A7"/><path d="M58 116h140q-6 67-70 75-65-8-70-75" fill="#BE8873"/><ellipse cx="128" cy="116" rx="63" ry="25" fill="#EDCB8C"/><g fill="none" stroke="#FAE8BE" stroke-width="4" stroke-linecap="round"><path d="M81 111q20-15 47 0t47 0M77 121q20-15 47 0t47 0M99 101q24-11 46 0"/></g><g stroke="#7F7855" stroke-width="5" stroke-linecap="round"><path d="m146 96 59-37M156 105l56-29"/></g>${face(128,147)}${steam}`,
  `<g transform="rotate(12 128 132)"><rect x="93" y="56" width="70" height="134" rx="33" fill="#E5BD61"/><g stroke="#F3D891" stroke-width="4" stroke-linecap="round"><path d="M112 70v94m19-94v97m19-93v84M100 89h56m-56 19h58m-58 20h58m-57 20h56"/></g><path d="M125 198q-53-11-58-89 38 21 58 89M130 198q46-19 48-75-32 20-48 75" fill="#8C9C6C"/>${face(129,111,14)}</g>`,
  `<path d="M93 83q34-43 68 0l35 66q15 46-35 54h-64q-50-8-35-54z" fill="#77916B"/><path d="M100 93q28-36 56 0l27 56q13 35-28 42h-51q-42-7-29-42z" fill="#D3D79A"/><circle cx="128" cy="153" r="29" fill="#A47C59"/>${face(127,100,15)}`,
  `<circle cx="128" cy="139" r="60" fill="#E3AC62"/><path d="M91 99q-16 10-20 27" fill="none" stroke="#EFCA8E" stroke-width="7" stroke-linecap="round"/><path d="M130 78q12-27 40-17-10 23-40 17" fill="#839C6C"/><path d="M127 81v-19" stroke="#947557" stroke-width="5" stroke-linecap="round"/>${face(128,135)}`,
  `<path d="m107 72-49 80 q-18 34 20 38h100q38-4 20-38l-49-80q-21-25-42 0" fill="#FAF6E9"/><path d="M105 149h46v44h-46z" fill="#5F7561"/><g fill="#CACABA"><ellipse cx="102" cy="100" rx="5" ry="2" transform="rotate(-25 102 100)"/><ellipse cx="160" cy="146" rx="5" ry="2"/></g>${face(128,114,16)}`,
  `<path d="M48 167q46-76 147-85-8 71-79 97-43 13-68-12" fill="#82986A"/><path d="M53 164q77 11 137-75" stroke="#ADB98E" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="87" cy="146" r="24" fill="#B1BE84"/><circle cx="127" cy="122" r="24" fill="#B1BE84"/><circle cx="164" cy="97" r="23" fill="#B1BE84"/>${face(88,142,8)}${face(128,118,8)}${face(164,93,8)}`,
  `<path d="M174 112h17q29 1 21 24-7 23-40 16" fill="none" stroke="#8EA49A" stroke-width="13"/><path d="M69 110h109l-9 59q-40 31-80 0z" fill="#8EA49A"/><ellipse cx="124" cy="110" rx="54" ry="14" fill="#D8D7B8"/><ellipse cx="124" cy="107" rx="46" ry="9" fill="#A8AF82"/><ellipse cx="128" cy="192" rx="70" ry="8" fill="#C6C6B3"/>${face(123,142)}${steam}`,
];
const files = [];
for (const [index, avatar] of DEFAULT_AVATARS.entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="${backgrounds[index]}"/><circle cx="128" cy="124" r="98" fill="#FFFDF7" opacity=".32"/><ellipse cx="128" cy="209" rx="57" ry="9" fill="#756D56" opacity=".09"/>${art[index]}</svg>`;
  const png = await sharp(Buffer.from(svg)).resize(320, 320).png({ palette: true, quality: 95, compressionLevel: 9 }).toBuffer();
  await writeFile(resolve(output, `${avatar.id}.png`), png);
  files.push(png);
}
const width = 1500, height = 1510;
const labels = DEFAULT_AVATARS.map((avatar, index) => {
  const x = 50 + (index % 5) * 288, y = 170 + Math.floor(index / 5) * 315;
  return `<text x="${x+128}" y="${y+253}" text-anchor="middle" font-size="24" fill="#43534A">${String(index+1).padStart(2,'0')} · ${avatar.name}</text>`;
}).join('');
const canvas = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#FAF8F2"/><g font-family="PingFang SC, sans-serif"><text x="64" y="75" font-size="36" font-weight="600" fill="#334F42">食愿 · 20 个默认头像</text><text x="64" y="116" font-size="22" fill="#7F877D">原创食物小伙伴 · 缺省头像按账号固定分配 · 随时可换成自己的照片</text>${labels}<text x="64" y="1470" font-size="18" fill="#90958A">头像及昵称只用于展示，不承担用户身份标识；昵称允许重复，用户 ID 始终独立唯一。</text></g></svg>`);
const overlays = await Promise.all(files.map(async (file,index) => ({ input: await sharp(file).resize(224,224).composite([{ input: Buffer.from('<svg width="224" height="224"><circle cx="112" cy="112" r="112" fill="white"/></svg>'), blend: 'dest-in' }]).png().toBuffer(), left: 66+(index%5)*288, top: 170+Math.floor(index/5)*315 })));
await sharp(canvas).composite(overlays).png().toFile(resolve(review, 'default-avatars-v1.png'));
const compatibilityNotes = `## 兼容与落地

- 头像不强制上传。登录身份确认后，首次资料页直接展示分配的头像和昵称；用户正在编辑的内容不会被稍后的登录响应覆盖。
- 默认分配按服务器认证的用户 ID 稳定选择，可重复使用同一头像或昵称。账号仍以微信 OPENID 派生的独立 ID 识别，不由客户端指定，也不依赖昵称唯一。
- 用户及家庭成员只新增可选的 \`defaultAvatarId\`。原有 \`avatar\` 保持合法云图片地址或空字符串，避免线上旧包引用尚未包含的静态头像资源。
- 新客户端发送 \`defaultProfileVersion: 1\`，新后端才返回默认头像展示值；无此能力标记的旧客户端沿用原协议。新客户端连接旧后端时可本地显示缺省头像，保存时仍使用旧版可接受的字段。
- Bootstrap、家庭列表、成员和发现页读取只做展示补全，不顺带改写业务数据。新建、入家庭、保存资料等成功事务会保存默认 ID；无效邀请、无权限或冲突请求不写入资料。
- 个人和家庭中的有效头像、昵称以账号当前资料为准；缺失或退出的历史身份仅使用原快照和安全默认头像，不读取退出后的真实头像。公开动态不额外暴露用户 ID。
- 不需要更换用户 ID、批量迁移旧记录或新增索引。先部署兼容后端，再发布包含 20 张资源的新客户端；旧包空头像不会因数据库写入静态路径而变成坏图。

以上为源码实现规则，真实微信验收、云端部署与前端发布由对应发布记录单独确认。`;
await writeFile(resolve(review, '默认头像与昵称-v1.md'), `# 默认头像与昵称 v1\n\n![20 个原创默认头像](default-avatars-v1.png)\n\n默认头像和昵称在登录身份确认后按用户 ID 固定分配，不因刷新、重装、切换家庭而改变。不修改已有非空昵称、头像。用户可随时自行编辑；昵称不要求唯一，账号 ID 与昵称无关。\n\n20 张头像为本项目原创绘制资源，生成脚本为 \`scripts/build-default-avatars.mjs\`，列表顺序固定。\n\n${compatibilityNotes}\n\n## 100 个昵称\n\n${DEFAULT_NICKNAMES.map((name,index)=>`${index+1}. ${name}`).join('\n')}\n`);
process.stdout.write(`Generated ${files.length} original avatars and a review sheet.\n`);
