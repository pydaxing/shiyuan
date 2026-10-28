import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { computed, effectScope, nextTick, onScopeDispose, ref, watch } from 'vue';
import { createSeed } from '../src/data/seed.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { clone, hasTextAmount, ingredientFieldErrors, localDate, makeOrder, normalizeSnapshot, SELECTABLE_UNITS } from '../src/domain/kitchen.js';
import { preparationMeals } from '../src/domain/meal-preparation.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { createPreparationAutosave } from '../src/composables/preparation-autosave.js';

const today = '2026-10-26';
const source = readFileSync(new URL('../src/components/DishPreparationEditor.vue', import.meta.url), 'utf8');
const script = parse(source).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
const tick = async () => { for (let index = 0; index < 8; index += 1) await nextTick(); };

function editor(context, wait = async () => {}, initialize = () => {}) {
  const state = ref(normalizeSnapshot(createSeed()));
  state.value.orders = [makeOrder({ id: 'dinner', recipes: state.value.recipes, cart: { tomato: 1, broccoli: 1 }, member: state.value.family.members[0], date: today, meal: '晚餐' })];
  initialize(state.value);
  const actions = createKitchenActions({ getState: () => state.value, commit: next => { state.value = next; }, today: () => today });
  const calls = []; const events = []; const modals = [];
  const autosave = createPreparationAutosave({
    getState: () => state.value, getScope: () => (state.value.family.id || '') + ':' + state.value.activeMemberId, debounceMs: 500,
    send: async (...args) => { calls.push(clone(args)); await wait(); return actions.saveDishPreparation(...args); },
  });
  const scope = effectScope();
  const bindings = {
    computed, nextTick, onScopeDispose, ref, watch, hasTextAmount, ingredientFieldErrors, localDate, SELECTABLE_UNITS, NATIVE_UI_COLORS, state,
    usePreparationAutosave: () => autosave,
    defineProps: () => ({ orderId: 'dinner', recipeId: 'tomato', today }),
    defineEmits: () => (...args) => { if (args[0] !== 'state-change') events.push(args); },
    defineExpose: () => {}, dismissFocusedKeyboard: () => {},
    uni: { showModal: options => modals.push(options) },
  };
  const api = scope.run(() => new Function(...Object.keys(bindings), script + '\nreturn { session, ingredients, rows, dirty, saving, fieldErrors, ingredientError, ingredientFields, feedback, unavailable, stale, validationStatus, retry, close, reloadLatest, restoreDefaults, changeUnit, toggleUnit, editingUnit, addIngredient, removeIngredient, unitOptions, startComposition, endComposition, blurField };')(...Object.values(bindings)));
  context.after(() => { scope.stop(); autosave.dispose(); });
  return { ...api, state, actions, autosave, calls, events, modals, scope, dish: () => preparationMeals(state.value, today)[0]?.dishes[0] };
}

