import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import * as mobile from '../src/domain/mobile.js';

const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
const themeNames = ['--paper', '--white', '--ink', '--green', '--green-light', '--muted', '--line', '--orange'];
function declarationsFor(selector) {
  const declarations = new Map();
  styles.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('detached app roots define their own full theme instead of inheriting from page', () => {
  const root = declarationsFor('.app-shell');
  const page = declarationsFor('page');
  for (const name of themeNames) {
    assert.ok(root.has(name), `root-portal loses ${name} inherited from page`);
    assert.equal(root.get(name), page.get(name));
  }
  for (const name of ['color', 'font-family', 'font-size', 'line-height']) assert.ok(root.has(name), name);
});

test('the sheet surface and fixed actions stay opaque even without inherited theme variables', () => {
  for (const selector of ['.sheet', '.sheet-footer']) {
    const background = declarationsFor(selector).get('background');
    assert.match(background, /var\(--white,\s*#ffffff\)/);
    assert.equal(declarationsFor('.app-shell').get('--white'), '#ffffff');
  }
});

test('native sheet headers remain below the WeChat capsule with and without a keyboard', () => {
  assert.equal(typeof mobile.sheetTopInset, 'function');
  for (const viewport of [{ windowHeight: 874, statusBarHeight: 62 }, { windowHeight: 667, statusBarHeight: 20 }]) {
    const capsule = { top: viewport.statusBarHeight + 4, bottom: viewport.statusBarHeight + 36 };
    const inset = mobile.sheetTopInset(viewport, capsule);
    assert.equal(inset, capsule.bottom + 12);
    for (const keyboard of [0, 300]) {
      const layout = mobile.keyboardLayout(viewport.windowHeight, keyboard, inset);
      assert.ok(viewport.windowHeight - layout.bottom - layout.maxHeight >= capsule.bottom + 12);
    }
  }
});

test('native capsule fallbacks reserve navigation space without changing web insets', () => {
  assert.equal(typeof mobile.sheetTopInset, 'function');
  assert.equal(mobile.sheetTopInset({ statusBarHeight: 62 }), 62);
  assert.equal(mobile.sheetTopInset({}), 24);
  assert.equal(mobile.sheetTopInset({ statusBarHeight: 62 }, {}), 118);
  assert.equal(mobile.sheetTopInset({ statusBarHeight: 20 }, { bottom: 0 }), 76);
});
