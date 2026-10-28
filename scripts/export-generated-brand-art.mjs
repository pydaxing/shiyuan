import sharp from 'sharp';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = new URL('../assets/brand/', import.meta.url);
const source = fileURLToPath(new URL('shiyuan-icon-v2-gpt-image-2-original.png', destination));
const original = await sharp(source).metadata();
if (original.width !== 1024 || original.height !== 1024) {
  throw new Error('Expected one 1024 × 1024 generated icon.');
}

for (const size of [1024, 288, 144, 32]) {
  const output = fileURLToPath(new URL(`shiyuan-icon-v2-${size}.png`, destination));
  await sharp(source).resize(size, size).flatten({ background: '#355E45' }).png().toFile(output);
  const metadata = await sharp(output).metadata();
  const file = await stat(output);
  if (metadata.width !== size || metadata.height !== size || metadata.format !== 'png' || file.size >= 2 * 1024 * 1024) {
    throw new Error(`Invalid WeChat icon: ${output}`);
  }
  console.log(`${size} × ${size} PNG · ${file.size} bytes · ${output}`);
}

const circleMask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="288" height="288"><circle cx="144" cy="144" r="144" fill="white"/></svg>');
await sharp(source)
  .resize(288, 288)
  .ensureAlpha()
  .composite([{ input: circleMask, blend: 'dest-in' }])
  .png()
  .toFile(fileURLToPath(new URL('shiyuan-icon-v2-circle-preview.png', destination)));
