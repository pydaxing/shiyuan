import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication as createSourceApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { loadCloudApplication } from './helpers/cloud-bundle.js';
import { createSeed } from '../src/data/seed.js';
import { getShoppingRequirements, kitchenOrders } from '../src/domain/kitchen.js';
import { shoppingMeals } from '../src/domain/meal-preparation.js';
import { OFFICIAL_PUBLISHER_ID, canDeleteCommunityPost } from '../src/domain/community-policy.js';

const clock = Date.parse('2026-09-09T03:00:00Z');
const recipe = createSeed().recipes[0];
const createApplication = process.env.KITCHEN_TEST_BUNDLE ? await loadCloudApplication(process.env.KITCHEN_TEST_BUNDLE) : createSourceApplication;
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(overrides = {}) {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => clock, signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async fileId => fileId, ...overrides });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ...payload }, { OPENID: openid });
  const command = (name, args, revision, openid = 'alice', requestId = `request-0000-${++sequence}`) => call('command', { name, args, revision, requestId }, openid);
  return { repository, app, call, command };
}
async function family(fixture, openid = 'alice') {
  const result = await fixture.call('createFamily', { name: openid, familyName: `${openid}的小家` }, openid);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}
async function success(promise) { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }

async function cancelledCloudMeal({ prepared = false } = {}) {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  const selection = { date: '2026-09-09', meal: '晚餐' };
  current = await success(server.command('submitOrder', [cart, selection, '少放辣'], current.revision));
  const orderId = current.snapshot.orders[0].id;
  if (prepared) {
    current = await success(server.command('setFeature', ['fridge', true], current.revision));
    current = await success(server.command('addStock', [{ name: '白菜', quantity: 400, unit: 'g', location: '冷藏', expiresOn: '' }], current.revision));
    const dish = shoppingMeals(current.snapshot, selection.date)[0].dishes[0];
    current = await success(server.command('saveDishPreparation', [orderId, dish.recipe.id, { ingredients: dish.ingredients, note: '另带葱' }, dish.editSignature], current.revision));
    const edited = shoppingMeals(current.snapshot, selection.date)[0].dishes[0];
    current = await success(server.command('setDishPrepared', [orderId, dish.recipe.id, true, edited.signature], current.revision));
  }
  current = await success(server.command('updateOrder', [orderId, 'cancelled'], current.revision));
  return { server, current, orderId, cart, selection, documentId: digest(`${current.familyId}:${orderId}`) };
}

test('new cloud families start with fridge and shopping disabled and retain explicitly enabled choices', async () => {
  const server = fixture();
  let current = await family(server);
  assert.deepEqual(current.snapshot.family.features, { fridge: false, shopping: false });
  current = await success(server.command('setFeature', ['fridge', true], current.revision));
  current = await success(server.command('setFeature', ['shopping', true], current.revision));
  const restored = await success(server.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(restored.snapshot.family.features, { fridge: true, shopping: true });
  assert.deepEqual((await server.repository.get('families', current.familyId)).features, { fridge: true, shopping: true });
});

test('food details can skip comment queries while existing comments and their API remain available', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish'], current.revision));
  const postId = current.value;
  const note = { id: 'saved-comment', postId, author: '家人', text: '这道菜很好吃', createdAt: clock };
  await server.repository.set('comments', note.id, note);
  const list = server.repository.list;
  const queries = [];
  server.repository.list = async (collection, where, options) => { queries.push(collection); return list(collection, where, options); };
  const hidden = await success(server.call('readPost', { postId, includeComments: false, paginateComments: true }));
  assert.equal(hidden.post.id, postId);
  assert.deepEqual(hidden.comments, []);
  assert.equal(hidden.commentCursor, '');
  assert.ok(!queries.includes('comments'));
  assert.deepEqual((await server.repository.get('comments', note.id)).text, note.text);
  const restored = await success(server.call('readPost', { postId, paginateComments: true }));
  assert.equal(restored.comments[0].text, note.text);
  const comments = await success(server.call('readComments', { postId }));
  assert.equal(comments.comments[0].text, note.text);
});

test('batch preferences use one transaction, keep permissions and reject a stale revision', async () => {
  const server = fixture();
  let current = await family(server);
  const transaction = server.repository.transaction;
  let count = 0;
  server.repository.transaction = callback => { count += 1; return transaction(callback); };
  current = await success(server.call('command', { name: 'setPreferences', args: [{ chef: true, fridge: true, shopping: false }], revision: current.revision, requestId: 'batch-settings-0001', responseMode: 'changes' }));
  assert.equal(count, 1);
  assert.equal(current.revision, 2);
  assert.deepEqual(current.changes.family.features, { fridge: true, shopping: false });
  assert.equal(current.changes.family.members[0].isChef, true);
  assert.equal((await server.command('setPreferences', [{ ownerId: 'forged' }], 2)).code, 'INVALID');
  assert.equal((await server.command('setPreferences', [{ chef: false }], 1)).code, 'CONFLICT');
  const replay = await success(server.call('command', { name: 'setPreferences', args: [{ chef: true, fridge: true, shopping: false }], revision: 1, requestId: 'batch-settings-0001', responseMode: 'changes' }));
  assert.equal(replay.revision, 2);
});

test('compact feed projects cards, paginates 35 records, and only details carry steps', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [{ ...recipe, category: '饮品' }], current.revision));
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish'], current.revision));
  const original = await server.repository.get('posts', current.value);
  await server.repository.remove('posts', current.value);
  for (let index = 0; index < 35; index += 1) {
    const id = `post-${String(index).padStart(3, '0')}`;
    await server.repository.set('posts', id, { ...original, id, card: { ...original.card, id } });
  }
  const list = server.repository.list;
  const queries = [];
  server.repository.list = async (collection, where, options) => { if (collection === 'posts') queries.push(structuredClone(options)); return list(collection, where, options); };
  const collected = [];
  let cursor = '';
  do {
    const page = await success(server.call('feed', { compact: true, type: '菜品', category: '饮品', cursor }));
    assert.ok(page.posts.length <= 16);
    assert.ok(page.posts.every(post => post.recipes[0].steps === undefined && post.recipes[0].ingredients === undefined));
    collected.push(...page.posts.map(post => post.id));
    cursor = page.cursor;
  } while (cursor);
  assert.equal(collected.length, 35);
  assert.equal(new Set(collected).size, 35);
  assert.ok(queries.every(options => options.limit === 17 && options.fields[0] === 'card'));
  const detail = await success(server.call('readPost', { postId: collected[0], paginateComments: true }));
  assert.deepEqual(detail.post.recipes[0].steps, recipe.steps);
  queries.length = 0;
  const boot = await success(server.call('bootstrap', { includeFeed: false }));
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].fields, ['id', 'familyItemId', 'familyKind', 'kind']);
  assert.deepEqual(boot.snapshot.posts, []);
});

test('comments page independently and adding or liking does not scan all comments', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish'], current.revision));
  const postId = current.value;
  for (let index = 0; index < 45; index += 1) {
    const id = `comment-${String(index).padStart(3, '0')}`;
    await server.repository.set('comments', id, { id, postId, author: '家人', memberId: 'someone', text: '试做成功', likes: [], parentId: '' });
  }
  const first = await success(server.call('readPost', { postId, paginateComments: true }));
  const second = await success(server.call('readComments', { postId, cursor: first.commentCursor }));
  const third = await success(server.call('readComments', { postId, cursor: second.commentCursor }));
  assert.deepEqual([first.comments.length, second.comments.length, third.comments.length], [20, 20, 5]);
  assert.equal(third.commentCursor, '');
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(db => callback({ ...db, list: async (name, ...args) => { assert.notEqual(name, 'comments'); return db.list(name, ...args); } }));
  const reply = await success(server.call('command', { name: 'addComment', args: [postId, '谢谢分享', first.comments[0].id], revision: current.revision, requestId: 'comment-partial-001', responseMode: 'changes', commentMode: 'patch' }));
  assert.equal(reply.changes.comments, undefined);
  assert.equal(reply.commentChanges.length, 2);
  const liked = await success(server.call('command', { name: 'toggleCommentLike', args: [first.comments[0].id], revision: current.revision, requestId: 'comment-partial-002', responseMode: 'changes', commentMode: 'patch' }));
  assert.equal(liked.commentChanges.length, 1);
  assert.equal(liked.commentChanges[0].likes.length, 1);
  const replyId = reply.commentChanges.find(comment => comment.replyToId)?.id;
  const nestedEvent = { name: 'addComment', args: [postId, '回复你的回复', replyId], revision: current.revision - 1, requestId: 'comment-partial-003', responseMode: 'changes', commentMode: 'patch', includeFeed: false };
  const originalList = server.repository.list;
  server.repository.list = async (name, ...args) => { assert.notEqual(name, 'comments'); return originalList(name, ...args); };
  const nested = await success(server.call('command', nestedEvent));
  assert.equal(nested.commentChanges.find(comment => comment.text === '回复你的回复').parentId, first.comments[0].id);
  const replay = await success(server.call('command', nestedEvent));
  assert.equal(replay.commentChanges.length, 1);
  assert.equal(replay.commentChanges[0].replyToId, replyId);
  assert.equal(replay.commentChanges[0].id, nested.commentChanges.find(comment => comment.text === '回复你的回复').id);
});

