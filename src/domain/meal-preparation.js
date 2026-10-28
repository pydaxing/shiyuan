import { round, hasTextAmount, localDate, sortMealOrders, preparationFieldErrors, aggregateItems } from './kitchen.js';

const seasonings = new Set(['盐', '食盐', '海盐', '食用盐', '油', '食用油', '植物油', '花生油', '玉米油', '菜籽油', '橄榄油', '香油', '芝麻油', '生抽', '老抽', '酱油', '蚝油', '料酒', '白醋', '陈醋', '米醋', '醋', '白糖', '白砂糖', '细砂糖', '冰糖', '糖', '胡椒粉', '黑胡椒', '黑胡椒粉', '白胡椒粉', '五香粉', '十三香', '辣椒粉', '花椒粉', '孜然粉', '鸡精', '味精', '豆瓣酱', '甜面酱', '番茄酱', '八角', '桂皮', '香叶', '花椒', '干辣椒', '葱', '小葱', '香葱', '葱花', '姜', '生姜', '姜片', '姜末', '蒜', '大蒜', '蒜末', '蒜蓉']);

const ingredientValues = ingredients => ingredients.map(ingredient => [ingredient.name.trim(), hasTextAmount(ingredient) ? null : Number(ingredient.quantity), ingredient.unit, ingredient.amountText || '', ...(ingredient.enabled === false ? [false] : [])]);

export const ingredientSection = name => seasonings.has(name.trim()) ? 'seasonings' : 'ingredients';

export function ingredientListGroups(ingredients) {
  return [{ key: 'ingredients', label: '食材' }, { key: 'seasonings', label: '配料' }].map(group => ({
    ...group,
    items: ingredients.map((ingredient, index) => ({ ingredient, index })).filter(({ ingredient }) => (ingredient.section || ingredientSection(ingredient.name)) === group.key),
  })).filter(group => group.items.length);
}

export function preparationIngredients(item, edit) {
  const factor = item.quantity * (item.scale ?? 1) / (edit?.quantity || 1);
  return (edit?.ingredients || item.recipe.ingredients).map(ingredient => ({
    ...(hasTextAmount(ingredient)
      ? { name: ingredient.name, quantity: null, unit: '', amountText: ingredient.amountText }
      : { name: ingredient.name, quantity: round(Number(ingredient.quantity) * factor), unit: ingredient.unit }),
    ...(ingredient.enabled === false ? { enabled: false } : {}),
  }));
}

export function preparationDefaults(item, note = '') {
  return { ingredients: preparationIngredients(item).map(({ enabled, ...ingredient }) => ingredient), note };
}

export function dishPreparationSignature(item, edit) {
  const source = JSON.stringify([item.recipe.id, item.quantity, item.scale ?? 1, ingredientValues(item.recipe.ingredients)]);
  if (!edit) return source;
  const current = ingredientValues(preparationIngredients(item, edit));
  return JSON.stringify(current) === JSON.stringify(ingredientValues(preparationIngredients(item))) ? source : JSON.stringify([source, current]);
}

export function preparationEditSignature(item, edit) {
  return JSON.stringify([dishPreparationSignature(item), ingredientValues(preparationIngredients(item, edit)), edit?.note || '']);
}

export function normalizePreparationDraft(draft) {
  const error = Object.values(preparationFieldErrors(draft))[0];
  if (error) throw new Error(error);
  return {
    ingredients: draft.ingredients.map(ingredient => ({
      ...(hasTextAmount(ingredient)
        ? { name: ingredient.name.trim(), quantity: null, unit: '', amountText: ingredient.amountText.trim() }
        : { name: ingredient.name.trim(), quantity: round(Number(ingredient.quantity)), unit: ingredient.unit }),
      ...(ingredient.enabled === false ? { enabled: false } : {}),
    })),
    note: draft.note.trim(),
  };
}

export function dishIngredientGroups(item, edit) {
  const ingredients = [];
  const seasoningsList = [];
  preparationIngredients(item, edit).forEach((ingredient, index) => {
    const amount = hasTextAmount(ingredient) ? ingredient.amountText : `${ingredient.quantity} ${ingredient.unit}`;
    const entry = { key: String(index), name: ingredient.name, amount, ...(ingredient.enabled === false ? { enabled: false } : {}) };
    (seasonings.has(ingredient.name.trim()) ? seasoningsList : ingredients).push(entry);
  });
  return [{ key: 'ingredients', label: '食材', items: ingredients }, { key: 'seasonings', label: '配料', items: seasoningsList }].filter(group => group.items.length);
}

export function preparationMeals(snapshot, today = localDate()) {
  return sortMealOrders(snapshot.orders, today).filter(order => ['pending', 'accepted'].includes(order.status)).map(order => {
    const dishes = order.items.map(item => {
      const edit = order.preparationEdits?.find(record => record.recipeId === item.recipe.id);
      const signature = dishPreparationSignature(item, edit);
      return {
        recipe: item.recipe,
        quantity: item.quantity * (item.scale ?? 1),
        signature,
        editSignature: preparationEditSignature(item, edit),
        ingredients: preparationIngredients(item, edit),
        note: edit?.note || '',
        groups: dishIngredientGroups(item, edit),
        prepared: (order.preparedDishes || []).some(record => record.recipeId === item.recipe.id && record.signature === signature),
      };
    });
    return { id: order.id, date: order.date, meal: order.meal, dishes, preparedCount: dishes.filter(dish => dish.prepared).length };
  });
}

export const shoppingMeals = preparationMeals;

export function mealPreparationRequirements(order) {
  return aggregateItems((order?.items || []).map(item => {
    const edit = order.preparationEdits?.find(record => record.recipeId === item.recipe.id);
    return edit ? { recipe: { ...item.recipe, ingredients: preparationIngredients(item, edit).filter(ingredient => ingredient.enabled !== false) }, quantity: 1 } : item;
  }));
}

export function preparationKey(orderId, recipeId) { return `${orderId}:${recipeId}`; }
export function shoppingOrderAnchor(index) { return `shopping-meal-${index}`; }
