import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';
import { getShoppingRequirements, UNITS } from '../src/domain/kitchen.js';
import { INGREDIENT_UNITS_VERSION } from '../src/domain/ingredient-units.js';

const today = '2026-09-10';
const clock = Date.parse(`${today}T03:00:00Z`);
const seedRecipe = createSeed().recipes[0];
const salt = { name: '盐', quantity: null, unit: '', amountText: '适量' };
const tomato = { name: '番茄', quantity: 200, unit: 'g' };
const digest = value => createHash('sha256').update(value).digest('hex');
const recipe = (ingredients = [tomato, salt]) => ({ ...structuredClone(seedRecipe), ingredients: structuredClone(ingredients) });
const confirmation = (overrides = {}) => ({ kind: 'confirmation', ...salt, ...overrides });
const stock = (name, quantity) => ({ name, quantity, unit: 'g', location: '常温', image: '', expiresOn: '' });

function fixture(overrides = {}) {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => clock, signFiles: async ids => Object.fromEntries(ids.map(id => [id, `signed:${id}`])), storeImage: async fileId => fileId, ...overrides });
  let sequence = 0;
  const call = (action, payload = {}, openid = 'alice') => app({ action, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, ...payload }, { OPENID: openid });
  const command = (name, args, revision, openid = 'alice', requestId = `text-amount-request-${++sequence}`) => call('command', { name, args, revision, requestId }, openid);
  return { repository, call, command };
}

async function success(promise) {
  const result = await promise;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

const family = (server, openid = 'alice') => success(server.call('createFamily', { name: openid, familyName: `${openid}的小家` }, openid));
const bootstrap = (server, openid = 'alice') => success(server.call('bootstrap', { includeFeed: false }, openid));
const stored = async (server, collection, familyId) => (await server.repository.list(collection, { familyId })).map(row => row.value);

async function orderedKitchen(server, { ingredients, fridge = false, openid = 'alice' } = {}) {
  let current = await family(server, openid);
  if (fridge) current = await success(server.command('setFeature', ['fridge', true], current.revision, openid));
  current = await success(server.command('saveRecipe', [recipe(ingredients)], current.revision, openid));
  return success(server.command('submitOrder', [{ [current.snapshot.recipes[0].id]: 1 }, { date: today, meal: '晚餐' }], current.revision, openid));
}

function assertTextRequirement(snapshot, needsConfirmation, date = today) {
  const required = getShoppingRequirements(snapshot, date).find(item => item.amountText === salt.amountText);
  assert.ok(required);
  assert.equal(required.name, salt.name);
  assert.equal(required.unit, '');
  assert.equal(required.needsConfirmation, needsConfirmation);
  for (const field of ['quantity', 'available', 'missing', 'toBuy']) assert.equal(required[field], null, field);
}

test('cloud saves and edits text amounts without coercing numeric ingredients or losing them on bootstrap', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe()], current.revision));
  const recipeId = current.snapshot.recipes[0].id;
  assert.deepEqual(current.snapshot.recipes[0].ingredients, [tomato, salt]);
  assert.deepEqual((await stored(server, 'recipes', current.familyId)), current.snapshot.recipes);
  assert.deepEqual((await bootstrap(server)).snapshot.recipes, current.snapshot.recipes);

  for (const ingredient of [
    { ...salt, amountText: '少许' },
    { name: '盐', quantity: 3, unit: 'g' },
    salt,
  ]) {
    current = await success(server.command('saveRecipe', [recipe([tomato, ingredient]), recipeId], current.revision));
    const restored = await bootstrap(server);
    assert.equal(restored.snapshot.recipes.length, 1);
    assert.equal(restored.snapshot.recipes[0].id, recipeId);
    assert.deepEqual(restored.snapshot.recipes[0].ingredients, [tomato, ingredient]);
    assert.deepEqual(await stored(server, 'recipes', current.familyId), restored.snapshot.recipes);
  }
});

