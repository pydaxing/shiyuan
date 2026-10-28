import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { canonicalRecipeUrl } from './recipe-discovery.mjs';
import { recipeContentFingerprints } from './recipe-content-dedupe.mjs';
import { reindexRecipeContent } from './reindex-recipe-content.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const atomicJson = async (file, value) => {
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
};

export async function archiveAuthorizedRecipe(root, raw, bundle) {
  root = path.resolve(root);
  const queuePath = path.join(root, 'queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const sourceUrl = canonicalRecipeUrl(raw.sourceUrl);
  const matching = queue.entries.filter(item => canonicalRecipeUrl(item.sourceUrl) === sourceUrl);
  const entry = matching.find(item => item.archiveDirectory) || matching[0];
  if (!entry) throw new Error('来源不在已授权队列中');
  if (raw.authorizationId !== queue.authorizationId || raw.authorizationId !== entry.authorizationId) throw new Error('授权记录不匹配');
  const sourceId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
  const directory = entry.archiveDirectory ? path.resolve(root, entry.archiveDirectory) : path.join(root, 'recipes', sourceId);
  const relative = path.relative(path.join(root, 'recipes'), directory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('归档目录超出 recipes');
  let existingManifest;
  try { existingManifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existingManifest && (canonicalRecipeUrl(existingManifest.sourceUrl) !== sourceUrl || existingManifest.authorizationId !== queue.authorizationId)) throw new Error('归档来源或授权不匹配');
  if (existingManifest?.fullContentCollected) return { ...existingManifest, skipped: true, skipReason: 'same_source_url' };
  try { raw = JSON.parse(await readFile(path.join(directory, 'source.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (canonicalRecipeUrl(raw.sourceUrl) !== sourceUrl || raw.authorizationId !== queue.authorizationId) throw new Error('源档来源或授权不匹配');
  if (!raw.title || !raw.author || !raw.cover?.url || !Array.isArray(raw.ingredients) || !Array.isArray(raw.steps)) throw new Error('正文结构异常，不能记为成功');
  const structureIssues = [];
  if (!raw.ingredients.length) structureIssues.push('来源未提供结构化用料表');
  if (!raw.steps.length) structureIssues.push(raw.videos?.length ? '来源为视频，未提供图文步骤' : '来源未提供步骤');
  await mkdir(path.join(directory, 'images'), { recursive: true });
  try { await writeFile(path.join(directory, 'source.json'), `${JSON.stringify(raw, null, 2)}\n`, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const imageRefs = [{ role: 'cover', url: raw.cover.url }, ...raw.steps.flatMap((step, stepIndex) => step.images.map((image, imageIndex) => ({ role: 'step', step: stepIndex + 1, index: imageIndex + 1, url: image.url })))];
  const urls = [...new Set(imageRefs.map(image => image.url))];
  const assets = {};
  const failures = [];
  for (const url of urls) {
    const asset = bundle.assets.find(item => item.url === url);
    if (!asset) { failures.push({ url, reason: bundle.failures?.find(item => item.url === url)?.reason || '浏览器未导出图片' }); continue; }
    try {
      const bytes = await readFile(asset.path);
      const metadata = await sharp(bytes, { limitInputPixels: 40000000 }).metadata();
      if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) || !metadata.width || !metadata.height) throw new Error('不支持或损坏的图片');
      const sha256 = digest(bytes);
      const filename = path.join(directory, 'images', `${sha256}.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`);
      await writeFile(filename, bytes);
      assets[url] = { path: filename, sha256, bytes: bytes.length, width: metadata.width, height: metadata.height, contentType: asset.contentType, sourceUrl: url };
    } catch (error) { failures.push({ url, reason: error.message }); }
  }
  const fingerprints = recipeContentFingerprints(raw);
  const manifest = { ...existingManifest, sourceUrl, title: raw.title, author: raw.author, authorizationId: raw.authorizationId, fetchedAt: raw.fetchedAt, archivedAt: existingManifest?.archivedAt || new Date().toISOString(), ...fingerprints, imageRefs, assets, failures, structureIssues, fullContentCollected: !failures.length && !structureIssues.length, duplicateOf: null, imageResolution: '页面实际展示图像，未猜测或请求未展示的原图地址' };
  await atomicJson(path.join(directory, 'manifest.json'), manifest);
  Object.assign(entry, { status: entry.publishedPostId ? 'published' : structureIssues.length ? 'source_missing_structure' : failures.length ? 'incomplete_images' : 'collected_pending_review', fullContentCollected: manifest.fullContentCollected, archiveDirectory: directory, fetchedAt: raw.fetchedAt, ...fingerprints, imageCount: Object.keys(assets).length, stepCount: raw.steps.length, ingredientCount: raw.ingredients.length, duplicateOf: null });
  queue.updatedAt = new Date().toISOString();
  if (!queue.pause && !queue.state?.startsWith('paused')) queue.state = 'collecting_in_verified_browser';
  await atomicJson(queuePath, queue);
  await reindexRecipeContent(root);
  return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , root, sourceFile, bundleFile] = process.argv;
  if (!root || !sourceFile || !bundleFile) throw new Error('用法: node scripts/archive-authorized-recipe.mjs <归档根目录> <source.json> <browser-bundle.json>');
  const result = await archiveAuthorizedRecipe(root, JSON.parse(await readFile(sourceFile, 'utf8')), JSON.parse(await readFile(bundleFile, 'utf8')));
  console.log(JSON.stringify({ title: result.title, fullContentCollected: result.fullContentCollected, images: Object.keys(result.assets).length, failures: result.failures, skipped: result.skipped || false, skipReason: result.skipReason || null, duplicateOf: result.duplicateOf, duplicateReason: result.duplicateReason, suspectedDuplicateOf: result.suspectedDuplicateOf, dedupeVersion: result.dedupeVersion }));
}
