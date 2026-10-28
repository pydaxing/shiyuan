import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';

const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));

function componentStyles(name) {
  const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
  return postcss.parse(parse(source).descriptor.styles.map(style => style.content).join('\n'));
}

function declarationsFor(selector, source = styles) {
  const declarations = new Map();
  source.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

function assertNoRowDividers(source, className) {
  let matchedRules = 0;
  const rowClass = new RegExp(`\\.${className}(?![\\w-])`);
  source.walkRules(rule => {
    if (!rule.selectors.some(selector => rowClass.test(selector.trim().split(/\s+|[>+~]/).at(-1)))) return;
    matchedRules += 1;
    rule.walkDecls(declaration => {
      if (!/^border(?:-(?:top|bottom|block(?:-start|-end)?))?(?:-(?:width|style))?$/.test(declaration.prop)) return;
      assert.match(declaration.value, /^(?:0(?:px)?|none)(?:\s+(?:0(?:px)?|none))*$/, `${rule.selector}: ${declaration.prop} must not draw a food-list divider`);
    });
  });
  assert.ok(matchedRules > 0, `Expected styles for .${className}`);
}

test('menu, selection and order rows have no separators in base, selected, or responsive styles', () => {
  for (const className of ['cart-item', 'meal-dish-row', 'set-pick-row', 'diary-recipe']) {
    assertNoRowDividers(styles, className);
  }
});

test('menu and food set details share separators only between their member dishes', () => {
  assert.equal(declarationsFor('.community-recipe + .community-recipe').get('border-top'), '1px solid var(--line)');
  assert.equal(declarationsFor('.community-recipe').get('border-top'), undefined);
  assert.equal(declarationsFor('.community-recipe').get('border-bottom'), undefined);
  for (const component of ['SetSheet', 'CommunityView']) {
    const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), 'utf8');
    assert.match(source, /v-for="\(recipe, index\) in (?:recipes|current\.recipes)"[^>]*class="community-recipe"/);
    assert.match(source, /toggleRecipe\(recipe.id, index\)/);
  }
});

test('home, add-dishes, and sharing lists do not restore row separators locally', () => {
  for (const [component, className] of [['MenuSwipeRow', 'menu-swipe'], ['AddDishesSheet', 'meal-addition-row'], ['ShareSheet', 'share-pick-row']]) {
    assertNoRowDividers(componentStyles(component), className);
  }
});

test('add-dishes adopts compact shared row spacing while detail and checkout spacing stay unchanged', () => {
  assert.equal(declarationsFor('.cart-item').get('padding'), '18px 0');
  assert.equal(declarationsFor('.community-recipe').get('padding-bottom'), '10px');
  assert.equal(declarationsFor('.meal-dish-row').get('padding'), '10px 0');
  assert.equal(declarationsFor('.set-pick-row').get('padding'), 'var(--food-row-padding) 0');
  const addition = declarationsFor('.meal-addition-row', componentStyles('AddDishesSheet'));
  assert.equal(addition.get('padding'), 'var(--food-row-padding) 0');
  assert.equal(addition.get('min-height'), '64px');
  assert.equal(addition.get('gap'), '10px');
});

test('kitchen dish rows keep compact spacing and shared food photos without avatar space', () => {
  const kitchenRow = declarationsFor('.order-card .meal-dish-row');
  assert.equal(kitchenRow.get('padding'), '6px 0');
  assert.equal(kitchenRow.get('height'), undefined);
  assert.equal(declarationsFor('.checkout-dishes .meal-dish-row').get('padding'), '10px 0');
  assert.equal(declarationsFor('.meal-dish-list').get('margin'), '10px 0');
  assert.equal(declarationsFor('.meal-dish-list').get('gap'), '0');
  assert.equal(declarationsFor('.meal-dish-photo').get('width'), undefined);
  assert.equal(declarationsFor('.meal-dish-photo').get('height'), undefined);
  assert.match(readFileSync(new URL('../src/components/MealDishList.vue', import.meta.url), 'utf8'), /<FoodThumbnail class="meal-dish-photo"/);
  assert.equal(declarationsFor('.meal-dish-open').get('min-height'), '58px');
  assert.equal(declarationsFor('.dish-avatar').size, 0);
  assert.equal(declarationsFor('.dish-avatars').size, 0);
  assert.equal(declarationsFor('.order-add-button').get('min-height'), '44px');
});

test('home rows tighten locally while set creation, sharing and touch controls keep their spacing', () => {
  const rowPadding = 'var(--food-row-padding)';
  const rowHeight = `calc(var(--food-row-content-height) + ${rowPadding} + ${rowPadding})`;
  assert.equal(declarationsFor('page').get('--food-row-padding'), '6px');
  assert.equal(declarationsFor('page').get('--food-row-height'), rowHeight);
  styles.walkDecls('--food-row-height', declaration => assert.equal(declaration.value, rowHeight));
  const homeStyles = componentStyles('HomeMenu');
  assert.equal(declarationsFor('.home-menu', homeStyles).get('--food-row-padding'), '2px');
  assert.equal(declarationsFor('.home-menu', homeStyles).get('--food-row-height'), rowHeight);
  const menuStyles = componentStyles('MenuSwipeRow');
  assert.equal(declarationsFor('.home-menu-info', menuStyles).get('padding'), '0');
  assert.equal(declarationsFor('.home-menu-info', menuStyles).get('min-height'), 'var(--food-row-content-height)');
  assert.equal(declarationsFor('.home-menu-row', menuStyles).get('padding'), `${rowPadding} 0`);
  assert.equal(declarationsFor('.home-menu-row', menuStyles).get('min-height'), 'var(--food-row-height)');
  assert.equal(declarationsFor('.home-menu-row', menuStyles).get('height'), undefined);
  assert.equal(declarationsFor('.home-menu-pick', menuStyles).get('width'), '44px');
  assert.equal(declarationsFor('.home-menu-pick', menuStyles).get('height'), '44px');
  assert.equal(declarationsFor('.set-pick-list').get('gap'), '0');
  assert.equal(declarationsFor('.set-pick-row').get('padding'), `${rowPadding} 0`);
  assert.equal(declarationsFor('.set-pick-row.share-pick-row', componentStyles('ShareSheet')).get('padding'), `${rowPadding} 12px`);
});

test('removing list separators keeps selection actions and ingredient rules intact', () => {
  const setEditor = readFileSync(new URL('../src/components/SetEditor.vue', import.meta.url), 'utf8');
  assert.match(setEditor, /:aria-pressed="selected.includes\(recipe.id\)"/);
  assert.match(setEditor, /toggle\(recipe.id\)/);
  const addition = readFileSync(new URL('../src/components/AddDishesSheet.vue', import.meta.url), 'utf8');
  assert.match(addition, /:aria-pressed="Boolean\(cart\[entry.key\]\)"/);
  assert.match(addition, /@click="toggle\(entry\)"/);
  assert.equal(declarationsFor('.ingredient-row').get('border-bottom'), '1px solid var(--line)');
});