test('cloud persists every expanded unit and edits numeric, preset and custom amounts interchangeably', async () => {
  const server = fixture();
  let current = await family(server);
  const ingredients = UNITS.map((unit, index) => ({ name: `食材${index + 1}`, quantity: 0.5, unit }));
  current = await success(server.command('saveRecipe', [recipe(ingredients.slice(0, 30))], current.revision));
  assert.deepEqual((await bootstrap(server)).snapshot.recipes[0].ingredients, ingredients.slice(0, 30));
  const recipeId = current.snapshot.recipes[0].id;
  for (let offset = 30; offset < ingredients.length; offset += 30) {
    const batch = ingredients.slice(offset, offset + 30);
    current = await success(server.command('saveRecipe', [recipe(batch), recipeId], current.revision));
    assert.deepEqual((await bootstrap(server)).snapshot.recipes[0].ingredients, batch);
  }
  for (const ingredient of [salt, { ...salt, amountText: '半茶匙' }, { name: '啤酒', quantity: 0.5, unit: '瓶' }]) {
    current = await success(server.command('saveRecipe', [recipe([ingredient]), recipeId], current.revision));
    assert.deepEqual((await bootstrap(server)).snapshot.recipes[0].ingredients, [ingredient]);
  }
});

test('public post detail and another family import preserve server-owned text amounts', async () => {
  const server = fixture();
  let alice = await family(server);
  alice = await success(server.command('saveRecipe', [recipe()], alice.revision));
  const sourceId = alice.snapshot.recipes[0].id;
  alice = await success(server.command('publishToCommunity', [sourceId, 'dish'], alice.revision));
  const postId = alice.value;
  const detail = await success(server.call('readPost', { postId, paginateComments: true }));
  assert.deepEqual(detail.post.recipes[0].ingredients, [tomato, salt]);
  const publicRecord = await server.repository.get('posts', postId);
  assert.equal(publicRecord.status, 'published');
  assert.deepEqual(publicRecord.recipes[0].ingredients, [tomato, salt]);

  let bob = await family(server, 'bob');
  bob = await success(server.command('addCollection', [{ id: postId, recipes: [recipe([{ ...salt, amountText: '客户端伪造' }])] }], bob.revision, 'bob'));
  assert.notEqual(bob.familyId, alice.familyId);
  assert.equal(bob.value, 1);
  assert.deepEqual(bob.snapshot.recipes[0].ingredients, [tomato, salt]);
  assert.deepEqual(await stored(server, 'recipes', bob.familyId), bob.snapshot.recipes);
  bob = await success(server.command('submitOrder', [{ [bob.snapshot.recipes[0].id]: 1 }, { date: today, meal: '午餐' }], bob.revision, 'bob'));
  assert.deepEqual(bob.snapshot.orders[0].items[0].recipe.ingredients, [tomato, salt]);
  assertTextRequirement((await bootstrap(server, 'bob')).snapshot, true);

  await success(server.command('saveRecipe', [recipe([{ ...salt, amountText: '少许' }]), sourceId], alice.revision));
  assert.deepEqual((await bootstrap(server, 'bob')).snapshot.recipes[0].ingredients, [tomato, salt]);
  assert.deepEqual((await success(server.call('readPost', { postId }))).post.recipes[0].ingredients, [tomato, salt]);
});

test('cloud orders retain ingredient snapshots and expose null unknown amounts after recipe edits', async () => {
  const server = fixture();
  let current = await orderedKitchen(server);
  const order = current.snapshot.orders[0];
  assert.equal(order.status, 'accepted');
  assert.deepEqual(order.items[0].recipe.ingredients, [tomato, salt]);
  assert.deepEqual(order.selections[0].items[0].recipe.ingredients, [tomato, salt]);
  assert.deepEqual(await stored(server, 'orders', current.familyId), current.snapshot.orders);
  current = await success(server.command('saveRecipe', [recipe([{ name: '盐', quantity: 5, unit: 'g' }]), current.snapshot.recipes[0].id], current.revision));
  const restored = await bootstrap(server);
  assert.deepEqual(restored.snapshot.orders[0], order);
  assertTextRequirement(restored.snapshot, true);
  const numeric = getShoppingRequirements(restored.snapshot, today).find(item => item.name === '番茄');
  assert.deepEqual([numeric.quantity, numeric.available, numeric.missing, numeric.toBuy], [200, 0, 200, 200]);
});

