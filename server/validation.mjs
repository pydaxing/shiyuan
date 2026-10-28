import { validateRecipe, validateIngredient, validatePurchase, validateReservation } from '../src/domain/kitchen.js';
import { normalizePreparationDraft } from '../src/domain/meal-preparation.js';
import { normalizeShoppingDraft } from '../src/domain/meal-shopping.js';

const invalid = message => { const error = new Error(message); error.code = 'INVALID'; throw error; };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('请求格式无效'); return value; };
const pick = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const id = value => { if (typeof value !== 'string' || !/^[\w-]{1,200}$/.test(value)) invalid('记录标识无效'); return value; };
const optionalId = value => value ? id(value) : '';

function normalizeRecipeFields(input) {
  const recipe = pick(object(input), ['title', 'category', 'minutes', 'image', 'nutrition', 'ingredients', 'steps', 'provenance']);
  if (recipe.provenance !== undefined) recipe.provenance = pick(object(recipe.provenance), ['source', 'url', 'license', 'attribution', 'note']);
  recipe.servings = 2;
  if (!Array.isArray(recipe.ingredients) || !Array.isArray(recipe.steps)) invalid('请填写食材和做法');
  recipe.ingredients = recipe.ingredients.map(item => pick(object(item), ['name', 'quantity', 'unit', 'amountText']));
  recipe.steps = recipe.steps.map(item => pick(object(item), ['title', 'text', 'image', 'images']));
  return recipe;
}

// Archived recipe imports preserve the reviewed source; direct save commands add
// their own title requirements below and never accept a client bypass flag.
export function normalizeImportedRecipe(input) {
  const recipe = normalizeRecipeFields(structuredClone(input));
  validateRecipe(recipe);
  return recipe;
}

export function validateEnvelope(event) {
  const pending = [{ value: event, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++visited > 25000 || depth > 32) invalid('请求结构过于复杂');
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.startsWith('$') || key.includes('.')) invalid('请求包含不允许的字段');
      pending.push({ value: child, depth: depth + 1 });
    }
  }
}