test('clean editor groups full add and restore labels at the left without a scope note or manual save controls', context => {
  const view = editor(context);
  assert.doesNotMatch(source, /以上仅调整本餐|preparation-edit-scope|preparation-scope/);
  assert.match(source, /class="text-button preparation-reset"[^>]*aria-label="恢复本餐默认食材和用量"[^>]*><AppIcon name="restore" active :size="16" \/><text>恢复默认<\/text><\/button>/);
  const actions = source.match(/<view class="preparation-edit-actions">([\s\S]*?)<\/view>/)[1];
  assert.match(actions, /class="text-button preparation-add"/);
  assert.match(actions, /class="text-button preparation-add"[^>]*aria-label="添加食材或配料"[\s\S]*?><AppIcon name="plus" active :size="16" \/><text>添加食材\/配料<\/text><\/button>/);
  assert.match(actions, /class="text-button preparation-reset"/);
  assert.ok(actions.indexOf('preparation-add') < actions.indexOf('preparation-reset'));
  assert.doesNotMatch(source, /保存本餐调整|撤销修改|已自动保存|<Sheet\b|<SelectField\b|#footer/);
  assert.match(source, /v-else-if="session.notice \|\| validationStatus"/);
  assert.equal(view.validationStatus.value, '');
  assert.equal(view.session.notice, '');
  const rules = {};
  postcss.parse(parse(source).descriptor.styles[0].content).walkRules('.preparation-reset', rule => rule.walkDecls(declaration => { rules[declaration.prop] = declaration.value; }));
  assert.equal(rules.color, undefined);
  assert.match(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'), /\.text-button\s*\{[^}]*color: var\(--green\)/);
  assert.equal(rules['text-decoration'], 'none');
  assert.equal(rules.gap, '4px');
  assert.equal(rules['min-height'], '44px');
  assert.match(source, /:class="\{ 'is-disabled': Boolean\(unavailable\) \|\| stale \|\| Boolean\(session.error\) \}"/);
  assert.match(source, /\.preparation-reset\.is-disabled\s*\{/);
  assert.doesNotMatch(source, /\.preparation-reset\[disabled\]/);
  const actionRules = {};
  const styles = postcss.parse(parse(source).descriptor.styles[0].content);
  styles.walkRules('.preparation-edit-actions', rule => rule.walkDecls(declaration => { actionRules[declaration.prop] = declaration.value; }));
  assert.equal(actionRules.display, 'flex');
  assert.equal(actionRules['justify-content'], 'space-between');
  assert.equal(actionRules['flex-wrap'], 'wrap');
  assert.equal(actionRules.gap, '0 16px');
  assert.equal(rules.margin, '0 0 0 auto');
  assert.doesNotMatch(parse(source).descriptor.template.content, /备注|查看做法|<input\b|<textarea\b/);
});

test('material footer keeps only its actions without extra note space or smaller touch targets', () => {
  const styles = postcss.parse(parse(source).descriptor.styles[0].content);
  const declarations = selector => {
    const values = {};
    styles.walkRules(selector, rule => rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; }));
    return values;
  };
  const footer = declarations('.preparation-edit-footer');
  assert.equal(footer.display, 'flex');
  assert.equal(footer['flex-direction'], 'column');
  assert.equal(footer.gap, '0');
  assert.equal(footer.margin, '0');
  assert.equal(footer.padding, '0');
  assert.deepEqual(declarations('.preparation-edit-scope'), {});
  for (const selector of ['.preparation-add', '.preparation-reset']) {
    const action = declarations(selector);
    assert.equal(action['min-height'], '44px');
    assert.equal(action['font-size'], 'var(--type-meta)');
    assert.equal(action['font-weight'], '400');
    assert.equal(action['line-height'], '20px');
  }
  assert.match(source, /class="preparation-edit-footer">\s*<view class="preparation-edit-actions">/);
  assert.match(source, /v-if="feedback \|\| session.notice \|\| validationStatus" class="preparation-edit-feedback"/);
});

test('material rows retain aligned headers, inline units and shared error targets', () => {
  assert.match(source, /type="digit"/);
  assert.match(source, /class="preparation-edit-errors">\s*<FieldError ref="ingredientErrors"/);
  assert.match(source, /class="preparation-unit-options" role="listbox"/);
  assert.match(source, /preparation-material-header, \.preparation-edit-fields/);
  assert.match(source, /grid-template-columns: minmax\(0, 1fr\).*44px/);
  assert.match(source, /text-amount-editor \.preparation-unit-field/);
  assert.match(source, /@media \(max-width: 360px\)/);
});

test('typing remains local immediately and autosave preserves rows, raw formatting and original recipe', async context => {
  const view = editor(context);
  const before = clone(view.state.value);
  const row = view.ingredients.value[0];
  row.quantity = '0600.0';
  assert.deepEqual(view.state.value, before);
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients[0].quantity, 600);
  assert.equal(view.ingredients.value[0], row);
  assert.equal(row.quantity, '0600.0');
  assert.deepEqual(view.state.value.recipes, before.recipes);
  assert.equal(view.dirty.value, false);
  assert.equal(view.validationStatus.value, '');
});

test('queued and slow autosaves stay silent while edits are immediately visible', async context => {
  let finish;
  const view = editor(context, () => new Promise(resolve => { finish = resolve; }));
  const ingredient = view.ingredients.value[0];
  ingredient.quantity = '600';
  await tick();
  assert.equal(view.dirty.value, true);
  assert.equal(view.saving.value, false);
  assert.equal(view.validationStatus.value, '');
  assert.equal(view.feedback.value, '');
  await view.autosave.dispatch('dinner', 'tomato');
  assert.equal(view.saving.value, true);
  assert.equal(view.validationStatus.value, '');
  assert.equal(view.feedback.value, '');
  assert.equal(view.session.notice, '');
  assert.equal(ingredient.quantity, '600');
  await view.close();
  assert.deepEqual(view.events, [['close']]);
  finish();
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.validationStatus.value, '');
  assert.equal(view.session.notice, '');
  assert.doesNotMatch(source, /正在同步|等待同步|同步中|已自动保存/);
});

