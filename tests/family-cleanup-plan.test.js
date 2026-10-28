import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { buildCleanupPlan, COLLECTIONS, exactBatchQuery, fingerprint, KEEP_FAMILY, TARGET, validatePlan } from '../scripts/family-cleanup-plan.mjs';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';

const OLD = 'family-removed';
const WITHDRAWN = 'family-already-deleted';
const cloud = name => `cloud://test-environment/${name}`;
const privateCollections = ['recipes', 'meal_sets', 'orders', 'inventory', 'purchases', 'invites', 'shares', 'requests'];

function fixture() {
  const collections = Object.fromEntries(COLLECTIONS.map(name => [name, []]));
  collections.families = [
    { _id: KEEP_FAMILY, id: KEEP_FAMILY, ownerId: 'owner', members: [{ id: 'owner', name: '主人' }, { id: 'member', name: '成员' }], name: '保留家庭', history: ['unchanged'] },
    { _id: OLD, id: OLD, ownerId: 'outsider', members: [{ id: 'outsider', name: '旧成员' }] },
    { _id: WITHDRAWN, id: WITHDRAWN, ownerId: 'former', members: [], deletedAt: 1 },
  ];
  collections.users = [
    { _id: 'owner', familyId: KEEP_FAMILY, familyIds: [KEEP_FAMILY], name: '主人', avatar: cloud('avatar'), preferences: { theme: 'dark' } },
    { _id: 'member', familyId: OLD, familyIds: [OLD, KEEP_FAMILY], name: '现有成员', preferences: { reminders: false } },
    { _id: 'outsider', familyId: OLD, familyIds: [OLD], name: '旧家庭成员', avatar: cloud('outsider-avatar') },
    { _id: 'former', familyId: WITHDRAWN, familyIds: [WITHDRAWN], name: '旧账号' },
  ];
  for (const name of privateCollections) collections[name] = [
    { _id: `${name}-keep`, familyId: KEEP_FAMILY, value: { note: '保留原文', image: cloud('private-keep') } },
    { _id: `${name}-old`, familyId: OLD, value: { image: cloud('private-old') } },
    { _id: `${name}-withdrawn`, familyId: WITHDRAWN },
  ];
  collections.posts = [
    { _id: 'public-old', familyId: OLD, status: 'published', importedFamilyCount: 8, image: cloud('public'), card: { title: '公开菜谱', importedFamilyCount: 8 }, recipes: [{ steps: ['原步骤'] }] },
    { _id: 'public-unaffected', familyId: WITHDRAWN, status: 'published', importedFamilyCount: 99, card: { importedFamilyCount: 99 } },
    { _id: 'deleted-old', familyId: OLD, status: 'deleted', image: cloud('deleted-post') },
    { _id: 'deleted-keep', familyId: KEEP_FAMILY, status: 'deleted', image: cloud('retained-deleted-post') },
  ];
  collections.comments = [{ _id: 'comment-public', postId: 'public-old' }, { _id: 'comment-deleted', postId: 'deleted-old' }];
  collections.reports = [{ _id: 'report-public', postId: 'public-old' }, { _id: 'report-deleted', postId: 'deleted-old' }];
  collections.imports = [
    { _id: 'edge-keep', familyId: KEEP_FAMILY, postId: 'public-old' },
    { _id: 'edge-keep-duplicate', familyId: KEEP_FAMILY, postId: 'public-old' },
    { _id: 'edge-old', familyId: OLD, postId: 'public-old' },
    { _id: 'edge-withdrawn-post', familyId: KEEP_FAMILY, postId: 'deleted-old' },
    { _id: 'source-job', kind: 'authorized_import_job_v1', familyId: OLD, state: 'superseded', supersededBy: 'review' },
    { _id: 'source-task', kind: 'authorized_import_task_v1', jobId: 'source-job', state: 'queued' },
    { _id: 'review', kind: 'owner_reviewed_import_v1', previousJobId: 'source-job' },
    { _id: 'source', kind: 'authorized_recipe_staging_v1', image: cloud('audit-source'), published: false },
    { _id: 'delivery', kind: 'image_delivery_job_v1', state: 'complete' },
  ];
  collections.rate_limits = [{ _id: 'limit', accountId: 'outsider', count: 4 }];
  return { target: structuredClone(TARGET), capturedAt: '2026-10-27T00:00:00.000Z', collections };
}

