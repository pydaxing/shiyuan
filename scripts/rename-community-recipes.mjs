import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdir, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertStagedRecipe, documentDigest, decodeDatabaseJson, IMPORT_KIND } from './admin-recipe-import.mjs';
import { validateRecipe } from '../src/domain/kitchen.js';

const execute = promisify(execFile);
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJson = async (file, value) => { await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`); await rename(`${file}.tmp`, file); };
const hash = value => createHash('sha256').update(value).digest('hex');
const atPath = (value, field) => field.split('.').reduce((current, key) => current?.[key], value);

export function parseTitleReview(text, input) {
  const [header, ...lines] = text.trimEnd().split('\n');
  assert.equal(header, 'sourceId\ttitle\tbasis');
  const entries = lines.map(line => {
    const fields = line.split('\t');
    assert.equal(fields.length, 3);
    const [sourceId, title, basis] = fields;
    assert.match(sourceId, /^\d+$/);
    assert.ok(title.trim() === title && /^[\p{Script=Han}（）]{2,16}$/u.test(title), `菜名应为简洁中文：${title}`);
    assert.ok(basis.trim().length >= 8, `缺少核对依据：${sourceId}`);
    const original = input.find(entry => entry.sourceId === sourceId);
    assert.ok(original, `未经逐道核对的来源：${sourceId}`);
    return { ...original, title, basis };
  });
  assert.equal(new Set(input.map(entry => entry.sourceId)).size, input.length, '核对输入有重复来源');
  assert.equal(new Set(entries.map(entry => entry.sourceId)).size, entries.length, '名称表有重复来源');
  assert.equal(entries.length, input.length, '名称表没有覆盖全部菜谱');
  return entries;
}

export function retainOriginalTitle(note, originalTitle) {
  assert.equal(typeof note, 'string');
  assert.ok(originalTitle && !/[\r\n]/.test(originalTitle));
  const lines = note.split('\n');
  const authorIndex = lines.findIndex(line => line.startsWith('作者链接：'));
  assert.ok(authorIndex >= 0, '来源记录缺少作者链接，不猜测重构');
  const titleLine = `原文标题：${originalTitle}`;
  if (lines[authorIndex + 1]?.startsWith('原文标题：')) assert.equal(lines[authorIndex + 1], titleLine, '已有原文标题不一致');
  else lines.splice(authorIndex + 1, 0, titleLine);
  const result = lines.join('\n');
  assert.ok(result.length <= 1500, '原文说明超限，不截断');
  return result;
}

export function renamedReview(review, title) {
  return { ...structuredClone(review), importOverrides: { ...review.importOverrides, displayTitle: title } };
}

export function renameDocument(document, entry, review) {
  const next = structuredClone(document);
  if (entry.kind === 'published') {
    assert.equal(document.kind, 'dish');
    assert.equal(document.status, 'published');
    assert.equal(document.recipes.length, 1, '组合菜谱需独立审核，不自动改名');
    assert.equal(document.card.recipes.length, 1);
    assert.equal(document.recipes[0].provenance.url, entry.sourceUrl);
    next.title = entry.title;
    next.recipes[0].title = entry.title;
    next.recipes[0].provenance.note = retainOriginalTitle(next.recipes[0].provenance.note, entry.originalTitle);
    next.card.title = entry.title;
    next.card.recipes[0].title = entry.title;
    next.search = JSON.stringify([next.title, ...next.recipes.map(recipe => [recipe.title, recipe.ingredients.map(item => item.name)])]).toLowerCase();
    validateRecipe(next.recipes[0]);
  } else {
    assert.equal(entry.kind, 'staged');
    assertStagedRecipe(document);
    assert.equal(document.sourceUrl, entry.sourceUrl);
    assert.equal(document.source.title, entry.originalTitle);
    assert.deepEqual(document.sourceReview, review, '暂存记录与本地来源审核不一致');
    next.sourceReview = renamedReview(review, entry.title);
    next.recipeDraft.title = entry.title;
    next.recipeDraft.provenance.note = retainOriginalTitle(next.recipeDraft.provenance.note, entry.originalTitle);
    next.contentDigest = documentDigest(next);
    assertStagedRecipe(next);
  }
  return next;
}

export function makeTitleOperation(before, after, entry) {
  assert.equal(before._id, after._id);
  assert.equal(before._id, entry.documentId);
  const published = entry.kind === 'published';
  const paths = published
    ? ['title', 'recipes.0.title', 'recipes.0.provenance.note', 'card.title', 'card.recipes.0.title', 'search']
    : ['recipeDraft.title', 'recipeDraft.provenance.note', 'sourceReview.importOverrides.displayTitle', 'contentDigest'];
  const set = Object.fromEntries(paths.filter(field => !isDeepStrictEqual(atPath(before, field), atPath(after, field))).map(field => [field, atPath(after, field)]));
  const operation = { collection: published ? 'posts' : 'imports', sourceId: entry.sourceId, entry, before, after, set };
  assert.deepEqual(applyTitleFields(before, set), after, '变更包含名称以外字段');
  return operation;
}

export function applyTitleFields(document, fields) {
  const next = structuredClone(document);
  for (const [field, value] of Object.entries(fields)) {
    const keys = field.split('.');
    const parent = keys.slice(0, -1).reduce((current, key) => current[key] ??= {}, next);
    parent[keys.at(-1)] = structuredClone(value);
  }
  return next;
}

function protectedFields(document, collection) {
  return collection === 'posts'
    ? { _id: document._id, kind: document.kind, status: document.status, title: document.title, recipes: document.recipes, cardTitle: document.card?.title, cardRecipes: document.card?.recipes, search: document.search }
    : document;
}

export function reconcileOperation(operation, current) {
  assert.ok(current, `云端记录缺失：${operation.sourceId}`);
  const actual = protectedFields(current, operation.collection);
  if (isDeepStrictEqual(actual, protectedFields(operation.after, operation.collection))) return { alreadyApplied: true, expected: current };
  assert.deepEqual(actual, protectedFields(operation.before, operation.collection), `云端内容已变更：${operation.sourceId}，停止而不覆盖`);
  const expected = applyTitleFields(current, operation.set);
  const guard = operation.collection === 'posts'
    ? { _id: current._id, kind: current.kind, status: current.status, title: current.title, recipes: current.recipes, 'card.title': current.card.title, 'card.recipes': current.card.recipes, search: current.search }
    : { _id: current._id, kind: current.kind, status: current.status, publiclyPublished: false, contentDigest: current.contentDigest };
  return { alreadyApplied: false, expected, update: { q: guard, u: { $set: operation.set }, multi: false, upsert: false } };
}

export function titleUpdateCommand(collection, updates) {
  assert.ok(['posts', 'imports'].includes(collection));
  return JSON.stringify([{ TableName: collection, CommandType: 'UPDATE', Command: JSON.stringify({ update: collection, updates, ordered: true }) }]);
}

export function splitTitleUpdates(collection, updates, maxBytes = 90000) {
  const batches = [];
  let batch = [];
  for (const update of updates) {
    assert.ok(Buffer.byteLength(titleUpdateCommand(collection, [update])) <= maxBytes, '单条更新过大');
    if (batch.length && Buffer.byteLength(titleUpdateCommand(collection, [...batch, update])) > maxBytes) { batches.push(batch); batch = []; }
    batch.push(update);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function verifyTitleUpdateResult(response, count) {
  const rows = response.data?.results?.flat();
  assert.equal(rows?.length, 1, '更新回执格式不正确');
  const result = rows[0];
  assert.equal(decodeDatabaseJson(result.ok), 1, '云端更新失败');
  assert.ok(!result.writeErrors?.length && !result.writeConcernError, '存在部分写入失败，必须回读');
  assert.equal(decodeDatabaseJson(result.n), count, '匹配数不符，可能发生并发修改，必须回读');
  assert.equal(decodeDatabaseJson(result.nModified), count, '修改数不符，必须回读');
  return response.data.requestId;
}

async function prepare(root, output) {
  const input = await readJson(path.join(output, 'review-input.json'));
  const entries = parseTitleReview(await readFile(path.join(output, 'titles.tsv'), 'utf8'), input);
  const posts = await readJson(path.join(output, 'posts-before.json'));
  const imports = await readJson(path.join(output, 'imports-before.json'));
  assert.equal(posts.env, imports.env);
  const documents = new Map([...posts.records, ...imports.records].map(document => [document._id, document]));
  assert.equal(documents.size, entries.length);
  const operations = [];
  const localReviews = [];
  let patch = '*** Begin Patch\n';
  for (const entry of entries) {
    const directory = path.join(root, 'recipes', entry.sourceId);
    const source = await readJson(path.join(directory, 'source.json'));
    const reviewPath = path.join(directory, 'review.json');
    const beforeText = await readFile(reviewPath, 'utf8');
    const review = JSON.parse(beforeText);
    assert.equal(source.title, entry.originalTitle);
    assert.equal(source.sourceUrl, entry.sourceUrl);
    assert.equal(review.sourceUrl, source.sourceUrl);
    assert.equal(review.sourceHtmlFingerprint, hash(source.sourceHtml));
    assert.equal(review.approved, true);
    const before = documents.get(entry.documentId);
    assert.equal(entry.currentTitle, entry.kind === 'published' ? before.title : before.recipeDraft.title);
    const recipe = entry.kind === 'published' ? before.recipes[0] : before.recipeDraft;
    assert.deepEqual(recipe.ingredients, entry.ingredients);
    assert.deepEqual(recipe.steps.map(step => ({ title: step.title, text: step.text })), entry.steps);
    const after = renameDocument(before, entry, review);
    operations.push(makeTitleOperation(before, after, entry));
    const nextReview = renamedReview(review, entry.title);
    localReviews.push({ sourceId: entry.sourceId, before: review, after: nextReview });
    const afterText = `${JSON.stringify(nextReview, null, 2)}\n`;
    patch += `*** Update File: ${reviewPath}\n@@\n${beforeText.trimEnd().split('\n').map(line => `-${line}`).join('\n')}\n${afterText.trimEnd().split('\n').map(line => `+${line}`).join('\n')}\n`;
  }
  patch += '*** End Patch\n';
  const plan = { createdAt: new Date().toISOString(), env: posts.env, entries, operations, localReviews };
  plan.contentDigest = documentDigest(plan);
  await writeFile(path.join(output, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(output, 'review-files.patch'), patch);
  await saveJson(path.join(output, 'renamed-staged-documents.json'), operations.filter(operation => operation.collection === 'imports').map(operation => operation.after));
  console.log(JSON.stringify({ state: 'prepared_no_cloud_writes', reviewed: entries.length, changedTitles: entries.filter(entry => entry.title !== entry.currentTitle).length, published: posts.records.length, staged: imports.records.length, patch: path.join(output, 'review-files.patch') }, null, 2));
}

async function live(root, output) {
  const plan = await readJson(path.join(output, 'plan.json'));
  assert.equal(plan.contentDigest, documentDigest(plan), '计划文件已变更');
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  assert.ok(process.argv.includes('--env') && process.argv.includes('--cloudbase-cli'));
  assert.equal(option('--env'), plan.env, '云环境与核对快照不同');
  const cli = option('--cloudbase-cli');
  assert.ok(path.isAbsolute(cli));
  for (const entry of plan.localReviews) assert.deepEqual(await readJson(path.join(root, 'recipes', entry.sourceId, 'review.json')), entry.after, '本地改名审核尚未应用或已变化');
  const lockPath = path.join(output, 'write.lock');
  const lock = await open(lockPath, 'wx');
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDirectory = path.join(output, `run-${runId}`);
  await mkdir(runDirectory);
  await lock.writeFile(JSON.stringify({ pid: process.pid, runDirectory }));
  let commandIndex = 0;
  const call = async command => {
    const responsePath = path.join(runDirectory, `response-${commandIndex++}.json`);
    try {
      const { stdout } = await execute(cli, ['db', 'nosql', 'execute', '-e', plan.env, '--command', command, '--json'], { encoding: 'utf8', maxBuffer: 16000000, timeout: 90000 });
      const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
      await saveJson(responsePath, response);
      return response;
    } catch (error) {
      await saveJson(responsePath, { outcome: 'unknown', message: error.message, stdout: error.stdout || '', stderr: error.stderr || '' });
      throw error;
    }
  };
  const readAll = async collection => {
    const records = [];
    const filter = collection === 'posts' ? { status: 'published' } : { kind: IMPORT_KIND };
    for (let skip = 0; skip < 10000; skip += 20) {
      const response = await call(JSON.stringify([{ TableName: collection, CommandType: 'QUERY', Command: JSON.stringify({ find: collection, filter, sort: { _id: 1 }, skip, limit: 20 }) }]));
      assert.equal(response.data?.results?.length, 1);
      const page = decodeDatabaseJson(response.data.results[0]);
      assert.ok(Array.isArray(page));
      assert.ok(page.every(document => document._id));
      records.push(...page);
      if (page.length < 20) {
        assert.equal(new Set(records.map(document => document._id)).size, records.length);
        return records;
      }
    }
    throw new Error('读取超过核对容量');
  };
  try {
    const current = {};
    for (const collection of ['posts', 'imports']) current[collection] = await readAll(collection);
    await saveJson(path.join(runDirectory, 'before.json'), { env: plan.env, checkedAt: new Date().toISOString(), ...current });
    const expected = {};
    const updates = {};
    for (const collection of ['posts', 'imports']) {
      const operations = plan.operations.filter(operation => operation.collection === collection);
      assert.deepEqual(current[collection].map(document => document._id).sort(), operations.map(operation => operation.before._id).sort(), '云端范围已变化，需要重新逐道核对');
      expected[collection] = [];
      updates[collection] = [];
      for (const operation of operations) {
        const result = reconcileOperation(operation, current[collection].find(document => document._id === operation.before._id));
        expected[collection].push(result.expected);
        if (!result.alreadyApplied) updates[collection].push(result.update);
      }
    }
    const receipt = { env: plan.env, planDigest: plan.contentDigest, at: new Date().toISOString(), state: 'prepared', verifyOnly: process.argv.includes('--verify-only'), plannedWrites: Object.fromEntries(Object.entries(updates).map(([collection, records]) => [collection, records.length])), batches: [] };
    const receiptPath = path.join(runDirectory, 'receipt.json');
    await saveJson(path.join(runDirectory, 'intent.json'), { env: plan.env, updates, expected });
    await saveJson(receiptPath, receipt);
    if (receipt.verifyOnly) assert.equal(updates.posts.length + updates.imports.length, 0, '仍有未更新名称，核验模式不会写入');
    for (const collection of ['posts', 'imports']) {
      const batches = splitTitleUpdates(collection, updates[collection]);
      for (const [index, batch] of batches.entries()) {
        const command = titleUpdateCommand(collection, batch);
        const record = { collection, index, count: batch.length, ids: batch.map(update => update.q._id), payloadHash: hash(command), state: 'dispatched_outcome_unknown' };
        receipt.batches.push(record);
        receipt.state = 'writing_outcome_not_verified';
        await saveJson(receiptPath, receipt);
        const response = await call(command);
        record.requestId = verifyTitleUpdateResult(response, batch.length);
        record.state = 'returned_needs_readback';
        await saveJson(receiptPath, receipt);
        console.log(`${collection} 批次 ${index + 1}/${batches.length}：${batch.length} 条已返回，等待完整回读`);
      }
    }
    const after = {};
    for (const collection of ['posts', 'imports']) {
      after[collection] = await readAll(collection);
      const sorted = records => [...records].sort((first, second) => first._id.localeCompare(second._id));
      assert.deepEqual(sorted(after[collection]), sorted(expected[collection]), '回读与预期不一致，不报告成功');
    }
    await saveJson(path.join(runDirectory, 'after.json'), { env: plan.env, checkedAt: new Date().toISOString(), ...after });
    Object.assign(receipt, { state: 'verified', verifiedAt: new Date().toISOString(), verified: { posts: after.posts.length, imports: after.imports.length }, changedTitles: { posts: plan.entries.filter(entry => entry.kind === 'published' && entry.title !== entry.currentTitle).length, imports: plan.entries.filter(entry => entry.kind === 'staged' && entry.title !== entry.currentTitle).length }, originalsPreserved: true, recipesImagesCategoriesUnchanged: true, privateFamiliesUntouched: true });
    await saveJson(receiptPath, receipt);
    await saveJson(path.join(output, 'latest-verified.json'), { runDirectory, ...receipt });
    console.log(JSON.stringify({ ...receipt, batches: undefined, runDirectory }, null, 2));
  } finally { await lock.close(); await unlink(lockPath); }
}

async function run() {
  const root = path.join(process.cwd(), 'artifacts/recipe-full');
  const output = path.join(root, 'title-review');
  if (process.argv.includes('--prepare')) await prepare(root, output);
  else if (process.argv.includes('--live')) await live(root, output);
  else throw new Error('使用 --prepare 构造改名计划；应用 review-files.patch 后，--live --env ENV --cloudbase-cli PATH 执行，--verify-only 只回读');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