test('media cache authorization still checks membership and never downloads unchanged files', async () => {
  let downloads = 0;
  const fileId = 'cloud://env/approved/photo.bin';
  const server = fixture({ readImage: async () => { downloads += 1; return {}; } });
  const current = await family(server);
  await server.repository.set('media', digest(fileId), { familyId: current.familyId, confirmed: true });
  assert.deepEqual(await success(server.call('mediaContent', { fileId, knownVersion: fileId })), { unchanged: true, version: fileId });
  assert.equal(downloads, 0);
  await family(server, 'bob');
  assert.equal((await server.call('mediaContent', { fileId, knownVersion: fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal(downloads, 0);
});

test('preference patches read no business lists and still commit revision and an idempotency receipt', async () => {
  const server = fixture();
  let current = await family(server);
  const originalList = server.repository.list;
  const originalTransaction = server.repository.transaction;
  server.repository.list = async () => { throw new Error('unexpected full read'); };
  server.repository.transaction = callback => originalTransaction(db => callback({ ...db, list: server.repository.list }));
  for (const [name, args] of [['setFeature', ['fridge', true]], ['setChef', [true]], ['customizeFamily', [{ name: '更快的小家', cover: '', coverTitle: '' }]]]) {
    const updated = await success(server.call('command', { name, args, requestId: `patch-preference-${name}`, revision: current.revision, responseMode: 'changes' }));
    assert.deepEqual(Object.keys(updated.changes), ['family']);
    assert.equal(updated.baseRevision, current.revision);
    assert.equal(updated.revision, current.revision + 1);
    assert.equal(updated.snapshot, undefined);
    current = updated;
  }
  server.repository.list = originalList;
  server.repository.transaction = originalTransaction;
  const retried = await success(server.call('command', { name: 'setChef', args: [true], requestId: 'patch-preference-setChef', revision: 2, responseMode: 'changes' }));
  assert.equal(retried.revision, current.revision);
  assert.equal(retried.snapshot.family.name, '更快的小家');
  assert.equal(retried.snapshot.family.members[0].isChef, true);
});

test('family cover edits preserve text and enforce image ownership', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('customizeFamily', [{ name: '一起吃饭', cover: '', coverTitle: '三餐四季' }], current.revision));
  const fileId = 'cloud://env/approved/family-cover.bin';
  await server.repository.set('media', digest(fileId), { familyId: current.familyId, confirmed: true });
  for (const cover of [fileId, fileId, '']) {
    current = await success(server.command('customizeFamily', [{ name: ' 一起吃饭 ', cover, coverTitle: ' 三餐四季 ' }], current.revision));
    assert.equal(current.snapshot.family.cover, cover);
  }
  current = await success(server.command('customizeFamily', [{ name: '一起吃饭', cover: '', coverTitle: '' }], current.revision));
  assert.equal(current.snapshot.family.coverTitle, '');
  assert.equal((await server.command('customizeFamily', [{ name: '一起吃饭', cover: 'cloud://env/foreign.bin', coverTitle: '' }], current.revision)).code, 'FORBIDDEN');
});

test('family text edits preserve idempotency', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('customizeFamily', [{ name: 'alice的小家', cover: '', coverTitle: '一起吃饭' }], current.revision));
  current = await success(server.command('customizeFamily', [{ name: ' 三餐小家 ', cover: '', coverTitle: '一起吃饭' }], current.revision));
  assert.equal(current.snapshot.family.name, '三餐小家');
  const args = [{ name: '三餐四季', cover: '', coverTitle: '好好吃饭' }];
  const revision = current.revision;
  current = await success(server.command('customizeFamily', args, revision, 'alice', 'family-edit-retry-001'));
  const replay = await success(server.command('customizeFamily', args, revision, 'alice', 'family-edit-retry-001'));
  assert.equal(replay.revision, current.revision);
  assert.deepEqual(replay.snapshot.family, current.snapshot.family);
  assert.equal(current.snapshot.family.name, '三餐四季');
  assert.equal(current.snapshot.family.coverTitle, '好好吃饭');
});

test('family name saves are direct and stale revisions still fail', async () => {
  const server = fixture();
  let current = await family(server);
  const unchanged = [{ name: current.snapshot.family.name, cover: '', coverTitle: '' }];
  current = await success(server.command('customizeFamily', unchanged, current.revision));
  current = await success(server.command('customizeFamily', [{ ...unchanged[0], name: '新名称' }], current.revision, 'alice', 'direct-family-edit-001'));
  assert.equal(current.snapshot.family.name, '新名称');
  assert.ok(await server.repository.get('requests', digest(`${digest('alice')}:direct-family-edit-001`)));
  const actual = await success(server.call('bootstrap'));
  assert.equal(actual.revision, current.revision);
  assert.deepEqual(actual.snapshot.family, current.snapshot.family);
  assert.equal((await server.command('customizeFamily', [{ ...unchanged[0], name: '旧页面修改' }], current.revision - 1)).code, 'CONFLICT');
});

test('family edits check revisions and membership inside the write transaction', async () => {
  const server = fixture();
  const initial = await family(server);
  const args = [{ name: '新名称', cover: '', coverTitle: '' }];
  const transaction = server.repository.transaction;
  let beforeTransaction = async () => {
    const current = await server.repository.get('families', initial.familyId);
    await server.repository.set('families', initial.familyId, { ...current, revision: current.revision + 1, name: '家人刚刚修改' });
  };
  server.repository.transaction = async callback => { await beforeTransaction(); return transaction(callback); };
  assert.equal((await server.command('customizeFamily', args, initial.revision)).code, 'CONFLICT');
  assert.equal((await success(server.call('bootstrap'))).snapshot.family.name, '家人刚刚修改');
  beforeTransaction = async () => {
    const current = await server.repository.get('families', initial.familyId);
    await server.repository.set('families', initial.familyId, { ...current, members: [] });
  };
  assert.equal((await server.command('customizeFamily', args, initial.revision + 1)).code, 'NO_FAMILY');
  assert.equal((await server.repository.get('families', initial.familyId)).name, '家人刚刚修改');
});

test('partial command snapshots preserve recipes, sets, inventory, purchases and order dependencies', async () => {
  const server = fixture();
  let current = await family(server);
  const local = structuredClone(current.snapshot);
  let request = 0;
  async function mutate(name, args) {
    current = await success(server.call('command', { name, args, requestId: `patch-workflow-${++request}`, revision: current.revision, responseMode: 'changes' }));
    assert.ok(current.changes);
    Object.assign(local, current.changes);
    const confirmed = (await success(server.call('bootstrap'))).snapshot;
    for (const field of ['family', 'recipes', 'mealSets', 'inventory', 'orders', 'purchases']) assert.deepEqual(local[field], confirmed[field], `${name}: ${field}`);
  }
  await mutate('saveRecipe', [recipe]);
  await mutate('saveRecipe', [{ ...recipe, title: '第二道菜' }]);
  await mutate('saveMealSet', [{ title: '两道菜', image: '', recipeIds: local.recipes.map(item => item.id) }]);
  await mutate('addStock', [{ name: '番茄', quantity: 2, unit: '个', location: '冷藏', image: '', expiresOn: '' }]);
  await mutate('customizeFamily', [{ name: '新名字', cover: '', coverTitle: '' }]);
  await mutate('submitOrder', [{ [`set:${local.mealSets[0].id}`]: 1 }, { date: '2026-09-09', meal: '晚餐' }]);
  await mutate('recordPurchase', [{ name: '番茄', quantity: 2, unit: '个', location: '冷藏', image: '', expiresOn: '' }]);
  await mutate('updateOrder', [local.orders[0].id, 'accepted']);
  await mutate('updateOrder', [local.orders[0].id, 'completed']);
  await mutate('removeFamilyEntry', [local.recipes[0].id, 'dish']);
  await mutate('changeStockImage', [local.inventory[0].id, '/static/tofu.png']);
  await mutate('removeStock', [local.inventory[0].id]);
});

test('stale permitted ordering falls back to a full snapshot rather than an unsafe partial update', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [recipe], 1));
  const result = await success(server.call('command', { name: 'submitOrder', args: [{ [saved.snapshot.recipes[0].id]: 1 }, { date: '2026-09-09', meal: '晚餐' }], requestId: 'stale-order-patch', revision: 1, responseMode: 'changes' }));
  assert.ok(result.snapshot);
  assert.equal(result.changes, undefined);
  assert.equal(result.snapshot.recipes.length, 1);
  assert.equal(result.snapshot.orders.length, 1);
});

test('social patches preserve family data and imports update only the relevant public record', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [recipe], 1));
  const published = await success(server.command('publishToCommunity', [saved.snapshot.recipes[0].id], saved.revision));
  const patch = (name, args, revision, openid = 'alice') => success(server.call('command', { name, args, revision, responseMode: 'changes', requestId: `social-patch-${name}-${openid}` }, openid));
  const comment = await patch('addComment', [published.value, '好吃'], published.revision);
  assert.equal(comment.revision, published.revision);
  assert.equal(comment.changes.recipes, undefined);
  const liked = await patch('toggleCommentLike', [comment.changes.comments[0].id], published.revision);
  assert.deepEqual(liked.changes.comments[0].likes, [digest('alice')]);
  const other = await family(server, 'bob');
  const imported = await patch('addCollection', [{ id: published.value }], other.revision, 'bob');
  assert.equal(imported.changes.recipes.length, 1);
  assert.equal(imported.postChanges.upsert[0].importedFamilyCount, 1);
  const deleted = await patch('deleteCommunityPost', [published.value], published.revision);
  assert.deepEqual(deleted.postChanges.remove, [published.value]);
  assert.equal((await success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes.length, 1);
});

test('direct uploads enforce authentication, size, format and encrypted server-only media records', async () => {
  const uploads = [];
  let rejected = false;
  const server = fixture({ storeImageBytes: async (bytes, owner) => {
    if (rejected) throw Object.assign(new Error('图片格式不支持'), { code: 'IMAGE_FORMAT' });
    uploads.push({ bytes, owner });
    return { fileId: `cloud://env/approved/image-${uploads.length}.bin`, encryptionKey: 'private-secret' };
  } });
  assert.equal((await server.call('mediaUpload', { base64: 'YWJj' })).code, 'NO_FAMILY');
  const created = await family(server);
  for (const base64 of ['', '%%%%', 'aaa', 'A'.repeat(700004)]) assert.equal((await server.call('mediaUpload', { base64 })).code, 'IMAGE_SIZE');
  const confirmed = await success(server.call('mediaUpload', { base64: Buffer.alloc(500000, 5).toString('base64'), familyId: 'forged' }));
  assert.equal(confirmed.protected, true);
  assert.equal(JSON.stringify(confirmed).includes('private-secret'), false);
  assert.equal(uploads[0].owner.familyId, created.familyId);
  assert.equal(uploads[0].bytes.length, 500000);
  const record = await server.repository.get('media', digest(confirmed.fileId));
  assert.equal(record.confirmed, true);
  assert.equal(record.encryptionKey, 'private-secret');
  rejected = true;
  assert.equal((await server.call('mediaUpload', { base64: 'YWJj' })).code, 'IMAGE_FORMAT');
  assert.equal((await server.repository.list('media')).length, 1);
  await family(server, 'bob');
  assert.equal((await server.call('mediaContent', { fileId: confirmed.fileId }, 'bob')).code, 'FORBIDDEN');
});

test('fast preferences still enforce rate limits and authorization on every command', async () => {
  const server = fixture();
  const created = await family(server);
  const bucket = Math.floor(clock / 60000);
  await server.repository.set('rate_limits', digest(`${created.userId}:command:${bucket}`), { count: 60 });
  const event = { name: 'setChef', args: [true], revision: created.revision, requestId: 'limited-fast-switch', responseMode: 'changes' };
  assert.equal((await server.call('command', event)).code, 'RATE_LIMIT');
  await server.repository.remove('rate_limits', digest(`${created.userId}:command:${bucket}`));
  const record = await server.repository.get('families', created.familyId);
  await server.repository.set('families', created.familyId, { ...record, members: [] });
  assert.equal((await server.call('command', event)).code, 'NO_FAMILY');
});

