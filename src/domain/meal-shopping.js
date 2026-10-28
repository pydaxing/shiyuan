import { clone, hasTextAmount, localDate, shoppingDraftFieldErrors, round } from './kitchen.js';
import { dishPreparationSignature, preparationIngredients, preparationMeals } from './meal-preparation.js';

export function shoppingSourceIngredients(ingredients) {
  const occurrences = new Map();
  return ingredients.map(ingredient => {
    const name = ingredient.name.trim();
    const occurrence = occurrences.get(name) || 0;
    occurrences.set(name, occurrence + 1);
    return { ...clone(ingredient), sourceKey: JSON.stringify([name, occurrence]) };
  }).filter(ingredient => ingredient.enabled !== false);
}

export function normalizeShoppingDraft(draft) {
  const errors = shoppingDraftFieldErrors(draft);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  return { ingredients: draft.ingredients.map(ingredient => ({
    sourceKey: ingredient.sourceKey,
    name: ingredient.name.trim(),
    ...(hasTextAmount(ingredient)
      ? { quantity: null, unit: '', amountText: ingredient.amountText.trim() }
      : { quantity: round(Number(ingredient.quantity)), unit: ingredient.unit }),
  })) };
}

export function wholeDishShoppingDraft(dish) {
  if (!dish.ingredients.length) throw new Error('请先在本餐补充食材 / 配料');
  const ingredients = shoppingSourceIngredients(dish.ingredients);
  if (!ingredients.length) throw new Error('本餐没有需要采购的食材 / 配料，可在备菜中重新开启');
  return normalizeShoppingDraft({ ingredients });
}

export function shoppingEditSignature(order, recipeId) {
  const item = order?.items.find(entry => entry.recipe.id === recipeId);
  if (!item) return '';
  const edit = order.preparationEdits?.find(entry => entry.recipeId === recipeId);
  const sourceSignature = dishPreparationSignature(item, edit);
  const draft = order.shoppingDrafts?.find(entry => entry.recipeId === recipeId);
  const prepared = order.preparedDishes?.find(entry => entry.recipeId === recipeId && entry.signature === sourceSignature);
  return JSON.stringify([sourceSignature, draft || null, prepared?.preparedAt || null]);
}

export function assertShoppingSources(order, recipeId, draft) {
  const item = order.items.find(entry => entry.recipe.id === recipeId);
  const edit = order.preparationEdits?.find(entry => entry.recipeId === recipeId);
  const sources = shoppingSourceIngredients(preparationIngredients(item, edit));
  if (draft.ingredients.some(ingredient => !sources.some(source => source.sourceKey === ingredient.sourceKey && source.name === ingredient.name))) {
    throw Object.assign(new Error('食材已变化，请重新勾选这一餐要买的食材'), { code: 'CONFLICT' });
  }
}

export function shoppingCartMeals(snapshot, today = localDate()) {
  return preparationMeals(snapshot, today).map(meal => {
    const order = snapshot.orders.find(entry => entry.id === meal.id);
    const dishes = meal.dishes.flatMap(dish => {
      const draft = order.shoppingDrafts?.find(entry => entry.recipeId === dish.recipe.id);
      if (!draft?.ingredients.length || dish.prepared) return [];
      const purchaseIngredients = shoppingSourceIngredients(dish.ingredients);
      if (!purchaseIngredients.length) return [];
      return [{ ...dish, purchaseIngredients, shoppingSignature: shoppingEditSignature(order, dish.recipe.id) }];
    });
    return { ...meal, dishes };
  }).filter(meal => meal.dishes.length);
}
