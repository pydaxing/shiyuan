import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const stylesheet = postcss.parse(readFileSync(join(sourceRoot, 'styles.css'), 'utf8'));
const radiusProperty = /^border(?:-[a-z]+-[a-z]+)?-radius$/;

function declarationsFor(selector, styles = stylesheet) {
  const declarations = new Map();
  styles.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

function componentStyles(name) {
  const component = parse(readFileSync(join(sourceRoot, 'components', `${name}.vue`), 'utf8'));
  return postcss.parse(component.descriptor.styles.map(style => style.content).join('\n'));
}

function collectStyles(directory = sourceRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) return collectStyles(filename);
    if (!/\.(?:css|vue)$/.test(entry.name)) return [];
    const source = readFileSync(filename, 'utf8');
    const styles = entry.name.endsWith('.vue') ? parse(source).descriptor.styles.map(style => style.content) : [source];
    return styles.map(style => ({ filename: relative(sourceRoot, filename), styles: postcss.parse(style) }));
  });
}

test('shared radius scale is restrained and its image aliases match the maintained design contract', () => {
  const tokens = declarationsFor('.app-shell');
  const expected = {
    '--radius-subtle': '3px',
    '--radius-small': '4px',
    '--radius-control': '6px',
    '--radius-card': '8px',
    '--radius-sheet': '12px',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(tokens.get(name), value, name);
  assert.equal(tokens.get('--radius-card-inset'), 'calc(var(--radius-card) - 1px)');
  assert.equal(tokens.get('--food-photo-radius'), 'var(--radius-small)');
  assert.equal(tokens.get('--feed-cover-radius'), 'var(--radius-control)');
  const design = readFileSync(new URL('../DESIGN.md', import.meta.url), 'utf8');
  const rounded = design.match(/\nrounded:\n([\s\S]*?)\n---/)[1];
  for (const [name, value] of Object.entries({ subtle: '3px', small: '4px', control: '6px', primaryAction: '6px', cover: '8px', sheet: '12px', foodThumbnail: '4px', feedCover: '6px' })) {
    assert.match(rounded, new RegExp(`^  ${name}: ${value}$`, 'm'));
  }
});

test('all app-owned rectangular corners use shared tokens rather than isolated large radii', () => {
  const intrinsicShapes = new Set(['.nav-count', '.segment-count', '.cart-count', '.feature-switch::before', '.chef-hat', '.avatar-chef-mark']);
  let inspected = 0;
  for (const { filename, styles } of collectStyles()) {
    styles.walkDecls(radiusProperty, declaration => {
      inspected += 1;
      if (/var\(|inherit|%|999px/.test(declaration.value) || intrinsicShapes.has(declaration.parent.selector)) return;
      const fixedCorners = [...declaration.value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].map(match => Number(match[1]));
      assert.ok(fixedCorners.every(value => value < 4), `${filename}: ${declaration.parent.selector} must use a shared corner token, got ${declaration.value}`);
    });
  }
  assert.ok(inspected > 250);
});

test('main pages, forms, uploads and details share the same control and card corner tiers', () => {
  for (const selector of ['.primary-button', '.secondary-button', '.recipe-detail-button', '.search-wrap', '.input', '.textarea', '.input.choice-trigger', '.choice-options button', '.step-entry-fields', '.reservation-days button']) {
    assert.equal(declarationsFor(selector).get('border-radius'), 'var(--radius-control)', selector);
  }
  for (const selector of ['.order-card', '.family-banner', '.stock-card', '.zone-card', '.detail-cover', '.image-upload', '.step-editor', '.selection-dock', '.entry-card', '.invitation-paper', '.shared-recipe-card', '.cloud-card']) {
    assert.equal(declarationsFor(selector).get('border-radius'), 'var(--radius-card)', selector);
  }
  assert.equal(declarationsFor('.community-waterfall .feed-card').get('border-radius'), 'var(--feed-cover-radius)');
  assert.equal(declarationsFor('.community-waterfall .feed-cover').get('border-radius'), 'var(--feed-cover-radius)');
});

test('scoped menu, family and add-dishes surfaces cannot retain the previous larger corners', () => {
  for (const [component, selector, radius] of [
    ['HomeMenu', '.home-menu-category', 'var(--radius-control)'],
    ['HomeWelcome', '.home-welcome-cover .home-welcome-frame', 'var(--radius-small)'],
    ['FamilyManagement', '.family-choice-cover', 'var(--radius-small)'],
    ['ImageCropper', '.cover-crop-frame', 'var(--radius-card)'],
    ['FoodThumbnail', '.food-thumbnail', 'var(--food-photo-radius)'],
  ]) {
    assert.equal(declarationsFor(selector, componentStyles(component)).get('border-radius'), radius, component);
  }
  assert.equal(declarationsFor('.meal-addition-search.search-wrap').get('border-radius'), 'var(--search-radius)');
  assert.equal(declarationsFor('.meal-addition-search', componentStyles('AddDishesSheet')).size, 0);
});

test('family members reuse the shared white bordered card without adding nested frames or cramped spacing', () => {
  const panel = new Map([...declarationsFor('.feature-panel'), ...declarationsFor('.feature-panel.family-members-panel')]);
  assert.equal(panel.get('border'), '1px solid var(--line)');
  assert.equal(panel.get('border-radius'), declarationsFor('.cooking-diary').get('border-radius'));
  assert.equal(panel.get('background'), declarationsFor('.feature-panel.family-preferences').get('background'));
  assert.equal(panel.get('margin'), '16px 0 0');
  assert.equal(panel.get('padding'), '14px 12px 12px');
  assert.equal(panel.has('height'), false);
  assert.equal(panel.has('overflow'), false);
  assert.equal(panel.has('box-shadow'), false);
  assert.equal(declarationsFor('.family-view .family-members-heading').get('margin'), '0 0 10px');
  assert.equal(declarationsFor('.family-member-grid').get('grid-template-columns'), 'repeat(4, minmax(0, 1fr))');
  assert.equal(declarationsFor('.family-member-grid .member-card').get('border'), '0');
});

test('sheet corners keep desktop and bottom-sheet geometry while inset images fit their parent border', () => {
  const sheetRules = [];
  stylesheet.walkRules(rule => {
    if (rule.selectors.includes('.sheet')) rule.walkDecls('border-radius', declaration => sheetRules.push(declaration.value));
  });
  assert.ok(sheetRules.length >= 4);
  assert.ok(sheetRules.every(value => ['var(--radius-sheet)', 'var(--radius-sheet) var(--radius-sheet) 0 0'].includes(value)));
  assert.equal(declarationsFor('.invitation-cover').get('border-radius'), 'var(--radius-card-inset) var(--radius-card-inset) 0 0');
  assert.equal(declarationsFor('.meal-tabs').get('border-radius'), 'var(--radius-control)');
  assert.equal(declarationsFor('.meal-tabs button').get('border-radius'), 'var(--radius-small)');
  assert.equal(declarationsFor('.step-entry-fields .input').get('border-radius'), '0');
});

test('circular avatars, photo capsules, switch tracks and full touch targets remain intact', () => {
  for (const selector of ['.member-photo', '.home-menu-add', '.detail-toolbar-button', '.feature-switch > view', '.family-banner-edit']) {
    assert.equal(declarationsFor(selector).get('border-radius'), '50%', selector);
  }
  assert.equal(declarationsFor('.feature-switch::before').get('border-radius'), '20px');
  assert.equal(declarationsFor('.feed-cover-category').get('border-radius'), '999px');
  assert.equal(declarationsFor('.recipe-cover-tag').get('border-radius'), '999px');
  assert.equal(declarationsFor('.cover-image-picker:not(.compact-image-picker) .upload-caption', componentStyles('ImagePicker')).get('border-radius'), '999px');
  assert.equal(declarationsFor('.profile-avatar-frame', componentStyles('ProfileFields')).get('border-radius'), '50%');
  for (const selector of ['.primary-button', '.secondary-button', '.community-waterfall .feed-body']) {
    assert.equal(declarationsFor(selector).get('min-height'), '44px', selector);
  }
});

test('family edit has a subtle 32px circle without shrinking the original 44px touch target', () => {
  const button = declarationsFor('.family-banner-edit');
  assert.equal(button.get('width'), '44px');
  assert.equal(button.get('height'), '44px');
  assert.equal(button.get('min-height'), '44px');
  assert.equal(button.get('flex'), '0 0 44px');
  assert.equal(button.get('border-radius'), '50%');
  assert.equal(button.get('background'), 'transparent');
  assert.equal(button.get('border'), '0');
  assert.equal(button.get('box-shadow'), 'none');
  const surface = declarationsFor('.family-banner-edit .action-icon-circle');
  assert.equal(surface.get('width'), '32px');
  assert.equal(surface.get('height'), '32px');
  assert.equal(surface.get('flex'), '0 0 32px');
  assert.equal(surface.get('background'), 'var(--control-accent)');
  const shared = declarationsFor('.action-icon-circle');
  assert.equal(shared.get('border-radius'), '50%');
  assert.equal(shared.get('align-items'), 'center');
  assert.equal(shared.get('justify-content'), 'center');
});