test('unchanged background sync validates membership without listing records or opening a transaction', async () => {
  const server = fixture();
  const created = await family(server);
  server.repository.list = async () => { throw new Error('no list expected'); };
  server.repository.transaction = async () => { throw new Error('no transaction expected'); };
  const result = await success(server.call('bootstrap', { knownFamilyId: created.familyId, knownRevision: created.revision }));
  assert.equal(result.unchanged, true);
  assert.equal(result.snapshot, undefined);
  assert.equal(result.familyId, created.familyId);
  const stored = await server.repository.get('families', created.familyId);
  await server.repository.set('families', created.familyId, { ...stored, members: [] });
  assert.equal((await server.call('bootstrap', { knownFamilyId: created.familyId, knownRevision: created.revision })).code, 'NO_FAMILY');
});

test('known revisions cannot select another family or suppress a changed family snapshot', async () => {
  const server = fixture();
  const created = await family(server);
  const other = await family(server, 'bob');
  for (const known of [
    { knownFamilyId: other.familyId, knownRevision: created.revision },
    { knownFamilyId: created.familyId, knownRevision: String(created.revision) },
    { knownFamilyId: created.familyId, knownRevision: created.revision + 1 },
  ]) {
    const result = await success(server.call('bootstrap', known));
    assert.equal(result.familyId, created.familyId);
    assert.ok(result.snapshot);
  }
  await success(server.command('setChef', [true], created.revision));
  const changed = await success(server.call('bootstrap', { knownFamilyId: created.familyId, knownRevision: created.revision }));
  assert.equal(changed.revision, created.revision + 1);
  assert.equal(changed.snapshot.family.members[0].isChef, true);
});

test('full bootstrap reads independent lists concurrently outside write transactions', async () => {
  const server = fixture();
  await family(server);
  const list = server.repository.list;
  let active = 0;
  let maximum = 0;
  server.repository.transaction = async () => { throw new Error('no read transaction expected'); };
  server.repository.list = async (...args) => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    const rows = await list(...args);
    active -= 1;
    return rows;
  };
  await success(server.call('bootstrap'));
  assert.equal(maximum, 7);
});

test('snapshot revision fence retries a concurrent change instead of returning mixed data', async () => {
  const server = fixture();
  const created = await family(server);
  const list = server.repository.list;
  let reads = 0;
  server.repository.list = async (...args) => {
    const rows = await list(...args);
    if (args[0] === 'recipes' && ++reads === 1) {
      const stored = await server.repository.get('families', created.familyId);
      await server.repository.set('recipes', 'new-recipe', { familyId: created.familyId, value: { ...recipe, id: 'new-recipe' } });
      await server.repository.set('families', created.familyId, { ...stored, revision: stored.revision + 1 });
    }
    return rows;
  };
  const result = await success(server.call('bootstrap'));
  assert.equal(reads, 2);
  assert.equal(result.revision, created.revision + 1);
  assert.equal(result.snapshot.recipes[0].id, 'new-recipe');
});

test('continuous concurrent changes return a retryable error, and revocation during reads rejects the snapshot', async () => {
  const server = fixture();
  const created = await family(server);
  const list = server.repository.list;
  let revoke = false;
  let reads = 0;
  server.repository.list = async (...args) => {
    const rows = await list(...args);
    if (args[0] === 'recipes') {
      reads += 1;
      const stored = await server.repository.get('families', created.familyId);
      await server.repository.set('families', created.familyId, { ...stored, revision: stored.revision + 1, ...(revoke ? { members: [] } : {}) });
    }
    return rows;
  };
  assert.equal((await server.call('bootstrap')).code, 'SYNC_BUSY');
  assert.equal(reads, 3);
  revoke = true;
  assert.equal((await server.call('bootstrap')).code, 'NO_FAMILY');
});

test('approved encrypted uploads signal that the local photo can be reused without exposing a key', async () => {
  const server = fixture({ storeImage: async () => ({ fileId: 'cloud://env/approved/encrypted.bin', encryptionKey: 'private-key' }) });
  await family(server);
  const ticket = await success(server.call('mediaTicket'));
  const confirmed = await success(server.call('mediaConfirm', { ticket: ticket.id, fileId: `cloud://env/${ticket.path}` }));
  assert.deepEqual(confirmed, { fileId: 'cloud://env/approved/encrypted.bin', protected: true });
});

test('profile upload tickets work before family creation and cannot be used by another user or purpose', async () => {
  let stored = 0;
  const server = fixture({ storeImage: async () => { stored += 1; return { fileId: 'cloud://env/approved/avatar.bin', encryptionKey: 'private-key', variants: { card: { fileId: 'cloud://env/approved/avatar-card.bin' } } }; } });
  const ticket = await success(server.call('profileMediaTicket'));
  assert.ok(ticket.path.startsWith('private/alice/'));
  const payload = { ticket: ticket.id, fileId: `cloud://env/${ticket.path}` };
  assert.equal((await server.call('profileMediaConfirm', payload, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('profileMediaConfirm', { ...payload, fileId: 'cloud://env/private/alice/other.jpg' })).code, 'FORBIDDEN');
  const confirmed = await success(server.call('profileMediaConfirm', payload));
  assert.deepEqual(confirmed, { fileId: 'cloud://env/approved/avatar.bin', protected: true });
  assert.deepEqual(await success(server.call('profileMediaConfirm', payload)), confirmed);
  assert.equal(stored, 1);
  const media = await server.repository.get('media', digest(confirmed.fileId));
  assert.equal(media.profile, true);
  assert.equal(media.userId, digest('alice'));
  assert.equal(media.familyId, `profile-${digest('alice')}`);
  assert.equal(media.variants.card.fileId, 'cloud://env/approved/avatar-card.bin');
  assert.equal(JSON.stringify(confirmed).includes('private-key'), false);
  assert.equal((await success(server.call('bootstrap'))).needsFamily, true);
  await family(server);
  assert.equal((await server.call('mediaConfirm', payload)).code, 'FORBIDDEN');
  const familyTicket = await success(server.call('mediaTicket'));
  assert.equal((await server.call('profileMediaConfirm', { ticket: familyTicket.id, fileId: `cloud://env/${familyTicket.path}` })).code, 'FORBIDDEN');
  const expired = await success(server.call('profileMediaTicket'));
  const row = await server.repository.get('media', expired.id);
  await server.repository.set('media', expired.id, { ...row, expiresAt: clock });
  assert.equal((await server.call('profileMediaConfirm', { ticket: expired.id, fileId: `cloud://env/${expired.path}` })).code, 'FORBIDDEN');
  assert.equal(stored, 1);
});

test('family image tickets are scoped to the editor family and replay returns only the confirmed image', async () => {
  let stored = 0;
  const server = fixture({ storeImage: async () => { stored += 1; return { fileId: 'cloud://env/approved/photo.bin', encryptionKey: 'private' }; } });
  const current = await family(server);
  assert.equal((await server.call('mediaTicket', { familyId: 'wrong-family' })).code, 'CONFLICT');
  const ticket = await success(server.call('mediaTicket', { familyId: current.familyId }));
  const payload = { familyId: current.familyId, ticket: ticket.id, fileId: `cloud://env/${ticket.path}` };
  const confirmed = await success(server.call('mediaConfirm', payload));
  assert.deepEqual(await success(server.call('mediaConfirm', payload)), confirmed);
  assert.equal(stored, 1);
  assert.equal((await server.call('mediaConfirm', { ...payload, familyId: 'wrong-family' })).code, 'CONFLICT');
  assert.equal((await server.call('mediaConfirm', { ...payload, fileId: `cloud://other-env/${ticket.path}` })).code, 'FORBIDDEN');
  const next = await success(server.call('createFamily', { name: 'alice', familyName: '另一个家', requestId: 'another-home-upload-check' }));
  assert.notEqual(next.familyId, current.familyId);
  assert.equal((await server.call('mediaConfirm', payload)).code, 'CONFLICT');
  assert.equal((await server.call('mediaConfirm', { ticket: ticket.id, fileId: payload.fileId })).code, 'FORBIDDEN');
  assert.equal(stored, 1);
});

test('upstream errors retain a numeric diagnostic code without exposing private SDK messages', async () => {
  const reports = [];
  const server = fixture({ onError: (error, context) => reports.push({ error, context }) });
  const transaction = server.repository.transaction;
  server.repository.transaction = async () => { throw { errCode: -604101, errMsg: 'private input and service details' }; };
  const result = await server.call('createFamily', { name: '我', familyName: '我们的小家' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL');
  assert.equal(result.serviceCode, -604101);
  assert.equal(JSON.stringify(result).includes('private input'), false);
  assert.equal(reports[0].context.action, 'createFamily');
  server.repository.transaction = transaction;
  assert.equal((await server.call('bootstrap')).data.needsFamily, true);
});

test('cloud starts empty, authenticates by trusted OPENID, and rejects client identity switching', async () => {
  const server = fixture();
  assert.equal((await server.app({ action: 'bootstrap', openid: 'alice' }, {})).code, 'UNAUTHENTICATED');
  assert.equal((await server.call('bootstrap')).data.needsFamily, true);
  const created = await family(server);
  for (const field of ['recipes', 'mealSets', 'orders', 'inventory', 'purchases', 'posts', 'comments']) assert.deepEqual(created.snapshot[field], []);
  assert.equal(created.snapshot.family.members.length, 1);
  assert.equal(created.snapshot.activeMemberId, digest('alice'));
  assert.equal((await server.command('switchMember', [digest('bob')], 1)).ok, false);
  assert.equal((await server.command('saveRecipe', [recipe], 1, 'outsider')).code, 'NO_FAMILY');
});

test('invitation joins the actual family, expires, rotates, and removal revokes read and write access', async () => {
  let now = clock;
  const server = fixture({ now: () => now });
  const created = await family(server);
  const old = await success(server.call('createInvite'));
  const invite = await success(server.call('createInvite'));
  assert.equal((await server.call('joinFamily', { code: old.code, name: 'Bob' }, 'bob')).ok, false);
  const joined = await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  assert.equal(joined.familyId, created.familyId);
  assert.equal(joined.snapshot.family.members.length, 2);
  assert.equal((await server.call('createInvite', {}, 'bob')).code, 'FORBIDDEN');
  now += 25 * 3600000;
  assert.equal((await server.call('joinFamily', { code: invite.code, name: 'Carl' }, 'carl')).ok, false);
  await success(server.call('removeMember', { memberId: digest('bob') }));
  assert.equal((await server.call('bootstrap', {}, 'bob')).data.needsFamily, true);
  assert.equal((await server.command('saveRecipe', [recipe], 3, 'bob')).code, 'NO_FAMILY');
  assert.equal((await success(server.call('leaveFamily', { familyId: created.familyId }))).needsFamily, true);
  assert.ok((await server.repository.get('families', created.familyId)).deletedAt);
});

test('two members order concurrently into one meal; idempotent retry cannot duplicate a meal or inventory', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [recipe], 1));
  const id = saved.snapshot.recipes[0].id;
  const invite = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  const orders = await Promise.all(['alice', 'bob'].map(openid => server.command('submitOrder', [{ [id]: 1 }, { date: '2026-09-09', meal: '晚餐' }, '少盐'], 1, openid)));
  orders.forEach(result => assert.equal(result.ok, true, JSON.stringify(result)));
  const state = (await success(server.call('bootstrap'))).snapshot;
  assert.equal(state.orders.length, 1);
  assert.equal(state.orders[0].items.length, 1);
  assert.equal(state.orders[0].items[0].chosenBy.length, 2);
  const revision = (await success(server.call('bootstrap'))).revision;
  const batch = { name: '番茄', quantity: 500, unit: 'g', location: '冷藏', expiresOn: '', image: '' };
  const first = await success(server.command('recordPurchase', [batch], revision, 'alice', 'purchase-retry-001'));
  const second = await success(server.command('recordPurchase', [batch], revision, 'alice', 'purchase-retry-001'));
  assert.equal(first.snapshot.purchases.length, 1);
  assert.equal(second.snapshot.purchases.length, 1);
  assert.equal(second.revision, first.revision);
  assert.equal((await server.command('recordPurchase', [{ ...batch, quantity: 900 }], revision, 'alice', 'purchase-retry-001')).code, 'CONFLICT');
});

