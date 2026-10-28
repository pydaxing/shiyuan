import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAmount, amountNumber, assertStandardIngredient, standardizeIngredient } from '../scripts/ingredient-standardization.mjs';
import { inventoryIngredients, ingredientRecipes, makeIngredientOperation, ingredientUpdate, setIngredientFields, readCollection } from '../scripts/standardize-live-ingredients.mjs';
import { UNITS, normalizedIngredient } from '../src/domain/kitchen.js';

const emptyReview = { amounts: [], groups: [], contextual: [] };
const amount = value => ({ name: '盐', quantity: null, unit: '', amountText: value });
const dish = (ingredients = [amount('1勺')]) => ({ id: 'dish-one', title: '菜品', ingredients, image: 'original-image', steps: [{ text: '保留原做法' }] });
const post = () => ({ _id: 'post-one', kind: 'dish', status: 'published', title: '菜品', recipes: [dish()], importedFamilyCount: 4, author: '原作者' });

test('explicit quantities normalize without assuming spoon or bowl capacities', () => {
  for (const [source, quantity, unit] of [['1勺', 1, '勺'], ['半勺', 0.5, '勺'], ['两勺', 2, '勺'], ['１／２ 茶匙', 0.5, '茶匙'], ['一勺半', 1.5, '勺'], ['1碗半', 1.5, '碗'], ['十二克', 12, 'g'], ['1KG', 1, 'kg'], ['0.5升', 0.5, 'L'], ['1头', 1, '头'], ['3滴', 3, '滴'], ['一小勺', 1, '小勺'], ['一大勺', 1, '大勺']]) {
    assert.deepEqual(canonicalAmount(source), { quantity, unit });
  }
  for (const unit of ['头', '段', '滴', '撮', '盘', '泵', '副', '芽', '小勺', '大勺', '铲勺']) {
    assert.ok(UNITS.includes(unit));
    assert.equal(normalizedIngredient({ name: '食材', quantity: 2, unit }).quantity, 2);
    assert.equal(normalizedIngredient({ name: '食材', quantity: 2, unit }).unit, unit);
  }
});

test('ranges, missing units, arithmetic and conditional values require review', () => {
  for (const source of ['1-2个', '二三个', '两三瓣', '一百克', '四分之一', '原文未注明', '1', '约1勺', '1/0g', '0g', '-1g', '100001g', '0.0001g', 'NaNg', 'Infinityg', '1e3g', '半勺半', '1勺\n']) assert.equal(canonicalAmount(source), null, source);
  for (const source of ['1-2个', '原文未注明', '新出现的描述']) assert.throws(() => standardizeIngredient(amount(source), emptyReview), /尚未复核/);
  assert.equal(amountNumber('三四'), null);
});

test('reviewed presets do not mix text with a numeric quantity or unit', () => {
  const review = { ...emptyReview, groups: [{ from: ['原文未注明'], to: '适量', reason: '用户要求缺少用量时改为适量，不猜测重量' }, { from: ['少量'], to: '少许', reason: '原文明示少量，采用现有固定少许选项' }] };
  assert.deepEqual(standardizeIngredient(amount('原文未注明'), review).ingredients, [amount('适量')]);
  assert.deepEqual(standardizeIngredient(amount('少量'), review).ingredients, [amount('少许')]);
  assert.deepEqual(standardizeIngredient(amount('1勺'), review).ingredients, [{ name: '盐', quantity: 1, unit: '勺' }]);
  assert.throws(() => assertStandardIngredient({ name: '盐', quantity: 1, unit: 'g', amountText: '适量' }));
  assert.throws(() => assertStandardIngredient(amount('自定义')));
  assert.throws(() => assertStandardIngredient({ name: '盐', quantity: '1', unit: 'g' }));
});

test('context corrections use the reviewed ingredient and never apply to unrelated foods', () => {
  const review = { ...emptyReview, contextual: [{ name: '肉末', amountText: '200颗', reason: '已核对原文做法明确写肉末二百克', ingredients: [{ name: '肉末', quantity: 200, unit: 'g' }] }] };
  assert.deepEqual(standardizeIngredient({ ...amount('200颗'), name: '肉末' }, review).ingredients, [{ name: '肉末', quantity: 200, unit: 'g' }]);
  assert.deepEqual(standardizeIngredient({ ...amount('200颗'), name: '花椒' }, review).ingredients, [{ name: '花椒', quantity: 200, unit: '颗' }]);
});

test('nested set and share recipes are included without touching archived source ingredients', () => {
  const set = { ...post(), kind: 'set', recipes: [dish(), { ...dish([amount('少许')]), id: 'dish-two' }] };
  const sources = { recipes: [{ _id: 'private-one', familyId: 'family-one', value: dish() }], posts: [set], imports: [{ _id: 'raw-one', kind: 'unrelated', source: { ingredients: [amount('原文未注明')] } }], shares: [{ _id: 'share-one', post: set }] };
  assert.equal(ingredientRecipes('imports', sources.imports[0]).length, 0);
  const inventory = inventoryIngredients(sources);
  assert.equal(inventory.counts.posts.recipes, 2);
  assert.equal(inventory.counts.shares.recipes, 2);
  assert.equal(inventory.counts.imports.ingredients, 0);
  assert.deepEqual(inventory.configuredUnits, UNITS);
});