export function normalizeCommand(name, input, today) {
  const args = structuredClone(input);
  try {
    if (name === 'saveRecipe') {
      const recipe = normalizeRecipeFields(args[0]);
      validateRecipe(recipe, { requireStepTitles: true });
      return [recipe, optionalId(args[1])];
    }
    if (name === 'saveMealSet') {
      const mealSet = pick(object(args[0]), ['title', 'image', 'recipeIds']);
      if (typeof mealSet.title !== 'string' || !mealSet.title.trim() || mealSet.title.length > 30 || !Array.isArray(mealSet.recipeIds) || mealSet.recipeIds.length < 2 || mealSet.recipeIds.length > 20) invalid('请填写套餐名称并选择 2～20 道菜品');
      mealSet.recipeIds.forEach(id);
      return [mealSet, optionalId(args[1])];
    }
    if (name === 'customizeFamily') {
      const family = pick(object(args[0]), ['name', 'cover', 'coverTitle', 'coverSubtitle']);
      if (typeof family.name !== 'string' || !family.name.trim() || family.name.length > 20 || typeof family.coverTitle !== 'string' || family.coverTitle.length > 30) invalid('请检查家庭名称和菜单主标题');
      if (family.coverSubtitle !== undefined && (typeof family.coverSubtitle !== 'string' || family.coverSubtitle.length > 50)) invalid('菜单副标题最多 50 个字');
      return [family];
    }
    if (name === 'addStock' || name === 'recordPurchase') {
      const batch = pick(object(args[0]), ['name', 'quantity', 'unit', 'location', 'expiresOn', 'image', 'amountText', ...(name === 'recordPurchase' ? ['kind'] : [])]);
      if (name === 'recordPurchase') validatePurchase(batch);
      else validateIngredient(batch);
      return [batch];
    }
    if (name === 'submitOrder' || name === 'addOrderDishes') {
      const cart = object(args[name === 'addOrderDishes' ? 1 : 0]);
      if (Object.keys(cart).length > 60) invalid('一餐最多选择 60 项');
      for (const [key, quantity] of Object.entries(cart)) { id(key.replace(/^set:/, '')); if (quantity !== 1) invalid('每道菜只需选择一次'); }
      if (name === 'addOrderDishes') {
        if (!Object.keys(cart).length) invalid('先选几道想吃的菜吧');
        return [id(args[0]), cart];
      }
      const selection = pick(object(args[1]), ['date', 'meal']);
      validateReservation(selection, today);
      const note = args[2] ?? '';
      if (typeof note !== 'string' || note.length > 200) invalid('备注最多 200 字');
      return [cart, selection, note];
    }
    if (name === 'addComment') {
      if (typeof args[1] !== 'string' || !args[1].trim() || args[1].trim().length > 300) invalid('评论需要 1～300 个字');
      return [id(args[0]), args[1].trim(), optionalId(args[2])];
    }
    if (name === 'addCollection') return [{ id: id(object(args[0]).id) }];
    if (name === 'removeOrderDish') return [id(args[0]), id(args[1])];
    if (['removeOrder', 'removeStock', 'toggleCommentLike', 'deleteCommunityPost'].includes(name)) return [id(args[0])];
    if (['removeFamilyEntry', 'publishToCommunity'].includes(name)) {
      const kind = args[1] || 'dish';
      if (!['dish', 'set'].includes(kind)) invalid('请选择菜品或套餐');
      return [id(args[0]), kind];
    }
    if (name === 'updateOrder') {
      if (!['accepted', 'cancelled', 'completed'].includes(args[1])) invalid('订单操作无效');
      return [id(args[0]), args[1]];
    }
    if (name === 'setDishPrepared') {
      if (typeof args[2] !== 'boolean' || typeof args[3] !== 'string' || !args[3] || args[3].length > 50000) invalid('备菜信息无效，请重新打开');
      return [id(args[0]), id(args[1]), args[2], args[3]];
    }
    if (name === 'saveDishPreparation') {
      if (typeof args[3] !== 'string' || !args[3] || args[3].length > 50000) invalid('备菜信息无效，请重新打开');
      const draft = pick(object(args[2]), ['ingredients', 'note']);
      if (Array.isArray(draft.ingredients)) draft.ingredients = draft.ingredients.map(ingredient => pick(object(ingredient), ['name', 'quantity', 'unit', 'amountText', 'enabled']));
      return [id(args[0]), id(args[1]), normalizePreparationDraft(draft), args[3]];
    }
    if (name === 'saveShoppingDraft' || name === 'removeShoppingDraft') {
      const signature = args[name === 'saveShoppingDraft' ? 3 : 2];
      if (typeof signature !== 'string' || !signature || signature.length > 100000) invalid('采购信息无效，请重新打开');
      if (name === 'removeShoppingDraft') return [id(args[0]), id(args[1]), signature];
      const draft = pick(object(args[2]), ['ingredients']);
      if (Array.isArray(draft.ingredients)) draft.ingredients = draft.ingredients.map(ingredient => pick(object(ingredient), ['sourceKey', 'name', 'quantity', 'unit', 'amountText']));
      return [id(args[0]), id(args[1]), normalizeShoppingDraft(draft), signature];
    }
    if (name === 'changeStockImage') return [id(args[0]), args[1]];
    if (name === 'setChef') { if (typeof args[0] !== 'boolean') invalid('设置无效'); return [args[0]]; }
    if (name === 'setPreferences') {
      const values = object(args[0]);
      if (!Object.keys(values).length || Object.entries(values).some(([key, enabled]) => !['chef', 'fridge', 'shopping'].includes(key) || typeof enabled !== 'boolean')) invalid('设置无效');
      return [values];
    }
    if (name === 'setFeature') { if (!['fridge', 'shopping'].includes(args[0]) || typeof args[1] !== 'boolean') invalid('设置无效'); return [args[0], args[1]]; }
    invalid('不支持的操作');
  } catch (error) { invalid(error.message); }
}