test('concurrent add-dishes appends both members and keeps stock, receipts and request idempotency', async () => {
  const server = fixture();
  let current = await family(server);
  for (const item of createSeed().recipes.slice(0, 3)) current = await success(server.command('saveRecipe', [item], current.revision));
  const ids = current.snapshot.recipes.map(item => item.id);
  current = await success(server.command('submitOrder', [{ [ids[0]]: 1 }, { date: '2026-09-09', meal: '晚餐' }, '保留备注'], current.revision));
  const orderId = current.snapshot.orders[0].id;
  current = await success(server.command('recordPurchase', [{ name: '番茄', quantity: 100, unit: 'g', location: '冷藏' }], current.revision));
  const supplies = structuredClone({ inventory: current.snapshot.inventory, purchases: current.snapshot.purchases });
  const invite = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  const changes = await Promise.all([
    server.command('addOrderDishes', [orderId, { [ids[1]]: 1 }], 1, 'alice', 'add-dishes-alice-01'),
    server.command('addOrderDishes', [orderId, { [ids[0]]: 1, [ids[2]]: 1 }], 1, 'bob', 'add-dishes-bob-0001'),
  ]);
  changes.forEach(result => assert.equal(result.ok, true, JSON.stringify(result)));
  current = await success(server.call('bootstrap'));
  const [order] = current.snapshot.orders;
  assert.equal(current.snapshot.orders.length, 1);
  assert.equal(order.id, orderId);
  assert.equal(order.items.length, 3);
  assert.deepEqual(order.items.find(item => item.recipe.id === ids[0]).chosenBy.map(member => member.id), [digest('alice'), digest('bob')]);
  assert.match(order.note, /保留备注/);
  assert.deepEqual({ inventory: current.snapshot.inventory, purchases: current.snapshot.purchases }, supplies);
  const replay = await success(server.command('addOrderDishes', [orderId, { [ids[1]]: 1 }], 1, 'alice', 'add-dishes-alice-01'));
  assert.equal(replay.value, orderId);
  assert.equal(replay.revision, current.revision);
  assert.deepEqual(replay.snapshot.orders, current.snapshot.orders);
  assert.equal((await server.command('addOrderDishes', [orderId, { [ids[2]]: 1 }], 1, 'alice', 'add-dishes-alice-01')).code, 'CONFLICT');
});

test('two stale devices can add during preparation but cannot reopen a served meal', async () => {
  const server = fixture();
  let current = await family(server);
  for (const item of createSeed().recipes.slice(0, 3)) current = await success(server.command('saveRecipe', [item], current.revision));
  const ids = current.snapshot.recipes.map(item => item.id);
  const slot = { date: '2026-09-09', meal: '晚餐' };
  current = await success(server.command('submitOrder', [{ [ids[0]]: 1 }, slot], current.revision));
  const orderId = current.snapshot.orders[0].id;
  const previousRevision = current.revision;
  const results = await Promise.all(ids.slice(1).map(id => server.command('addOrderDishes', [orderId, { [id]: 1 }], previousRevision)));
  results.forEach(result => assert.equal(result.ok, true, JSON.stringify(result)));
  current = await success(server.call('bootstrap'));
  assert.equal(current.snapshot.orders[0].selections[0].items.length, 3);
  assert.equal(current.snapshot.orders[0].status, 'accepted');
  assert.equal((await server.command('updateOrder', [orderId, 'accepted'], previousRevision)).code, 'CONFLICT');
  current = await success(server.command('updateOrder', [orderId, 'accepted'], current.revision));
  current = await success(server.command('updateOrder', [orderId, 'completed'], current.revision));
  const before = structuredClone(current.snapshot.orders);
  for (const [name, args] of [['addOrderDishes', [orderId, { [ids[0]]: 1 }]], ['submitOrder', [{ [ids[1]]: 1 }, slot]], ['submitOrder', [{}, slot]]]) {
    const rejected = await server.command(name, args, previousRevision);
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /已结束|已经做好/);
  }
  assert.deepEqual((await success(server.call('bootstrap'))).snapshot.orders, before);
});

test('add-dishes checks family ownership, accepts only menu keys and takes voter identity from login', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const recipeId = current.snapshot.recipes[0].id;
  current = await success(server.command('submitOrder', [{ [recipeId]: 1 }, { date: '2026-09-09', meal: '午餐' }], current.revision));
  const orderId = current.snapshot.orders[0].id;
  await family(server, 'outsider');
  const foreign = await server.command('addOrderDishes', [orderId, { [recipeId]: 1 }], 1, 'outsider');
  assert.equal(foreign.ok, false);
  const invite = await success(server.call('createInvite'));
  await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  const result = await success(server.command('addOrderDishes', [orderId, { [recipeId]: 1 }, { memberId: 'outsider', date: '2030-01-01' }], 1, 'bob'));
  assert.deepEqual(result.snapshot.orders[0].items[0].chosenBy.map(member => member.id), [digest('alice'), digest('bob')]);
  assert.equal(result.snapshot.orders[0].date, '2026-09-09');
  for (const cart of [{}, { [recipeId]: 2 }, { missing: 1 }]) assert.equal((await server.command('addOrderDishes', [orderId, cart], 1)).ok, false);
  assert.equal((await success(server.call('bootstrap'))).snapshot.orders[0].items[0].chosenBy.length, 2);
});

test('stale editing is rejected instead of overwriting another family member', async () => {
  const server = fixture();
  await family(server);
  await success(server.command('saveRecipe', [recipe], 1));
  const result = await server.command('customizeFamily', [{ name: '新的家庭', cover: '', coverTitle: '' }], 1);
  assert.equal(result.code, 'CONFLICT');
  assert.equal((await success(server.call('bootstrap'))).snapshot.family.name, 'alice的小家');
});

test('cloud rejects future serving without changing the meal, shopping or revision', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  for (const date of ['2026-09-10', '2026-09-11']) {
    current = await success(server.command('submitOrder', [cart, { date, meal: '晚餐' }], current.revision));
    const order = current.snapshot.orders.find(item => item.date === date);
    const before = structuredClone(current);
    const rejected = await server.command('updateOrder', [order.id, 'completed'], current.revision);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, 'INVALID');
    assert.equal(rejected.message, '只能当天开饭');
    const restored = await success(server.call('bootstrap', { includeFeed: false }));
    assert.equal(restored.revision, before.revision);
    assert.deepEqual(restored.snapshot.orders, before.snapshot.orders);
    assert.deepEqual(restored.snapshot.purchases, before.snapshot.purchases);
    assert.deepEqual(restored.snapshot.inventory, before.snapshot.inventory);
  }
});

test('serving uses the Shanghai calendar day and keeps successful retries idempotent across midnight', async () => {
  let instant = Date.parse('2026-09-09T15:59:59Z');
  const server = fixture({ now: () => instant });
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  for (const [date, meal] of [['2026-09-09', '晚餐'], ['2026-09-09', '宵夜'], ['2026-09-10', '早餐']]) {
    current = await success(server.command('submitOrder', [cart, { date, meal }], current.revision));
  }
  const dinner = current.snapshot.orders.find(order => order.meal === '晚餐');
  const midnightMeal = current.snapshot.orders.find(order => order.meal === '宵夜');
  const breakfast = current.snapshot.orders.find(order => order.meal === '早餐');
  const completion = { name: 'updateOrder', args: [dinner.id, 'completed'], revision: current.revision, requestId: 'serve-across-midnight-001' };
  current = await success(server.call('command', completion));
  const completedAt = current.snapshot.orders.find(order => order.id === dinner.id).completedAt;
  assert.equal((await server.command('updateOrder', [breakfast.id, 'completed'], current.revision)).message, '只能当天开饭');

  instant += 1000;
  current = await success(server.call('command', completion));
  assert.equal(current.snapshot.orders.find(order => order.id === dinner.id).completedAt, completedAt);
  const rejected = await server.command('updateOrder', [midnightMeal.id, 'completed'], current.revision);
  assert.equal(rejected.code, 'INVALID');
  assert.equal(rejected.message, '只能当天开饭');
  current = await success(server.command('updateOrder', [breakfast.id, 'completed'], current.revision));
  assert.equal(current.snapshot.orders.find(order => order.id === breakfast.id).status, 'completed');
  assert.equal(current.snapshot.orders.find(order => order.id === midnightMeal.id).status, 'accepted');
});