function project(backup, plan) {
  const output = structuredClone(backup.collections);
  const changed = new Map();
  const retainedFamily = backup.collections.families.find(family => family._id === KEEP_FAMILY);
  const removedFamilyIds = backup.collections.families.filter(family => family._id !== KEEP_FAMILY).map(family => family._id);
  for (const operation of plan.operations) for (const row of operation.rows) {
    assert.deepEqual(output.families.find(family => family._id === KEEP_FAMILY), retainedFamily, 'retained family remains unchanged throughout cleanup');
    if (operation.action === 'delete' && privateCollections.includes(operation.collection)) {
      for (const id of removedFamilyIds) {
        const family = output.families.find(item => item._id === id);
        assert.ok(family?.deletedAt, 'every removed family must already be inaccessible before private deletion');
      }
    }
    const key = `${operation.collection}/${row.before._id}`;
    const previous = changed.get(key);
    if (previous) {
      assert.equal(operation.collection, 'families', `only a family fence may precede a second mutation: ${key}`);
      assert.equal(previous.action, 'update');
      assert.equal(operation.action, 'delete');
      assert.deepEqual(row.before, previous.after, 'final family deletion must guard the fenced state');
    }
    changed.set(key, { action: operation.action, after: row.after });
    const index = output[operation.collection].findIndex(item => item._id === row.before._id);
    assert.ok(index >= 0);
    assert.deepEqual(output[operation.collection][index], row.before);
    if (operation.action === 'delete') {
      assert.equal(row.after, null);
      output[operation.collection].splice(index, 1);
    } else {
      assert.equal(operation.action, 'update');
      const updated = structuredClone(output[operation.collection][index]);
      for (const [path, value] of Object.entries(operation.fields)) {
        const parts = path.split('.');
        const parent = parts.slice(0, -1).reduce((object, part) => object[part], updated);
        parent[parts.at(-1)] = structuredClone(value);
      }
      assert.deepEqual(updated, row.after, 'declared fields must produce exact planned result');
      output[operation.collection][index] = updated;
    }
  }
  return output;
}

test('the first phase fences only active removed families using a frozen timestamp, then deletes their exact fenced state', () => {
  const backup = fixture();
  const plan = buildCleanupPlan(backup);
  const gates = plan.operations.filter(operation => operation.collection === 'families' && operation.action === 'update');
  assert.equal(gates.length, 1);
  assert.equal(plan.operations[0], gates[0]);
  assert.equal(plan.cleanupAt, Date.parse(backup.capturedAt));
  assert.deepEqual(gates[0].fields, { deletedAt: plan.cleanupAt });
  assert.deepEqual(gates[0].rows.map(row => row.before._id), [OLD]);
  assert.deepEqual(gates[0].rows[0].after, { ...backup.collections.families[1], deletedAt: plan.cleanupAt });
  const finalDeletion = plan.operations.at(-1);
  assert.deepEqual(finalDeletion.rows.find(row => row.before._id === OLD).before, gates[0].rows[0].after);
  assert.deepEqual(finalDeletion.rows.find(row => row.before._id === WITHDRAWN).before, backup.collections.families[2], 'previous deletion timestamp remains unchanged');
  assert.deepEqual(plan.totals.families, { before: 3, deleted: 2, updated: 1, after: 1 });
  assert.equal(plan.operations.some(operation => operation.collection === 'families' && operation.rows.some(row => row.before._id === KEEP_FAMILY)), false);
  assert.deepEqual(project(backup, plan).families, [backup.collections.families[0]]);
});

