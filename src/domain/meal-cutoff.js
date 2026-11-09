// Scheduling and archival share one Beijing-time boundary, independent of the
// device's timezone. Legacy 宵夜 and current 加餐 denote the same slot.
const hours = { 早餐: 10, 午餐: 14, 晚餐: 20, 加餐: 24, 宵夜: 24 };
export const chinaMealDate = (value = Date.now()) => new Date(Number(value) + 8 * 3600000).toISOString().slice(0, 10);
export const canonicalMeal = meal => meal === '宵夜' ? '加餐' : meal;
export function mealCutoffAt({ date, meal } = {}) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date || '') || hours[meal] === undefined) return NaN;
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(start) || chinaMealDate(start) !== date) return NaN;
  return start + hours[meal] * 3600000;
}
export const mealIsDue = (order, now = Date.now()) => Number(now) >= mealCutoffAt(order);
export function mealCutoffMessage(order, now = Date.now()) {
  if (!mealIsDue(order, now)) return '';
  return `${canonicalMeal(order.meal)}安排已截止，请选择其他日期、餐次。`;
}
export function assertMealBeforeCutoff(order, now = Date.now()) {
  const message = mealCutoffMessage(order, now);
  if (message) throw Object.assign(new Error(message), { code: 'INVALID' });
}
export function mealArchiveWindow(now = Date.now()) {
  const date = chinaMealDate(now);
  const hour = new Date(Number(now) + 8 * 3600000).getUTCHours();
  return `${date}:${hour >= 20 ? 20 : hour >= 14 ? 14 : hour >= 10 ? 10 : 0}`;
}