test('cloud end times use the server clock, survive refresh and retries, and sort finished meals together', async () => {
  let instant = clock;
  const server = fixture({ now: () => instant });
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  current = await success(server.command('submitOrder', [cart, { date: '2026-09-09', meal: '晚餐' }], current.revision));
  const dinnerId = current.snapshot.orders[0].id;
  current = await success(server.command('submitOrder', [cart, { date: '2026-09-10', meal: '早餐' }], current.revision));
  const breakfastId = current.snapshot.orders.find(order => order.date === '2026-09-10' && order.meal === '早餐').id;
  current = await success(server.command('submitOrder', [cart, { date: '2026-09-09', meal: '宵夜' }], current.revision));
  const lateNightId = current.snapshot.orders.find(order => order.meal === '宵夜').id;
  instant += 60000;
  const completionRequest = { name: 'updateOrder', args: [dinnerId, 'completed'], revision: current.revision, requestId: 'complete-timestamp-001', responseMode: 'changes' };
  const completion = await success(server.call('command', completionRequest));
  const completedAt = new Date(instant).toISOString();
  assert.equal(completion.changes.orders.find(order => order.id === dinnerId).completedAt, completedAt);
  instant += 60000;
  const cancellationRequest = { name: 'updateOrder', args: [breakfastId, 'cancelled'], revision: completion.revision, requestId: 'cancel-timestamp-0001', responseMode: 'changes' };
  const cancellation = await success(server.call('command', cancellationRequest));
  const cancelledAt = new Date(instant).toISOString();
  assert.equal(cancellation.changes.orders.find(order => order.id === breakfastId).cancelledAt, cancelledAt);
  instant += 60000;
  await success(server.call('command', completionRequest));
  await success(server.call('command', cancellationRequest));
  current = await success(server.call('bootstrap', { includeFeed: false }));
  assert.equal(current.snapshot.orders.find(order => order.id === dinnerId).completedAt, completedAt);
  assert.equal(current.snapshot.orders.find(order => order.id === breakfastId).cancelledAt, cancelledAt);
  assert.deepEqual(kitchenOrders(current.snapshot.orders, '2026-09-09').map(order => order.id), [lateNightId, breakfastId, dinnerId]);
  const persisted = await server.repository.get('orders', digest(`${current.familyId}:${breakfastId}`));
  assert.equal(persisted.value.cancelledAt, cancelledAt);
  current = await success(server.command('updateOrder', [breakfastId, 'accepted'], current.revision));
  assert.deepEqual(kitchenOrders(current.snapshot.orders, '2026-09-09').map(order => order.id), [lateNightId, breakfastId, dinnerId]);
  instant += 60000;
  current = await success(server.command('updateOrder', [breakfastId, 'cancelled'], current.revision));
  assert.equal(current.snapshot.orders.find(order => order.id === breakfastId).cancelledAt, new Date(instant).toISOString());
  assert.notEqual(current.snapshot.orders.find(order => order.id === breakfastId).cancelledAt, cancelledAt);
});

test('cloud withdrawing the final selection records cancellation once using server time', async () => {
  let instant = clock;
  const server = fixture({ now: () => instant });
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  const selection = { date: '2026-09-09', meal: '午餐' };
  current = await success(server.command('submitOrder', [cart, selection], current.revision));
  instant += 60000;
  const request = { name: 'submitOrder', args: [{}, selection], revision: current.revision, requestId: 'withdraw-timestamp-01' };
  current = await success(server.call('command', request));
  const cancelledAt = new Date(instant).toISOString();
  assert.equal(current.snapshot.orders[0].status, 'cancelled');
  assert.equal(current.snapshot.orders[0].cancelledAt, cancelledAt);
  instant += 60000;
  await success(server.call('command', request));
  assert.equal((await success(server.call('bootstrap'))).snapshot.orders[0].cancelledAt, cancelledAt);
});

test('cloud persists sets, settings, stock, orders and diary; completed meals clear shopping with fridge off', async () => {
  const server = fixture();
  let current = await family(server);
  async function mutate(name, args) { current = await success(server.command(name, args, current.revision)); return current; }
  await mutate('saveRecipe', [recipe]);
  await mutate('saveRecipe', [{ ...recipe, title: '第二道菜' }]);
  await mutate('saveMealSet', [{ title: '晚餐双拼', image: '', recipeIds: current.snapshot.recipes.map(item => item.id) }]);
  await mutate('customizeFamily', [{ name: '云端小家', cover: '', coverTitle: '每天一起吃饭' }]);
  await mutate('setChef', [true]);
  await mutate('addStock', [{ name: '番茄', quantity: 5, unit: '个', location: '冷藏', image: '', expiresOn: '2026-09-11' }]);
  await mutate('submitOrder', [{ [`set:${current.snapshot.mealSets[0].id}`]: 1 }, { date: '2026-09-09', meal: '晚餐' }]);
  assert.ok(getShoppingRequirements(current.snapshot, '2026-09-09').length);
  const orderId = current.snapshot.orders[0].id;
  await mutate('updateOrder', [orderId, 'accepted']);
  await mutate('updateOrder', [orderId, 'completed']);
  assert.deepEqual(getShoppingRequirements(current.snapshot, '2026-09-09'), []);
  const restored = await success(server.call('bootstrap'));
  assert.ok(restored.snapshot.orders[0].completedAt);
  assert.equal(restored.snapshot.family.name, '云端小家');
  assert.equal(restored.snapshot.family.members[0].isChef, true);
  assert.equal(restored.snapshot.inventory.length, 1);
  assert.equal(restored.snapshot.mealSets.length, 1);
  assert.equal((await server.command('updateOrder', [orderId, 'completed'], restored.revision)).ok, false);
});

test('public recipe copies, real counts, replies and likes survive deletion without leaking private records', async () => {
  const server = fixture();
  await family(server);
  let current = await success(server.command('saveRecipe', [recipe], 1));
  const dishId = current.snapshot.recipes[0].id;
  current = await success(server.command('publishToCommunity', [dishId, 'dish'], current.revision));
  const postId = current.value;
  const other = await family(server, 'bob');
  assert.equal(other.snapshot.recipes.length, 0);
  assert.equal(other.snapshot.posts.length, 0);
  const publicFeed = await success(server.call('feed', {}, 'bob'));
  assert.equal(publicFeed.posts.length, 1);
  assert.equal(publicFeed.posts[0].family?.members, undefined);
  let bob = await success(server.command('addCollection', [{ id: postId, recipes: [] }], other.revision, 'bob'));
  assert.equal(bob.snapshot.recipes[0].title, recipe.title);
  bob = await success(server.command('addCollection', [{ id: postId }], bob.revision, 'bob'));
  assert.equal(bob.snapshot.recipes.length, 1);
  assert.equal((await success(server.call('readPost', { postId }))).post.importedFamilyCount, 1);
  bob = await success(server.command('addComment', [postId, '很好吃'], bob.revision, 'bob'));
  const commentId = bob.snapshot.comments[0].id;
  const reply = await success(server.command('addComment', [postId, '谢谢，记得少盐', commentId], current.revision));
  assert.equal(reply.snapshot.comments.find(item => item.id !== commentId).replyToId, commentId);
  const liked = await success(server.command('toggleCommentLike', [commentId], current.revision));
  assert.deepEqual(liked.snapshot.comments.find(item => item.id === commentId).likes, [digest('alice')]);
  assert.equal((await server.command('deleteCommunityPost', [postId], bob.revision, 'bob')).ok, false);
  await success(server.command('deleteCommunityPost', [postId], current.revision));
  assert.equal((await server.call('readPost', { postId }, 'bob')).ok, false);
  assert.equal((await success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes.length, 1);
});

test('official posts deny deletion to the import owner and other users, preserving copies and comments', async () => {
  const server = fixture();
  let alice = await family(server);
  alice = await success(server.command('saveRecipe', [recipe], alice.revision));
  alice = await success(server.command('publishToCommunity', [alice.snapshot.recipes[0].id], alice.revision));
  const postId = alice.value;
  const original = await server.repository.get('posts', postId);
  let bob = await family(server, 'bob');
  bob = await success(server.command('addCollection', [{ id: postId }], bob.revision, 'bob'));
  bob = await success(server.command('addComment', [postId, '收藏了'], bob.revision, 'bob'));
  const commentsBefore = await server.repository.list('comments');
  const copied = bob.snapshot.recipes;
  const updated = await server.repository.get('posts', postId);
  for (const publisher of [{ publisherId: original.publisherId, publisherType: 'official' }, { publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official' }, { publisherId: undefined }]) {
    const post = { ...updated, ...publisher, card: { ...updated.card, ...publisher } };
    await server.repository.set('posts', postId, post);
    for (const user of ['alice', 'bob']) assert.equal((await server.command('deleteCommunityPost', [postId], 0, user)).code, 'FORBIDDEN');
    assert.deepEqual(await server.repository.get('posts', postId), post);
    assert.deepEqual(await server.repository.list('comments'), commentsBefore);
    assert.deepEqual((await success(server.call('bootstrap', {}, 'bob'))).snapshot.recipes, copied);
  }
  const official = { ...updated, publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official', author: '食愿小灶' };
  official.card = { ...updated.card, publisherId: official.publisherId, publisherType: official.publisherType, author: official.author };
  await server.repository.set('posts', postId, official);
  const card = (await success(server.call('feed', { compact: true }))).posts[0];
  const detail = (await success(server.call('readPost', { postId }))).post;
  for (const value of [card, detail]) {
    assert.equal(value.author, '食愿小灶');
    assert.equal(value.publisherType, 'official');
    assert.equal(canDeleteCommunityPost(value, original.publisherId), false);
  }
  bob = await success(server.command('publishToCommunity', [copied[0].id], bob.revision, 'bob'));
  const personal = await server.repository.get('posts', bob.value);
  assert.equal(personal.publisherId, digest('bob'));
  assert.equal(personal.publisherType, 'user');
  assert.notEqual(personal.id, postId);
  await success(server.command('deleteCommunityPost', [personal.id], bob.revision, 'bob'));
  assert.equal((await server.repository.get('posts', postId)).status, 'published');
});

test('clients cannot forge official publisher identity through recipe fields or publish arguments', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [{ ...recipe, publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official', author: '食愿小灶' }], current.revision));
  assert.equal(current.snapshot.recipes[0].publisherType, undefined);
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id, 'dish', { publisherType: 'official', publisherId: OFFICIAL_PUBLISHER_ID }], current.revision));
  const personal = await server.repository.get('posts', current.value);
  assert.equal(personal.publisherId, digest('alice'));
  assert.equal(personal.publisherType, 'user');
  assert.equal(personal.card.publisherType, 'user');
  await success(server.command('deleteCommunityPost', [personal.id], current.revision));
});

test('source-author display survives feed, detail, family imports and cannot grant deletion rights', async () => {
  const server = fixture();
  let current = await family(server);
  const provenance = { source: '下厨房', attribution: '小美好曾曾', url: 'https://www.xiachufang.com/recipe/1234/', note: '来源记录保留' };
  current = await success(server.command('saveRecipe', [{ ...recipe, provenance }], current.revision));
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id], current.revision));
  const postId = current.value;
  const post = await server.repository.get('posts', postId);
  Object.assign(post, { publisherType: 'official', publisherId: OFFICIAL_PUBLISHER_ID, author: provenance.attribution });
  Object.assign(post.card, { publisherType: 'official', publisherId: OFFICIAL_PUBLISHER_ID, author: provenance.attribution });
  post.recipes[0].author = provenance.attribution;
  await server.repository.set('posts', postId, post);
  for (const compact of [true, false]) {
    const feed = await success(server.call('feed', { compact }));
    assert.equal(feed.posts[0].author, provenance.attribution);
    assert.equal(canDeleteCommunityPost(feed.posts[0], digest('alice')), false);
    if (compact) assert.equal(feed.posts[0].recipes[0].provenance, undefined);
  }
  const detail = await success(server.call('readPost', { postId }));
  assert.equal(detail.post.author, provenance.attribution);
  assert.deepEqual(detail.post.recipes[0].provenance, provenance);
  let bob = await family(server, 'bob');
  bob = await success(server.command('addCollection', [{ id: postId }], bob.revision, 'bob'));
  assert.equal(bob.snapshot.recipes[0].author, provenance.attribution);
  assert.deepEqual(bob.snapshot.recipes[0].provenance, provenance);
  for (const openid of ['alice', 'bob', provenance.attribution]) {
    if (openid === provenance.attribution) await family(server, openid);
    assert.equal((await server.command('deleteCommunityPost', [postId], 0, openid)).code, 'FORBIDDEN');
  }
  assert.equal((await server.repository.get('posts', postId)).status, 'published');
});

