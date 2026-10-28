import { assertMealEditable, localDate, makeOrder, mergeMealSelection, validateReservation } from './kitchen.js';

export function appendOrderDishes(order, { recipes, mealSets = [], cart, member, today = localDate() }) {
  assertMealEditable(order);
  validateReservation(order, today);
  const incoming = makeOrder({ id: order.id, recipes, mealSets, cart, member, date: order.date, meal: order.meal });
  return mergeMealSelection(order, incoming, { append: true });
}

export function mealAdditionOptions(entries, order, memberId) {
  const ownItems = order?.selections?.find((selection) => selection.memberId === memberId)?.items || [];
  const ownIds = new Set(ownItems.map((item) => item.recipe.id));
  const orderedIds = new Set((order?.items || []).map((item) => item.recipe.id));
  return entries.map((entry) => {
    const availableIds = entry.recipes.map((recipe) => recipe.id).filter((id) => !ownIds.has(id));
    return { ...entry, availableIds, alreadySelected: !availableIds.length, inMeal: entry.recipes.some((recipe) => orderedIds.has(recipe.id)) };
  });
}

export function mealAdditionCart(selected, options) {
  return Object.fromEntries(options.filter((entry) => selected[entry.key] && !entry.alreadySelected).map((entry) => [entry.key, 1]));
}

export function mealAdditionCount(cart, options) {
  return new Set(options.filter((entry) => cart[entry.key]).flatMap((entry) => entry.availableIds)).size;
}