test('fenced families reject new private requests while the retained family and published content remain accessible', async () => {
  const backup = fixture();
  const plan = buildCleanupPlan(backup);
  const gates = plan.operations.filter(operation => operation.collection === 'families' && operation.action === 'update');
  const gated = project(backup, { operations: gates });
  const repository = memoryRepository();
  const hash = value => createHash('sha256').update(value).digest('hex');
  for (const family of gated.families) await repository.set('families', family._id, { ...family, ownerId: hash(family.ownerId), members: family.members.map(member => ({ ...member, id: hash(member.id) })) });
  for (const user of gated.users) await repository.set('users', hash(user._id), { ...user, _id: hash(user._id) });
  for (const post of gated.posts) await repository.set('posts', post._id, post);
  const app = createApplication({ repository, now: () => plan.cleanupAt, signFiles: async () => ({}) });
  for (const action of ['bootstrap', 'createInvite', 'prepareInvite', 'mediaTicket', 'createDishShare']) {
    const result = await app({ action, familyId: OLD }, { OPENID: 'outsider' });
    assert.equal(result.ok, false, action);
    assert.equal(result.code, 'NO_FAMILY', action);
  }
  const oldFamilies = await app({ action: 'listFamilies' }, { OPENID: 'outsider' });
  assert.equal(oldFamilies.ok, true);
  assert.deepEqual(oldFamilies.data.families, []);
  const retained = await app({ action: 'bootstrap', includeFeed: false }, { OPENID: 'owner' });
  assert.equal(retained.ok, true, JSON.stringify(retained));
  assert.equal(retained.data.familyId, KEEP_FAMILY);
  const published = await app({ action: 'readPost', postId: 'public-old', includeComments: false }, { OPENID: 'outsider' });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.equal(published.data.post.status, 'published');
  for (const name of privateCollections) assert.deepEqual(await repository.list(name), [], 'rejected private requests cannot recreate dependencies');
  assert.deepEqual(await repository.get('families', KEEP_FAMILY), { ...backup.collections.families[0], ownerId: hash('owner'), members: backup.collections.families[0].members.map(member => ({ ...member, id: hash(member.id) })) });
});

test('cleanup preserves the retained family and every private document exactly, including history', () => {
  const backup = fixture();
  const original = structuredClone(backup);
  const plan = buildCleanupPlan(backup);
  const output = project(backup, plan);
  assert.deepEqual(backup, original, 'planning must not mutate the backup');
  assert.deepEqual(plan.removedFamilyIds, [WITHDRAWN, OLD].sort());
  assert.deepEqual(output.families, [original.collections.families[0]]);
  for (const name of privateCollections) assert.deepEqual(output[name], [original.collections[name][0]], name);
  assert.deepEqual(output.rate_limits, original.collections.rate_limits);
  assert.equal(plan.operations.at(-1).collection, 'families');
  assert.equal(plan.operations.at(-1).action, 'delete');
});

test('published posts and public moderation survive while withdrawn old posts lose only their dependencies', () => {
  const backup = fixture();
  const output = project(backup, buildCleanupPlan(backup));
  assert.deepEqual(output.posts.map(row => row._id), ['public-old', 'public-unaffected', 'deleted-keep']);
  assert.deepEqual(output.comments, [backup.collections.comments[0]]);
  assert.deepEqual(output.reports, [backup.collections.reports[0]]);
  const originalPost = backup.collections.posts[0];
  assert.deepEqual(output.posts[0], { ...originalPost, importedFamilyCount: 1, card: { ...originalPost.card, importedFamilyCount: 1 } });
  assert.deepEqual(output.posts[1], backup.collections.posts[1], 'unaffected historical counters are not normalized');
  assert.deepEqual(output.posts[2], backup.collections.posts[3]);
});

