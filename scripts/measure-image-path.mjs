import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';
import { verifyPreviewTarget } from './preview-weixin.mjs';

const label = process.argv[2] || 'before';
assert.match(label, /^[a-z0-9-]+$/);
const root = process.cwd();
const target = await verifyPreviewTarget(root, { ...loadEnv('production', root, ''), ...process.env });
const directory = resolve(root, 'artifacts/deployment/performance-20260930');
await mkdir(directory, { recursive: true, mode: 0o700 });
const probe = async function (target) {
  const appId = wx.getAccountInfoSync().miniProgram.appId;
  if (appId !== target.appid) throw new Error('Wrong mini-program identity');
  const samples = [];
  async function invoke(action, payload = {}, label = action) {
    const started = Date.now();
    const include = target.includeImageManifests && ['bootstrap', 'feed', 'readPost'].includes(action);
    const response = await wx.cloud.callFunction({ name: target.functionName, data: { action, ...(include ? { includeImageManifests: true } : {}), ...payload, diagnostics: true } });
    const result = response.result;
    samples.push({ stage: label, elapsedMs: Date.now() - started, responseChars: JSON.stringify(result).length, ok: result?.ok, code: result?.code, imageManifests: result?.data?.imageManifests?.length || 0, diagnostics: result?.diagnostics });
    if (!result?.ok) throw new Error(`${action}: ${result?.code || 'FAILED'}`);
    return result.data;
  }
  async function download(image, label) {
    const started = Date.now();
    if (!image?.url) return { stage: label, transport: 'base64', bytes: image?.base64?.length || 0 };
    const response = await new Promise(resolve => wx.downloadFile({ url: image.url, timeout: 30000, success: resolve, fail: error => resolve({ error }) }));
    const outcome = { stage: label, elapsedMs: Date.now() - started, transport: 'signed-url', expectedBytes: image.bytes, status: response.statusCode, domainRejected: /domain|合法域名/i.test(response.error?.errMsg || '') };
    if (response.error) outcome.error = outcome.domainRejected ? 'DOMAIN_NOT_ALLOWED' : 'DOWNLOAD_FAILED';
    if (response.tempFilePath) {
      const files = wx.getFileSystemManager();
      const stats = await new Promise(resolve => files.stat({ path: response.tempFilePath, success: resolve, fail: () => resolve({}) }));
      outcome.actualBytes = stats.stats?.size;
      await new Promise(resolve => files.unlink({ filePath: response.tempFilePath, success: resolve, fail: resolve }));
    }
    return outcome;
  }
  async function images(requests, label, prepared = []) {
    if (!requests.length) return;
    const versions = new Set(requests.map(request => `${request.fileId}#display-${request.variant}-v1`));
    const inline = prepared.filter(image => versions.has(image.version) && image.urlExpiresAt > Date.now());
    const available = new Set(inline.map(image => image.version));
    const missing = requests.filter(request => !available.has(`${request.fileId}#display-${request.variant}-v1`));
    const manifest = missing.length ? await invoke('mediaBatch', { images: missing }, `${label}-authorization`) : { images: [] };
    const signed = [...inline, ...manifest.images.filter(image => image.ok).map(image => image.data)];
    const started = Date.now();
    const transfers = await Promise.all(signed.map((image, index) => download(image, `${label}-${index + 1}`)));
    samples.push({ stage: `${label}-download`, elapsedMs: Date.now() - started, inlineImages: inline.length, fallbackImages: missing.length, transfers, rejectedImages: manifest.images.filter(image => !image.ok).map(image => image.code) });
    await invoke('mediaBatch', { images: requests.map(request => ({ ...request, knownVersion: `${request.fileId}#display-${request.variant}-v1` })) }, `${label}-warm-authorization`);
  }
  let snapshot;
  for (let index = 0; index < 2; index += 1) snapshot = await invoke('bootstrap', { includeFeed: false }, `bootstrap-${index + 1}`);
  await invoke('bootstrap', { includeFeed: false, knownFamilyId: snapshot.familyId, knownRevision: snapshot.revision }, 'bootstrap-unchanged');
  const family = snapshot.snapshot?.family;
  const familyRequests = [...new Set([family?.cover, ...(family?.members || []).map(member => member.avatar)].filter(value => value?.startsWith('cloud://')))].slice(0, 6).map(fileId => ({ fileId, variant: target.includeImageManifests && fileId === family?.cover ? 'detail' : 'card', transport: 'url' }));
  await images(familyRequests, 'family', snapshot.imageManifests);
  const feed = await invoke('feed', { type: '全部', compact: true }, 'feed-first');
  await invoke('feed', { type: '全部', compact: true }, 'feed-repeat');
  const cards = feed.posts.filter(post => post.image?.startsWith('cloud://')).slice(0, 6);
  await images(cards.map(post => ({ fileId: post.image, postId: post.id, variant: 'card', transport: 'url' })), 'feed-card', feed.imageManifests);
  if (cards.length) {
    const detail = await invoke('readPost', { postId: cards[0].id, paginateComments: true }, 'detail');
    const requested = [detail.post.image, ...detail.post.recipes.flatMap(recipe => [recipe.image, ...(recipe.steps || []).flatMap(step => [step.image, ...(step.images || [])])])];
    const distinct = [...new Set(requested.filter(value => value?.startsWith('cloud://')))].slice(0, 6);
    await images(distinct.map(fileId => ({ fileId, postId: detail.post.id, variant: 'detail', transport: 'url' })), 'detail-photo', detail.imageManifests);
  }
  return { appId, platform: wx.getDeviceInfo?.().platform || 'unknown', measuredAt: new Date().toISOString(), familyImages: familyRequests.length, feedPageItems: feed.posts.length, samples };
};
const source = `function() { return (${probe.toString()})(${JSON.stringify({ ...target, includeImageManifests: process.argv.includes('--inline') })}); }`;
const raw = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', target.project, '--fn-source', source], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
const envelope = JSON.parse(raw.slice(raw.indexOf('{')));
assert.equal(envelope.ok, true, JSON.stringify(envelope));
const result = envelope.result?.result?.result;
assert.ok(Array.isArray(result?.samples), 'Missing measurement samples');
await writeFile(resolve(directory, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
for (const sample of result.samples) console.log(JSON.stringify({ stage: sample.stage, elapsedMs: sample.elapsedMs, serverMs: sample.diagnostics?.serverMs, firstInvocation: sample.diagnostics?.firstInvocation, databaseCalls: sample.diagnostics?.spans.filter(span => span.operation.startsWith('db.')).length, imageManifests: sample.imageManifests, inlineImages: sample.inlineImages, fallbackImages: sample.fallbackImages, transfers: sample.transfers }));
console.log(JSON.stringify({ saved: resolve(directory, `${label}.json`), platform: result.platform, familyImages: result.familyImages, feedPageItems: result.feedPageItems }));