test('publication and its receipt commit atomically and retry without duplicate posts', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const baseline = structuredClone(current);
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(database => callback({ ...database, set: async (collection, id, value) => {
    if (collection === 'requests') throw new Error('receipt storage unavailable');
    return database.set(collection, id, value);
  } }));
  const args = [current.snapshot.recipes[0].id, 'dish'];
  const requestId = 'atomic-publication-001';
  const failed = await server.command('publishToCommunity', args, current.revision, 'alice', requestId);
  assert.equal(failed.ok, false);
  assert.deepEqual(await server.repository.list('posts'), []);
  assert.equal(await server.repository.get('requests', digest(`${current.userId}:${requestId}`)), null);
  assert.deepEqual((await success(server.call('bootstrap'))).snapshot, baseline.snapshot);
  server.repository.transaction = transaction;
  const published = await success(server.command('publishToCommunity', args, current.revision, 'alice', requestId));
  const replay = await success(server.command('publishToCommunity', args, current.revision, 'alice', requestId));
  assert.equal(published.value, replay.value);
  const posts = await server.repository.list('posts');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, 'published');
});

test('publishing is immediate while private media remains inaccessible to another family', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [recipe], 1));
  await success(server.command('publishToCommunity', [saved.snapshot.recipes[0].id], saved.revision));
  assert.equal((await success(server.call('feed'))).posts.length, 1);
  const ticket = await success(server.call('mediaTicket'));
  const fileId = `cloud://environment.bucket/${ticket.path}`;
  await success(server.call('mediaConfirm', { ticket: ticket.id, fileId }));
  const alice = await success(server.call('bootstrap'));
  await success(server.command('customizeFamily', [{ name: '照片小家', cover: fileId, coverTitle: '' }], alice.revision));
  await family(server, 'bob');
  assert.equal((await server.call('mediaUrl', { fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.command('saveRecipe', [{ ...recipe, image: fileId }], 1, 'bob')).code, 'FORBIDDEN');
  assert.equal((await server.call('mediaConfirm', { ticket: ticket.id, fileId }, 'bob')).code, 'FORBIDDEN');
});

test('server enforces China reservation dates and refuses privileged or forged commands', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [recipe], 1));
  const cart = { [saved.snapshot.recipes[0].id]: 1 };
  for (const date of ['2026-09-08', '2026-09-12']) assert.equal((await server.command('submitOrder', [cart, { date, meal: '晚餐' }], saved.revision)).ok, false);
  assert.equal((await server.call('command', { name: 'resetDemo', args: [], requestId: 'forged-request-001' })).ok, false);
  assert.equal((await server.call('command', { name: '__proto__', args: [], requestId: 'forged-request-001' })).ok, false);
  const other = await family(server, 'bob');
  assert.equal((await server.call('command', { name: 'setChef', args: [true], requestId: 'forged-request-001', revision: other.revision, familyId: saved.familyId, activeMemberId: digest('alice'), role: 'admin' }, 'bob')).code, 'CONFLICT');
  const result = await success(server.call('command', { name: 'setChef', args: [true], requestId: 'forged-request-002', revision: other.revision, familyId: other.familyId, activeMemberId: digest('alice'), role: 'admin' }, 'bob'));
  assert.equal(result.snapshot.family.ownerId, digest('bob'));
  assert.equal((await success(server.call('bootstrap'))).snapshot.family.members[0].isChef, false);
});

test('encrypted media keys stay server-side; public, imported and historical image access follows authorization', async () => {
  const accesses = [];
  const fileId = 'cloud://environment.bucket/approved/family/encrypted.bin';
  const server = fixture({
    signFiles: async ids => Object.fromEntries(ids.map(id => [id, { protected: true }])),
    storeImage: async () => ({ fileId, encryptionKey: 'server-only-key' }),
    readImage: async (id, media) => { accesses.push(id); assert.equal(media.encryptionKey, 'server-only-key'); return { base64: 'cGhvdG8=', contentType: 'image/jpeg' }; },
  });
  let alice = await family(server);
  const ticket = await success(server.call('mediaTicket'));
  const confirmed = await success(server.call('mediaConfirm', { ticket: ticket.id, fileId: `cloud://environment.bucket/${ticket.path}` }));
  assert.deepEqual(confirmed, { fileId, protected: true });
  await success(server.call('mediaContent', { fileId }));
  let bob = await family(server, 'bob');
  await family(server, 'carl');
  assert.equal((await server.call('mediaContent', { fileId }, 'bob')).code, 'FORBIDDEN');
  assert.equal(accesses.length, 1);
  alice = await success(server.command('saveRecipe', [{ ...recipe, image: fileId }], alice.revision));
  assert.equal(JSON.stringify(alice).includes('server-only-key'), false);
  alice = await success(server.command('publishToCommunity', [alice.snapshot.recipes[0].id, 'dish'], alice.revision));
  const postId = alice.value;
  await success(server.call('mediaContent', { fileId }, 'bob'));
  bob = await success(server.command('addCollection', [{ id: postId }], bob.revision, 'bob'));
  await success(server.command('deleteCommunityPost', [postId], alice.revision));
  await success(server.call('mediaContent', { fileId }, 'bob'));
  assert.equal((await server.call('mediaContent', { fileId }, 'carl')).code, 'FORBIDDEN');
  const dishId = bob.snapshot.recipes[0].id;
  bob = await success(server.command('submitOrder', [{ [dishId]: 1 }, { date: '2026-09-09', meal: '晚餐' }], bob.revision, 'bob'));
  bob = await success(server.command('removeFamilyEntry', [dishId, 'dish'], bob.revision, 'bob'));
  assert.equal(bob.snapshot.recipes.length, 0);
  await success(server.call('mediaContent', { fileId }, 'bob'));
  const invite = await success(server.call('createInvite', {}, 'bob'));
  await success(server.call('joinFamily', { code: invite.code, name: '家人' }, 'dora'));
  await success(server.call('mediaContent', { fileId }, 'dora'));
  await success(server.call('removeMember', { memberId: digest('dora') }, 'bob'));
  assert.equal((await server.call('mediaContent', { fileId }, 'dora')).code, 'FORBIDDEN');
  assert.equal((await server.call('mediaContent', { fileId: {} })).code, 'INVALID');
});

test('display batches keep per-image authorization, scoped versions, and private variant descriptors', async () => {
  const reads = [];
  const fileId = 'cloud://environment.bucket/approved/batch.bin';
  const server = fixture({
    storeImageBytes: async () => ({ fileId, encryptionKey: 'private-original-key', variants: { card: { fileId: 'cloud://environment.bucket/private-small.bin', encryptionKey: 'private-card-key', formatVersion: 1 } } }),
    readImage: async (id, media, variant) => { reads.push({ id, variant }); return { base64: 'cGhvdG8=', contentType: 'image/jpeg' }; },
  });
  let alice = await family(server);
  await family(server, 'bob');
  const upload = await success(server.call('mediaUpload', { base64: 'cGhvdG8=' }));
  assert.deepEqual(upload, { fileId, protected: true });
  const images = [{ fileId, variant: 'card' }, { fileId: 'cloud://unknown/no-access.bin', variant: 'detail' }];
  const own = await success(server.call('mediaBatch', { images }));
  assert.equal(own.images[0].data.version, `${fileId}#display-card-v1`);
  assert.equal(own.images[1].code, 'FORBIDDEN');
  assert.equal(JSON.stringify(own).includes('private-card-key'), false);
  const denied = await success(server.call('mediaBatch', { images }, 'bob'));
  assert.equal(denied.images[0].code, 'FORBIDDEN');
  const cached = await success(server.call('mediaBatch', { images: [{ fileId, variant: 'card', knownVersion: `${fileId}#display-card-v1` }] }));
  assert.equal(cached.images[0].data.unchanged, true);
  assert.equal(reads.length, 1);
  await success(server.call('mediaContent', { fileId, variant: 'detail', knownVersion: `${fileId}#display-card-v1` }));
  assert.equal(reads.at(-1).variant, 'detail');
  alice = await success(server.command('saveRecipe', [{ ...recipe, image: fileId }], alice.revision));
  alice = await success(server.command('publishToCommunity', [alice.snapshot.recipes[0].id, 'dish'], alice.revision));
  assert.equal((await success(server.call('mediaBatch', { images }, 'bob'))).images[0].ok, true);
  await success(server.command('deleteCommunityPost', [alice.value], alice.revision));
  const revoked = await success(server.call('mediaBatch', { images: [{ fileId, variant: 'card', knownVersion: `${fileId}#display-card-v1` }] }, 'bob'));
  assert.equal(revoked.images[0].code, 'FORBIDDEN');
  for (const invalid of [[], Array(7).fill(images[0]), [{ fileId, variant: 'original' }], [null]]) assert.equal((await server.call('mediaBatch', { images: invalid })).code, 'INVALID');
  assert.equal((await server.call('mediaContent', { fileId, variant: 'giant' })).code, 'INVALID');
});