test('incomplete inputs show correction hints only after interaction, never during composition', async context => {
  const view = editor(context);
  view.addIngredient();
  await tick();
  assert.equal(view.validationStatus.value, '');
  await view.blurField();
  assert.match(view.validationStatus.value, /待补全/);
  assert.ok(Object.keys(view.fieldErrors.value).length);
  view.startComposition();
  assert.equal(view.validationStatus.value, '');
  view.ingredients.value.at(-1).name = '香菜';
  await view.endComposition();
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.validationStatus.value, '');
  view.session.notice = '用量已更新，请重新确认备齐';
  assert.match(source, /session.notice \|\| validationStatus/);
  assert.match(source, /v-if="feedback"[^>]*role="alert"/);
});

test('unit choices preserve historical text and default numeric transitions to a saveable zero', async context => {
  const view = editor(context, async () => {}, snapshot => {
    snapshot.orders[0].items[0].recipe.ingredients[0] = { name: '番茄', quantity: null, unit: '', amountText: '按需要准备' };
  });
  const ingredient = view.ingredients.value[0];
  assert.equal(ingredient.choice, '原用量');
  assert.deepEqual(view.unitOptions.slice(0, 2), ['适量', '少许']);
  assert.equal(view.unitOptions.includes('原用量'), false);
  view.toggleUnit(ingredient);
  view.changeUnit(ingredient, 'g');
  assert.equal(ingredient.quantity, 0);
  assert.equal(ingredient.amountText, undefined);
  assert.equal(view.editingUnit.value, null);
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients[0].quantity, 0);
  ingredient.quantity = '300';
  await view.autosave.flush('dinner', 'tomato');
  view.changeUnit(ingredient, '少许');
  assert.equal(ingredient.quantity, null);
  assert.equal(ingredient.unit, '');
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients[0].amountText, '少许');
});

test('new preparation rows use zero without replacing existing recipe amounts or blocking actions', async context => {
  const view = editor(context);
  const original = clone(view.state.value.recipes);
  const existing = clone(view.ingredients.value);
  view.addIngredient();
  const added = view.ingredients.value.at(-1);
  assert.equal(added.quantity, 0);
  assert.equal(added.unit, 'g');
  added.name = '香菜';
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients.at(-1).quantity, 0);
  assert.deepEqual(view.fieldErrors.value, {});
  assert.deepEqual(view.ingredients.value.slice(0, -1), existing);
  assert.deepEqual(view.state.value.recipes, original);
  let acted = false;
  await view.autosave.act('dinner', 'tomato', 'prepared', async () => { acted = true; });
  assert.equal(acted, true);
  for (const quantity of [0, '0', '0.0', '00.00']) {
    added.quantity = quantity;
    await view.autosave.flush('dinner', 'tomato');
    assert.equal(view.dish().ingredients.at(-1).quantity, 0);
    assert.equal(view.validationStatus.value, '');
  }
});

test('material inputs use a quiet underline and zero color, with centered five-column units and native arrow wrappers', () => {
  const css = postcss.parse(parse(source).descriptor.styles[0].content);
  const declarations = selector => {
    const result = {};
    css.walkRules(selector, rule => rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; }));
    return result;
  };
  assert.equal(declarations('.preparation-unit-options')['grid-template-columns'], 'repeat(5, minmax(0, 1fr))');
  assert.equal(declarations('.preparation-unit-option').display, 'flex');
  assert.equal(declarations('.preparation-unit-option')['align-items'], 'center');
  assert.equal(declarations('.preparation-unit-option')['justify-content'], 'center');
  assert.equal(declarations('.preparation-unit-option')['min-height'], '44px');
  assert.match(source, /variant="material" :empty-value="0"/);
  assert.match(source, /Number\(ingredient.quantity\) === 0 \? ' quantity-zero'/);
  assert.match(source, /<view class="preparation-unit-chevron"><AppIcon/);
  assert.equal(declarations('.preparation-unit-trigger.is-expanded .preparation-unit-chevron').transform, 'rotate(180deg)');
  const sheet = readFileSync(new URL('../src/components/MealPreparationSheet.vue', import.meta.url), 'utf8');
  assert.match(sheet, /<view class="prep-disclosure-chevron"><AppIcon/);
  assert.match(sheet, /\.prep-disclosure\.expanded \.prep-disclosure-chevron \{ transform: rotate\(180deg\)/);
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.form-field-material \.input\.preparation-material-input \{[^}]*border: 0;[^}]*border-radius: 0;[^}]*box-shadow: none/);
  assert.match(styles, /\.form-field-material\.is-focused \.input\.preparation-material-input \{[^}]*box-shadow: inset 0 -1px 0 var\(--green\)/);
  assert.match(styles, /\.input\.preparation-material-quantity\.quantity-zero \{ color: var\(--danger\)/);
});

