import sharp from 'sharp';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const destination = new URL('../assets/brand/', import.meta.url);
const source = await readFile(new URL('shiyuan-icon-v1.svg', destination));

for (const size of [1024, 288, 144]) {
  const output = fileURLToPath(new URL(`shiyuan-icon-v1-${size}.png`, destination));
  await sharp(source).resize(size, size).flatten({ background: '#355E45' }).png().toFile(output);
  const metadata = await sharp(output).metadata();
  const file = await stat(output);
  if (metadata.width !== size || metadata.height !== size || metadata.format !== 'png' || file.size >= 2 * 1024 * 1024) {
    throw new Error(`Invalid WeChat icon: ${output}`);
  }
  console.log(`${size} × ${size} PNG · ${file.size} bytes · ${output}`);
}
