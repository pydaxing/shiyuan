import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeDatabaseJson } from './admin-recipe-import.mjs';
import { splitTitleUpdates, titleUpdateCommand, verifyTitleUpdateResult } from './rename-community-recipes.mjs';
import { OFFICIAL_PUBLISHER_ID, OFFICIAL_PUBLISHER_NAME, communityPublisherName } from '../src/domain/community-policy.js';

const execute = promisify(execFile);
const atPath = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);
export const officialPublisherFields = {
  author: OFFICIAL_PUBLISHER_NAME,
  publisherId: OFFICIAL_PUBLISHER_ID,
  publisherType: 'official',
  'card.author': OFFICIAL_PUBLISHER_NAME,
  'card.publisherId': OFFICIAL_PUBLISHER_ID,
  'card.publisherType': 'official',
};

export function planOfficialPublishers(posts, receipt) {
  assert.ok(receipt?.familyId && receipt.recipes && !Array.isArray(receipt.recipes), '缺少可信发布回执');
  const entries = Object.entries(receipt.recipes);
  assert.ok(entries.length, '发布回执为空');
  assert.equal(new Set(entries.map(([, entry]) => entry.postId)).size, entries.length, '回执包含重复帖子');
  const byId = new Map(posts.map(post => [post._id, post]));
  assert.equal(byId.size, posts.length, '查询结果重复');
  const updates = [];
  const alreadyApplied = [];
  const skippedDeleted = [];
  for (const [sourceUrl, entry] of entries) {
    assert.equal(entry.stage, 'published_verified', '回执未完成发布验证');
    const post = byId.get(entry.postId);
    assert.ok(post && post.id === entry.postId, `云端帖子缺失：${entry.postId}`);
    assert.equal(post.familyId, receipt.familyId, `家庭不匹配：${post.id}`);
    assert.equal(post.kind, 'dish', `不是单品导入：${post.id}`);
    assert.equal(post.recipes?.length, 1, `来源结构不匹配：${post.id}`);
    assert.equal(post.recipes[0].provenance?.url, sourceUrl, `来源不匹配：${post.id}`);
    if (post.status === 'deleted') { skippedDeleted.push(post.id); continue; }
    assert.equal(post.status, 'published', `帖子状态已改变：${post.id}`);
    assert.equal(post.card?.id, post.id, `缺少对应广场卡片：${post.id}`);
    const author = communityPublisherName({ ...post, ...officialPublisherFields });
    const desired = { ...officialPublisherFields, author, 'card.author': author };
    const fields = Object.fromEntries(Object.entries(desired).filter(([field, value]) => atPath(post, field) !== value));
    if (!Object.keys(fields).length) { alreadyApplied.push(post.id); continue; }
    const guardFields = ['_id', 'id', 'familyId', 'kind', 'status', 'recipes.0.provenance.url', 'card.id', ...Object.keys(officialPublisherFields)];
    const guard = Object.fromEntries(guardFields.map(field => [field, atPath(post, field) === undefined ? { $exists: false } : atPath(post, field)]));
    updates.push({ q: guard, u: { $set: fields }, multi: false, upsert: false });
  }
  return { matched: entries.length, updates, alreadyApplied, skippedDeleted };
}

async function run() {
  const apply = process.argv.includes('--apply');
  assert.ok(!apply || process.argv.includes('--live'), '实际修改必须同时指定 --apply --live');
  const cli = process.env.TCB_CLI;
  assert.ok(cli && path.isAbsolute(cli), '设置官方 TCB_CLI 绝对路径');
  const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
  const receipt = JSON.parse(await readFile('artifacts/recipe-full/publication-receipt.json', 'utf8'));
  const output = path.resolve(`artifacts/deployment/official-publisher-20260911/${apply ? 'apply' : 'dry-run'}-${Date.now()}`);
  await mkdir(output, { recursive: true });
  const save = (name, value) => writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  async function call(command) {
    const { stdout } = await execute(cli, ['db', 'nosql', 'execute', '-e', config.envId, '--command', command, '--json'], { encoding: 'utf8', maxBuffer: 24000000, timeout: 120000 });
    const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert.ok(!response.error && !response.Error && response.data?.results?.length === 1, '数据库调用失败');
    return response;
  }
  async function readAll() {
    const posts = [];
    for (let skip = 0; skip < 10000; skip += 100) {
      const response = await call(JSON.stringify([{ TableName: 'posts', CommandType: 'QUERY', Command: JSON.stringify({ find: 'posts', filter: {}, sort: { _id: 1 }, skip, limit: 100 }) }]));
      const rows = decodeDatabaseJson(response.data.results[0]);
      assert.ok(Array.isArray(rows), '查询回执无效');
      posts.push(...rows);
      if (rows.length < 100) return posts;
    }
    throw new Error('超出本次迁移容量');
  }
  const before = await readAll();
  const plan = planOfficialPublishers(before, receipt);
  await save('backup.json', { environment: config.envId, readAt: new Date().toISOString(), receipt, posts: before });
  await save('plan.json', plan);
  console.log(JSON.stringify({ output, apply, matched: plan.matched, changes: plan.updates.length, alreadyApplied: plan.alreadyApplied.length, skippedDeleted: plan.skippedDeleted.length }));
  if (!apply) return;
  for (const [index, updates] of splitTitleUpdates('posts', plan.updates).entries()) {
    await save(`batch-${index}-intent.json`, { updates, at: new Date().toISOString() });
    const response = await call(titleUpdateCommand('posts', updates));
    await save(`batch-${index}-response.json`, response);
    verifyTitleUpdateResult(response, updates.length);
  }
  const after = await readAll();
  await save('after.json', after);
  const verified = planOfficialPublishers(after, receipt);
  assert.equal(verified.updates.length, 0, '仍有未修正的发布者，请先回读而非盲目重试');
  assert.deepEqual(verified.skippedDeleted, plan.skippedDeleted, '迁移期间帖子状态变化，请核对');
  const summary = { environment: config.envId, modified: plan.updates.length, officialPublished: verified.alreadyApplied.length, skippedDeleted: verified.skippedDeleted.length, verifiedAt: new Date().toISOString() };
  await save('verified.json', summary);
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run().catch(error => { console.error(error.message); process.exitCode = 1; });