test('selection cannot override server recipes or member identity; extra recipe fields are discarded', async () => {
  const server = fixture();
  await family(server);
  const saved = await success(server.command('saveRecipe', [{ ...recipe, publisherId: 'forged', sourceId: 'forged', ingredients: recipe.ingredients.map(item => ({ ...item, secret: 'never-persist' })) }], 1));
  const dish = saved.snapshot.recipes[0];
  assert.equal(dish.sourceId, undefined);
  assert.equal(dish.ingredients[0].secret, undefined);
  const selected = await success(server.command('submitOrder', [{ [dish.id]: 1 }, { date: '2026-09-09', meal: '晚餐', member: { id: 'victim', name: '伪造家人' }, id: 'forged-order' }], saved.revision));
  assert.equal(selected.snapshot.orders[0].selections[0].memberId, digest('alice'));
  assert.notEqual(selected.snapshot.orders[0].id, 'forged-order');
});

test('null optional reply becomes an empty ID and invalid text is rejected before writes', async () => {
  const server = fixture();
  await family(server);
  assert.equal((await server.command('saveRecipe', [{ ...recipe, title: '长'.repeat(10000) }], 1)).code, 'INVALID');
  assert.deepEqual(await server.repository.list('recipes'), []);
  assert.deepEqual(await server.repository.list('requests'), []);
  let current = await success(server.command('saveRecipe', [recipe, null], 1));
  current = await success(server.command('publishToCommunity', [current.snapshot.recipes[0].id], current.revision));
  const comment = await success(server.command('addComment', [current.value, '试做成功', null], current.revision));
  assert.equal(comment.snapshot.comments[0].replyToId, '');
});

test('concurrent repeated completion commits only once and leaves fridge stock unchanged', async () => {
  const server = fixture();
  let current = await family(server);
  async function mutate(name, args) { current = await success(server.command(name, args, current.revision)); }
  await mutate('saveRecipe', [{ ...recipe, ingredients: [{ name: '玉米', quantity: 1, unit: '根' }] }]);
  await mutate('setFeature', ['fridge', true]);
  await mutate('submitOrder', [{ [current.snapshot.recipes[0].id]: 1 }, { date: '2026-09-09', meal: '晚餐' }]);
  const orderId = current.snapshot.orders[0].id;
  await mutate('updateOrder', [orderId, 'accepted']);
  assert.equal((await success(server.call('bootstrap'))).snapshot.orders[0].status, 'accepted');
  await mutate('addStock', [{ name: '玉米', quantity: 3, unit: '根', location: '冷藏', image: '', expiresOn: '' }]);
  const results = await Promise.all([1, 2].map(() => server.command('updateOrder', [orderId, 'completed'], current.revision)));
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
  assert.equal((await success(server.call('bootstrap'))).snapshot.inventory[0].quantity, 3);
});

test('community cursor pagination has no duplicates and supports category, sets and escaped search', async () => {
  const server = fixture();
  await family(server);
  for (let index = 0; index < 36; index += 1) await server.repository.set('posts', `post-${String(index).padStart(3, '0')}`, { id: `post-${index}`, status: 'published', kind: index === 35 ? 'menu' : 'dish', categories: index === 35 ? [] : [recipe.category], recipes: [recipe], title: recipe.title, search: `${recipe.title} 番茄 ${index === 34 ? '.*' : ''}` });
  const first = await success(server.call('feed'));
  const second = await success(server.call('feed', { cursor: first.cursor }));
  assert.equal(first.posts.length, 30);
  assert.equal(second.posts.length, 6);
  assert.equal(new Set([...first.posts, ...second.posts].map(post => post.id)).size, 36);
  assert.equal((await success(server.call('feed', { type: '套餐' }))).posts.length, 1);
  assert.equal((await success(server.call('feed', { search: '.*' }))).posts.length, 1);
});

test('onboarding retry reuses family, invitations enforce capacity and invalid imports leave no partial copy', async () => {
  const server = fixture();
  const original = await family(server);
  assert.equal((await family(server)).familyId, original.familyId);
  const invite = await success(server.call('createInvite'));
  for (let index = 0; index < 19; index += 1) await success(server.call('joinFamily', { code: invite.code, name: `家人${index}` }, `member-${index}`));
  assert.equal((await server.call('joinFamily', { code: invite.code, name: '多一个' }, 'extra')).ok, false);
  assert.equal((await success(server.call('bootstrap'))).snapshot.family.members.length, 20);
  assert.equal((await server.command('addCollection', [{ id: 'missing' }], 20)).ok, false);
  assert.equal((await success(server.call('bootstrap'))).snapshot.recipes.length, 0);
});

test('only reviewed immutable image IDs become usable family assets', async () => {
  const approved = 'cloud://env/approved/family-1/reviewed.jpg';
  const server = fixture({ storeImage: async () => approved });
  await family(server);
  const ticket = await success(server.call('mediaTicket'));
  const temporary = `cloud://env/${ticket.path}`;
  assert.equal((await success(server.call('mediaConfirm', { ticket: ticket.id, fileId: temporary }))).fileId, approved);
  assert.equal((await server.call('mediaUrl', { fileId: temporary })).code, 'FORBIDDEN');
  assert.equal((await success(server.call('mediaUrl', { fileId: approved }))).media[approved], `signed:${approved}`);
});

test('untrusted payloads cannot pass prototype paths, database operators or deeply nested objects', async () => {
  const server = fixture();
  for (const payload of [JSON.parse('{"action":"bootstrap","__proto__":{"polluted":true}}'), { action: 'feed', category: { $ne: null } }, { action: 'bootstrap', 'constructor.prototype': 'bad' }]) assert.equal((await server.app(payload, { OPENID: 'alice' })).code, 'INVALID');
  let nested = {};
  for (let index = 0; index < 40; index += 1) nested = { child: nested };
  assert.equal((await server.call('bootstrap', { nested })).code, 'INVALID');
  assert.equal({}.polluted, undefined);
});

for (const status of ['pending', 'accepted', 'completed', 'cancelled']) {
  test(`cloud deletion removes a ${status} meal document and frees the same reservation`, async () => {
    const server = fixture();
    let current = await family(server);
    current = await success(server.command('saveRecipe', [recipe], current.revision));
    current = await success(server.command('addStock', [{ name: '白菜', quantity: 400, unit: 'g', location: '冷藏', expiresOn: '' }], current.revision));
    const cart = { [current.snapshot.recipes[0].id]: 1 };
    const selection = { date: '2026-09-09', meal: '晚餐' };
    current = await success(server.command('submitOrder', [cart, selection], current.revision));
    const orderId = current.snapshot.orders[0].id;
    const documentId = digest(`${current.familyId}:${orderId}`);
    if (status === 'pending') {
      const document = await server.repository.get('orders', documentId);
      await server.repository.set('orders', documentId, { ...document, value: { ...document.value, status } });
      current = await success(server.call('bootstrap', { includeFeed: false }));
    } else if (status !== 'accepted') current = await success(server.command('updateOrder', [orderId, status], current.revision));
    if (status === 'completed') assert.equal((await server.command('submitOrder', [cart, selection], current.revision)).ok, false);
    const before = structuredClone(current);
    const removed = await success(server.call('command', { name: 'removeOrder', args: [orderId], revision: current.revision, familyId: current.familyId, requestId: `delete-${status}-0001`, responseMode: 'changes' }));
    assert.equal(removed.value, orderId);
    assert.equal(removed.revision, before.revision + 1);
    assert.deepEqual(removed.changes.orders, []);
    assert.equal(removed.changes.inventory, undefined);
    assert.equal(removed.changes.recipes, undefined);
    assert.equal(await server.repository.get('orders', documentId), null);
    current = await success(server.call('bootstrap', { includeFeed: false }));
    assert.deepEqual(current.snapshot.orders, []);
    assert.deepEqual(current.snapshot.inventory, before.snapshot.inventory);
    assert.deepEqual(current.snapshot.recipes, before.snapshot.recipes);
    current = await success(server.command('submitOrder', [cart, selection], current.revision));
    assert.equal(current.snapshot.orders.length, 1);
    assert.notEqual(current.snapshot.orders[0].id, orderId);
    assert.equal(current.snapshot.orders[0].status, 'accepted');
    assert.equal(current.snapshot.orders[0].date, selection.date);
    assert.equal(current.snapshot.orders[0].meal, selection.meal);
  });
}

test('cloud deletion preserves other meals and updates shared purchase links in the same transaction', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  current = await success(server.command('submitOrder', [cart, { date: '2026-09-09', meal: '午餐' }], current.revision));
  const deletedId = current.snapshot.orders[0].id;
  current = await success(server.command('submitOrder', [cart, { date: '2026-09-09', meal: '晚餐' }], current.revision));
  const retained = current.snapshot.orders.find(order => order.id !== deletedId);
  for (const purchase of [
    { id: 'exclusive-purchase', name: '白菜', quantity: 100, unit: 'g', orderIds: [deletedId] },
    { id: 'shared-purchase', name: '牛肉', quantity: 400, unit: 'g', orderIds: [deletedId, retained.id] },
  ]) await server.repository.set('purchases', digest(`${current.familyId}:${purchase.id}`), { familyId: current.familyId, value: purchase });
  const deleted = await success(server.call('command', { name: 'removeOrder', args: [deletedId], revision: current.revision, requestId: 'delete-shared-purchase-0001', responseMode: 'changes' }));
  assert.deepEqual(deleted.changes.orders, [retained]);
  assert.equal(deleted.changes.purchases.length, 1);
  assert.deepEqual(deleted.changes.purchases[0].orderIds, [retained.id]);
  assert.equal(await server.repository.get('purchases', digest(`${current.familyId}:exclusive-purchase`)), null);
  assert.deepEqual((await server.repository.get('purchases', digest(`${current.familyId}:shared-purchase`))).value.orderIds, [retained.id]);
});

test('stale and duplicate deletion cannot remove a newly rebooked meal', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  const cart = { [current.snapshot.recipes[0].id]: 1 };
  const selection = { date: '2026-09-09', meal: '晚餐' };
  current = await success(server.command('submitOrder', [cart, selection], current.revision));
  const deletedId = current.snapshot.orders[0].id;
  assert.equal((await server.command('removeOrder', [deletedId], current.revision - 1)).code, 'CONFLICT');
  const payload = { name: 'removeOrder', args: [deletedId], revision: current.revision, familyId: current.familyId, requestId: 'delete-replay-0001', responseMode: 'changes' };
  const outcomes = await Promise.all([server.call('command', payload), server.call('command', { ...payload, requestId: 'delete-concurrent-0001' })]);
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[1].code, 'CONFLICT');
  current = await success(server.command('submitOrder', [cart, selection], outcomes[0].data.revision));
  const rebooked = structuredClone(current.snapshot.orders);
  const replay = await success(server.call('command', payload));
  assert.equal(replay.value, deletedId);
  assert.equal(replay.revision, current.revision);
  assert.deepEqual(replay.snapshot.orders, rebooked);
  assert.equal((await server.command('removeOrder', [deletedId], current.revision)).code, 'CONFLICT');
  assert.deepEqual((await success(server.call('bootstrap', { includeFeed: false }))).snapshot.orders, rebooked);
});

