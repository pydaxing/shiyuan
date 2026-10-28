import assert from 'node:assert/strict';
import { UNITS, validateIngredient } from '../src/domain/kitchen.js';

export const AMOUNT_PRESETS = ['适量', '少许'];
const aliases = { 克: 'g', 公斤: 'kg', 千克: 'kg', 毫升: 'ml', 升: 'L', 公升: 'L', g: 'g', kg: 'kg', ml: 'ml', l: 'L', 匙: '勺', 勺子: '勺', 汤勺: '汤匙', 小撮: '撮', 大只: '只', 小瓣: '瓣', 小块: '块', 大块: '块', 小把: '把', 小碗: '碗', 大碗: '碗', 小盒: '盒', 小包: '包', 大段: '段', 小段: '段' };
const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const units = [...new Set([...UNITS, ...Object.keys(aliases)])].sort((first, second) => second.length - first.length);
const numberPattern = '(?:半|[一二两三四五六七八九十]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:\\s*/\\s*\\d+(?:\\.\\d+)?)?)';
const measuredPattern = new RegExp(`^(${numberPattern})\\s*(${units.join('|')})(半)?$`, 'i');

export function amountNumber(value) {
  if (value === '半') return 0.5;
  if (Object.hasOwn(digits, value)) return digits[value];
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(value)) {
    const [tens, ones] = value.split('十');
    return (digits[tens] || 1) * 10 + (digits[ones] || 0);
  }
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\/\s*\d+(?:\.\d+)?)?$/.test(value)) return null;
  const [numerator, denominator = 1] = value.split('/').map(part => Number(part.trim()));
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator > Number.MAX_SAFE_INTEGER || denominator <= 0 || denominator > Number.MAX_SAFE_INTEGER) return null;
  return numerator / denominator;
}

export function canonicalAmount(amount) {
  if (typeof amount !== 'string' || /[\u0000-\u001f\u007f]/.test(amount)) return null;
  const clean = amount.normalize('NFKC').replace(/⁄/g, '/').trim();
  if (AMOUNT_PRESETS.includes(clean)) return { quantity: null, unit: '', amountText: clean };
  const match = clean.match(measuredPattern);
  if (!match || match[1] === '半' && match[3]) return null;
  const parsed = amountNumber(match[1]);
  if (parsed === null) return null;
  const result = { quantity: parsed + (match[3] ? 0.5 : 0), unit: aliases[match[2].toLowerCase()] || aliases[match[2]] || match[2] };
  try { validateIngredient({ name: '食材', ...result }); return result; }
  catch { return null; }
}

export function assertStandardIngredient(ingredient) {
  assert.ok(ingredient && typeof ingredient.name === 'string' && ingredient.name.trim());
  if (ingredient.amountText !== undefined) {
    assert.ok(AMOUNT_PRESETS.includes(ingredient.amountText), `不是固定用量选项：${ingredient.amountText}`);
    assert.equal(ingredient.quantity, null);
    assert.equal(ingredient.unit, '');
  } else {
    assert.equal(typeof ingredient.quantity, 'number');
    validateIngredient(ingredient);
  }
}

export function standardizeIngredient(ingredient, review) {
  const raw = ingredient.amountText;
  const contextual = (review.contextual || []).find(entry => entry.name === ingredient.name && entry.amountText === raw && (entry.originalQuantity === undefined || entry.originalQuantity === ingredient.quantity));
  if (contextual) {
    assert.ok(contextual.reason?.length >= 8, '语义修正缺少核对依据');
    contextual.ingredients.forEach(assertStandardIngredient);
    return { ingredients: structuredClone(contextual.ingredients), reason: contextual.reason, kind: 'reviewed_context' };
  }
  if (raw === undefined) {
    const next = { ...ingredient, quantity: Number(ingredient.quantity) };
    assertStandardIngredient(next);
    return { ingredients: [next], reason: '已有数字用量和单位保持不变', kind: 'measured' };
  }
  const manual = (review.amounts || []).find(entry => entry.from === raw) || (review.groups || []).find(entry => entry.from.includes(raw));
  const amount = manual ? (typeof manual.to === 'string' ? canonicalAmount(manual.to) : manual.to) : canonicalAmount(raw);
  assert.ok(amount, `尚未复核用量：${JSON.stringify(raw)}（${ingredient.name}）`);
  if (manual) assert.ok(manual.reason?.length >= 8, `复核缺少依据：${raw}`);
  const next = { ...ingredient };
  delete next.amountText;
  Object.assign(next, amount);
  assertStandardIngredient(next);
  return { ingredients: [next], reason: manual?.reason || '原文明示数值及单位，未换算勺、杯、碗的容量', kind: manual ? 'reviewed_text' : AMOUNT_PRESETS.includes(raw) ? 'preset' : 'parsed_measure' };
}

export function standardizeIngredients(ingredients, review) {
  return ingredients.flatMap(ingredient => standardizeIngredient(ingredient, review).ingredients);
}
