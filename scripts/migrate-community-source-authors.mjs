import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeDatabaseJson } from './admin-recipe-import.mjs';
import { splitTitleUpdates, titleUpdateCommand, verifyTitleUpdateResult, applyTitleFields } from './rename-community-recipes.mjs';
import { OFFICIAL_PUBLISHER_ID, OFFICIAL_PUBLISHER_NAME, isOfficialPost } from '../src/domain/community-policy.js';

const execute = promisify(execFile);
const atPath = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);

export function planSourceAuthors(posts, receipt) {
  assert.ok(receipt?.familyId && receipt.recipes && !Array.isArray(receipt.recipes), '缺少发布回执');
  const entries = Object.entries(receipt.recipes);
  assert.ok(entries.length, '发布回执为空');
  const targets = new Set(entries.map(([, entry]) => entry.postId));
  assert.equal(targets.size, entries.length, '发布回执重复');
  const byId = new Map(posts.map(post => [post._id, post]));
  assert.equal(byId.size, posts.length, '查询结果重复');
  const unknown = posts.filter(post => post.status === 'published' && (isOfficialPost(post) || post.author === OFFICIAL_PUBLISHER_NAME) && !targets.has(post.id));
  assert.equal(unknown.length, 0, '发现没有对应发布回执的导入菜品，需先核对');
  const plan = { updates: [], authors: [], alreadyApplied: [], skippedDeleted: [] };
  for (const [sourceUrl, entry] of entries) {
    assert.equal(entry.stage, 'published_verified');
    const post = byId.get(entry.postId);
    assert.ok(post && post.id === entry.postId, `缺少帖子：${entry.postId}`);
    assert.equal(post.familyId, receipt.familyId);
    assert.equal(post.kind, 'dish');
    assert.equal(post.recipes?.length, 1);
    assert.equal(post.recipes[0].provenance?.url, sourceUrl);
    if (post.status === 'deleted') { plan.skippedDeleted.push(post.id); continue; }
    assert.equal(post.status, 'published');
    assert.equal(post.publisherId, OFFICIAL_PUBLISHER_ID, '不能修改个人发布者');
    assert.equal(post.publisherType, 'official');
    assert.equal(post.card?.id, post.id);
    assert.equal(post.card.publisherId, post.publisherId);
    assert.equal(post.card.publisherType, post.publisherType);
    const author = post.recipes[0].provenance.attribution;
    assert.ok(typeof author === 'string' && author.trim() && author.trim().length <= 30 && !/[\u0000-\u001f\u007f]/.test(author), `原作者名字缺失或无效：${post.title}`);
    const fields = Object.fromEntries(Object.entries({ author: author.trim(), 'card.author': author.trim(), 'recipes.0.author': author.trim() }).filter(([field, value]) => atPath(post, field) !== value));
    plan.authors.push({ id: post.id, title: post.title, author: author.trim(), sourceUrl });
    if (!Object.keys(fields).length) { plan.alreadyApplied.push(post.id); continue; }
    const paths = ['_id', 'id', 'familyId', 'status', 'kind', 'publisherId', 'publisherType', 'card.id', 'card.publisherId', 'card.publisherType', 'recipes.0.provenance.url', 'recipes.0.provenance.attribution', ...Object.keys(fields)];
    const guard = Object.fromEntries(paths.map(field => [field, atPath(post, field) === undefined ? { $exists: false } : atPath(post, field)]));
    plan.updates.push({ q: guard, u: { $set: fields }, multi: false, upsert: false });
  }
  return plan;
}

export function verifySourceAuthorChanges(before, after, plan) {
  assert.equal(after.length, before.length, '帖子数量发生变化，需核对');
  const actual = new Map(after.map(post => [post._id, post]));
  assert.equal(actual.size, after.length);
  const updates = new Map(plan.updates.map(update => [update.q._id, update.u.$set]));
  for (const post of before) {
    const expected = applyTitleFields(post, updates.get(post._id) || {});
    assert.deepEqual(actual.get(post._id), expected, `作者之外字段发生变化：${post._id}`);
  }
}

async function run() {
  const apply = process.argv.includes('--apply');
  assert.ok(!apply || process.argv.includes('--live'), '实际修改必须指定 --apply --live');
  const cli = process.env.TCB_CLI;
  assert.ok(cli && path.isAbsolute(cli), '设置官方 TCB_CLI 绝对路径');
  const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
  const receipt = JSON.parse(await readFile('artifacts/recipe-full/publication-receipt.json', 'utf8'));
  const output = path.resolve(`artifacts/deployment/source-authors-20260911/${apply ? 'apply' : 'dry-run'}-${Date.now()}`);
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
      assert.ok(Array.isArray(rows));
      posts.push(...rows);
      if (rows.length < 100) return posts;
    }
    throw new Error('超过本次迁移容量');
  }
  const before = await readAll();
  await save('backup.json', { environment: config.envId, readAt: new Date().toISOString(), receipt, posts: before });
  const plan = planSourceAuthors(before, receipt);
  await save('plan.json', plan);
  console.log(JSON.stringify({ output, apply, matched: plan.authors.length, changes: plan.updates.length, skippedDeleted: plan.skippedDeleted.length }));
  if (!apply) return;
  for (const [index, updates] of splitTitleUpdates('posts', plan.updates).entries()) {
    await save(`batch-${index}-intent.json`, { updates, at: new Date().toISOString() });
    const response = await call(titleUpdateCommand('posts', updates));
    await save(`batch-${index}-response.json`, response);
    verifyTitleUpdateResult(response, updates.length);
  }
  const after = await readAll();
  await save('after.json', after);
  verifySourceAuthorChanges(before, after, plan);
  const verified = planSourceAuthors(after, receipt);
  assert.equal(verified.updates.length, 0);
  const summary = { environment: config.envId, modified: plan.updates.length, sourceAuthors: verified.alreadyApplied.length, otherFieldsUnchanged: true, skippedDeleted: verified.skippedDeleted.length, verifiedAt: new Date().toISOString() };
  await save('verified.json', summary);
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run().catch(error => { console.error(error.message); process.exitCode = 1; });
