import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aliasKey, canonicalRecipeUrl, robotsPolicy } from './recipe-discovery.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const folder = resolve(root, 'artifacts/recipe-crawl');
const json = async name => JSON.parse(await readFile(resolve(folder, name), 'utf8'));
const report = await json('report.json');
const state = await json('checkpoint.json');
const candidates = await json('source-links.json');
const duplicates = await json('duplicates.json');
const near = await json('near-duplicates.json');
const live = await json('live-baseline.json');
const baseline = [...live.recipes, ...JSON.parse(await readFile(resolve(root, 'artifacts/recipe-sources/candidates.json'), 'utf8'))];
const keys = candidates.map(record => aliasKey(record.title));
const urls = candidates.map(record => record.sourceUrl);
assert.equal(new Set(urls).size, urls.length, 'duplicate URLs');
assert.equal(new Set(keys).size, keys.length, 'duplicate normalized titles');
for (const candidate of candidates) {
  assert.equal(canonicalRecipeUrl(candidate.sourceUrl), candidate.sourceUrl);
  assert.equal(candidate.autoImportAllowed, false);
  assert.equal(candidate.publicPublishingAllowed, false);
  assert.equal(candidate.recordType, 'source_link_only');
  assert.equal(candidate.ingredients, undefined);
  assert.equal(candidate.steps, undefined);
  assert.equal(candidate.image, undefined);
  assert.equal(baseline.some(record => aliasKey(record.title) === aliasKey(candidate.title)), false, candidate.title);
  assert.ok(candidate.discoveredOn.every(url => Boolean(state.pages[url])));
}
assert.equal(report.uniqueSourceUrls, candidates.length + duplicates.length + near.length);
assert.equal(report.sourceLinkCandidates, candidates.length);
assert.equal(report.exactDuplicates, duplicates.length);
assert.equal(report.nearDuplicatesHeldForReview, near.length);
assert.equal(report.fullRecipesCollected, 0);
assert.equal(report.downloadedImages, 0);
assert.equal(report.databaseWrites, 0);
const logs = (await readFile(resolve(folder, 'access-log.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
const crawlRequests = logs.filter(record => record.startedAt);
let minRequestGapMs = Infinity;
for (let index = 0; index < crawlRequests.length; index += 1) {
  const current = crawlRequests[index];
  const host = new URL(current.url).hostname;
  assert.equal(robotsPolicy(state.hosts[host].robots).allows(current.url), true);
  assert.match(new URL(current.url).pathname, /^\/category\/(\d+\/)?$/);
  const previous = crawlRequests.slice(0, index).filter(record => new URL(record.url).hostname === host).at(-1);
  if (!previous) continue;
  const gap = Date.parse(current.startedAt) - Date.parse(previous.startedAt);
  minRequestGapMs = Math.min(minRequestGapMs, gap);
  assert.ok(gap >= 11950, `Too frequent: ${gap}ms`);
}
assert.equal(state.hosts['www.xiachufang.com'].blocked, 'http_418');
assert.equal(state.hosts['home.meishichina.com'].blocked, 'http_403');
assert.equal(state.queue.length, report.pausedListingPages);
const validation = { validatedAt: new Date().toISOString(), ok: true, uniqueCandidateUrls: urls.length, uniqueCandidateTitleKeys: keys.length, checkedAgainstCloudCount: live.recipes.length, verifiedListRequests: crawlRequests.length, minRequestGapMs: Number.isFinite(minRequestGapMs) ? minRequestGapMs : null, hostsRemainPaused: true, publicOrCloudWrites: false, limits: '仅验证本批快照的URL/标题一致性和请求节奏，不证明配方语义全局唯一、不验证图片授权。' };
await writeFile(resolve(folder, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
console.log(JSON.stringify(validation, null, 2));