test('mixed imports retain the complete public job, task, review and source chain under a removed family', () => {
  const backup = fixture();
  const output = project(backup, buildCleanupPlan(backup));
  assert.deepEqual(output.imports, backup.collections.imports.filter(row => !['edge-old', 'edge-withdrawn-post'].includes(row._id)));
  assert.equal(output.posts[0].importedFamilyCount, 1, 'two edges for the same surviving family count once');
  assert.deepEqual(output.imports.find(row => row._id === 'source'), backup.collections.imports.find(row => row._id === 'source'), 'source staging flags are preserved as provenance');
});

test('account repair retains profiles and grants a family pointer only to existing retained-family members', () => {
  const backup = fixture();
  const output = project(backup, buildCleanupPlan(backup));
  assert.deepEqual(output.users[0], backup.collections.users[0]);
  assert.deepEqual(output.users[1], { ...backup.collections.users[1], familyId: KEEP_FAMILY, familyIds: [KEEP_FAMILY] });
  for (const index of [2, 3]) assert.deepEqual(output.users[index], { ...backup.collections.users[index], familyId: '', familyIds: [] });
  assert.deepEqual(output.families[0].members, backup.collections.families[0].members, 'outsiders must not be admitted');
});

test('media retention closes aliases and tickets transitively across family, public, account and audit roots', () => {
  const backup = fixture();
  backup.collections.media = [
    { _id: 'far-variant', familyId: OLD, fileId: cloud('bridge-2'), variants: { preview: cloud('bridge-3') } },
    { _id: 'bridge-ticket', familyId: OLD, status: 'ticket', source: cloud('bridge-1'), fileId: cloud('bridge-2') },
    { _id: 'public-image', familyId: OLD, fileId: cloud('public'), variants: { source: cloud('bridge-1') } },
    ...['private-keep', 'avatar', 'outsider-avatar', 'audit-source', 'retained-deleted-post'].map(name => ({ _id: name, familyId: OLD, fileId: cloud(name) })),
    { _id: 'profile-orphan', familyId: 'profile-account', fileId: cloud('profile-only') },
    { _id: 'keep-orphan', familyId: KEEP_FAMILY, fileId: cloud('keep-only') },
    { _id: 'unscoped-orphan', fileId: cloud('unscoped') },
    { _id: 'private-old', familyId: OLD, fileId: cloud('private-old') },
    { _id: 'deleted-post', familyId: OLD, fileId: cloud('deleted-post') },
    { _id: 'empty-ticket', familyId: WITHDRAWN, status: 'ticket' },
  ];
  const plan = buildCleanupPlan(backup);
  const output = project(backup, plan);
  assert.deepEqual(output.media, backup.collections.media.slice(0, -3));
  assert.deepEqual(plan.protectedMediaIds, output.media.map(row => row._id).sort());
  assert.deepEqual(plan.operations.filter(operation => operation.collection === 'media').flatMap(operation => operation.rows.map(row => row.before._id)), ['private-old', 'deleted-post', 'empty-ticket']);
  assert.ok(plan.operations.every(operation => COLLECTIONS.includes(operation.collection)), 'plan contains database operations only');
});

test('an affected published post with no remaining family imports gets zero in its body and card', () => {
  const backup = fixture();
  backup.collections.imports = backup.collections.imports.filter(row => !row._id.startsWith('edge-keep'));
  const output = project(backup, buildCleanupPlan(backup));
  assert.equal(output.posts[0].importedFamilyCount, 0);
  assert.equal(output.posts[0].card.importedFamilyCount, 0);
});

