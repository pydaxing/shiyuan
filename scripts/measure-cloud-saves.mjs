import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import sharp from 'sharp';

const label = process.argv[2];
assert.match(label || '', /^(before|after)-saves$/);
assert.equal(process.argv[3], '--live', '需要 --live；仅原值保存家庭设置并上传项目插图，不改变用户内容');
const directory = `${process.cwd()}/artifacts/deployment/performance`;
const receipt = `${directory}/${label}.json`;
assert.equal(await access(receipt).then(() => true, () => false), false, '已有回执，请勿重复执行');
await mkdir(directory, { recursive: true });
const bytes = await sharp('src/static/tofu.png').resize(1000).jpeg({ quality: 75 }).toBuffer();
const argsFile = `${directory}/${label}-args.json`;
await writeFile(argsFile, JSON.stringify([label, bytes.toString('base64')]));
const callback = function(label, base64) {
  const app = getApp();
  if (app.__saveMeasurement?.label === label) return { started: true };
  const progress = { label, done: false, samples: [], uploads: [] };
  app.__saveMeasurement = progress;
  void (async function() {
    const cloud = require('services/cloud.js');
    const path = `${wx.env.USER_DATA_PATH}/shiyuan-save-measurement.jpg`;
    const files = wx.getFileSystemManager();
    try {
      if (cloud.cloudStatus.value.busy) throw new Error('当前正在保存，请稍后测量');
      let current = await cloud.cloudCall('bootstrap');
      if (!current.snapshot) throw new Error('需要已加入家庭');
      progress.counts = Object.fromEntries(['recipes', 'mealSets', 'orders', 'inventory', 'purchases'].map(field => [field, current.snapshot[field].length]));
      for (let round = 0; round < 3; round += 1) {
        const family = current.snapshot.family;
        for (const [name, args] of [
          ['setFeature', ['fridge', family.features.fridge]],
          ['setChef', [family.members.find(member => member.id === current.userId).isChef]],
          ['customizeFamily', [{ name: family.name, cover: family.cover, coverTitle: family.coverTitle }]],
        ]) {
          const started = Date.now();
          await cloud.remoteAction(name, args);
          progress.samples.push({ kind: name, ms: Date.now() - started });
        }
        current = await cloud.cloudCall('bootstrap');
      }
      files.writeFileSync(path, base64, 'base64');
      for (let round = 0; round < 3; round += 1) {
        const started = Date.now();
        const fileId = await cloud.uploadCloudImage(path);
        progress.samples.push({ kind: 'upload', ms: Date.now() - started, bytes: Math.floor(base64.length * 3 / 4) });
        progress.uploads.push(fileId);
        const verified = await cloud.invokeCloud('mediaContent', { fileId });
        if (verified.base64 !== base64) throw new Error('图片回读不一致');
      }
      progress.ok = true;
    } catch (error) { progress.error = error.message; }
    finally { progress.done = true; try { files.unlinkSync(path); } catch {} }
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
  result = evaluate('function(){ return getApp().__saveMeasurement; }');
  await writeFile(receipt, JSON.stringify(result, null, 2));
  if (result?.done) break;
}
assert.equal(result?.ok, true, JSON.stringify(result));
for (const kind of [...new Set(result.samples.map(item => item.kind))]) {
  const times = result.samples.filter(item => item.kind === kind).map(item => item.ms).sort((left, right) => left - right);
  console.log(JSON.stringify({ kind, medianMs: times[Math.floor(times.length / 2)], times }));
}