test('only current family members can delete a meal, including a joined member', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  current = await success(server.command('submitOrder', [{ [current.snapshot.recipes[0].id]: 1 }, { date: '2026-09-09', meal: '晚餐' }], current.revision));
  const orderId = current.snapshot.orders[0].id;
  assert.equal((await server.command('removeOrder', [orderId], current.revision, 'outsider')).code, 'NO_FAMILY');
  const other = await family(server, 'other-family');
  assert.equal((await server.call('command', { name: 'removeOrder', args: [orderId], revision: other.revision, familyId: current.familyId, requestId: 'delete-forged-family-0001' }, 'other-family')).code, 'CONFLICT');
  assert.equal((await server.command('removeOrder', [orderId], other.revision, 'other-family')).code, 'CONFLICT');
  const invite = await success(server.call('createInvite'));
  current = await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  await success(server.call('removeMember', { memberId: digest('bob') }));
  assert.equal((await server.command('removeOrder', [orderId], current.revision, 'bob')).code, 'NO_FAMILY');
  const refreshedInvite = await success(server.call('createInvite'));
  current = await success(server.call('joinFamily', { code: refreshedInvite.code, name: 'Carol' }, 'carol'));
  const result = await success(server.command('removeOrder', [orderId], current.revision, 'carol'));
  assert.deepEqual(result.snapshot.orders, []);
  assert.equal(await server.repository.get('orders', digest(`${current.familyId}:${orderId}`)), null);
});

test('deleting old meal history needs a valid record id but not a current reservation date', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  current = await success(server.command('submitOrder', [{ [current.snapshot.recipes[0].id]: 1 }, { date: '2026-09-09', meal: '晚餐' }], current.revision));
  const order = current.snapshot.orders[0];
  const documentId = digest(`${current.familyId}:${order.id}`);
  await server.repository.set('orders', documentId, { familyId: current.familyId, value: { ...order, status: 'completed', date: '2026-08-01' } });
  for (const invalidId of ['', null, {}, '../order', 'invalid'.repeat(40)]) assert.equal((await server.command('removeOrder', [invalidId], current.revision)).code, 'INVALID');
  assert.ok(await server.repository.get('orders', documentId));
  const result = await success(server.command('removeOrder', [order.id], current.revision));
  assert.deepEqual(result.snapshot.orders, []);
});

test('failed persistence rolls back both deletion and linked purchase cleanup', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe], current.revision));
  current = await success(server.command('submitOrder', [{ [current.snapshot.recipes[0].id]: 1 }, { date: '2026-09-09', meal: '晚餐' }], current.revision));
  const order = current.snapshot.orders[0];
  const documentId = digest(`${current.familyId}:${order.id}`);
  const purchaseId = digest(`${current.familyId}:related-purchase`);
  await server.repository.set('purchases', purchaseId, { familyId: current.familyId, value: { id: 'related-purchase', name: '白菜', quantity: 100, unit: 'g', orderIds: [order.id] } });
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(db => callback({ ...db, async remove(collection, id) { if (collection === 'purchases') throw new Error('暂时无法保存'); return db.remove(collection, id); } }));
  const result = await server.command('removeOrder', [order.id], current.revision);
  assert.equal(result.ok, false);
  assert.deepEqual((await server.repository.get('orders', documentId)).value, order);
  assert.ok(await server.repository.get('purchases', purchaseId));
  assert.equal((await server.repository.get('families', current.familyId)).revision, current.revision);
  server.repository.transaction = transaction;
  const retried = await success(server.command('removeOrder', [order.id], current.revision));
  assert.deepEqual(retried.snapshot.orders, []);
  assert.deepEqual(retried.snapshot.purchases, []);
});

test('cloud restoration persists the original meal and preparation without touching inventory', async () => {
  const { server, current, orderId, documentId } = await cancelledCloudMeal({ prepared: true });
  const stored = await server.repository.get('orders', documentId);
  const original = stored.value;
  const before = await success(server.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(shoppingMeals(before.snapshot, '2026-09-09'), []);
  const restored = await success(server.call('command', { name: 'updateOrder', args: [orderId, 'accepted'], revision: current.revision, requestId: 'restore-kept-preparation-0001', responseMode: 'changes' }));
  assert.deepEqual(restored.changes.orders, [{ ...original, status: 'accepted' }]);
  assert.deepEqual((await server.repository.get('orders', documentId)).value, { ...original, status: 'accepted' });
  const refreshed = await success(server.call('bootstrap', { includeFeed: false }));
  assert.deepEqual(refreshed.snapshot.orders, restored.changes.orders);
  assert.deepEqual(refreshed.snapshot.inventory, before.snapshot.inventory);
  assert.deepEqual(refreshed.snapshot.purchases, before.snapshot.purchases);
  assert.equal(shoppingMeals(refreshed.snapshot, '2026-09-09').length, 1);
  assert.equal(shoppingMeals(refreshed.snapshot, '2026-09-09')[0].dishes[0].prepared, true);
  assert.equal(shoppingMeals(refreshed.snapshot, '2026-09-09')[0].dishes[0].note, '另带葱');
});

for (const status of ['pending', 'accepted', 'completed']) {
  test(`cloud restoration rejects a conflicting ${status} reservation transactionally`, async () => {
    const { server, current, orderId, cart, selection } = await cancelledCloudMeal();
    const rebooked = await success(server.command('submitOrder', [cart, selection], current.revision));
    const otherOrder = rebooked.snapshot.orders.find(order => order.id !== orderId);
    const documentId = digest(`${rebooked.familyId}:${otherOrder.id}`);
    const stored = await server.repository.get('orders', documentId);
    await server.repository.set('orders', documentId, { ...stored, value: { ...stored.value, status } });
    const before = await success(server.call('bootstrap', { includeFeed: false }));
    const result = await server.command('updateOrder', [orderId, 'accepted'], before.revision);
    assert.equal(result.code, 'CONFLICT');
    assert.match(result.message, /不能重复恢复/);
    const after = await success(server.call('bootstrap', { includeFeed: false }));
    assert.equal(after.revision, before.revision);
    assert.deepEqual(after.snapshot.orders, before.snapshot.orders);
  });
}

test('stale, racing and replayed restoration cannot reopen a meal after it is cancelled again', async () => {
  const { server, current, orderId } = await cancelledCloudMeal();
  assert.equal((await server.command('updateOrder', [orderId, 'accepted'], current.revision - 1)).code, 'CONFLICT');
  const payload = { name: 'updateOrder', args: [orderId, 'accepted'], revision: current.revision, requestId: 'restore-replay-0001', familyId: current.familyId };
  const outcomes = await Promise.all([server.call('command', payload), server.call('command', { ...payload, requestId: 'restore-racing-0001' })]);
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[1].code, 'CONFLICT');
  const cancelledAgain = await success(server.command('updateOrder', [orderId, 'cancelled'], outcomes[0].data.revision));
  const replay = await success(server.call('command', payload));
  assert.equal(replay.revision, cancelledAgain.revision);
  assert.deepEqual(replay.snapshot.orders, cancelledAgain.snapshot.orders);
  assert.equal(replay.snapshot.orders[0].status, 'cancelled');
});

test('cloud restoration is restricted to the current family and works for joined members', async () => {
  const { server, current, orderId, documentId } = await cancelledCloudMeal();
  assert.equal((await server.command('updateOrder', [orderId, 'accepted'], current.revision, 'outsider')).code, 'NO_FAMILY');
  const other = await family(server, 'other-family');
  assert.equal((await server.call('command', { name: 'updateOrder', args: [orderId, 'accepted'], revision: other.revision, familyId: current.familyId, requestId: 'restore-forged-family-0001' }, 'other-family')).code, 'CONFLICT');
  assert.equal((await server.command('updateOrder', [orderId, 'accepted'], other.revision, 'other-family')).ok, false);
  const invite = await success(server.call('createInvite'));
  const joined = await success(server.call('joinFamily', { code: invite.code, name: 'Bob' }, 'bob'));
  await success(server.call('removeMember', { memberId: digest('bob') }));
  assert.equal((await server.command('updateOrder', [orderId, 'accepted'], joined.revision, 'bob')).code, 'NO_FAMILY');
  const nextInvite = await success(server.call('createInvite'));
  const member = await success(server.call('joinFamily', { code: nextInvite.code, name: 'Carol' }, 'carol'));
  const restored = await success(server.command('updateOrder', [orderId, 'accepted'], member.revision, 'carol'));
  assert.equal(restored.snapshot.orders[0].status, 'accepted');
  assert.equal((await server.repository.get('orders', documentId)).value.status, 'accepted');
});

test('cloud restoration retains the reservation window and never reopens a completed meal', async () => {
  const { server, current, orderId, documentId } = await cancelledCloudMeal();
  const stored = await server.repository.get('orders', documentId);
  for (const changes of [{ date: '2026-09-08' }, { date: '2026-09-12' }, { status: 'completed' }]) {
    const order = { ...stored.value, ...changes };
    await server.repository.set('orders', documentId, { ...stored, value: order });
    const result = await server.command('updateOrder', [orderId, 'accepted'], current.revision);
    assert.equal(result.ok, false);
    assert.deepEqual((await server.repository.get('orders', documentId)).value, order);
    assert.equal((await server.repository.get('families', current.familyId)).revision, current.revision);
  }
});

test('failed cloud restoration rolls back the status and can be retried safely', async () => {
  const { server, current, orderId, documentId } = await cancelledCloudMeal();
  const stored = await server.repository.get('orders', documentId);
  const transaction = server.repository.transaction;
  server.repository.transaction = callback => transaction(db => callback({ ...db, async set(collection, id, value) { if (collection === 'orders') throw new Error('暂时无法保存'); return db.set(collection, id, value); } }));
  const result = await server.command('updateOrder', [orderId, 'accepted'], current.revision);
  assert.equal(result.ok, false);
  assert.deepEqual((await server.repository.get('orders', documentId)).value, stored.value);
  assert.equal((await server.repository.get('families', current.familyId)).revision, current.revision);
  server.repository.transaction = transaction;
  const retried = await success(server.command('updateOrder', [orderId, 'accepted'], current.revision));
  assert.equal(retried.snapshot.orders[0].status, 'accepted');
});
