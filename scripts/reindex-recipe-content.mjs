import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalRecipeUrl } from './recipe-discovery.mjs';
import { indexRecipeContent, RECIPE_CONTENT_DEDUPE_VERSION } from './recipe-content-dedupe.mjs';

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function saveJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function indexedStatus(entry, manifest, indexed, publishedPostId) {
  if (publishedPostId) return 'published';
  if (indexed.duplicateOf) return indexed.duplicateReason === 'same_source_url' ? 'duplicate_url' : 'duplicate_content';
  if (!['duplicate_url', 'duplicate_content'].includes(entry.status)) return entry.status;
  if (!manifest) return 'pending_detail';
  if (manifest.structureIssues?.length) return 'source_missing_structure';
  return manifest.fullContentCollected ? 'collected_pending_review' : 'incomplete_images';
}

export async function reindexRecipeContent(root, { dryRun = false } = {}) {
  root = path.resolve(root);
  const queuePath = path.join(root, 'queue.json');
  const queue = JSON.parse(await readFile(queuePath, 'utf8'));
  const previousQueue = JSON.stringify(queue);
  const publication = await optionalJson(path.join(root, 'publication-receipt.json'));
  const archives = new Map();
  const records = [];
  for (const entry of queue.entries) {
    const sourceUrl = canonicalRecipeUrl(entry.sourceUrl);
    if (!sourceUrl) throw new Error(`不支持的菜谱来源: ${entry.sourceUrl}`);
    const sourceId = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    const directory = entry.archiveDirectory ? path.resolve(root, entry.archiveDirectory) : path.join(root, 'recipes', sourceId);
    const relative = path.relative(path.join(root, 'recipes'), directory);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`归档目录超出 recipes: ${directory}`);
    if (!archives.has(directory)) {
      const [raw, manifest] = await Promise.all(['source.json', 'manifest.json'].map(file => optionalJson(path.join(directory, file))));
      if (Boolean(raw) !== Boolean(manifest) || entry.archiveDirectory && !raw) throw new Error(`归档缺少 source.json 或 manifest.json: ${directory}`);
      archives.set(directory, { raw, manifest, directory });
    }
    const archive = archives.get(directory);
    if (archive.raw && (canonicalRecipeUrl(archive.raw.sourceUrl) !== sourceUrl || canonicalRecipeUrl(archive.manifest.sourceUrl) !== sourceUrl || archive.raw.authorizationId !== queue.authorizationId || archive.manifest.authorizationId !== queue.authorizationId)) throw new Error(`归档来源或授权不匹配: ${directory}`);
    const receipt = publication?.recipes?.[sourceUrl];
    records.push({ ...entry, ...archive, sourceUrl, fullContentCollected: archive.manifest?.fullContentCollected ?? entry.fullContentCollected, archivedAt: archive.manifest?.archivedAt, publishedPostId: entry.publishedPostId || archive.manifest?.publishedPostId || receipt?.postId || null });
  }
  const indexed = indexRecipeContent(records);
  const manifests = new Map();
  records.forEach((record, index) => {
    const entry = queue.entries[index];
    const metadata = indexed[index];
    Object.assign(entry, metadata, { status: indexedStatus(entry, record.manifest, metadata, record.publishedPostId) });
    if (record.publishedPostId) entry.publishedPostId = record.publishedPostId;
    if (!record.manifest) return;
    entry.archiveDirectory = record.directory;
    entry.fullContentCollected = record.manifest.fullContentCollected;
    const previous = manifests.get(record.directory);
    if (!previous || previous.metadata.duplicateReason === 'same_source_url') manifests.set(record.directory, { record, metadata });
  });
  const changes = [];
  for (const { record, metadata } of manifests.values()) {
    const updated = { ...record.manifest, ...metadata };
    if (JSON.stringify(updated) !== JSON.stringify(record.manifest)) changes.push({ file: path.join(record.directory, 'manifest.json'), value: updated });
  }
  queue.dedupeVersion = RECIPE_CONTENT_DEDUPE_VERSION;
  if (JSON.stringify(queue) !== previousQueue) {
    queue.updatedAt = new Date().toISOString();
    changes.push({ file: queuePath, value: queue });
  }
  if (!dryRun) for (const change of changes) await saveJson(change.file, change.value);
  return { dryRun, dedupeVersion: RECIPE_CONTENT_DEDUPE_VERSION, indexedEntries: records.length, archivedSources: manifests.size, duplicateEntries: indexed.filter(item => item.duplicateOf).length, suspectedDuplicates: indexed.filter(item => item.requiresDuplicateReview).length, candidateEntries: indexed.filter(item => item.candidateEligible).length, changedFiles: changes.length, databaseWrites: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.filter(value => value !== '--dry-run').length !== 1 || args.some(value => value.startsWith('--') && value !== '--dry-run')) throw new Error('用法: node scripts/reindex-recipe-content.mjs <归档根目录> [--dry-run]；仅更新本地 manifest/queue，保留源档和图片，不发布');
  console.log(JSON.stringify(await reindexRecipeContent(args.find(value => value !== '--dry-run'), { dryRun: args.includes('--dry-run') }), null, 2));
}
