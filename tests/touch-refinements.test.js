import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSeed } from '../src/data/seed.js';
import { recipeFieldErrors, validateRecipe } from '../src/domain/kitchen.js';

const component = (name) => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
const recipe = createSeed().recipes[0];

test('recipe field validation identifies every missing input rather than only the first', () => {
  const draft = { ...recipe, title: ' ', minutes: '', ingredients: [{ name: '', quantity: '', unit: 'g' }, { name: '玉米', quantity: -1, unit: '根' }] };
  const errors = recipeFieldErrors(draft);
  assert.deepEqual(Object.keys(errors), ['title', 'minutes', 'ingredients.0.name', 'ingredients.0.quantity', 'ingredients.1.quantity']);
  assert.throws(() => validateRecipe(draft), { message: errors.title });
  draft.title = '清蒸玉米';
  assert.equal(recipeFieldErrors(draft).title, undefined);
  assert.ok(recipeFieldErrors(draft)['ingredients.1.quantity']);
});

test('field and persistence validation agree on quantities, units and cooking times', () => {
  assert.deepEqual(recipeFieldErrors(recipe), {});
  for (const quantity of ['', 0, -2, 0.0001, 100001, Infinity, 'bad']) {
    const draft = { ...recipe, ingredients: [{ name: '玉米', quantity, unit: '根' }] };
    assert.throws(() => validateRecipe(draft), { message: recipeFieldErrors(draft)['ingredients.0.quantity'] });
  }
  for (const minutes of [0, 1.2, 601, NaN]) {
    const draft = { ...recipe, minutes };
    assert.throws(() => validateRecipe(draft), { message: recipeFieldErrors(draft).minutes });
  }
  assert.ok(recipeFieldErrors({ ...recipe, ingredients: [{ name: '玉米', quantity: 1, unit: 'invalid' }] })['ingredients.0.unit']);
  assert.doesNotThrow(() => recipeFieldErrors(null));
});

test('validating multiple ingredient rows leaves the draft untouched', () => {
  const draft = { ...recipe, ingredients: [{ name: '玉米', quantity: 1, unit: '根' }, { name: '', quantity: '', unit: 'g' }] };
  const snapshot = structuredClone(draft);
  assert.deepEqual(Object.keys(recipeFieldErrors(draft)), ['ingredients.1.name', 'ingredients.1.quantity']);
  assert.deepEqual(draft, snapshot);
  draft.ingredients.splice(1, 1);
  assert.deepEqual(recipeFieldErrors(draft), {});
});

test('native sheets use root portals and stable flex heights without changing mask isolation', () => {
  const sheet = component('Sheet');
  assert.match(sheet, /#ifdef MP-WEIXIN[\s\S]*?<root-portal>/);
  assert.match(sheet, /@scroll="handleScroll"/);
  assert.match(sheet, /function handleScroll\(event\) \{\s*onScroll\(event\);/);
  assert.doesNotMatch(sheet, /onUpdated|measureContent/);
  assert.match(sheet, /useSheetSizing/);
  assert.match(sheet, /canMeasure: \(\) => !keyboard.value && !focusedToken && layer.isTop\(\)/);
  assert.match(sheet, /height: `\$\{keyboard.value \? maxHeight.value : Math.min\(props.preferredHeight/);
  assert.doesNotMatch(sheet, /@click\.self/);
  assert.match(component('DateField'), /function show\(\) \{ dismissFocusedKeyboard\(\)/);
});

test('recipe errors highlight fields and reveal the first invalid field while save failures stay by the action', () => {
  const editor = component('RecipeEditor');
  assert.match(editor, /fieldRefs\[invalidField\]\?\.reveal\(\)/);
  assert.match(editor, /recipeFieldErrors\(\{ \.\.\.draft.value, steps: steps.value \}, \{ requireStepTitles: true \}\)/);
  assert.ok(editor.indexOf('<template #footer>') < editor.indexOf('class="error-message"'));
  assert.match(component('FormField'), /field-invalid/);
  assert.match(component('FormField'), /:aria-invalid="Boolean\(error\)"/);
  assert.match(editor, /<SelectField class="ingredient-unit-field"[^\n]+:error="[^\n]+:model-value="ingredientInput\(ingredient\).unit" centered/);
  assert.match(editor, /@update:model-value="changeIngredientUnit\(ingredient, \$event\)"/);
});

test('preparation keeps every dish visible while procurement includes only explicit packages', () => {
  const shopping = component('ShoppingView');
  assert.doesNotMatch(shopping, /showReady|ready-toggle/);
  assert.match(shopping, /v-for="\(dish, dishIndex\) in order.dishes"/);
  assert.match(shopping, /shoppingCartMeals\(state.value, props.today\)/);
  const preparation = component('MealPreparationSheet');
  assert.match(preparation, /:aria-expanded="expanded.includes\(dish.recipe.id\)"/);
  assert.match(preparation, /'is-prepared': dish.prepared/);
  assert.match(component('CommentItem'), /<AppIcon name="thumb"/);
  assert.doesNotMatch(component('CommentItem'), /♥|♡/);
});
