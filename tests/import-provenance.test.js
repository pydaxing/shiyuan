import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportProvenance } from '../src/services/import-provenance.js';
import { createPersistentCache } from '../src/services/persistent-cache.js';
import { matchesImportedSource } from '../src/domain/kitchen.js';

const scope = 'cloud:kitchen:member-a:target-family';
const clone = value => structuredClone(value);
const post = (familyId = 'source-family', id = 'post-a') => ({ id, familyId, kind: 'dish', recipes: [{ id: 'shared-recipe' }] });
const recipe = (sourceId = 'shared-recipe', extra = {}) => ({ id: `import-${sourceId}`, sourceId, title: '香煎鸡胸肉', ...extra });
const snapshot = (recipes = [], mealSets = [], familyId = 'target-family') => ({ family: { id: familyId }, recipes, mealSets, posts: [], inventory: [] });
function setup() {
  const cache = new Map();
  return { cache, provenance: createImportProvenance({ cache }) };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('a successful legacy import records only its actual added ID and completes strict provenance immutably', () => {
  const { cache, provenance } = setup();
  const existing = { id: 'local-recipe', title: '原有菜品' };
  const before = freeze(snapshot([existing]));
  const next = freeze(snapshot([existing, recipe()]));
  assert.equal(matchesImportedSource(next.recipes[1], 'shared-recipe', post()), false);
  assert.equal(provenance.record(scope, before, next, post()), 1);
  assert.deepEqual(cache.get(scope).entries, [{ field: 'recipes', id: 'import-shared-recipe', sourceId: 'shared-recipe', sourceFamilyId: 'source-family', sourcePostId: 'post-a' }]);
  const applied = provenance.apply(scope, next);
  assert.notEqual(applied, next);
  assert.notEqual(applied.recipes, next.recipes);
  assert.equal(applied.recipes[0], existing);
  assert.equal(applied.mealSets, next.mealSets);
  assert.equal(applied.inventory, next.inventory);
  assert.equal(next.recipes[1].sourceFamilyId, undefined);
  assert.equal(applied.recipes[1].shareId, undefined);
  assert.equal(matchesImportedSource(applied.recipes[1], 'shared-recipe', post()), true);
  assert.equal(provenance.apply(scope, applied), applied);
});

test('a later raw bootstrap restores known provenance without inferring anything for unknown records', () => {
  const { provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const bootstrap = snapshot([recipe(), recipe('unknown-source')]);
  const restored = provenance.apply(scope, bootstrap);
  assert.equal(restored.recipes[0].sourceFamilyId, 'source-family');
  assert.equal(restored.recipes[1], bootstrap.recipes[1]);
  assert.equal(restored.recipes[1].sourceFamilyId, undefined);
});

test('provenance survives an application restart through the injected persistent cache', () => {
  const storage = new Map();
  const platform = () => ({ getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) });
  const cache = () => createPersistentCache('test-import-provenance', { platform });
  createImportProvenance({ cache: cache() }).record(scope, snapshot(), snapshot([recipe()]), post());
  const restarted = createImportProvenance({ cache: cache() });
  assert.equal(restarted.apply(scope, snapshot([recipe()])).recipes[0].sourcePostId, 'post-a');
});

test('scope and target-family isolation prevent another account or family from inheriting a receipt', () => {
  const { provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  for (const otherScope of ['cloud:kitchen:member-b:target-family', 'cloud:kitchen:member-a:other-family']) {
    const raw = snapshot([recipe()]);
    assert.equal(provenance.apply(otherScope, raw), raw);
  }
  const wrongFamily = snapshot([recipe()], [], 'other-family');
  assert.equal(provenance.apply(scope, wrongFamily), wrongFamily);
  assert.equal(provenance.record(scope, snapshot(), wrongFamily, post()), 0);
});

test('a reused source ID already present before the command cannot be reassigned to another source family', () => {
  const { provenance } = setup();
  const before = snapshot([recipe()]);
  assert.equal(provenance.record(scope, before, clone(before), post('another-source', 'post-b')), 0);
  assert.equal(provenance.apply(scope, before), before);
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const known = provenance.apply(scope, snapshot([recipe()]));
  assert.equal(provenance.record(scope, known, clone(known), post('another-source', 'post-b')), 0);
  assert.equal(matchesImportedSource(provenance.apply(scope, snapshot([recipe()])).recipes[0], 'shared-recipe', post('another-source', 'post-b')), false);
});

test('a failed command with no record call cannot create provenance from a legacy snapshot', () => {
  const { cache, provenance } = setup();
  const raw = snapshot([recipe()]);
  assert.equal(provenance.apply(scope, raw), raw);
  assert.equal(cache.size, 0);
  assert.equal(matchesImportedSource(raw.recipes[0], 'shared-recipe', post()), false);
});

test('observed deletion invalidates the receipt before the same legacy ID is recreated', () => {
  const { cache, provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const deleted = snapshot();
  assert.equal(provenance.apply(scope, deleted), deleted);
  assert.equal(cache.size, 0);
  const recreated = snapshot([recipe()]);
  assert.equal(provenance.apply(scope, recreated), recreated);
  assert.equal(provenance.record(scope, deleted, recreated, post('another-source', 'post-b')), 1);
  assert.equal(provenance.apply(scope, recreated).recipes[0].sourceFamilyId, 'another-source');
});

for (const conflict of [
  { sourceId: 'different-source' }, { sourceFamilyId: 'different-family' },
  { sourcePostId: 'different-post' },
  { sourceFamilyId: null }, { sourcePostId: '' },
]) {
  test(`an explicit conflicting source field invalidates the receipt: ${JSON.stringify(conflict)}`, () => {
    const { cache, provenance } = setup();
    provenance.record(scope, snapshot(), snapshot([recipe()]), post());
    const changed = freeze(snapshot([recipe('shared-recipe', conflict)]));
    assert.equal(provenance.apply(scope, changed), changed);
    assert.equal(cache.size, 0);
    const legacyAgain = snapshot([recipe()]);
    assert.equal(provenance.apply(scope, legacyAgain), legacyAgain);
  });
}

test('matching existing provenance can be retained while only its missing field is restored', () => {
  const { provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  for (const partial of [{ sourceFamilyId: 'source-family' }, { sourcePostId: 'post-a' }]) {
    const raw = freeze(snapshot([recipe('shared-recipe', partial)]));
    const restored = provenance.apply(scope, raw).recipes[0];
    assert.equal(restored.sourceFamilyId, 'source-family');
    assert.equal(restored.sourcePostId, 'post-a');
  }
});

test('editing a known imported recipe keeps its provenance when its independent sharing identity changes', () => {
  const { cache, provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const edited = freeze(snapshot([recipe('shared-recipe', { title: '我家调整过的鸡胸肉', shareId: 'new-sharing-identity' })]));
  const applied = provenance.apply(scope, edited);
  assert.equal(applied.recipes[0].title, edited.recipes[0].title);
  assert.equal(applied.recipes[0].shareId, 'new-sharing-identity');
  assert.equal(matchesImportedSource(applied.recipes[0], 'shared-recipe', post()), true);
  assert.equal(cache.get(scope).entries.length, 1);
  const restarted = createImportProvenance({ cache });
  const bootstrap = snapshot([recipe('shared-recipe', { shareId: 'changed-sharing-identity' })]);
  assert.equal(restarted.apply(scope, bootstrap).recipes[0].sourcePostId, 'post-a');
  assert.equal(bootstrap.recipes[0].sourcePostId, undefined);
});

test('editing a known imported menu keeps its source without reverting its name, sharing identity, or membership', () => {
  const { cache, provenance } = setup();
  const collection = { ...post(), kind: 'menu', recipes: [{ id: 'first-source' }, { id: 'second-source' }] };
  const recipes = [recipe('first-source'), recipe('second-source')];
  const initialSet = { id: 'set-random-123', sourceId: 'post-a', title: '原套餐', recipeIds: recipes.map(entry => entry.id) };
  provenance.record(scope, snapshot(), snapshot(recipes, [initialSet]), collection);
  const editedSet = { ...initialSet, title: '本家套餐', shareId: 'new-set-share', recipeIds: [...initialSet.recipeIds].reverse() };
  const edited = freeze(snapshot(recipes, [editedSet]));
  const applied = provenance.apply(scope, edited).mealSets[0];
  assert.equal(applied.title, editedSet.title);
  assert.equal(applied.shareId, editedSet.shareId);
  assert.equal(applied.recipeIds, editedSet.recipeIds);
  assert.equal(matchesImportedSource(applied, collection.id, collection), true);
  const restarted = createImportProvenance({ cache });
  assert.equal(restarted.apply(scope, edited).mealSets[0].sourceFamilyId, 'source-family');
});

test('record skips partial modern provenance, nonlegacy IDs, unrelated additions, and duplicate IDs', () => {
  const { cache, provenance } = setup();
  for (const extra of [{ sourceFamilyId: 'source-family' }, { sourcePostId: 'post-a' }, { shareId: 'share-a' }, { sourceFamilyId: '' }, { sourcePostId: null }, { id: 'independent-modern-id' }]) {
    assert.equal(provenance.record(scope, snapshot(), snapshot([recipe('shared-recipe', extra)]), post()), 0);
  }
  assert.equal(provenance.record(scope, snapshot(), snapshot([recipe('unrelated')]), post()), 0);
  assert.equal(provenance.record(scope, snapshot(), snapshot([recipe(), recipe()]), post()), 0);
  assert.equal(cache.size, 0);
});

test('a menu records its new random set ID and only newly added legacy recipes alongside modern or preexisting entries', () => {
  const { cache, provenance } = setup();
  const collection = { ...post(), kind: 'menu', recipes: [{ id: 'modern-source' }, { id: 'legacy-source' }, { id: 'existing-source' }] };
  const modern = { id: 'modern-copy', sourceId: 'modern-source', shareId: 'shared-copy', sourceFamilyId: 'source-family', sourcePostId: 'post-a' };
  const existing = recipe('existing-source');
  const set = { id: 'set-random-123', sourceId: 'post-a', title: '周末套餐', recipeIds: ['modern-copy', 'import-legacy-source', 'import-existing-source'] };
  const next = freeze(snapshot([modern, recipe('legacy-source'), existing], [set]));
  assert.equal(provenance.record(scope, snapshot([modern, existing]), next, collection), 2);
  assert.deepEqual(cache.get(scope).entries.map(entry => [entry.field, entry.id]), [['recipes', 'import-legacy-source'], ['mealSets', 'set-random-123']]);
  const restored = provenance.apply(scope, next);
  assert.equal(restored.recipes[0], modern);
  assert.equal(restored.recipes[1].sourceFamilyId, 'source-family');
  assert.equal(restored.recipes[2], existing);
  assert.equal(existing.sourceFamilyId, undefined);
  assert.equal(restored.mealSets[0].sourcePostId, 'post-a');
  assert.equal(matchesImportedSource(restored.mealSets[0], collection.id, collection), true);
  assert.equal(restored.mealSets[0].recipeIds, set.recipeIds);
  const deletedSet = snapshot(next.recipes);
  provenance.apply(scope, deletedSet);
  assert.deepEqual(cache.get(scope).entries.map(entry => entry.field), ['recipes']);
});

test('a preexisting or unrelated menu set never receives the new collection provenance', () => {
  const { provenance } = setup();
  const collection = { ...post(), kind: 'menu' };
  const existing = { id: 'set-existing', sourceId: 'post-a', recipeIds: [] };
  const unrelated = { id: 'set-new-unrelated', sourceId: 'post-b', recipeIds: [] };
  const next = snapshot([], [existing, unrelated]);
  assert.equal(provenance.record(scope, snapshot([], [existing]), next, collection), 0);
  assert.equal(provenance.apply(scope, next), next);
});

test('missing source identity or an incomplete snapshot provides no proof and does not erase saved receipts', () => {
  const { cache, provenance } = setup();
  assert.equal(provenance.record('', snapshot(), snapshot([recipe()]), post()), 0);
  assert.equal(provenance.record(scope, snapshot(), snapshot([recipe()]), { ...post(), familyId: undefined }), 0);
  assert.equal(provenance.record(scope, snapshot(), snapshot([recipe()]), { ...post(), recipes: [{ id: 'same' }, { id: 'same' }] }), 0);
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const partial = { family: { id: 'target-family' }, recipes: [] };
  assert.equal(provenance.apply(scope, partial), partial);
  assert.equal(cache.size, 1);
});

test('malformed or duplicated stored receipts fail closed', () => {
  const { cache, provenance } = setup();
  provenance.record(scope, snapshot(), snapshot([recipe()]), post());
  const valid = clone(cache.get(scope));
  for (const saved of [{ ...valid, scope: 'other-scope' }, { ...valid, entries: [...valid.entries, ...valid.entries] }, { ...valid, entries: [{ ...valid.entries[0], id: 'wrong-id' }] }]) {
    cache.set(scope, saved);
    const raw = snapshot([recipe()]);
    assert.equal(provenance.apply(scope, raw), raw);
    assert.equal(cache.size, 0);
  }
});
