import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const directory = path.resolve(process.argv[2]);
const rows = JSON.parse(await fs.readFile(path.join(directory, 'review-input.json'), 'utf8'));
const cells = [];
for (const [recipeIndex, row] of rows.entries()) {
  if (!row.recipe.steps.some(step => !step.text?.trim())) continue;
  const sourceId = row.recipe.provenance.url.match(/recipe\/(\d+)/)?.[1];
  assert.ok(sourceId);
  const archive = path.resolve('artifacts/recipe-full/recipes', sourceId);
  const manifest = JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8'));
  const source = JSON.parse(await fs.readFile(path.join(archive, 'source.json'), 'utf8'));
  const original = await fs.readFile(path.join(archive, 'cloud-readback.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  assert.equal(source.sourceUrl, row.recipe.provenance.url);
  assert.equal(source.steps.length, row.recipe.steps.length);
  for (const [stepIndex, step] of row.recipe.steps.entries()) {
    if (step.text?.trim()) continue;
    if (original) assert.deepEqual(step.images, original.post.recipes[0].steps[stepIndex].images, '步骤图片顺序与归档不匹配');
    assert.equal(source.steps[stepIndex].text.trim(), step.text.trim());
    const reference = manifest.imageRefs.find(item => item.role === 'step' && item.step === stepIndex + 1);
    const image = manifest.assets[reference?.url];
    assert.ok(image?.path, `归档缺图 ${recipeIndex}/${stepIndex + 1}`);
    cells.push({ recipeIndex, step: stepIndex + 1, title: row.recipe.title, image: image.path });
  }
}
await fs.mkdir(path.join(directory, 'contact-sheets'), { recursive: true });
for (let start = 0; start < cells.length; start += 12) {
  const batch = cells.slice(start, start + 12);
  const composites = [];
  for (const [position, cell] of batch.entries()) {
    const left = position % 4 * 320;
    const top = Math.floor(position / 4) * 350;
    const label = `${cell.recipeIndex} / STEP ${cell.step}`;
    composites.push({ input: Buffer.from(`<svg width="320" height="30"><rect width="320" height="30" fill="white"/><text x="8" y="23" font-size="20">${label}</text></svg>`), left, top });
    composites.push({ input: await sharp(cell.image).resize(320, 320, { fit: 'contain', background: 'white' }).toBuffer(), left, top: top + 30 });
  }
  await sharp({ create: { width: 1280, height: Math.ceil(batch.length / 4) * 350, channels: 3, background: '#dddddd' } }).composite(composites).png().toFile(path.join(directory, 'contact-sheets', `${String(start / 12).padStart(2, '0')}.png`));
}
await fs.writeFile(path.join(directory, 'contact-sheets', 'index.json'), JSON.stringify(cells, null, 2));
console.log(`Archived image verification: ${cells.length} steps`);
