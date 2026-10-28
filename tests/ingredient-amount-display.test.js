import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, normalizedIngredient, UNITS } from '../src/domain/kitchen.js';

test('common kitchen fractions display as familiar quantities without rounded approximations', () => {
  for (const [quantity, unit, expected] of [
    [0.5, '块', '半块'], [1 / 3, '根', '1/3 根'], [0.25, '根', '1/4 根'],
    [2 / 3, '杯', '2/3 杯'], [0.75, '勺', '3/4 勺'], [0.125, '茶匙', '1/8 茶匙'],
    [0.375, '汤匙', '3/8 汤匙'], [5 / 6, '碗', '5/6 碗'],
    [1.5, '块', '1块半'], [2.5, '杯', '2杯半'],
    [4 / 3, '根', '1 又 1/3 根'], [2.25, '勺', '2 又 1/4 勺'],
  ]) assert.equal(formatAmount(quantity, unit), expected);
});

test('fraction matching respects six-decimal arithmetic precision and does not round arbitrary values into fractions', () => {
  const third = normalizedIngredient({ name: '黄瓜', quantity: 1 / 3, unit: '根' });
  assert.equal(third.quantity, 0.333333);
  assert.equal(formatAmount(third.quantity, third.unit), '1/3 根');
  assert.equal(formatAmount(0.666667, '杯'), '2/3 杯');
  for (const [quantity, expected] of [
    [0.37, '0.37 根'], [0.33, '0.33 根'], [0.3333, '约 0.33 根'],
    [0.333334, '约 0.33 根'], [0.2499, '约 0.25 根'],
    [0.1, '0.1 根'], [1.37, '1.37 根'],
  ]) assert.equal(formatAmount(quantity, '根'), expected);
});

test('metric and mainland mass units retain the existing conversion and decimal display', () => {
  for (const [quantity, unit, expected] of [
    [0.5, 'kg', '500 g'], [0.5, '斤', '250 g'], [0.5, '两', '25 g'],
    [0.5, 'L', '500 ml'], [0.5, 'g', '0.5 g'], [0.25, 'ml', '0.25 ml'],
    [1 / 3, 'kg', '约 333 g'], [0.25, 'L', '250 ml'],
  ]) assert.equal(formatAmount(quantity, unit), expected);
});

test('display does not modify stored numeric quantities, custom text amounts, zero or missing data', () => {
  const ingredient = { name: '黄瓜', quantity: 1 / 3, unit: '根' };
  const original = structuredClone(ingredient);
  assert.equal(formatAmount(ingredient.quantity, ingredient.unit), '1/3 根');
  assert.deepEqual(ingredient, original);
  assert.equal(typeof ingredient.quantity, 'number');
  assert.equal('amountText' in ingredient, false);
  assert.equal(formatAmount(null, '', ' 适量 '), '适量');
  assert.equal(formatAmount(0.5, '根', '原文按需'), '原文按需');
  assert.equal(formatAmount(null, '根'), '用量待确认');
  assert.equal(formatAmount(undefined, '根'), '用量待确认');
  assert.equal(formatAmount(Number.NaN, '根'), '用量待确认');
  assert.equal(formatAmount(0, '根'), '0 根');
  assert.equal(formatAmount(2, '根'), '2 根');
  assert.equal(formatAmount(0.001, '根'), '约 <0.01 根');
  assert.equal(formatAmount(0.5, 'unknown'), '0.5 unknown');
  for (const unit of UNITS.filter(unit => !['g', 'kg', '斤', '两', 'ml', 'L'].includes(unit))) {
    assert.equal(formatAmount(0.5, unit), `半${unit}`);
  }
});