test('an incomplete material can be removed without its invalid fields blocking autosave', async context => {
  const view = editor(context);
  const ingredient = view.ingredients.value[0];
  ingredient.quantity = '';
  const remaining = view.ingredients.value.slice(1);
  const removing = view.removeIngredient(ingredient);
  assert.deepEqual(view.ingredients.value, remaining);
  await removing;
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.fieldErrors.value, {});
  assert.equal(view.dish().ingredients.length, remaining.length);
  assert.equal(view.calls.length, 1);
});

test('delete uses a trash action and removes only the chosen meal material immediately', async context => {
  const view = editor(context);
  const recipes = clone(view.state.value.recipes);
  const otherDish = clone(view.state.value.orders[0].items[1]);
  const ingredient = view.ingredients.value[0];
  view.toggleUnit(ingredient);
  const remainingKeys = view.ingredients.value.slice(1).map(row => row.key);
  const removing = view.removeIngredient(ingredient);
  assert.deepEqual(view.ingredients.value.map(row => row.key), remainingKeys);
  assert.equal(view.editingUnit.value, null);
  await removing;
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients.length, remainingKeys.length);
  assert.deepEqual(view.state.value.recipes, recipes);
  assert.deepEqual(view.state.value.orders[0].items[1], otherDish);
  await view.removeIngredient(ingredient);
  assert.deepEqual(view.ingredients.value.map(row => row.key), remainingKeys);
  assert.match(source, /class="icon-button preparation-remove"/);
  assert.match(source, /<AppIcon name="trash-danger" :size="16"/);
  assert.match(source, />操作<\/text>/);
  assert.doesNotMatch(source, /role="switch"|preparation-needed-toggle|toggleIngredient/);
});

test('stable presentation rows never reorder after names change or saves complete', async context => {
  const original = [{ name: '盐', quantity: null, unit: '', amountText: '少许' }, { name: '番茄', quantity: 200, unit: 'g' }, { name: '蒜', quantity: 2, unit: '瓣' }];
  const view = editor(context, async () => {}, snapshot => { snapshot.orders[0].items[0].recipe.ingredients = clone(original); });
  assert.deepEqual(view.rows.value.map(entry => entry.index), [1, 0, 2]);
  const keys = view.rows.value.map(entry => entry.ingredient.key);
  view.rows.value[0].ingredient.name = '生抽';
  view.addIngredient();
  view.rows.value.at(-1).ingredient.name = '土豆';
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.rows.value.slice(0, 3).map(entry => entry.ingredient.key), keys);
  assert.deepEqual(view.calls[0][2].ingredients.map(ingredient => ingredient.name), ['盐', '生抽', '蒜', '土豆']);
  await view.removeIngredient(view.rows.value[1].ingredient);
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.rows.value.map(entry => entry.index), [0, 1, 2]);
  assert.deepEqual(view.rows.value.slice(0, 2).map(entry => entry.ingredient.key), [keys[0], keys[2]]);
  assert.deepEqual(view.dish().ingredients.map(ingredient => ingredient.name), ['生抽', '蒜', '土豆']);
});

test('all materials can be deleted, saved empty, and restored from the original meal snapshot', async context => {
  const view = editor(context);
  const original = clone(view.dish().ingredients);
  for (const ingredient of [...view.ingredients.value]) await view.removeIngredient(ingredient);
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.dish().ingredients, []);
  assert.deepEqual(view.rows.value, []);
  await view.restoreDefaults();
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.dish().ingredients, original);
  assert.equal(new Set(view.rows.value.map(row => row.ingredient.key)).size, original.length);
});

test('legacy excluded materials remain excluded until explicitly removed or reset', async context => {
  const view = editor(context, async () => {}, snapshot => { snapshot.orders[0].items[0].recipe.ingredients[0].enabled = false; });
  await tick();
  assert.equal(view.calls.length, 0);
  const excluded = view.ingredients.value[0];
  assert.equal(excluded.enabled, false);
  await view.removeIngredient(excluded);
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.dish().ingredients.some(row => row.name === excluded.name), false);
});

