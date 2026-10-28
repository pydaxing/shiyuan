import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';

const mode = process.argv[2];
assert.ok(['before', 'after', 'warm', 'retry'].includes(mode), '选择 before、after、warm 或 retry');
const directory = `${process.cwd()}/artifacts/deployment/image-delivery`;
await mkdir(directory, { recursive: true });
const evaluate = (callback, args = []) => {
  const argsPath = `${directory}/runtime-args.json`;
  writeFileSync(argsPath, JSON.stringify(args));
  const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${process.cwd()}/dist/release`, '--fn-source', callback.toString(), '--args-file', argsPath], { encoding: 'utf8', timeout: 180000, maxBuffer: 2000000 });
  const envelope = JSON.parse(output.slice(output.indexOf('{')));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  const result = envelope.result?.result?.result;
  assert.ok(result && !result.error, JSON.stringify(result));
  return result;
};
if (mode === 'retry') {
  const warm = JSON.parse(await readFile(`${directory}/warm.json`, 'utf8'));
  assert.equal(warm.done, true, '先等待原有处理结束');
  const result = { recovered: [], failures: [], verifiedAt: '' };
  for (let offset = 0; offset < warm.failures.length; offset += 3) {
    const batch = evaluate(async function(images) {
    const failures = [];
    const recovered = [];
    for (const image of images) {
      const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action: 'mediaBatch', images: [{ fileId: image.fileId, variant: image.variant }] } });
      const result = response.result?.data?.images?.[0];
      if (result?.ok) recovered.push(image);
      else failures.push({ ...image, code: result?.code || response.result?.code || 'INTERNAL', message: result?.message || response.result?.message });
    }
    return { recovered, failures, verifiedAt: new Date().toISOString() };
    }, [warm.failures.slice(offset, offset + 3)]);
    result.recovered.push(...batch.recovered);
    result.failures.push(...batch.failures);
    result.verifiedAt = batch.verifiedAt;
  }
  await writeFile(`${directory}/retry.json`, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(`${directory}/warm.json`, `${JSON.stringify({ ...warm, initialFailureCount: warm.initialFailureCount ?? warm.failures.length, failures: result.failures, retryVerifiedAt: result.verifiedAt }, null, 2)}\n`);
  assert.equal(result.failures.length, 0, '仍有图片失败，请查看回执');
  console.log(JSON.stringify({ recovered: result.recovered.length, failures: result.failures.length }));
} else if (mode !== 'warm') {
  const before = mode === 'after' ? JSON.parse(await readFile(`${directory}/before.json`, 'utf8')) : null;
  const result = evaluate(async function(mode, knownIds) {
    const invoke = async (action, payload = {}) => {
      const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action, ...payload } });
      if (!response.result?.ok) throw new Error(JSON.stringify(response.result));
      return response.result.data;
    };
    const feed = await invoke('feed', { compact: true });
    const ids = knownIds || [...new Set(feed.posts.map(post => post.image).filter(image => image?.startsWith('cloud://')))].slice(0, 6);
    const samples = [];
    for (let trial = 0; trial < 3; trial += 1) {
      const started = Date.now();
      const photos = [];
      if (mode === 'before') {
        for (let offset = 0; offset < ids.length; offset += 3) photos.push(...await Promise.all(ids.slice(offset, offset + 3).map(fileId => invoke('mediaContent', { fileId }))));
      } else {
        const batch = await invoke('mediaBatch', { images: ids.map(fileId => ({ fileId, variant: 'card' })) });
        for (const image of batch.images) { if (!image.ok) throw new Error(JSON.stringify(image)); photos.push(image.data); }
      }
      samples.push({ trial, ms: Date.now() - started, requests: mode === 'before' ? ids.length : 1, bytes: photos.reduce((total, photo) => total + photo.base64.length / 4 * 3 - (photo.base64.endsWith('==') ? 2 : photo.base64.endsWith('=') ? 1 : 0), 0), photos: photos.map(photo => ({ bytes: photo.base64.length / 4 * 3, contentType: photo.contentType })) });
    }
    return { mode, ids, samples, verifiedAt: new Date().toISOString(), environment: 'WeChat IDE against production cloud, not a phone network' };
  }, [mode, before?.ids]);
  await writeFile(`${directory}/${mode}.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} else {
  const started = evaluate(function() {
    if (getApp().__imageVariantWarmup) return { started: true, reused: true };
    const state = { done: false, completed: 0, total: 0, failures: [], startedAt: new Date().toISOString(), posts: 0 };
    getApp().__imageVariantWarmup = state;
    void (async () => {
      const invoke = async (action, payload = {}) => {
        const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action, ...payload } });
        if (!response.result?.ok) throw new Error(JSON.stringify(response.result));
        return response.result.data;
      };
      const images = new Map();
      const add = (fileId, variant) => { if (fileId?.startsWith('cloud://')) images.set(`${fileId}:${variant}`, { fileId, variant }); };
      let cursor = '';
      do {
        const feed = await invoke('feed', { compact: true, cursor });
        for (const card of feed.posts) {
          const { post } = await invoke('readPost', { postId: card.id, paginateComments: true });
          add(post.image, 'card'); add(post.image, 'detail');
          for (const recipe of post.recipes) {
            add(recipe.image, 'card'); add(recipe.image, 'detail');
            for (const step of recipe.steps || []) {
              add(step.image, 'detail');
              for (const image of step.images || []) add(image, 'detail');
            }
          }
          state.posts += 1;
        }
        cursor = feed.cursor;
      } while (cursor);
      const queue = [...images.values()];
      state.total = queue.length;
      for (let offset = 0; offset < queue.length; offset += 6) {
        const requests = queue.slice(offset, offset + 6);
        const batch = await invoke('mediaBatch', { images: requests });
        batch.images.forEach((result, index) => {
          if (!result.ok) state.failures.push({ ...requests[index], code: result.code, message: result.message });
          state.completed += 1;
        });
      }
    })().catch(error => { state.error = error.message; }).finally(() => { state.done = true; state.finishedAt = new Date().toISOString(); });
    return { started: true };
  });
  assert.equal(started.started, true);
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 15000));
    const state = evaluate(function() { return getApp().__imageVariantWarmup; });
    await writeFile(`${directory}/warm.json`, `${JSON.stringify(state, null, 2)}\n`);
    console.log(JSON.stringify({ posts: state.posts, completed: state.completed, total: state.total, failures: state.failures.length, done: state.done }));
    if (state.done) { assert.equal(state.failures.length, 0, '有图片生成失败，查看回执'); break; }
  }
}
