import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeAuthorizedRecipe } from './normalize-authorized-recipes.mjs';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
async function optionalJson(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export function summarizeArchives(entries, records) {
  const hashes = new Set(records.flatMap(record => record.imageHashes));
  return {
    discoveredSourcePages: entries.length,
    archivedSourcePages: records.length,
    completeSourcePages: records.filter(record => record.fullContentCollected).length,
    uniqueCompleteSourcePages: records.filter(record => record.fullContentCollected && !record.duplicateOf).length,
    incompleteSourcePages: records.filter(record => !record.fullContentCollected).length,
    pendingSourcePages: entries.filter(entry => !entry.archiveDirectory).length,
    imageFiles: records.reduce((sum, record) => sum + record.imageFiles, 0),
    uniqueImageContents: hashes.size,
    sourceSteps: records.reduce((sum, record) => sum + record.steps, 0),
    duplicatePages: records.filter(record => record.duplicateOf).length,
    publishedVerifiedRecipes: records.filter(record => record.publishedPostId && record.publicPublishingAllowed).length,
  };
}

export async function reportArchives(root) {
  const queue = await readJson(path.join(root, 'queue.json'));
  const publication = await optionalJson(path.join(root, 'publication-receipt.json'));
  const records = [];
  for (const entry of queue.entries.filter(item => item.archiveDirectory)) {
    const sourceId = new URL(entry.sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    const directory = path.join(root, 'recipes', sourceId);
    const [raw, manifest, review] = await Promise.all([
      readJson(path.join(directory, 'source.json')),
      readJson(path.join(directory, 'manifest.json')),
      optionalJson(path.join(directory, 'review.json')),
    ]);
    const assets = Object.fromEntries(Object.entries(manifest.assets).map(([url, asset]) => [url, { ...asset, fileId: publication?.uploads?.[asset.sha256]?.fileId }]));
    const normalized = await normalizeAuthorizedRecipe(raw, { category: review?.category || '其他', authorizationId: queue.authorizationId, assets, review });
    const receipt = publication?.recipes?.[entry.sourceUrl];
    const record = {
      sourceId, title: raw.title, sourceUrl: entry.sourceUrl, author: raw.author,
      fullContentCollected: manifest.fullContentCollected,
      imageFiles: new Set(Object.values(manifest.assets).map(asset => asset.path)).size,
      imageHashes: [...new Set(Object.values(manifest.assets).map(asset => asset.sha256))],
      steps: raw.steps.length, ingredients: raw.ingredients.length,
      duplicateOf: manifest.duplicateOf,
      publishedPostId: receipt?.stage === 'published_verified' ? receipt.postId : null,
      publicPublishingAllowed: normalized.publicPublishingAllowed,
      checks: { images: manifest.failures, sourceStructure: manifest.structureIssues, issues: normalized.issues },
    };
    records.push(record);
  }
  return { generatedAt: new Date().toISOString(), authorizationId: queue.authorizationId, collectionState: queue.state, collectionPolicy: queue.collectionPolicy || null, pause: queue.pause || null, counts: summarizeArchives(queue.entries, records), records };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(process.argv[2] || 'artifacts/recipe-full');
  const report = await reportArchives(root);
  const file = path.join(root, 'batch-report.json');
  await writeFile(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
  console.log(JSON.stringify(report.counts, null, 2));
}
