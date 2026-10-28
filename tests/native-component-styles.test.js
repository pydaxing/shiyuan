import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';

test('component styles use native-supported class selectors for disabled controls and child elements', () => {
  const root = new URL('../src/components/', import.meta.url);
  const invalid = [];
  for (const filename of readdirSync(root).filter(name => name.endsWith('.vue'))) {
    const component = parse(readFileSync(new URL(filename, root), 'utf8')).descriptor;
    for (const style of component.styles.filter(style => style.scoped)) {
      postcss.parse(style.content).walkRules(rule => {
        if (rule.parent.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
        if (/\[|(?:^|[\s>+~,])(?:text|view|button|image|input|canvas)\b/.test(rule.selector)) invalid.push(`${filename}: ${rule.selector}`);
      });
    }
  }
  assert.deepEqual(invalid, []);
});

test('native disabled appearance uses the same state as the actual disabled attribute', () => {
  for (const [name, expression] of [
    ['AddDishesSheet', 'locked || saving || entry.alreadySelected'],
    ['DishPreparationEditor', 'Boolean(unavailable) || ingredient.enabled === false'],
    ['DishReadyButton', 'disabled || busy'],
    ['MealPreparationSheet', 'Boolean(pending(dish)) || dish.prepared'],
    ['ShareSheet', 'busy || syncing || !ready || entry.shared'],
  ]) {
    const source = readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
    assert.ok(source.includes(`'is-disabled': ${expression}`), name);
    assert.ok(source.includes(`:disabled="${expression}"`), name);
    assert.ok(source.includes('.is-disabled'), name);
  }
});