test('snapshot validation stops on identity, inventory and retained-owner drift', () => {
  const cases = [
    [backup => { backup.target.env = 'other-environment'; }, /./],
    [backup => { delete backup.collections.media; }, /./],
    [backup => { backup.collections.users.push(structuredClone(backup.collections.users[0])); }, /duplicate ids/],
    [backup => { backup.collections.families[1].id = 'different-id'; }, /./],
    [backup => { backup.collections.families[0].deletedAt = 1; }, /inactive/],
    [backup => { backup.collections.families[0].members = []; }, /inactive/],
    [backup => { backup.collections.families[0].ownerId = 'missing-owner'; }, /owner missing/],
    [backup => { backup.collections.users[0].familyId = OLD; }, /changed current family/],
  ];
  for (const [change, expected] of cases) {
    const backup = fixture();
    change(backup);
    assert.throws(() => buildCleanupPlan(backup), expected);
  }
});

test('unknown ownership and import semantics fail closed before producing a destructive plan', () => {
  const cases = [
    [backup => { delete backup.collections.recipes[0].familyId; }, /missing\/unknown owner/],
    [backup => { backup.collections.orders[1].familyId = 'unknown'; }, /missing\/unknown owner/],
    [backup => { backup.collections.posts[0].status = 'draft'; }, /unknown post status/],
    [backup => { backup.collections.imports[0].familyId = 'unknown'; }, /unknown household import edge/],
    [backup => { backup.collections.imports[0].postId = 'missing'; }, /missing post/],
    [backup => { backup.collections.imports.push({ _id: 'new-kind', kind: 'unreviewed_kind' }); }, /unknown global import kind/],
    [backup => { backup.collections.imports.find(row => row._id === 'source-task').jobId = 'missing'; }, /missing source job/],
  ];
  for (const [change, expected] of cases) {
    const backup = fixture();
    change(backup);
    assert.throws(() => buildCleanupPlan(backup), expected);
  }
});

// Evaluate the generated expression against JSON documents. This covers the CAS
// contract locally; server support and transaction behavior require cloud checks.
function evaluate(expression, variables) {
  if (typeof expression === 'string' && expression.startsWith('$$')) {
    return expression.slice(2).split('.').reduce((value, key) => value?.[key], variables);
  }
  if (!expression || typeof expression !== 'object') return expression;
  if (Array.isArray(expression)) return expression.map(value => evaluate(value, variables));
  const [[operator, value]] = Object.entries(expression);
  switch (operator) {
    case '$literal': return value;
    case '$eq': { const [left, right] = evaluate(value, variables); return isDeepStrictEqual(left, right); }
    case '$type': { const result = evaluate(value, variables); return result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result; }
    case '$size': return evaluate(value, variables).length;
    case '$objectToArray': return Object.entries(evaluate(value, variables)).map(([k, v]) => ({ k, v }));
    case '$arrayElemAt': { const [array, index] = evaluate(value, variables); return array[index]; }
    case '$and': return value.every(item => evaluate(item, variables));
    case '$cond': return evaluate(value[0], variables) ? evaluate(value[1], variables) : evaluate(value[2], variables);
    case '$let': return evaluate(value.in, { ...variables, ...Object.fromEntries(Object.entries(value.vars).map(([name, child]) => [name, evaluate(child, variables)])) });
    default: throw new Error(`unsupported expression: ${operator}`);
  }
}

function queryMatches(query, document) {
  if (query.$or) return query.$or.some(branch => queryMatches(branch, document));
  return query._id === document._id && evaluate(query.$expr, { ROOT: document });
}

