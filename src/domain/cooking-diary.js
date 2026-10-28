import { MEALS, localDate, validDate, dateOffset } from './kitchen.js';

export function cookingDays(orders, start, count) {
  if (!validDate(start) || !Number.isInteger(count) || count < 1) throw new Error('请选择有效日期范围');
  const completed = new Map();
  orders.filter((order) => order.status === 'completed').forEach((order) => {
    if (!completed.has(order.date)) completed.set(order.date, new Map());
    const meals = completed.get(order.date);
    if (!meals.has(order.meal)) meals.set(order.meal, new Map());
    order.items.forEach((item) => {
      const recipes = meals.get(order.meal);
      if (!recipes.has(item.recipe.id)) recipes.set(item.recipe.id, item.recipe);
    });
  });
  return Array.from({ length: count }, (_, index) => {
    const date = dateOffset(index, new Date(`${start}T12:00:00`));
    const meals = MEALS.map((name) => ({ name, recipes: [...(completed.get(date)?.get(name)?.values() || [])] })).filter((meal) => meal.recipes.length);
    return { date, day: Number(date.slice(8)), meals };
  });
}

export function cookingMonth(orders, month) {
  if (!validDate(`${month}-01`)) throw new Error('请选择有效月份');
  const first = new Date(`${month}-01T12:00:00`);
  const leading = (first.getDay() + 6) % 7;
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const days = cookingDays(orders, `${month}-01`, count);
  const cells = Array.from({ length: Math.ceil((leading + count) / 7) * 7 }, (_, index) => days[index - leading] || { date: `blank-${index}`, day: null, meals: [] });
  return { days, cells, cookedDays: days.filter((day) => day.meals.length).length, cookedMeals: days.reduce((total, day) => total + day.meals.length, 0) };
}

export function shiftDiaryMonth(month, offset) {
  if (!validDate(`${month}-01`)) throw new Error('请选择有效月份');
  const date = new Date(`${month}-01T12:00:00`);
  date.setMonth(date.getMonth() + offset);
  return localDate(date).slice(0, 7);
}