test('planned updates change only ingredient arrays and preserve every other field', () => {
  const before = post();
  const operation = makeIngredientOperation('posts', before, emptyReview);
  assert.deepEqual(Object.keys(operation.fields), ['recipes.0.ingredients']);
  assert.deepEqual(operation.after.recipes[0], { ...before.recipes[0], ingredients: [{ name: '盐', quantity: 1, unit: '勺' }] });
  assert.deepEqual(before, post());
  assert.throws(() => setIngredientFields(before, { author: '新作者' }), /禁止修改/);
  assert.throws(() => setIngredientFields(before, { 'recipes.0.steps': [] }), /禁止修改/);
  assert.throws(() => setIngredientFields(before, { '__proto__.ingredients': [] }), /禁止修改/);
});

test('updates are guarded, idempotent, rollback-capable, and preserve concurrent counters', () => {
  const operation = makeIngredientOperation('posts', post(), emptyReview);
  const current = { ...post(), importedFamilyCount: 9 };
  const prepared = ingredientUpdate(operation, current);
  assert.deepEqual(prepared.query['recipes.0.ingredients'], post().recipes[0].ingredients);
  assert.equal(prepared.query._id, 'post-one');
  assert.equal(prepared.query.status, 'published');
  assert.equal(prepared.expected.importedFamilyCount, 9);
  assert.equal(ingredientUpdate(operation, prepared.expected).alreadyApplied, true);
  assert.deepEqual(ingredientUpdate(operation, prepared.expected, true).expected, current);
  const edited = structuredClone(current);
  edited.recipes[0].ingredients = [amount('2勺')];
  assert.throws(() => ingredientUpdate(operation, edited), /已被修改/);
  assert.throws(() => ingredientUpdate(operation, { ...operation.after, status: 'deleted' }), /已撤回/);
  const reordered = structuredClone(operation.after);
  reordered.recipes[0].id = 'different-dish';
  assert.throws(() => ingredientUpdate(operation, reordered), /顺序已变化/);
});

test('split ingredients retain individual quantities and enforce the recipe row limit', () => {
  const original = { name: '盐和水', quantity: null, unit: '', amountText: '1克和10克' };
  const review = { ...emptyReview, contextual: [{ name: original.name, amountText: original.amountText, reason: '原文明示两项不同用量，拆分保留各自原量', ingredients: [{ name: '盐', quantity: 1, unit: 'g' }, { name: '水', quantity: 10, unit: 'g' }] }] };
  const record = { _id: 'recipe-one', familyId: 'family-one', value: dish([original]) };
  assert.equal(makeIngredientOperation('recipes', record, review).after.value.ingredients.length, 2);
  const tooMany = { ...record, value: dish(Array.from({ length: 30 }, () => original)) };
  assert.throws(() => makeIngredientOperation('recipes', tooMany, review), /行数/);
});

test('read-only pagination retries truncated responses with a smaller limit', async () => {
  const documents = Array.from({ length: 6 }, (_, index) => ({ _id: `doc-${index}` }));
  const limits = [];
  const call = async (tool, args) => {
    assert.equal(tool, 'cloud_db_read_doc');
    const limit = Number(args[args.indexOf('--limit') + 1]);
    const offset = Number(args[args.indexOf('--offset') + 1]);
    limits.push(limit);
    if (limit > 2) throw Object.assign(new Error('truncated'), { code: 'INCOMPLETE_IDE_JSON' });
    return { total: documents.length, data: documents.slice(offset, offset + limit) };
  };
  assert.deepEqual(await readCollection(call, 'posts'), documents);
  assert.deepEqual(limits, [5, 2, 2, 2]);
});

test('pagination fails on changing totals, duplicate IDs, incomplete pages and confirmation', async () => {
  const first = Array.from({ length: 5 }, (_, index) => ({ _id: `doc-${index}` }));
  let calls = 0;
  await assert.rejects(readCollection(async () => ++calls === 1 ? { total: 6, data: first } : { total: 7, data: [{ _id: 'doc-5' }] }, 'posts'), /总数变化/);
  await assert.rejects(readCollection(async () => ({ total: 2, data: [{ _id: 'same' }, { _id: 'same' }] }), 'posts'), /分页重复/);
  await assert.rejects(readCollection(async () => ({ total: 5, data: first.slice(0, 2) }), 'posts'), /分页不完整/);
  let attempted = 0;
  await assert.rejects(readCollection(async () => { attempted += 1; throw Object.assign(new Error('requires confirmation'), { taskId: 'pending-one' }); }, 'posts'), /confirmation/);
  assert.equal(attempted, 1);
});
