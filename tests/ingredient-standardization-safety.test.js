import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { createSeed } from '../src/data/seed.js';
import { INGREDIENT_UNITS_VERSION, LEGACY_INGREDIENT_UNITS, legacyIngredientAmounts, restoreIngredientCommand, restoreMeasuredIngredient } from '../src/domain/ingredient-units.js';
import { reviewedIngredientEntry, applyReviewedIngredients } from '../scripts/reviewed-ingredient-imports.mjs';
import { assertNoUnresolvedWrite, createIdeClient } from '../scripts/standardize-live-ingredients.mjs';
import { buildIngredientUnitHotfix } from '../scripts/build-ingredient-unit-hotfix.mjs';

test('legacy recipe projection preserves exact new amounts without changing stored recipes or other fields', () => {
  const ingredients = [{ name: '蒜', quantity: 1, unit: '头' }, { name: '水', quantity: 300, unit: 'ml' }, { name: '盐', quantity: null, unit: '', amountText: '适量' }];
  const original = { snapshot: { recipes: [{ ingredients, image: 'original-image' }], inventory: [{ name: '蒜', quantity: 1, unit: '头' }] }, post: { recipes: [{ ingredients }] } };
  const legacy = legacyIngredientAmounts(original);
  assert.deepEqual(legacy.snapshot.recipes[0].ingredients[0], { name: '蒜', quantity: null, unit: '', amountText: '1 头' });
  assert.deepEqual(legacy.post.recipes[0].ingredients, legacy.snapshot.recipes[0].ingredients);
  assert.strictEqual(legacy.snapshot.recipes[0].ingredients[1], ingredients[1]);
  assert.strictEqual(legacy.snapshot.inventory, original.snapshot.inventory);
  assert.equal(original.snapshot.recipes[0].ingredients[0].quantity, 1);
  assert.strictEqual(legacyIngredientAmounts(original, INGREDIENT_UNITS_VERSION), original);
  assert.ok(legacy.snapshot.recipes[0].ingredients.every(ingredient => ingredient.amountText !== undefined || LEGACY_INGREDIENT_UNITS.includes(ingredient.unit)));
});

test('save compatibility only restores exact measured recipe amounts and retains invalid input for validation', () => {
  const amount = { name: '盐', quantity: null, unit: '', amountText: '0.5 小勺' };
  assert.deepEqual(restoreMeasuredIngredient(amount), { name: '盐', quantity: 0.5, unit: '小勺' });
  for (const text of ['1-2 小勺', '适量', '原文未注明', '0 头', '100001 头', '0.00001 头']) {
    const ingredient = { ...amount, amountText: text };
    assert.strictEqual(restoreMeasuredIngredient(ingredient), ingredient);
  }
  const malformed = { ...amount, quantity: 2 };
  assert.strictEqual(restoreMeasuredIngredient(malformed), malformed);
  const event = { action: 'command', name: 'saveRecipe', args: [{ ingredients: [amount], title: '菜品' }, 'recipe-id'], requestId: 'stable-request' };
  const restored = restoreIngredientCommand(event);
  assert.equal(restored.requestId, event.requestId);
  assert.equal(restored.args[1], 'recipe-id');
  assert.deepEqual(restored.args[0].ingredients, [{ name: '盐', quantity: 0.5, unit: '小勺' }]);
  assert.strictEqual(restoreIngredientCommand({ ...event, name: 'placeOrder' }).args, event.args);
});

test('old and new cloud clients can read and edit the same canonical recipe', async () => {
  const repository = memoryRepository();
  const app = createApplication({ repository, signFiles: async () => ({}), now: () => Date.parse('2026-10-20T03:00:00Z') });
  const invoke = async (event, version = INGREDIENT_UNITS_VERSION) => {
    const response = await app({ ...event, ...(version === undefined ? {} : { ingredientUnitsVersion: version }) }, { OPENID: 'unit-compatibility-test' });
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  };
  let current = await invoke({ action: 'createFamily', name: '成员', familyName: '家庭' });
  const draft = { ...createSeed().recipes[0], title: '新单位测试', ingredients: [{ name: '蒜', quantity: 0.5, unit: '头' }] };
  current = await invoke({ action: 'command', name: 'saveRecipe', args: [draft], revision: current.revision, requestId: 'new-unit-save-one' });
  const canonical = current.snapshot.recipes.find(recipe => recipe.title === draft.title);
  const legacy = await invoke({ action: 'bootstrap', includeFeed: false }, 1);
  const legacyRecipe = legacy.snapshot.recipes.find(recipe => recipe.id === canonical.id);
  assert.equal(legacyRecipe.ingredients[0].amountText, '0.5 头');
  await invoke({ action: 'command', name: 'saveRecipe', args: [{ ...legacyRecipe, title: '旧版编辑' }, canonical.id], revision: legacy.revision, requestId: 'old-unit-save-two' }, 1);
  current = await invoke({ action: 'bootstrap', includeFeed: false });
  const saved = current.snapshot.recipes.find(recipe => recipe.id === canonical.id);
  assert.equal(saved.title, '旧版编辑');
  assert.deepEqual(saved.ingredients, draft.ingredients);
  const stored = await repository.list('recipes', { familyId: current.familyId });
  assert.deepEqual(stored.find(document => document.value.id === saved.id).value.ingredients, draft.ingredients);
});

