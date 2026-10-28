import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = `${process.cwd()}/artifacts/deployment/performance`;
await mkdir(directory, { recursive: true });
const label = process.argv[2] || 'before';
assert.match(label, /^[a-z-]+$/);
const callback = async function() {
  const samples = [];
  let latest;
  async function measure(action, data = {}, kind = action) {
    const started = Date.now();
    const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action, ...data } });
    if (!response.result?.ok) throw new Error(JSON.stringify(response.result));
    samples.push({ kind, ms: Date.now() - started, responseBytes: JSON.stringify(response.result).length, unchanged: Boolean(response.result.data?.unchanged) });
    return response.result.data;
  }
  for (let index = 0; index < 5; index += 1) latest = await measure('bootstrap');
  for (let index = 0; index < 5; index += 1) await measure('bootstrap', { knownFamilyId: latest.familyId, knownRevision: latest.revision }, 'background-sync');
  for (let index = 0; index < 3; index += 1) await measure('feed', { type: '全部' });
  return { samples, counts: Object.fromEntries(['recipes', 'mealSets', 'orders', 'inventory', 'purchases', 'posts'].map(field => [field, latest.snapshot[field].length])) };
};
const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', callback.toString()], { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
const envelope = JSON.parse(output.slice(output.indexOf('{')));
assert.equal(envelope.ok, true, JSON.stringify(envelope));
const result = envelope.result?.result?.result;
assert.ok(Array.isArray(result?.samples), JSON.stringify(envelope));
await writeFile(`${directory}/${label}.json`, JSON.stringify(result, null, 2));
for (const kind of ['bootstrap', 'background-sync', 'feed']) {
  const samples = result.samples.filter(item => item.kind === kind);
  const sorted = samples.map(item => item.ms).sort((left, right) => left - right);
  console.log(JSON.stringify({ kind, medianMs: sorted[Math.floor(sorted.length / 2)], samples, counts: result.counts }));
}
