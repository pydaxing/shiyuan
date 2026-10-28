import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';

const source = readFileSync(new URL('../src/components/ShareSheet.vue', import.meta.url), 'utf8');
const descriptor = parse(source).descriptor;
const stylesheet = postcss.parse(descriptor.styles.map(style => style.content).join('\n'));
const nodes = [];
function walk(node) {
  if (node.type !== 1) return;
  nodes.push(node);
  node.children.forEach(walk);
}
baseParse(descriptor.template.content).children.forEach(walk);
const hasClass = (node, name) => node?.props.some(prop => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
const findClass = name => nodes.find(node => hasClass(node, name));
function declarationsFor(selector) {
  const declarations = new Map();
  stylesheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('share rows use compact vertical spacing while retaining horizontal gutters and disabled styling', () => {
  assert.ok(descriptor.styles.every(style => style.scoped));
  assert.ok(hasClass(findClass('share-pick-row'), 'set-pick-row'));
  assert.equal(declarationsFor('.set-pick-row.share-pick-row').get('padding'), 'var(--food-row-padding) 12px');
  assert.equal(declarationsFor('.set-pick-row.share-pick-row').get('gap'), '12px');
  assert.equal(declarationsFor('.set-pick-row.share-pick-row').get('background'), 'transparent');
  assert.equal(declarationsFor('.share-pick-row.is-disabled').get('background'), 'transparent');
  assert.equal(declarationsFor('.share-pick-row.is-shared.is-disabled').get('opacity'), '1');
});

test('share filters sit closer to the list without fixing row heights or shrinking thumbnails', () => {
  assert.equal(declarationsFor('.share-types').get('margin-bottom'), '8px');
  const row = declarationsFor('.set-pick-row.share-pick-row');
  assert.equal(row.get('height'), undefined);
  assert.equal(row.get('max-height'), undefined);
  const thumbnail = declarationsFor('.share-pick-row > image');
  assert.equal(thumbnail.get('width'), undefined);
  assert.equal(thumbnail.get('height'), undefined);
});

test('shared text and selectable controls occupy the same aligned action slot', () => {
  const row = findClass('share-pick-row');
  const action = findClass('share-pick-action');
  assert.ok(row);
  assert.ok(action);
  assert.ok(row.children.includes(action));
  assert.ok(action.children.includes(findClass('share-published-label')));
  assert.ok(action.children.includes(findClass('pick-check')));
  assert.equal(declarationsFor('.share-pick-row > .share-pick-action').get('flex'), '0 0 48px');
  assert.equal(declarationsFor('.share-pick-row > .share-pick-action').get('justify-content'), 'center');
  assert.equal(declarationsFor('.share-pick-row .pick-check').get('margin'), '0');
  assert.match(source, /:disabled="busy \|\| syncing \|\| !ready \|\| entry.shared"/);
  assert.match(source, /v-if="entry.shared" class="share-published-label">已分享/);
  assert.match(source, /v-else class="pick-check"/);
});

test('published status is quiet text rather than a filled tag or a faded row', () => {
  const label = declarationsFor('.share-published-label');
  assert.equal(label.get('background'), undefined);
  assert.equal(label.get('border'), undefined);
  assert.equal(label.get('padding'), undefined);
  assert.equal(label.get('color'), 'var(--muted)');
  assert.equal(label.get('white-space'), 'nowrap');
  assert.equal(label.get('font-size'), 'var(--type-caption)');
  assert.equal(declarationsFor('.share-pick-copy .stock-name').has('-webkit-line-clamp'), false);
  assert.match(source, /class="stock-name food-list-title"/);
  assert.equal(declarationsFor('.share-pick-row > .share-pick-copy').get('min-width'), '0');
});
