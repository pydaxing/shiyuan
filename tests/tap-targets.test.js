import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';

const source = readFileSync(new URL('../src/components/MenuSwipeRow.vue', import.meta.url), 'utf8');
const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));

test('pressed controls retain their hit bounds and desktop hover effects do not apply to touchscreens', () => {
  styles.walkRules((rule) => {
    if (/touch-feedback|:active/.test(rule.selector)) {
      rule.walkDecls('transform', (declaration) => assert.equal(declaration.value, 'none'));
    }
    if (rule.selector.includes(':hover')) {
      assert.equal(rule.parent.type, 'atrule');
      assert.match(rule.parent.params, /hover: hover/);
      assert.match(rule.parent.params, /pointer: fine/);
    }
  });
});

test('pressed feedback is immediate rather than fading in after the finger has left', () => {
  const rule = styles.nodes.find((node) => node.selector === 'button.touch-feedback, button:active:not([disabled])');
  assert.ok(rule.nodes.some((declaration) => declaration.prop === 'transition' && declaration.value === 'none'));
});

test('the entire recipe card body opens details while selection remains a separate sibling button', () => {
  const nodes = [];
  function walk(node) {
    if (node.type !== 1) return;
    nodes.push(node);
    node.children.forEach(walk);
  }
  baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  const hasClass = (node, name) => node.props.some((prop) => prop.name === 'class' && prop.value?.content.split(' ').includes(name));
  const body = nodes.find((node) => hasClass(node, 'home-menu-row-body'));
  const owners = body.children.filter((node) => node.tag === 'view');
  const buttons = owners.flatMap(node => node.children.filter(child => child.tag === 'button'));
  assert.equal(buttons.length, 2);
  assert.ok(hasClass(buttons[0], 'home-menu-info'));
  assert.equal(owners[0].props.find(prop => prop.name === 'data-action').value.content, 'open');
  for (const name of ['home-menu-title', 'home-menu-meta']) assert.ok(buttons[0].children.some((node) => node.type === 1 && hasClass(node, name)));
  assert.ok(hasClass(buttons[1], 'home-menu-pick'));
  assert.equal(owners[1].props.find(prop => prop.name === 'data-action').value.content, 'toggle');
  assert.ok(owners.every(node => node.props.some(prop => prop.name === 'on' && prop.exp?.content === 'swipe.tap')));
  assert.ok(!buttons[0].children.some((node) => node.tag === 'button'));
  assert.doesNotMatch(source, /@touch(?:start|end)="[^"]*(?:submit|toggleSelection|openEntry)/);
  const home = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(home, /@open="openEntry" @toggle="toggleSelection"/);
});

test('sheet touches and field blur cancel pending auto-scroll without swallowing the tap', () => {
  const sheet = readFileSync(new URL('../src/components/Sheet.vue', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/FormField.vue', import.meta.url), 'utf8');
  assert.match(sheet, /@touchstart="startSurfaceGesture"/);
  assert.match(sheet, /function startSurfaceGesture\(event\) \{\s*surfaceGesture.begin\(event\);\s*\}/);
  assert.match(sheet, /function cancelReveal\(\) \{ fields.interrupt\(\); \}/);
  assert.match(sheet, /fields.blur\(token\)/);
  assert.match(sheet, /keyboard.value = 0;[\s\S]*?fields.clear\(\);/);
  assert.match(field, /sheet\?\.blur\(token\)/);
  assert.equal((field.match(/@blur="onBlur"/g) || []).length, 2);
  assert.doesNotMatch(sheet, /@touchstart\.(stop|prevent)/);
});
