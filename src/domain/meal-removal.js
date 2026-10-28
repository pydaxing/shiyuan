import { assertMealEditable, clone, localDate, rebuildMealOrder, validateReservation } from './kitchen.js';

export function removeDishFromOrder(order, recipeId, { today = localDate(), now = Date.now() } = {}) {
  assertMealEditable(order);
  validateReservation(order, today);
  if (!order.items.some(item => item.recipe.id === recipeId)) throw Object.assign(new Error('这道菜已从本餐移除，请重新查看'), { code: 'CONFLICT' });
  const next = clone(order);
  next.selections = next.selections.flatMap(selection => {
    const items = selection.items.filter(item => item.recipe.id !== recipeId);
    if (!items.length) return [];
    const entries = new Map();
    for (const entry of selection.entries) {
      if (entry.kind === 'dish' && entry.id === recipeId) continue;
      if (entry.kind === 'set' && entry.recipeIds?.includes(recipeId)) {
        for (const selectedId of entry.recipeIds) {
          const item = items.find(candidate => candidate.recipe.id === selectedId);
          if (item) entries.set(selectedId, { id: selectedId, kind: 'dish', title: item.recipe.title, image: item.recipe.image || '', quantity: 1, dishCount: 1, recipeIds: [selectedId] });
        }
      } else entries.set(entry.id, entry);
    }
    return [{ ...selection, items, entries: [...entries.values()] }];
  });
  if (!next.selections.length) {
    next.status = 'cancelled';
    next.cancelledAt = new Date(now).toISOString();
  }
  return rebuildMealOrder(next);
}
