import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileTemplate } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import postcss from 'postcss';
import { MEALS, reservationDays, calendarDateLabel } from '../src/domain/kitchen.js';

const source = readFileSync(new URL('../src/components/MealBar.vue', import.meta.url), 'utf8');
const compiled = compileTemplate({ source: parse(source).descriptor.template.content, filename: 'meal-bar-test.vue', id: 'meal-bar-test' });
assert.deepEqual(compiled.errors, []);
const renderCode = compiled.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
const render = new Function('Vue', renderCode)({ ...Vue, resolveComponent: name => name });

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(nodes) : [])];
}

for (const [today, expected] of [
  ['2026-10-26', ['10月26日', '10月27日', '10月28日']],
  ['2026-12-31', ['12月31日', '1月1日', '1月2日']],
  ['2024-02-28', ['2月28日', '2月29日', '3月1日']],
]) test(`meal date buttons pair relative labels with actual dates on ${today}`, () => {
  const days = reservationDays(today);
  const emissions = [];
  const rendered = nodes(render({ MEALS, reservationDays, calendarDateLabel, today, date: days[1].date, meal: '晚餐', $feedback() {}, $emit: (...args) => emissions.push(args) }, []));
  const dates = rendered.find(node => node.props?.class === 'reservation-days');
  const buttons = nodes(dates).filter(node => node.type === 'button');
  assert.equal(buttons.length, 3);
  buttons.forEach((button, index) => {
    assert.equal(nodes(button).find(node => node.props?.class === 'reservation-day-label').children, days[index].label);
    assert.equal(nodes(button).find(node => node.props?.class === 'reservation-day-date').children, expected[index]);
    assert.equal(button.props['aria-label'], `选择${days[index].label}，${expected[index]}`);
    assert.equal(button.props['aria-pressed'], index === 1);
    assert.equal(button.props['hover-class'], 'touch-feedback');
    button.props.onClick();
  });
  assert.deepEqual(emissions, days.map(day => ['update:date', day.date]));
  const mealButtons = nodes(rendered.find(node => node.props?.class === 'meal-tabs')).filter(node => node.type === 'button');
  assert.deepEqual(mealButtons.map(button => button.children), MEALS);
});

test('meal dates reserve enough height for two lines without enlarging the shared type scale', () => {
  const declarations = new Map();
  postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')).walkRules(rule => {
    if (rule.selectors.includes('.reservation-days button')) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  assert.equal(declarations.get('flex-direction'), 'column');
  assert.equal(declarations.get('min-height'), '64px');
  assert.equal(declarations.get('font-size'), 'var(--type-control)');
  assert.equal(declarations.get('border-radius'), 'var(--radius-control)');
  for (const invalid of ['', undefined, null, '2026-02-30']) assert.equal(calendarDateLabel(invalid), '');
});
