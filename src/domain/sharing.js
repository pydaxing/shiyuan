import { clone, validateRecipe, validateMealSet } from './kitchen.js';
import { validateImage } from './presentation.js';

export function makeShare(recipeOrSet, recipes, author, kind = 'dish') {
  const dishes = kind === 'set' ? recipeOrSet.recipeIds.map((id) => recipes.find((recipe) => recipe.id === id)) : [recipeOrSet];
  if (kind === 'set') validateMealSet(recipeOrSet, recipes);
  dishes.forEach(validateRecipe);
  const payload = { format: 'shiyuan-share', version: 1, id: recipeOrSet.shareId || recipeOrSet.id, kind: kind === 'set' ? 'menu' : 'dish', title: recipeOrSet.title, image: recipeOrSet.image || '', author, recipes: dishes.map((recipe) => ({ id: recipe.shareId || recipe.id, title: recipe.title, category: recipe.category, minutes: recipe.minutes, servings: recipe.servings, image: recipe.image || '', nutrition: recipe.nutrition || '', author, ingredients: clone(recipe.ingredients), steps: clone(recipe.steps) })) };
  dishes.forEach((recipe, index) => { if (recipe.provenance) payload.recipes[index].provenance = clone(recipe.provenance); });
  return JSON.stringify(payload);
}

export function parseShare(text) {
  if (typeof text !== 'string' || text.length > 12000000) throw new Error('分享内容过大，请减少图片后重试');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('分享内容不完整，请重新复制'); }
  if (payload?.format !== 'shiyuan-share' || payload.version !== 1 || !['dish', 'menu'].includes(payload.kind) || typeof payload.id !== 'string' || !payload.id || typeof payload.author !== 'string' || payload.author.length > 30 || typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 30 || !Array.isArray(payload.recipes) || payload.recipes.length > 20 || payload.recipes.length < (payload.kind === 'menu' ? 2 : 1) || (payload.kind === 'dish' && payload.recipes.length !== 1)) throw new Error('这不是有效的菜品或套餐分享');
  for (const recipe of payload.recipes) {
    validateRecipe(recipe);
    if (typeof recipe.id !== 'string' || !recipe.id || recipe.id.length > 200) throw new Error('菜品标识无效');
  }
  if (new Set(payload.recipes.map((recipe) => recipe.id)).size !== payload.recipes.length) throw new Error('套餐包含重复菜品');
  validateImage(payload.image);
  return payload;
}