test('whole-document CAS rejects concurrent additions, removals, nested edits and identity changes', () => {
  const before = { _id: 'guarded', familyId: OLD, count: 3, nil: null, records: [{ label: '$literal-content', values: [false, 7] }] };
  const query = exactBatchQuery([before]);
  assert.equal(queryMatches(query, before), true);
  assert.equal(queryMatches(query, { records: before.records, nil: null, count: 3, familyId: OLD, _id: 'guarded' }), true, 'object key order is immaterial');
  const cases = [
    row => { row.newField = true; },
    row => { delete row.nil; },
    row => { row.nil = {}; },
    row => { row.familyId = KEEP_FAMILY; },
    row => { row.count = '3'; },
    row => { row.records[0].values.push(8); },
    row => { row.records[0].values[0] = true; },
    row => { row.records[0].newField = 'concurrent'; },
    row => { row.records = {}; },
    row => { row._id = 'other'; },
  ];
  for (const change of cases) {
    const row = structuredClone(before);
    change(row);
    assert.equal(queryMatches(query, row), false);
  }
  const other = { _id: 'other', familyId: WITHDRAWN };
  const multi = exactBatchQuery([before, other]);
  assert.equal(queryMatches(multi, before), true);
  assert.equal(queryMatches(multi, other), true);
  assert.equal(queryMatches(multi, { ...other, familyId: KEEP_FAMILY }), false);
  assert.throws(() => exactBatchQuery([]));
  assert.throws(() => exactBatchQuery(Array.from({ length: 61 }, (_, index) => ({ _id: String(index) }))));
});

test('delete batches respect both document count and payload size and keep original CAS guards', () => {
  const backup = fixture();
  backup.collections.requests = Array.from({ length: 121 }, (_, index) => ({ _id: `request-${index}`, familyId: OLD, value: index }));
  backup.collections.shares = Array.from({ length: 3 }, (_, index) => ({ _id: `share-${index}`, familyId: OLD, body: 'x'.repeat(50000) }));
  const plan = buildCleanupPlan(backup);
  assert.deepEqual(plan.operations.filter(operation => operation.collection === 'requests').map(operation => operation.rows.length), [60, 60, 1]);
  assert.deepEqual(plan.operations.filter(operation => operation.collection === 'shares').map(operation => operation.rows.length), [1, 1, 1]);
  for (const operation of plan.operations) {
    assert.ok(operation.rows.length <= 60);
    const bytes = Buffer.byteLength(JSON.stringify(operation.query));
    assert.ok(bytes < 100000);
    if (operation.rows.length > 1) assert.ok(bytes <= 90000);
    for (const row of operation.rows) {
      assert.equal(queryMatches(operation.query, row.before), true);
      assert.equal(queryMatches(operation.query, { ...row.before, concurrentField: 1 }), false);
    }
  }
  project(backup, plan);
});

test('a single document exceeding the hard CAS limit is rejected', () => {
  const backup = fixture();
  backup.collections.requests.push({ _id: 'large-single', familyId: OLD, body: 'x'.repeat(95000) });
  const permitted = buildCleanupPlan(backup).operations.find(operation => operation.rows.some(row => row.before._id === 'large-single'));
  assert.equal(permitted.rows.length, 1, 'a record above the soft limit must be isolated');
  assert.ok(Buffer.byteLength(JSON.stringify(permitted.query)) > 90000);
  assert.ok(Buffer.byteLength(JSON.stringify(permitted.query)) < 100000);
  backup.collections.requests.push({ _id: 'oversized', familyId: OLD, body: 'x'.repeat(100000) });
  assert.throws(() => buildCleanupPlan(backup), /single CAS query too large/);
});

test('plan validation rejects both an unsigned edit and a re-signed destructive rule change', () => {
  const backup = fixture();
  const plan = buildCleanupPlan(backup);
  assert.equal(validatePlan(plan, backup), true);
  const unsigned = structuredClone(plan);
  unsigned.keepOwnerId = 'outsider';
  assert.throws(() => validatePlan(unsigned, backup));
  const changed = structuredClone(plan);
  changed.operations.pop();
  const { digest: _oldDigest, ...body } = changed;
  changed.digest = fingerprint(body);
  assert.throws(() => validatePlan(changed, backup), /deterministic reviewed rules/);
  const staleBackup = structuredClone(backup);
  staleBackup.collections.users[0].name = 'concurrent profile edit';
  assert.throws(() => validatePlan(plan, staleBackup), /deterministic reviewed rules/);
});
