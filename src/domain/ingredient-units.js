import { UNITS } from './kitchen.js';

export const INGREDIENT_UNITS_VERSION = 2;
export const LEGACY_INGREDIENT_UNITS = ['g', 'kg', '斤', '两', 'ml', 'L', '个', '根', '只', '条', '块', '片', '张', '颗', '粒', '瓣', '朵', '棵', '把', '束', '勺', '茶匙', '汤匙', '杯', '碗', '瓶', '罐', '盒', '袋', '包'];
const legacyUnits = new Set(LEGACY_INGREDIENT_UNITS);
const measuredAmount = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${[...UNITS].sort((first, second) => second.length - first.length).join('|')})$`);

export function restoreMeasuredIngredient(ingredient) {
  if (typeof ingredient?.amountText !== 'string' || ingredient.quantity !== null || ingredient.unit !== '') return ingredient;
  const match = ingredient.amountText.trim().match(measuredAmount);
  if (!match) return ingredient;
  const quantity = Number(match[1]);
  if (!Number.isFinite(quantity) || quantity < 0.001 || quantity > 100000) return ingredient;
  const { amountText, ...rest } = ingredient;
  return { ...rest, quantity, unit: match[2] };
}

export function restoreIngredientCommand(event) {
  if (event?.action !== 'command' || event.name !== 'saveRecipe' || !Array.isArray(event.args?.[0]?.ingredients)) return event;
  const [recipe, ...rest] = event.args;
  return { ...event, args: [{ ...recipe, ingredients: recipe.ingredients.map(restoreMeasuredIngredient) }, ...rest] };
}

export function legacyIngredientAmounts(value, version) {
  if (version === INGREDIENT_UNITS_VERSION) return value;
  function ingredientForLegacy(ingredient) {
    if (!ingredient || ingredient.amountText !== undefined || !UNITS.includes(ingredient.unit) || legacyUnits.has(ingredient.unit) || !Number.isFinite(ingredient.quantity)) return ingredient;
    return { ...ingredient, quantity: null, unit: '', amountText: `${ingredient.quantity} ${ingredient.unit}` };
  }
  function walk(current, field) {
    if (!current || typeof current !== 'object') return current;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype) return current;
    if (Array.isArray(current)) {
      const next = current.map(item => field === 'ingredients' ? ingredientForLegacy(item) : walk(item));
      return next.some((item, index) => item !== current[index]) ? next : current;
    }
    let next = current;
    for (const [key, child] of Object.entries(current)) {
      const mapped = walk(child, key);
      if (mapped !== child) { if (next === current) next = { ...current }; next[key] = mapped; }
    }
    return next;
  }
  return walk(value);
}