test('reviewed imports preserve raw provenance and reject changed original sources', () => {
  const raw = { sourceUrl: 'https://example.com/recipe/123/', sourceHtml: '<article>原文</article>', ingredients: [{ name: '盐', amountText: '原文未注明' }] };
  const ingredients = [{ name: '盐', quantity: null, unit: '', amountText: '适量' }];
  const entry = reviewedIngredientEntry(raw, ingredients);
  const overrides = { version: 1, recipes: { [raw.sourceUrl]: entry } };
  const recipe = { ingredients: raw.ingredients, steps: [{ text: '保留做法' }], provenance: { url: raw.sourceUrl } };
  const actual = applyReviewedIngredients(raw, recipe, overrides);
  assert.deepEqual(actual.ingredients, ingredients);
  assert.strictEqual(actual.steps, recipe.steps);
  assert.strictEqual(actual.provenance, recipe.provenance);
  assert.equal(raw.ingredients[0].amountText, '原文未注明');
  assert.throws(() => applyReviewedIngredients({ ...raw, ingredients: [] }, recipe, overrides), /原文食材已变化/);
  assert.throws(() => applyReviewedIngredients({ ...raw, sourceHtml: '新原文' }, recipe, overrides), /来源页面已变化/);
  assert.strictEqual(applyReviewedIngredients(raw, recipe), recipe);
});

test('pending and unknown write outcomes persist across runs and cannot be resent', async () => {
  for (const response of [JSON.stringify({ ok: true, pending: true, taskId: 'original-task' }), '{']) {
    const directory = await mkdtemp(path.join(tmpdir(), 'shiyuan-write-guard-'));
    try {
      const executable = path.join(directory, 'fake-cli');
      await writeFile(executable, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(response)});\n`);
      await chmod(executable, 0o700);
      const client = createIdeClient({ appid: 'test', env: 'test' }, directory, executable);
      await assert.rejects(client('cloud_db_write_doc', []));
      await assert.rejects(assertNoUnresolvedWrite(directory), /上次写入结果未确认/);
      const resumed = createIdeClient({ appid: 'test', env: 'test' }, directory, executable);
      await assert.rejects(resumed('cloud_db_write_doc', []), /上次写入结果未确认/);
      const guard = JSON.parse(await readFile(path.join(directory, 'write-reconciliation-required.json'), 'utf8'));
      assert.equal(guard.tool, 'cloud_db_write_doc');
      if (response !== '{') assert.equal(guard.taskId, 'original-task');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('a definite successful write releases the per-write guard', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shiyuan-write-success-'));
  try {
    const executable = path.join(directory, 'fake-cli');
    await writeFile(executable, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,result:{success:true,updated:1}}));\n');
    await chmod(executable, 0o700);
    const client = createIdeClient({ appid: 'test', env: 'test' }, directory, executable);
    assert.equal((await client('cloud_db_write_doc', [])).updated, 1);
    await assertNoUnresolvedWrite(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production hotfix changes only the known unit declaration and request boundary', async () => {
  const baseline = `var UNITS = ${JSON.stringify(LEGACY_INGREDIENT_UNITS)};\nvar unrelatedFeature = 'unchanged';\nvar import_wx_server_sdk = {default:{getWXContext:()=>({OPENID:'member'})}};\nvar application = async event => ({ok:true,data:JSON.parse(JSON.stringify({snapshot:{recipes:[event.args[0]]}}))});\nasync function main(event) { const invoke = () => application(event, import_wx_server_sdk.default.getWXContext()); return invoke(); }\n`;
  const protocol = await readFile(new URL('../src/domain/ingredient-units.js', import.meta.url), 'utf8');
  const code = await buildIngredientUnitHotfix(baseline, protocol);
  const context = vm.createContext({});
  vm.runInContext(code, context);
  assert.equal(context.unrelatedFeature, 'unchanged');
  const args = [{ ingredients: [{ name: '蒜', quantity: null, unit: '', amountText: '0.5 头' }] }];
  const modern = JSON.parse(JSON.stringify(await context.main({ action: 'command', name: 'saveRecipe', args, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION })));
  assert.deepEqual(modern.data.snapshot.recipes[0].ingredients, [{ name: '蒜', quantity: 0.5, unit: '头' }]);
  const legacy = JSON.parse(JSON.stringify(await context.main({ action: 'command', name: 'saveRecipe', args })));
  assert.equal(legacy.data.snapshot.recipes[0].ingredients[0].amountText, '0.5 头');
  await assert.rejects(buildIngredientUnitHotfix(`${baseline}\n${baseline}`, protocol), /入口不唯一/);
  await assert.rejects(buildIngredientUnitHotfix(baseline.replace('var UNITS', 'var OTHER_UNITS'), protocol), /单位定义不符/);
});
