import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';

const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/);
const saveOriginal = process.argv.includes('--save-original');
const uploadSynthetic = process.argv.includes('--upload-synthetic');
const optimized = process.argv.includes('--optimized');
assert.equal(saveOriginal && uploadSynthetic, false, '设置和图片分开测量');
const directory = `${process.cwd()}/artifacts/deployment/performance`;
const receipt = `${directory}/${label}.json`;
assert.equal(await access(receipt).then(() => true, () => false), false, '已有回执，请勿重复执行');
await mkdir(directory, { recursive: true });
const argsFile = `${directory}/${label}-args.json`;
const base64 = uploadSynthetic ? (await (await import('sharp')).default('src/static/tofu.png').resize(1000).jpeg({ quality: 75 }).toBuffer()).toString('base64') : '';
await writeFile(argsFile, JSON.stringify([label, saveOriginal, base64, optimized]));
const callback = function(label, saveOriginal, base64, optimized) {
  const app = getApp();
  if (app.__latencyDiagnosis?.label === label) return { started: true };
  const progress = { label, startedAt: new Date().toISOString(), done: false, samples: [] };
  app.__latencyDiagnosis = progress;
  void (async function() {
    async function request(kind, data) {
      const started = Date.now();
      const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { ...data, diagnostics: true } });
      const result = response.result;
      progress.samples.push({ kind, ms: Date.now() - started, requestId: response.requestID, ok: result?.ok, code: result?.code, diagnostics: result?.diagnostics, posts: result?.data?.posts?.length });
      if (!result?.ok) throw new Error(result?.code || 'Request failed');
      if (!result.diagnostics) throw new Error('诊断版本尚未部署');
      return result.data;
    }
    try {
      const initial = await request('bootstrap', { action: 'bootstrap', ...(optimized ? { includeFeed: false } : {}) });
      if (!initial.snapshot) throw new Error('需要已加入家庭');
      progress.counts = Object.fromEntries(['recipes', 'mealSets', 'orders', 'inventory', 'purchases', 'posts'].map(field => [field, initial.snapshot[field].length]));
      if (base64) {
        progress.uploads = [];
        for (let round = 0; round < 3; round += 1) {
          const uploaded = await request('image-upload', { action: 'mediaUpload', base64 });
          progress.uploads.push(uploaded.fileId);
          const verified = await request('image-readback', { action: 'mediaContent', fileId: uploaded.fileId });
          if (verified.base64 !== base64) throw new Error('图片回读不一致');
        }
        progress.ok = true;
        return;
      }
      for (let round = 0; round < 3; round += 1) {
        for (const [kind, query] of [
          ['feed-all', { type: '全部', category: '全部' }],
          ['feed-dish', { type: '菜品', category: '全部' }],
          ['feed-meat', { type: '菜品', category: '荤菜' }],
          ['feed-menu', { type: '套餐', category: '全部' }],
        ]) await request(kind, { action: 'feed', ...query, compact: optimized });
        await request('background-sync', { action: 'bootstrap', knownFamilyId: initial.familyId, knownRevision: initial.revision });
      }
      if (saveOriginal) for (let round = 0; round < 3; round += 1) {
        for (const name of optimized ? ['setPreferences', 'customizeFamily'] : ['setFeature', 'setChef', 'customizeFamily']) {
          const cloud = require('services/cloud.js');
          if (cloud.cloudStatus.value.busy) throw new Error('用户正在保存，停止诊断');
          const current = await request('save-baseline', { action: 'bootstrap' });
          if (current.familyId !== initial.familyId) throw new Error('家庭已变更，停止诊断');
          const family = current.snapshot.family;
          const args = name === 'setPreferences' ? [{ fridge: family.features.fridge, shopping: family.features.shopping, chef: family.members.find(member => member.id === current.userId).isChef }] : name === 'setFeature' ? ['fridge', family.features.fridge] : name === 'setChef' ? [family.members.find(member => member.id === current.userId).isChef] : [{ name: family.name, cover: family.cover, coverTitle: family.coverTitle }];
          await request(name, { action: 'command', name, args, revision: current.revision, responseMode: 'changes', requestId: `diagnosis-${label}-${name}-${round}-${Date.now()}` });
        }
      }
      progress.ok = true;
    } catch (error) { progress.error = error.message; }
    finally { progress.done = true; }
  })();
  return { started: true };
};

function evaluate(source, args = []) {
  const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', source, ...args], { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
  const envelope = JSON.parse(output.slice(output.indexOf('{')));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope.result?.result?.result;
}

evaluate(callback.toString(), ['--args-file', argsFile]);
let result;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 4000));
  result = evaluate('function(){ return getApp().__latencyDiagnosis; }');
  await writeFile(receipt, JSON.stringify(result, null, 2));
  if (result?.done) break;
}
assert.equal(result?.ok, true, JSON.stringify(result));
for (const kind of [...new Set(result.samples.map(item => item.kind))]) {
  const samples = result.samples.filter(item => item.kind === kind);
  console.log(JSON.stringify({ kind, samples: samples.map(item => ({ ms: item.ms, serverMs: item.diagnostics.serverMs, outsideHandlerMs: item.ms - item.diagnostics.serverMs, firstInvocation: item.diagnostics.firstInvocation })) }));
}