for (const fridge of [false, true]) {
  test(`confirmation persists and retries idempotently without altering numeric stock (fridge ${fridge ? 'on' : 'off'})`, async () => {
    const server = fixture();
    let current = await orderedKitchen(server, { fridge, ingredients: [tomato, salt, { name: '盐', quantity: 3, unit: 'g' }] });
    const orderId = current.snapshot.orders[0].id;
    const recipeId = current.snapshot.recipes[0].id;
    for (const batch of [stock('番茄', 500), stock('盐', 20)]) current = await success(server.command('addStock', [batch], current.revision));
    current = await success(server.command('recordPurchase', [stock('盐', 10)], current.revision));
    const before = await bootstrap(server);
    const numericBefore = getShoppingRequirements(before.snapshot, today).filter(item => item.amountText === undefined);
    assertTextRequirement(before.snapshot, true);
    assert.equal(before.snapshot.inventory.length, 2);
    assert.equal(before.snapshot.purchases.length, 1);
    assert.deepEqual(numericBefore.find(item => item.name === '盐').available, 3);

    const requestId = `confirmation-idempotent-${fridge}`;
    const results = await Promise.all([1, 2].map(() => success(server.command('recordPurchase', [confirmation()], before.revision, 'alice', requestId))));
    assert.equal(results[0].revision, before.revision + 1);
    assert.deepEqual(results[1].snapshot, results[0].snapshot);
    current = await bootstrap(server);
    assert.equal(current.revision, before.revision + 1);
    assert.deepEqual(current.snapshot.inventory, before.snapshot.inventory);
    assert.deepEqual(current.snapshot.purchases.filter(item => item.kind !== 'confirmation'), before.snapshot.purchases);
    assert.deepEqual(getShoppingRequirements(current.snapshot, today).filter(item => item.amountText === undefined), numericBefore);
    const confirmations = current.snapshot.purchases.filter(item => item.kind === 'confirmation');
    assert.equal(confirmations.length, 1);
    assert.deepEqual({ ...confirmations[0], id: undefined, signature: undefined }, { ...confirmation(), orderIds: [orderId], id: undefined, signature: undefined });
    assert.deepEqual(JSON.parse(confirmations[0].signature), [[recipeId, 1, 1, 1]]);
    assert.deepEqual(await stored(server, 'purchases', current.familyId), current.snapshot.purchases);
    assert.deepEqual(await stored(server, 'inventory', current.familyId), before.snapshot.inventory);
    assertTextRequirement(current.snapshot, false);
    const receipt = await server.repository.get('requests', digest(`${current.userId}:${requestId}`));
    assert.equal(receipt.familyId, current.familyId);
    assert.equal(receipt.fingerprint, digest(JSON.stringify({ name: 'recordPurchase', args: [confirmation()] })));

    const collision = await server.command('recordPurchase', [confirmation({ amountText: '少许' })], before.revision, 'alice', requestId);
    assert.equal(collision.code, 'CONFLICT');
    assert.deepEqual((await bootstrap(server)).snapshot, current.snapshot);
    const stale = await server.command('recordPurchase', [confirmation()], before.revision);
    assert.equal(stale.code, 'CONFLICT');

    current = await success(server.command('updateOrder', [orderId, 'accepted'], current.revision));
    const completionRevision = current.revision;
    current = await success(server.command('updateOrder', [orderId, 'completed'], completionRevision, 'alice', 'text-amount-completed-once'));
    assert.equal(current.snapshot.orders[0].status, 'completed');
    assert.ok(current.snapshot.orders[0].completedAt);
    assert.deepEqual(current.snapshot.purchases, []);
    assert.deepEqual(await stored(server, 'purchases', current.familyId), []);
    assert.deepEqual(getShoppingRequirements(current.snapshot, today), []);
    assert.deepEqual(current.snapshot.inventory, before.snapshot.inventory);
    const replay = await success(server.command('updateOrder', [orderId, 'completed'], completionRevision, 'alice', 'text-amount-completed-once'));
    assert.equal(replay.revision, current.revision);
    assert.deepEqual(replay.snapshot.inventory, current.snapshot.inventory);
    assert.equal((await server.command('updateOrder', [orderId, 'completed'], current.revision)).code, 'INVALID');
    assert.equal((await server.command('recordPurchase', [confirmation({ orderIds: [orderId], signature: confirmations[0].signature })], current.revision)).code, 'INVALID');
    assert.deepEqual((await bootstrap(server)).snapshot, current.snapshot);
  });
}

