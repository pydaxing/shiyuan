import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { parse } from '@vue/compiler-sfc';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = filename => readFileSync(join(root, filename), 'utf8');
const globalStyles = postcss.parse(source('src/styles.css'));
const componentStyles = name => postcss.parse(parse(source(`src/components/${name}.vue`)).descriptor.styles.map(style => style.content).join('\n'));
const sizes = { caption: 12, meta: 13, control: 14, body: 15, list: 15, input: 16, section: 16, heading: 18, title: 20, display: 22 };
const widths = [320, 360, 374, 375, 390, 430, 760, 761];

function filesUnder(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const styleSources = filesUnder('src').filter(filename => /\.(css|vue)$/.test(filename)).flatMap(filename => {
  const content = source(filename);
  const sheets = filename.endsWith('.css') ? [content] : parse(content).descriptor.styles.map(style => style.content);
  return sheets.map(content => ({ filename, stylesheet: postcss.parse(content) }));
});

function matchesWidth(rule, width) {
  let parent = rule.parent;
  while (parent) {
    if (parent.type === 'atrule' && parent.name === 'media') {
      const maximum = parent.params.match(/max-width:\s*(\d+)px/);
      const minimum = parent.params.match(/min-width:\s*(\d+)px/);
      if ((maximum && width > Number(maximum[1])) || (minimum && width < Number(minimum[1]))) return false;
    }
    parent = parent.parent;
  }
  return true;
}

function declarations(selector, stylesheet = globalStyles, width = 390) {
  const values = new Map();
  stylesheet.walkRules(rule => {
    if (!rule.selectors.includes(selector) || !matchesWidth(rule, width)) return;
    rule.walkDecls(declaration => values.set(declaration.prop, declaration.value));
  });
  return values;
}

test('the type scale is owned by all application roots including detached sheets', () => {
  for (const width of widths) {
    for (const selector of [':root', 'page', '.app-shell']) {
      const tokens = declarations(selector, globalStyles, width);
      for (const [role, pixels] of Object.entries(sizes)) assert.equal(tokens.get(`--type-${role}`), `${pixels}px`, `${selector} ${role} at ${width}`);
    }
  }
  for (const { filename, stylesheet } of styleSources) {
    stylesheet.walkDecls(/^--type-/, declaration => {
      assert.equal(filename, 'src/styles.css');
      assert.equal(declaration.parent.parent.type, 'root');
    });
  }
});

test('all application font sizes use the shared readable scale rather than independent pixels or viewport units', () => {
  let checked = 0;
  for (const { filename, stylesheet } of styleSources) {
    stylesheet.walkDecls('font-size', declaration => {
      if (declaration.value === 'inherit') return;
      const role = declaration.value.match(/^var\(--type-([a-z]+)\)$/)?.[1];
      assert.ok(role in sizes, `${filename}: ${declaration.parent.selector}: ${declaration.value}`);
      assert.ok(sizes[role] >= 12 && sizes[role] <= 22);
      checked += 1;
    });
    stylesheet.walkDecls(/^(font|text-size-adjust|-webkit-text-size-adjust)$/, declaration => {
      assert.notEqual(declaration.prop, 'font', `${filename} bypasses the shared scale`);
      assert.notEqual(declaration.value, 'none', `${filename} disables user text sizing`);
    });
  }
  assert.ok(checked > 0, 'The audit must inspect application font-size declarations');
});

test('headings, form labels and controls retain the same hierarchy across narrow and regular screens', () => {
  const expected = {
    '.page-heading': 'heading', '.sheet-title': 'heading', '.subheading': 'section', '.field-label': 'section',
    '.input': 'input', '.textarea': 'input', '.ingredient-editor .input': 'input', '.optional-label': 'meta',
    '.primary-button': 'control', '.secondary-button': 'control', '.search-empty-hint': 'control',
    '.home-menu-search .home-menu-search-input': 'control', '.community-search .form-field input': 'control',
  };
  for (const width of widths) {
    for (const [selector, role] of Object.entries(expected)) {
      if (selector === '.ingredient-editor .input' && width > 760) continue;
      assert.equal(declarations(selector, globalStyles, width).get('font-size'), `var(--type-${role})`, `${selector} at ${width}`);
    }
    assert.equal(declarations('.input', globalStyles, width).get('font-weight'), '400');
    assert.equal(declarations('.textarea', globalStyles, width).get('font-weight'), '400');
  }
});

test('food titles share one compact size across menu, kitchen, food, procurement and diary while details wrap', () => {
  const sources = [
    [globalStyles, ['.community-waterfall .feed-title', '.meal-dish-copy .stock-name', '.stock-heading .stock-name', '.set-pick-row .stock-name', '.diary-recipe']],
    [componentStyles('MenuSwipeRow'), ['.home-menu-title']],
    [globalStyles, ['.meal-ingredient-title']],
  ];
  for (const width of widths) {
    for (const [stylesheet, selectors] of sources) {
      for (const selector of selectors) assert.equal(declarations(selector, stylesheet, width).get('font-size'), 'var(--type-list)', `${selector} at ${width}`);
    }
  }
  assert.equal(declarations('.food-list-title').get('white-space'), 'nowrap');
  assert.equal(declarations('.food-list-title').get('text-overflow'), 'ellipsis');
  assert.equal(declarations('.sheet-title').get('overflow-wrap'), 'anywhere');
  assert.equal(declarations('.recipe-step-copy .step-title').get('overflow-wrap'), 'anywhere');
});

test('welcome typography does not jump or squeeze line height at narrow breakpoints', () => {
  const stylesheet = componentStyles('HomeWelcome');
  for (const width of widths) {
    assert.equal(declarations('.home-welcome-title', stylesheet, width).get('font-size'), 'var(--type-title)');
    assert.equal(declarations('.is-compact .home-welcome-title', stylesheet, width).get('font-size'), 'var(--type-heading)');
    for (const selector of ['.home-welcome-title', '.is-compact .home-welcome-title']) assert.equal(declarations(selector, stylesheet, width).get('line-height'), '1.5');
  }
});

test('narrow ingredient editors reflow name and amount instead of shrinking input fonts or delete targets', () => {
  const template = parse(source('src/components/RecipeEditor.vue')).descriptor.template.content;
  for (const name of ['name', 'quantity', 'unit']) assert.match(template, new RegExp(`class="ingredient-${name}-field"`));
  for (const width of [320, 360]) {
    const layout = selector => declarations(selector, globalStyles, width);
    assert.equal(layout('.ingredient-editor').get('grid-template-columns'), 'minmax(0, 1fr) 84px 44px');
    assert.equal(layout('.ingredient-editor').get('gap'), '8px');
    assert.equal(layout('.ingredient-editor:not(.text-amount-editor) > .ingredient-name-field').get('grid-column'), '1 / 3');
    assert.equal(layout('.ingredient-editor:not(.text-amount-editor) > .ingredient-quantity-field').get('grid-row'), '2');
    assert.equal(layout('.ingredient-editor:not(.text-amount-editor) > .ingredient-unit-field').get('grid-row'), '2');
    assert.equal(layout('.ingredient-editor .icon-button').get('width'), '44px');
    assert.equal(layout('.ingredient-editor .icon-button').get('height'), '44px');
    assert.equal(layout('.ingredient-editor .input').get('font-size'), 'var(--type-input)');
  }
  assert.equal(declarations('.ingredient-editor').get('grid-template-columns'), 'minmax(0, 1fr) 62px 76px 44px');
  assert.equal(declarations('.form-grid').get('grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
  assert.equal(declarations('.form-grid > .field-label').get('min-width'), '0');
  assert.equal(declarations('.recipe-field-heading').get('flex-wrap'), 'wrap');
});

test('direct preparation lists keep readable compact fields and full-sized deletion targets', () => {
  const template = parse(source('src/components/DishPreparationEditor.vue')).descriptor.template.content;
  const stylesheet = componentStyles('DishPreparationEditor');
  for (const name of ['name', 'quantity', 'unit']) assert.match(template, new RegExp(`class="preparation-${name}-field"`));
  for (const width of widths) {
    const layout = selector => declarations(selector, stylesheet, width);
    assert.equal(layout('.preparation-edit-fields').get('grid-template-columns'), 'minmax(0, 1fr) var(--preparation-quantity-width) var(--preparation-unit-width) 44px');
    assert.equal(layout('.preparation-material-header').get('grid-template-columns'), layout('.preparation-edit-fields').get('grid-template-columns'));
    assert.equal(layout('.preparation-inline-editor').get('--preparation-quantity-width'), width <= 360 ? '46px' : '52px');
    assert.equal(layout('.preparation-inline-editor').get('--preparation-unit-width'), width <= 360 ? '48px' : '58px');
    assert.equal(layout('.preparation-edit-fields.text-amount-editor .preparation-unit-field').get('grid-column'), '2 / 4');
    assert.equal(declarations('.input.preparation-material-input', globalStyles, width).get('font-size'), 'var(--type-meta)');
    assert.equal(declarations('.input.preparation-material-input', globalStyles, width).get('min-height'), '44px');
    assert.equal(layout('.preparation-remove').get('width'), '44px');
    assert.equal(layout('.preparation-remove').get('min-height'), '44px');
    assert.equal(layout('.preparation-remove').get('background'), 'transparent');
  }
  assert.equal(declarations('.input.preparation-material-input').get('padding'), '0');
  assert.equal(declarations('.input.preparation-material-input').get('margin'), '0');
  assert.equal(declarations('.input.preparation-material-input').get('border'), '0');
  assert.equal(declarations('.input.preparation-material-quantity').get('text-align'), 'right');
});

test('profile labels can stack on narrow screens without changing avatar alignment or nickname input behavior', () => {
  const stylesheet = componentStyles('ProfileFields');
  for (const width of [320, 360]) {
    assert.equal(declarations('.profile-nickname-field', stylesheet, width).get('flex-direction'), 'column');
    assert.equal(declarations('.profile-nickname-field', stylesheet, width).get('align-items'), 'stretch');
    assert.equal(declarations('.profile-field-heading', stylesheet, width).get('flex-basis'), 'auto');
  }
  assert.equal(declarations('.profile-nickname-field', stylesheet, 390).get('flex-direction'), undefined);
  assert.equal(declarations('.profile-photo-actions', stylesheet).get('justify-content'), 'center');
});

test('prep labelled actions keep compact type and forty-four pixel targets without square checkbox faces', () => {
  const stylesheet = componentStyles('MealPreparationSheet');
  assert.equal(declarations('.prep-servings', stylesheet).get('font-size'), 'var(--type-caption)');
  assert.equal(declarations('.prep-cart-button', stylesheet).get('font-size'), 'var(--type-control)');
  assert.equal(declarations('.prep-cart-button', stylesheet).get('min-height'), '44px');
  assert.equal(declarations('.prep-cart-button', stylesheet).get('border-radius'), 'var(--radius-control)');
  const readyStyles = componentStyles('DishReadyButton');
  assert.equal(declarations('.dish-ready-button', readyStyles).get('width'), '100%');
  assert.equal(declarations('.dish-ready-button', readyStyles).get('min-height'), '44px');
  assert.equal(declarations('.dish-ready-button', readyStyles).get('font-size'), 'var(--type-control)');
  assert.equal(declarations('.dish-ready-button', readyStyles).get('border'), '1px solid var(--line)');
  assert.equal(declarations('.dish-ready-button', readyStyles).get('line-height'), '22px');
  assert.equal(declarations('.prep-cart-button', stylesheet).get('line-height'), '22px');
  assert.equal(declarations('.prep-card-actions', stylesheet).get('gap'), '8px');
  assert.equal(declarations('.shopping-package-meta', componentStyles('ShoppingView')).get('font-size'), 'var(--type-caption)');
  assert.equal(declarations('.order-progress-actions').get('flex-wrap'), 'wrap');
});
