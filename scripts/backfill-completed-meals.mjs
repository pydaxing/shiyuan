// Explicit operations tool. Never runs during build/deploy. Prepare a private
// backup and reviewable plan; apply inserts only missing completed-meal posts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv } from 'vite';
import { verifyPreviewTarget } from './preview-weixin.mjs';
import { createCleanupReader, readAllCleanup, runIdeToFile } from './family-cleanup-db.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const digest = data => hash(JSON.stringify(data));
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const image = value => typeof value === 'string' && /^(cloud:\/\/|https:\/\/)/.test(value) && value.length <= 1000 ? value : '';
export function completedMealPlan(snapshot) {
  const families = new Map(snapshot.families.map(f => [f.id, f]));
  const posts = [], skipped = [], seen = new Set();
  for (const row of snapshot.orders) {
    const order = row.value;
    if (order?.status !== 'completed') continue;
    const reason = code => skipped.push({ orderDocumentId: row._id, reason: code });
    const family = families.get(row.familyId);
    const member = family?.members?.find(m => m.id === order.memberId);
    const key = `${row.familyId}:${order.id}`;
    if (!order.id || row._id !== hash(key) || seen.has(key)) { reason('invalid-or-duplicate-order'); continue; }
    seen.add(key);
    // A linked post, including a deletion tombstone or private post, is never recreated.
    if (order.mealPostId || snapshot.meal_posts.some(p => p.spaceId === row.familyId && p.orderId === order.id)) { reason('already-recorded'); continue; }
    if (snapshot.meal_posts.some(p => p.spaceId === row.familyId && p.authorId === order.memberId && p.status === 'deleted' && !p.orderId)) { reason('possible-deleted-record'); continue; }
    if (!family || family.deletedAt || family.status === 'deleted' || !member) { reason('unresolved-owner'); continue; }
    if (order.visibility === 'private' || order.public === false || order.deletedAt) { reason('explicitly-not-public'); continue; }
    const createdAt = Date.parse(order.completedAt);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(order.date) || !['早餐', '午餐', '晚餐', '加餐', '宵夜'].includes(order.meal)) { reason('invalid-completion'); continue; }
    const dishes = (order.items || []).slice(0, 50).map(item => ({ title: text(item.recipe?.title, 30), image: image(item.recipe?.image) })).filter(dish => dish.title);
    if (!dishes.length) { reason('no-dishes'); continue; }
    const id = `meal-${hash(`legacy-completed:${key}`)}`;
    if (snapshot.meal_posts.some(p => p._id === id || p.id === id)) { reason('already-recorded'); continue; }
    const personal = family.kind === 'personal';
    const author = { name: text(personal ? member.name : family.name, 60) || '食愿用户', avatar: image(personal ? member.avatar : (family.cover || member.avatar)), mode: personal ? 'personal' : 'family' };
    const images = dishes.map(dish => dish.image).filter(Boolean).slice(0, 9);
    const post = { _id: id, id, spaceId: family.id, authorId: member.id, author, kind: 'plan', date: order.date, meal: order.meal, title: `${order.meal}这样搭配`, dishes, images, orderId: order.id, moodIds: [], visibility: 'public', status: 'published', createdAt, likeCount: 0, reactionCounts: {}, mealStarted: true };
    post.assetIds = [...new Set([...images, ...dishes.map(d => d.image), author.avatar].filter(ref => ref.startsWith('cloud://')))];
    posts.push(post);
  }
  return { posts: posts.sort((a, b) => a.id.localeCompare(b.id)), skipped, completed: snapshot.orders.filter(r => r.value?.status === 'completed').length };
}
async function target() {
  const config = { ...loadEnv('production', process.cwd(), ''), ...process.env };
  assert.equal(config.VITE_DATA_MODE, 'cloud');
  const verified = await verifyPreviewTarget(process.cwd(), config);
  return { appid: verified.appid, env: verified.environment, functionName: verified.functionName };
}
async function inventory(call) {
  const snapshot = {};
  for (const name of ['meal_posts', 'orders', 'families']) snapshot[name] = await readAllCleanup(call, name);
  return snapshot;
}
export async function prepareCompletedMeals(directory) {
  await mkdir(directory, { mode: 0o700 });
  const destination = await target();
  const snapshot = await inventory(createCleanupReader(destination, join(directory, 'read')));
  const plan = completedMealPlan(snapshot);
  await save(join(directory, 'backup.json'), snapshot);
  await save(join(directory, 'plan.json'), { target: destination, backupDigest: digest(snapshot), ...plan });
  return { completed: plan.completed, insert: plan.posts.length, skipped: plan.skipped.length };
}
export async function applyCompletedMeals(directory) {
  const plan = await json(join(directory, 'plan.json')), backup = await json(join(directory, 'backup.json'));
  assert.deepEqual(await target(), plan.target);
  assert.equal(digest(backup), plan.backupDigest);
  assert.deepEqual(completedMealPlan(backup), { posts: plan.posts, skipped: plan.skipped, completed: plan.completed });
  const run = join(directory, 'apply');
  await mkdir(run, { mode: 0o700 }); // Refuse redispatch after an ambiguous previous run.
  const read = createCleanupReader(plan.target, join(run, 'read'));
  const current = await inventory(read);
  await save(join(run, 'preflight.json'), current);
  assert.deepEqual(completedMealPlan(current).posts, plan.posts, 'Eligible meal records changed; prepare a fresh plan');
  if (plan.posts.length) {
    const file = join(run, 'inserts.json');
    await save(file, plan.posts);
    const args = ['--action', 'insert', '--collection-name', 'meal_posts', '--documents-file', file];
    await save(join(run, 'intent.json'), { target: plan.target, tool: 'cloud_db_write_doc', args, count: plan.posts.length });
    const { response } = await runIdeToFile(plan.target, run, 'insert', 'cloud_db_write_doc', args);
    assert.equal(response.ok, true);
    const taskId = response.taskId || response.result?.taskId;
    if (taskId || response.pending || response.result?.pending) {
      assert.ok(taskId, 'Missing task ID; inspect intent before retrying');
      await save(join(run, 'pending.json'), { taskId });
      let completed = false;
      for (let n = 0; n < 120; n++) {
        await delay(1500);
        const { response: poll } = await runIdeToFile(null, run, `poll-${n}`, 'polling_task_result', ['--task-id', taskId]);
        assert.equal(poll.ok, true); assert.equal(poll.result?.success, true); assert.equal(poll.result.taskId, taskId);
        if (poll.result.status === 'pending') continue;
        assert.equal(poll.result.status, 'success', 'Migration task failed; inspect original task');
        completed = true; break;
      }
      assert.ok(completed, 'Migration still pending; poll original task, never redispatch');
    } else assert.equal(response.result?.success, true);
  }
  const after = await readAllCleanup(read, 'meal_posts');
  for (const post of plan.posts) assert.deepEqual(after.find(row => row._id === post._id), post, 'Inserted post must exactly match reviewed plan');
  for (const post of current.meal_posts) assert.deepEqual(after.find(row => row._id === post._id), post, 'Existing post changed during migration; inspect before claiming completion');
  assert.equal(after.length, current.meal_posts.length + plan.posts.length);
  assert.deepEqual(await readAllCleanup(read, 'orders'), current.orders, 'Order data changed during migration');
  const result = { inserted: plan.posts.length, totalPosts: after.length, publicPosts: after.filter(p => p.status === 'published' && p.visibility === 'public').length, verifiedAt: new Date().toISOString(), ordersUnchanged: true };
  await save(join(run, 'verified.json'), result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory] = process.argv.slice(2);
  assert.ok(['prepare', 'apply'].includes(mode) && directory, 'Usage: node scripts/backfill-completed-meals.mjs prepare|apply private-directory');
  console.log(JSON.stringify(mode === 'prepare' ? await prepareCompletedMeals(resolve(directory)) : await applyCompletedMeals(resolve(directory))));
}