test('confirmation scope and signatures come only from matching active meals in the authenticated family', async () => {
  const server = fixture();
  let alice = await orderedKitchen(server);
  const recipeId = alice.snapshot.recipes[0].id;
  const pendingId = alice.snapshot.orders[0].id;
  const ids = {};
  for (const [meal, status] of [['早餐', 'completed'], ['午餐', 'cancelled'], ['宵夜', 'accepted']]) {
    alice = await success(server.command('submitOrder', [{ [recipeId]: 1 }, { date: today, meal }], alice.revision));
    ids[status] = alice.snapshot.orders.find(order => order.meal === meal).id;
    if (status === 'completed') alice = await success(server.command('updateOrder', [ids[status], 'accepted'], alice.revision));
    alice = await success(server.command('updateOrder', [ids[status], status], alice.revision));
  }
  alice = await success(server.command('saveRecipe', [recipe([tomato])], alice.revision));
  const numericId = alice.snapshot.recipes.find(item => item.id !== recipeId).id;
  alice = await success(server.command('submitOrder', [{ [numericId]: 1 }, { date: '2026-09-11', meal: '晚餐' }], alice.revision));
  const bob = await orderedKitchen(server, { openid: 'bob' });
  const forged = confirmation({ id: 'forged-purchase', familyId: bob.familyId, orderIds: [bob.snapshot.orders[0].id, ids.completed, ids.cancelled], signature: 'client-controlled-signature' });
  alice = await success(server.command('recordPurchase', [forged], alice.revision));
  assert.equal(alice.snapshot.purchases.length, 2);
  assert.deepEqual(alice.snapshot.purchases.flatMap(item => item.orderIds).sort(), [pendingId, ids.accepted].sort());
  for (const purchase of alice.snapshot.purchases) {
    assert.notEqual(purchase.id, forged.id);
    assert.equal(purchase.familyId, undefined);
    assert.deepEqual(JSON.parse(purchase.signature), [[recipeId, 1, 1, 1]]);
  }
  assertTextRequirement(alice.snapshot, false);
  assert.deepEqual(await stored(server, 'purchases', alice.familyId), alice.snapshot.purchases);
  assert.deepEqual((await bootstrap(server, 'bob')).snapshot, bob.snapshot);
  assert.deepEqual(await stored(server, 'purchases', bob.familyId), []);
  assert.equal((await server.command('recordPurchase', [forged], alice.revision, 'outsider')).code, 'NO_FAMILY');
});

test('new or changed meal selections require a fresh server confirmation rather than reusing an old signature', async () => {
  const server = fixture();
  let current = await orderedKitchen(server);
  const firstId = current.snapshot.recipes[0].id;
  current = await success(server.command('recordPurchase', [confirmation()], current.revision));
  const oldSignature = current.snapshot.purchases[0].signature;
  current = await success(server.command('saveRecipe', [{ ...recipe([salt]), title: '另一道菜' }], current.revision));
  const secondId = current.snapshot.recipes.find(item => item.id !== firstId).id;
  current = await success(server.command('submitOrder', [{ [firstId]: 1, [secondId]: 1 }, { date: today, meal: '晚餐' }], current.revision));
  assert.equal(current.snapshot.purchases[0].signature, oldSignature);
  assertTextRequirement((await bootstrap(server)).snapshot, true);
  current = await success(server.command('recordPurchase', [confirmation({ signature: oldSignature })], current.revision));
  assert.equal(current.snapshot.purchases.length, 1);
  assert.notEqual(current.snapshot.purchases[0].signature, oldSignature);
  assertTextRequirement(current.snapshot, false);
  current = await success(server.command('submitOrder', [{ [firstId]: 1 }, { date: '2026-09-11', meal: '晚餐' }], current.revision));
  assertTextRequirement((await bootstrap(server)).snapshot, true);
  current = await success(server.command('recordPurchase', [confirmation()], current.revision));
  assert.equal(current.snapshot.purchases.length, 2);
  assert.deepEqual(current.snapshot.purchases.flatMap(item => item.orderIds).sort(), current.snapshot.orders.map(order => order.id).sort());
  assertTextRequirement((await bootstrap(server)).snapshot, false);
});

