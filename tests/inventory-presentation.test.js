import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computed, ref } from 'vue';
import * as Vue from 'vue';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import postcss from 'postcss';
import sharp from 'sharp';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { expiryLabel, isExpired, formatAmount, localDate } from '../src/domain/kitchen.js';
import { ingredientImage } from '../src/domain/presentation.js';
import { coverFrameStyle } from '../src/domain/image-crop.js';
import { isPendingRecord, presentMutation } from '../src/services/mutation-feedback.js';

const source = readFileSync(new URL('../src/components/InventoryView.vue', import.meta.url), 'utf8');
const script = parse(source).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
const compiled = compileTemplate({ source: parse(source).descriptor.template.content, filename: 'inventory-presentation-test.vue', id: 'inventory-presentation-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const render = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => name });

function allNodes(node) {
  if (Array.isArray(node)) return node.flatMap(allNodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(allNodes) : [])];
}

function renderInventory(current) {
  const context = Vue.proxyRefs({ ...current, embedded: true, today: localDate(), expiring: 0, expired: 0, expiryLabel, isExpired, formatAmount, ingredientImage, coverFrameStyle, $image: path => path });
  return allNodes(render(context, []));
}

function declarationsFor(selector) {
  const declarations = new Map();
  styles.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

function inventoryView(inventory = [], overrides = {}) {
  const state = ref({ inventory });
  const bindings = { computed, ref, state, localDate, isPendingRecord, presentMutation, defineProps: () => ({ embedded: false, today: localDate() }), ...overrides };
  const current = new Function(...Object.keys(bindings), `${script}\nreturn { locations, location, filtered, countAt, locationTone, addAt, initialStock, editing, remove, editPhoto, photoBatch, photo };`)(...Object.values(bindings));
  return { state, ...current };
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test('fridge illustrations do not apply absolute positioning to action icons', () => {
  assert.match(source, /<image class="zone-illustration"[^>]*aria-hidden="true"/);
  styles.walkRules(rule => {
    for (const selector of rule.selectors) assert.doesNotMatch(selector, /\.zone-(?:card|filter)\s+image\b/);
  });
  const button = declarationsFor('.zone-add');
  assert.equal(button.get('width'), '44px');
  assert.equal(button.get('height'), '44px');
  assert.equal(button.get('padding'), '0');
  assert.equal(button.get('align-items'), 'center');
  assert.equal(button.get('justify-content'), 'center');
  assert.equal(declarationsFor('.zone-add .app-icon').get('position'), 'relative');
  assert.equal(declarationsFor('.zone-add .app-icon').get('width'), '18px');
  assert.equal(declarationsFor('.zone-add::before').get('transform'), 'translate(-50%, -50%)');
});

test('storage categories and individual stock rows share one location-to-tone mapping', () => {
  const current = inventoryView();
  assert.deepEqual(current.locations.map(zone => [zone.name, current.locationTone(zone.name)]), [
    ['冷藏', 'fresh'], ['冷冻', 'frozen'], ['常温', 'pantry'], ['全部', 'all'],
  ]);
  assert.equal(current.locationTone('未知位置'), 'all');
  assert.equal(current.locationTone(undefined), 'all');
  assert.match(source, /:class="\[zone\.tone, \{ selected: location === zone\.name \}\]"/);
  assert.match(source, /:class="\[locationTone\(batch\.location\), \{ expired: isExpired\(batch, today\) \}\]"/);
  assert.equal(declarationsFor('.zone-card').get('background'), 'var(--storage-zone-surface)');
  assert.equal(declarationsFor('.stock-card').get('background'), 'var(--white)');
  assert.equal(declarationsFor('.stock-location').get('color'), 'var(--storage-ink)');
});

test('storage palettes are pale, distinct and readable with subtler stock-row backgrounds', () => {
  const zoneColors = new Set();
  const rowColors = new Set();
  for (const selector of ['.inventory-view', '.inventory-view .fresh', '.inventory-view .frozen', '.inventory-view .pantry']) {
    const palette = declarationsFor(selector);
    const zone = palette.get('--storage-zone-surface');
    const row = palette.get('--storage-row-surface');
    const ink = palette.get('--storage-ink');
    zoneColors.add(zone);
    rowColors.add(row);
    assert.ok(luminance(zone) > 0.88, selector);
    assert.ok(luminance(row) > luminance(zone), selector);
    for (const background of [zone, row]) assert.ok((luminance(background) + 0.05) / (luminance(ink) + 0.05) >= 4.5, selector);
  }
  assert.equal(zoneColors.size, 4);
  assert.equal(rowColors.size, 4);
});

test('category selection remains separate from add actions and preserves filtered inventory', () => {
  const inventory = [{ id: 'chilled', location: '冷藏' }, { id: 'frozen', location: '冷冻' }, { id: 'pantry', location: '常温' }];
  const current = inventoryView(inventory);
  assert.equal(current.countAt('全部'), 3);
  for (const location of ['冷藏', '冷冻', '常温']) {
    current.location.value = location;
    assert.equal(current.countAt(location), 1);
    assert.deepEqual(current.filtered.value.map(batch => batch.location), [location]);
    current.addAt(location);
    assert.equal(current.initialStock.value.location, location);
    assert.equal(current.editing.value, true);
    assert.equal(current.location.value, location);
  }
  current.addAt('全部');
  assert.equal(current.initialStock.value.location, '冷藏');
  assert.deepEqual(current.state.value.inventory, inventory);
  assert.match(source, /:aria-pressed="location === zone\.name"/);
  assert.match(source, /<AppIcon v-if="location === zone\.name" class="zone-selected"/);
  assert.match(source, /<\/button>\s*<button role="button" class="zone-add"/);
});

test('empty fridge and procurement share a large icon without a background, circle or shadow', () => {
  const current = inventoryView();
  const nodes = renderInventory(current);
  const empty = nodes.find(node => node.props?.class === 'inventory-empty');
  assert.ok(empty);
  const artwork = allNodes(empty).find(node => node.props?.class === 'supplies-empty-art');
  assert.ok(artwork);
  const icon = allNodes(artwork).find(node => node.type === 'AppIcon');
  assert.equal(icon.props.name, 'inventory');
  assert.equal(icon.props.size, 50);
  assert.ok(readFileSync(new URL('../src/static/icon-inventory.png', import.meta.url)).length);
  const surface = declarationsFor('.inventory-empty');
  assert.equal(surface.get('background'), 'transparent');
  assert.equal(surface.get('border'), '0');
  assert.equal(surface.get('box-shadow'), 'none');
  assert.equal(surface.get('align-items'), 'center');
  const art = declarationsFor('.supplies-empty-art');
  assert.equal(art.get('width'), '64px');
  assert.equal(art.get('height'), '64px');
  assert.equal(art.get('margin'), '0 0 16px');
  assert.equal(declarationsFor('.inventory-empty .secondary-button').get('margin'), '0');
  assert.equal(art.get('background'), 'transparent');
  assert.equal(art.get('border-radius'), '0');
  assert.equal(art.get('border'), '0');
  assert.equal(art.get('box-shadow'), 'none');
  assert.match(readFileSync(new URL('../src/components/ShoppingView.vue', import.meta.url), 'utf8'), /class="shopping-empty-art supplies-empty-art"/);
});

test('empty fridge artwork follows the selected category and never replaces existing stock', () => {
  const current = inventoryView([{ id: 'chilled', name: '番茄', quantity: 1, unit: '个', location: '冷藏' }]);
  for (const [location, empty] of [['全部', false], ['冷藏', false], ['冷冻', true], ['常温', true]]) {
    current.location.value = location;
    const nodes = renderInventory(current);
    assert.equal(nodes.some(node => node.props?.class === 'inventory-empty'), empty);
    assert.equal(nodes.filter(node => node.props?.class?.split(' ').includes('stock-card')).length, empty ? 0 : 1);
  }
  assert.equal(current.state.value.inventory.length, 1);
});

test('empty fridge action pairs a small plus icon with its label and opens the existing stock editor', () => {
  for (const location of ['全部', '冷藏', '冷冻', '常温']) {
    const current = inventoryView();
    current.location.value = location;
    const nodes = renderInventory(current);
    assert.equal(nodes.some(node => node.type === 'text' && node.children === '冰箱空空如也'), false);
    assert.equal(nodes.find(node => node.props?.class === 'inventory-empty').props['aria-label'], '冰箱空空如也');
    assert.equal(nodes.some(node => node.children === '这里还没有食材' || node.children === '记录食材'), false);
    const action = nodes.find(node => node.type === 'button' && allNodes(node).some(child => child.type === 'text' && child.children === '放入冰箱'));
    assert.ok(action);
    const icons = allNodes(action).filter(node => node.type === 'AppIcon');
    assert.equal(icons.length, 1);
    assert.equal(icons[0].props.name, 'plus');
    assert.equal(icons[0].props.size, 18);
    assert.equal(icons[0].props.active, '');
    assert.equal(action.props.class, 'secondary-button');
    assert.equal(action.props['hover-class'], 'touch-feedback');
    action.props.onClick();
    assert.equal(current.editing.value, true);
    assert.equal(current.initialStock.value.location, location === '全部' ? '冷藏' : location);
    assert.equal(current.location.value, location);
    assert.deepEqual(current.state.value.inventory, []);
  }
  const button = declarationsFor('.secondary-button');
  assert.equal(button.get('display'), 'inline-flex');
  assert.equal(button.get('align-items'), 'center');
  assert.equal(button.get('justify-content'), 'center');
  assert.equal(button.get('gap'), '7px');
  assert.equal(button.get('min-height'), '44px');
  assert.ok(readFileSync(new URL('../src/static/icon-plus-active.png', import.meta.url)).length);
});

test('stock sections omit the duplicate view-all action while the all zone still resets filtering', () => {
  const inventory = ['冷藏', '冷冻', '常温'].map((location, index) => ({ id: `stock-${index}`, name: '番茄', quantity: 1, unit: '个', location }));
  for (const location of ['全部', '冷藏', '冷冻', '常温']) {
    const current = inventoryView(inventory);
    current.location.value = location;
    const nodes = renderInventory(current);
    const section = nodes.find(node => node.props?.class === 'section-line');
    assert.equal(allNodes(section).some(node => node.type === 'button'), false);
    assert.equal(nodes.some(node => node.children === '查看全部'), false);
    assert.equal(nodes.filter(node => node.props?.class?.split(' ').includes('stock-card')).length, location === '全部' ? 3 : 1);
    const allZone = nodes.find(node => node.props?.class === 'zone-filter' && node.props['aria-label'] === '查看全部食材');
    assert.ok(allZone);
    allZone.props.onClick();
    assert.equal(current.location.value, '全部');
    assert.equal(current.filtered.value.length, 3);
    assert.deepEqual(current.state.value.inventory, inventory);
  }
});

test('expired warnings, stock-photo editing and removal retain their existing semantics', () => {
  assert.match(source, /v-if="expired" class="danger"/);
  assert.match(source, /class="expiry" :class="\{ danger: isExpired\(batch, today\) \}"/);
  assert.match(source, /@click="editPhoto\(batch\)"/);
  assert.match(source, /@click\.stop="remove\(batch\)"/);
  assert.match(source, /:aria-label="`删除\$\{batch\.name\}`"/);
  assert.match(source, /<AppIcon name="trash-danger" :size="18"/);
  assert.match(source, /if \(result\.confirm\) runAction\(\(\) => removeStock\(batch\.id\)\)/);
  assert.equal(declarationsFor('.stock-card .card-remove').get('position'), 'absolute');
  assert.equal(declarationsFor('.stock-card .card-remove').get('width'), '44px');
  assert.equal(declarationsFor('.stock-card .card-remove').get('height'), '44px');
  assert.equal(declarationsFor('.stock-photo').get('width'), '100%');
  assert.equal(declarationsFor('.stock-photo').get('height'), 'auto');
});

test('stock remains a two-column outlined photo-card grid with one-line names on mobile', () => {
  const grid = declarationsFor('.stock-grid');
  assert.equal(grid.get('grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
  assert.equal(grid.get('gap'), '12px');
  const card = declarationsFor('.stock-card');
  assert.equal(card.get('flex-direction'), 'column');
  assert.equal(card.get('align-items'), 'stretch');
  assert.equal(card.get('background'), 'var(--white)');
  assert.equal(card.get('border'), '1px solid var(--line)');
  assert.equal(card.get('padding'), '0');
  assert.equal(card.get('min-width'), '0');
  const title = declarationsFor('.stock-heading .stock-name');
  assert.equal(title.get('min-width'), '0');
  assert.equal(title.get('white-space'), 'nowrap');
  assert.equal(title.get('text-overflow'), 'ellipsis');
  assert.equal(declarationsFor('.stock-heading').get('flex-wrap'), 'nowrap');
  assert.equal(declarationsFor('.stock-description').get('justify-content'), 'space-between');
});

test('stock photos reserve the shared cover ratio while built-in illustrations remain fully visible', () => {
  const inventory = [
    { id: 'photo', name: '自家番茄', quantity: 300, unit: 'g', location: '冷藏', image: 'cloud://stock-photo' },
    { id: 'illustration', name: '番茄', quantity: 2, unit: '个', location: '常温' },
  ];
  const nodes = renderInventory(inventoryView(inventory));
  const photos = nodes.filter(node => node.props?.class === 'stock-photo');
  assert.equal(photos.length, 2);
  for (const photo of photos) assert.deepEqual(photo.props.style, coverFrameStyle('recipe'));
  const images = photos.map(photo => allNodes(photo).find(node => node.type === 'LazyImage'));
  assert.equal(images[0].props.src, inventory[0].image);
  assert.equal(images[0].props.mode, 'aspectFill');
  assert.equal(images[1].props.src, ingredientImage('番茄'));
  assert.equal(images[1].props.mode, 'aspectFit');
  for (const image of images) {
    assert.equal(image.props.style.position, 'absolute');
    assert.equal(image.props.style.background, 'var(--white)');
  }
  assert.equal(nodes.filter(node => node.props?.class === 'stock-body').length, 2);
});

test('the fridge trash action confirms deletion while photo editing and cancelling never remove stock', () => {
  const batch = { id: 'tomatoes', name: '番茄', image: 'tomatoes.jpg' };
  const modals = [];
  const removed = [];
  const current = inventoryView([batch], {
    NATIVE_UI_COLORS,
    uni: { showModal: options => modals.push(options) },
    runAction: action => action(),
    removeStock: batchId => removed.push(batchId),
  });
  current.editPhoto(batch);
  assert.equal(current.photoBatch.value.id, batch.id);
  assert.equal(current.photo.value, batch.image);
  assert.deepEqual(modals, []);
  current.remove(batch);
  assert.equal(modals[0].title, '删除番茄？');
  assert.equal(modals[0].confirmText, '删除');
  assert.equal(modals[0].confirmColor, NATIVE_UI_COLORS.danger);
  assert.match(modals[0].content, /整个食材批次.*不影响餐单和备菜状态/);
  assert.deepEqual(removed, []);
  modals[0].success({ confirm: false });
  assert.deepEqual(removed, []);
  current.remove(batch);
  modals[1].success({ confirm: true });
  assert.deepEqual(removed, [batch.id]);
});

test('freshness notice uses an independent pale rose surface without recoloring storage categories', () => {
  const surface = declarationsFor('.inventory-view').get('--inventory-alert-surface');
  const notice = declarationsFor('.freshness-notice');
  assert.equal(surface, '#fbf1ef');
  assert.equal(declarationsFor('.inventory-view .pantry').get('--storage-zone-surface'), '#faf4e8');
  assert.equal(notice.get('background'), 'var(--inventory-alert-surface)');
  assert.equal(notice.get('color'), 'var(--danger)');
  assert.equal(notice.get('border'), '0');
  assert.equal(notice.get('box-shadow'), 'none');
  assert.ok((luminance(surface) + 0.05) / (luminance(NATIVE_UI_COLORS.danger) + 0.05) >= 4.5);
  assert.equal(declarationsFor('.freshness-notice-text').get('flex-wrap'), 'wrap');
  assert.equal(declarationsFor('.freshness-notice-icon').get('flex'), '0 0 16px');
  assert.match(source, /v-if="expiring \|\| expired" class="freshness-notice" role="status"/);
  assert.match(source, /<AppIcon class="freshness-notice-icon" name="alert-danger" :size="16"/);
});

test('freshness warning icon is packaged in both native states with the semantic danger color', async () => {
  const expected = NATIVE_UI_COLORS.danger.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
  for (const suffix of ['', '-active']) {
    const { data, info } = await sharp(readFileSync(new URL(`../src/static/icon-alert-danger${suffix}.png`, import.meta.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 96);
    assert.equal(info.height, 96);
    let visiblePixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3] !== 255) continue;
      assert.deepEqual([...data.subarray(offset, offset + 3)], expected);
      visiblePixels += 1;
    }
    assert.ok(visiblePixels > 100);
  }
});
