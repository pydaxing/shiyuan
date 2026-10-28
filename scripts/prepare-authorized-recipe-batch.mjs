import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalRecipeUrl } from './recipe-discovery.mjs';
import { RECIPE_CONTENT_DEDUPE_VERSION } from './recipe-content-dedupe.mjs';

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

export async function prepareAuthorizedRecipeBatch(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const folder = resolve(root, 'artifacts/recipe-full');
  const authorization = JSON.parse(await readFile(resolve(folder, 'authorization.json'), 'utf8'));
  assert.equal(authorization.basis, 'user_confirmation_in_current_conversation');
  const allowedHosts = new Set(authorization.sourceWebsites.map(website => new URL(website).hostname));
  const inputNames = ['source-links.json', 'duplicates.json', 'near-duplicates.json'];
  const inputs = await Promise.all(inputNames.map(async (name, index) => {
    const file = resolve(root, 'artifacts/recipe-crawl', name);
    const entries = index ? await optionalJson(file, []) : JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Array.isArray(entries), `${name} 必须为链接数组`);
    return entries;
  }));
  const target = resolve(folder, 'queue.json');
  const existing = await optionalJson(target, null);
  if (existing) assert.equal(existing.authorizationId, authorization.id);
  const queue = existing || {
    createdAt: new Date().toISOString(),
    authorizationId: authorization.id,
    state: 'awaiting_website_access',
    plannedFields: ['title', 'author', 'sourceUrl', 'fetchedAt', 'cover', 'ingredients', 'steps', 'imageSourceUrls', 'contentFingerprint', 'textFingerprint', 'stepsFingerprint', 'dedupeVersion', 'duplicateOf', 'duplicateReason', 'suspectedDuplicateOf', 'imageHashes'],
    publicationPolicy: 'complete_source_content_and_valid_recipe_required_then_publish',
    entries: [],
  };
  const urls = new Set(queue.entries.map(entry => canonicalRecipeUrl(entry.sourceUrl)));
  let addedEntries = 0;
  let skippedSameUrl = 0;
  let rejectedLinks = 0;
  for (const link of inputs.flat()) {
    const sourceUrl = canonicalRecipeUrl(link.sourceUrl);
    if (!sourceUrl || !allowedHosts.has(new URL(sourceUrl).hostname)) { rejectedLinks += 1; continue; }
    if (urls.has(sourceUrl)) { skippedSameUrl += 1; continue; }
    urls.add(sourceUrl);
    queue.entries.push({
      id: link.id || `discovery-${createHash('sha256').update(sourceUrl).digest('hex').slice(0, 16)}`,
      title: link.title,
      source: new URL(sourceUrl).hostname === 'www.xiachufang.com' ? '下厨房' : '美食天下',
      sourceUrl,
      sourceCategories: link.sourceCategories || [],
      discoveredOn: link.discoveredOn || [],
      authorizationId: authorization.id,
      status: 'pending_detail',
      fullContentCollected: false,
      publishedPostId: null,
      duplicateOf: null,
      duplicateReason: null,
      dedupeVersion: RECIPE_CONTENT_DEDUPE_VERSION,
      candidateEligible: true,
    });
    addedEntries += 1;
  }
  if (!existing) await writeFile(target, `${JSON.stringify(queue, null, 2)}\n`, { flag: 'wx' });
  else if (addedEntries) {
    queue.updatedAt = new Date().toISOString();
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(queue, null, 2)}\n`);
    await rename(temporary, target);
  }
  return { retainedExistingCheckpoint: Boolean(existing), entries: queue.entries.length, addedEntries, skippedSameUrl, rejectedLinks, databaseWrites: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await prepareAuthorizedRecipeBatch()));