test('adding a blank ingredient never sends it and respects the thirty row bound', async context => {
  const view = editor(context);
  view.addIngredient();
  await tick();
  assert.equal(view.calls.length, 0);
  while (view.ingredients.value.length < 30) view.addIngredient();
  view.addIngredient();
  assert.equal(view.ingredients.value.length, 30);
  assert.equal(new Set(view.ingredients.value.map(ingredient => ingredient.key)).size, 30);
});

test('slow saves never disable typing, adding or navigation, and close preserves drafts', async context => {
  let finish;
  const view = editor(context, () => new Promise(resolve => { finish = resolve; }));
  view.ingredients.value[0].quantity = '600';
  await view.autosave.dispatch('dinner', 'tomato');
  assert.equal(view.saving.value, true);
  view.addIngredient();
  view.ingredients.value.at(-1).name = '';
  await view.close();
  assert.deepEqual(view.events, [['close']]);
  assert.deepEqual(view.modals, []);
  assert.equal(view.ingredients.value.at(-1).name, '');
  assert.doesNotMatch(source, /:disabled="busy|:disabled="saving[^"]*" field-class/);
  view.scope.stop();
  finish(); await tick();
  assert.equal(view.dish().ingredients[0].quantity, 600);
  assert.equal(view.autosave.edit('dinner', 'tomato').ingredients.at(-1).name, '');
});

test('failed sync keeps raw input and offers retry without success feedback', async context => {
  let offline = true;
  const view = editor(context, async () => { if (offline) throw new Error('网络不可用'); });
  view.ingredients.value[0].quantity = '600';
  await assert.rejects(view.autosave.flush('dinner', 'tomato'), /网络/);
  assert.match(view.feedback.value, /网络/);
  assert.equal(view.ingredients.value[0].quantity, '600');
  offline = false;
  await view.retry();
  assert.equal(view.feedback.value, '');
  assert.equal(view.dirty.value, false);
  assert.deepEqual(view.events, []);
});

test('conflict reload is explicit and does not discard inputs on cancellation', async context => {
  const view = editor(context);
  view.ingredients.value[0].quantity = '600';
  await tick();
  view.actions.saveDishPreparation('dinner', 'tomato', { ingredients: view.dish().ingredients, note: '家人备注' }, view.dish().editSignature);
  await tick();
  assert.equal(view.stale.value, true);
  const cancelled = view.reloadLatest();
  view.modals.at(-1).success({ confirm: false }); await cancelled;
  assert.equal(view.ingredients.value[0].quantity, '600');
  const accepted = view.reloadLatest();
  view.modals.at(-1).success({ confirm: true }); await accepted;
  assert.equal(view.stale.value, false);
  assert.equal(view.session.note, '家人备注');
});

test('reset restores source materials and keeps hidden notes without a manual save', async context => {
  const view = editor(context);
  const original = clone(view.dish().ingredients);
  view.session.note = '历史备注';
  view.ingredients.value[0].quantity = '650';
  await view.autosave.flush('dinner', 'tomato');
  view.addIngredient();
  await view.restoreDefaults();
  await view.autosave.flush('dinner', 'tomato');
  assert.deepEqual(view.dish().ingredients, original);
  assert.equal(view.session.note, '历史备注');
});

test('composition holds candidate text and releases only the final model value', async context => {
  const view = editor(context);
  view.startComposition();
  view.ingredients.value[0].name = 'fan';
  await view.autosave.dispatch('dinner', 'tomato');
  assert.equal(view.calls.length, 0);
  view.ingredients.value[0].name = '番茄块';
  await view.endComposition();
  await view.autosave.flush('dinner', 'tomato');
  assert.equal(view.calls[0][2].ingredients[0].name, '番茄块');
  assert.match(source, /@compositionstart="startComposition"/);
  assert.match(source, /@compositionend="endComposition"/);
});

test('closed meals and family switches preserve local drafts without writing', async context => {
  const view = editor(context);
  view.ingredients.value[0].quantity = '600';
  view.state.value.orders[0].status = 'completed'; await tick();
  assert.ok(view.unavailable.value);
  assert.equal(view.calls.length, 0);
  assert.equal(view.ingredients.value[0].quantity, '600');
  view.state.value.family.id = 'different'; await tick();
  assert.deepEqual(view.events, [['close']]);
});