test('confirmation uses the server China date window, excluding historical and too-distant pending meals', async () => {
  let now = clock;
  const server = fixture({ now: () => now });
  let current = await orderedKitchen(server, { ingredients: [salt] });
  const recipeId = current.snapshot.recipes[0].id;
  current = await success(server.command('submitOrder', [{ [recipeId]: 1 }, { date: '2026-09-12', meal: '晚餐' }], current.revision));
  now += 86400000;
  current = await success(server.command('submitOrder', [{ [recipeId]: 1 }, { date: '2026-09-13', meal: '晚餐' }], current.revision));
  now = clock;
  current = await success(server.command('recordPurchase', [confirmation()], current.revision));
  const idsByDate = Object.fromEntries(current.snapshot.orders.map(order => [order.date, order.id]));
  assert.deepEqual(current.snapshot.purchases.flatMap(item => item.orderIds).sort(), [idsByDate[today], idsByDate['2026-09-12']].sort());
  const historical = current.snapshot.purchases.find(item => item.orderIds.includes(idsByDate[today]));
  now += 86400000;
  assertTextRequirement((await bootstrap(server)).snapshot, true, '2026-09-11');
  current = await success(server.command('recordPurchase', [confirmation({ orderIds: [idsByDate[today]] })], current.revision));
  assert.equal(current.snapshot.purchases.length, 3);
  assert.deepEqual(current.snapshot.purchases.find(item => item.orderIds.includes(idsByDate[today])), historical);
  assert.deepEqual(current.snapshot.purchases.filter(item => item.id !== historical.id).flatMap(item => item.orderIds).sort(), [idsByDate['2026-09-12'], idsByDate['2026-09-13']].sort());
  assertTextRequirement((await bootstrap(server)).snapshot, false, '2026-09-11');
});

test('completing an unconfirmed text-only meal skips unknown deductions and removes its shopping item', async () => {
  const server = fixture();
  let current = await orderedKitchen(server, { fridge: true, ingredients: [salt] });
  current = await success(server.command('addStock', [stock('盐', 20)], current.revision));
  const inventory = current.snapshot.inventory;
  const orderId = current.snapshot.orders[0].id;
  assertTextRequirement(current.snapshot, true);
  current = await success(server.command('updateOrder', [orderId, 'accepted'], current.revision));
  current = await success(server.command('updateOrder', [orderId, 'completed'], current.revision));
  assert.deepEqual(current.snapshot.inventory, inventory);
  assert.deepEqual(current.snapshot.purchases, []);
  assert.deepEqual(getShoppingRequirements((await bootstrap(server)).snapshot, today), []);
});

test('incremental cloud responses preserve text recipes and confirmation changes through completion', async () => {
  const server = fixture();
  let current = await family(server);
  const local = structuredClone(current.snapshot);
  let sequence = 0;
  async function mutate(name, args) {
    const revision = current.revision;
    current = await success(server.call('command', { name, args, revision, requestId: `text-amount-patch-${++sequence}`, responseMode: 'changes' }));
    assert.equal(current.snapshot, undefined);
    assert.equal(current.baseRevision, revision);
    assert.equal(current.revision, revision + 1);
    Object.assign(local, current.changes);
    const restored = await bootstrap(server);
    assert.deepEqual(local, restored.snapshot);
    return current.changes;
  }
  await mutate('saveRecipe', [recipe([salt])]);
  assert.deepEqual(local.recipes[0].ingredients, [salt]);
  await mutate('saveRecipe', [recipe(), local.recipes[0].id]);
  await mutate('addStock', [stock('盐', 20)]);
  const inventory = structuredClone(local.inventory);
  await mutate('submitOrder', [{ [local.recipes[0].id]: 1 }, { date: today, meal: '晚餐' }]);
  assertTextRequirement(local, true);
  const confirmed = await mutate('recordPurchase', [confirmation()]);
  assert.equal(confirmed.purchases.length, 1);
  assert.equal(confirmed.purchases[0].kind, 'confirmation');
  assert.equal(confirmed.inventory, undefined);
  assert.deepEqual(local.inventory, inventory);
  assertTextRequirement(local, false);
  await mutate('updateOrder', [local.orders[0].id, 'accepted']);
  const completed = await mutate('updateOrder', [local.orders[0].id, 'completed']);
  assert.deepEqual(completed.purchases, []);
  assert.deepEqual(local.inventory, inventory);
  assert.deepEqual(getShoppingRequirements(local, today), []);
});

