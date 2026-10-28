import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertStandardIngredient } from './ingredient-standardization.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function reviewedIngredientEntry(raw, ingredients) {
  assert.ok(raw.sourceUrl && Array.isArray(raw.ingredients) && typeof raw.sourceHtml === 'string');
  assert.ok(Array.isArray(ingredients) && ingredients.length > 0 && ingredients.length <= 30);
  ingredients.forEach(assertStandardIngredient);
  return { originalIngredientsDigest: digest(raw.ingredients), originalHtmlDigest: digest(raw.sourceHtml), ingredients: structuredClone(ingredients) };
}

export function applyReviewedIngredients(raw, recipe, overrides) {
  if (!overrides) return recipe;
  assert.equal(overrides.version, 1, '食材复核配置版本不受支持');
  const entry = overrides.recipes?.[raw.sourceUrl];
  if (!entry) return recipe;
  const current = reviewedIngredientEntry(raw, entry.ingredients);
  assert.equal(current.originalIngredientsDigest, entry.originalIngredientsDigest, '原文食材已变化，必须重新核对，不能套用旧的用量');
  assert.equal(current.originalHtmlDigest, entry.originalHtmlDigest, '来源页面已变化，必须重新核对食材');
  return { ...recipe, ingredients: current.ingredients };
}