test('text amounts save, edit, confirm and publish directly with idempotent receipts', async () => {
  const server = fixture();
  let current = await family(server);
  current = await success(server.command('saveRecipe', [recipe()], current.revision));
  const recipeId = current.snapshot.recipes[0].id;
  current = await success(server.command('saveRecipe', [recipe([{ ...salt, amountText: '少许' }]), recipeId], current.revision));
  assert.equal(current.snapshot.recipes[0].ingredients[0].amountText, '少许');
  current = await success(server.command('saveRecipe', [recipe(), recipeId], current.revision));
  current = await success(server.command('submitOrder', [{ [recipeId]: 1 }, { date: today, meal: '晚餐' }], current.revision));
  const requestId = 'direct-confirmation-001';
  const revision = current.revision;
  current = await success(server.command('recordPurchase', [confirmation()], revision, 'alice', requestId));
  const replay = await success(server.command('recordPurchase', [confirmation()], revision, 'alice', requestId));
  assert.deepEqual(replay.snapshot, current.snapshot);
  assertTextRequirement(current.snapshot, false);
  const publishId = 'direct-publish-text-001';
  const beforePublish = current.revision;
  current = await success(server.command('publishToCommunity', [recipeId, 'dish'], beforePublish, 'alice', publishId));
  const published = await server.repository.get('posts', current.value);
  assert.equal(published.status, 'published');
  const again = await success(server.command('publishToCommunity', [recipeId, 'dish'], beforePublish, 'alice', publishId));
  assert.equal(again.value, published.id);
  assert.equal((await success(server.call('feed'))).posts.length, 1);
  assert.deepEqual((await success(server.call('readPost', { postId: published.id }))).post.recipes[0].ingredients, [tomato, salt]);
});

test('malformed text amounts are rejected before business writes', async context => {
  const server = fixture();
  const current = await family(server);
  const malformed = [
    ...['', '  ', null, 3, false, [], {}, '量'.repeat(61), '适\n量', '适\u0000量'].map(amountText => ({ ...salt, amountText })),
    ...[0, 1, 'null', undefined].map(quantity => ({ ...salt, quantity })),
    ...['g', undefined].map(unit => ({ ...salt, unit })),
    ...['', '盐'.repeat(31)].map(name => ({ ...salt, name })),
    { name: '盐', quantity: null, unit: '' },
  ];
  for (const [index, ingredient] of malformed.entries()) {
    await context.test(`invalid ingredient ${index + 1}: ${JSON.stringify(ingredient)}`, async () => {
      for (const [name, args] of [
        ['saveRecipe', [recipe([ingredient])]],
        ['recordPurchase', [{ kind: 'confirmation', ...ingredient }]],
      ]) {
        const rejected = await server.command(name, args, current.revision);
        assert.equal(rejected.ok, false, name);
        assert.equal(rejected.code, 'INVALID', JSON.stringify(rejected));
      }
    });
  }
  assert.deepEqual((await bootstrap(server)).snapshot, current.snapshot);
  for (const collection of ['recipes', 'inventory', 'purchases', 'requests']) assert.deepEqual(await server.repository.list(collection), []);
});

test('text amounts cannot enter addStock or implicit purchases, and forged scope cannot create an unmatched confirmation', async () => {
  const server = fixture();
  const current = await family(server);
  for (const batch of [
    { ...stock('盐', 1), ...salt },
    { ...stock('盐', 1), ...confirmation() },
    { ...stock('盐', 1), amountText: '适量' },
    { ...stock('盐', 1), amountText: '' },
    { ...stock('盐', 1), amountText: null },
  ]) assert.equal((await server.command('addStock', [batch], current.revision)).code, 'INVALID');
  for (const batch of [salt, { ...salt, kind: 'purchase' }, { ...salt, kind: 'unknown' }, { kind: 'confirmation', name: '盐', quantity: 1, unit: 'g' }]) {
    assert.equal((await server.command('recordPurchase', [batch], current.revision)).code, 'INVALID');
  }
  assert.equal((await server.command('recordPurchase', [confirmation({ orderIds: ['forged-order'], signature: 'forged-signature' })], current.revision)).code, 'INVALID');
  assert.deepEqual((await bootstrap(server)).snapshot, current.snapshot);
  for (const collection of ['inventory', 'purchases', 'requests']) assert.deepEqual(await server.repository.list(collection), []);
});
