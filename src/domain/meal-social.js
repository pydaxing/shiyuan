// A small, deliberate vocabulary keeps reactions light and avoids reply threads.
export const MEAL_REACTIONS = Object.freeze([
  { id: 'want', label: '也想吃' },
  { id: 'balanced', label: '搭配不错' },
  { id: 'try', label: '下次试试' },
  { id: 'warm', label: '好好吃饭' },
]);
export const MEAL_MOODS = Object.freeze([
  { id: 'home', label: '家常幸福', emoji: '🏡', tone: 'peach' },
  { id: 'clean', label: '今天光盘', emoji: '🍽️', tone: 'mint' },
  { id: 'simple', label: '简单吃点', emoji: '🥣', tone: 'sky' },
  { id: 'care', label: '认真吃饭', emoji: '🍚', tone: 'rose' },
  { id: 'together', label: '一起吃饭', emoji: '🥢', tone: 'lavender' },
  { id: 'solo', label: '一人食', emoji: '🙋', tone: 'sky' },
  { id: 'after-work', label: '下班后的快乐', emoji: '🌙', tone: 'lavender' },
  { id: 'healed', label: '被这口饭治愈了', emoji: '🥰', tone: 'rose' },
  { id: 'hungry', label: '吃饱再说', emoji: '😋', tone: 'peach' },
  { id: 'newbie', label: '厨房新手上路', emoji: '🍳', tone: 'sky' },
  { id: 'proud', label: '这次发挥不错', emoji: '✨', tone: 'lavender' },
  { id: 'success', label: '复刻成功', emoji: '🎉', tone: 'peach' },
  { id: 'taste-home', label: '家的味道', emoji: '🫶', tone: 'rose' },
  { id: 'easy', label: '偷个懒也没关系', emoji: '🦥', tone: 'mint' },
  { id: 'extra', label: '给自己加个菜', emoji: '🥩', tone: 'peach' },
  { id: 'weekend', label: '周末慢慢吃', emoji: '☀️', tone: 'mint' },
  { id: 'warm-meal', label: '热乎乎的一餐', emoji: '🍲', tone: 'peach' },
  { id: 'favorite', label: '就爱这一口', emoji: '😍', tone: 'rose' },
  { id: 'fresh', label: '清清爽爽', emoji: '🥒', tone: 'mint' },
  { id: 'buddies', label: '饭搭子集合', emoji: '🙌', tone: 'sky' },
  { id: 'carbs', label: '我的快乐碳水', emoji: '🍜', tone: 'peach' },
  { id: 'one-pot', label: '一锅搞定', emoji: '🥘', tone: 'mint' },
  { id: 'ritual', label: '仪式感安排上', emoji: '🌷', tone: 'lavender' },
  { id: 'energy', label: '吃完元气满满', emoji: '💪', tone: 'sky' },
]);
// Picker and reader UI share compact labels. Preserve the stored vocabulary
// and IDs so historical posts and older clients remain compatible.
const MOOD_DISPLAY_LABELS = Object.freeze({
  home: '家常幸福',
  clean: '今天光盘',
  simple: '简单吃点',
  care: '认真吃饭',
  together: '一起吃饭',
  solo: '独自享用',
  'after-work': '下班快乐',
  healed: '美食治愈',
  hungry: '吃饱再说',
  newbie: '厨房新手',
  proud: '发挥不错',
  success: '复刻成功',
  'taste-home': '家的味道',
  easy: '偶尔偷懒',
  extra: '犒劳自己',
  weekend: '周末慢吃',
  'warm-meal': '热乎一餐',
  favorite: '就爱这口',
  fresh: '清清爽爽',
  buddies: '饭搭相聚',
  carbs: '快乐碳水',
  'one-pot': '一锅搞定',
  ritual: '小仪式感',
  energy: '元气满满',
});
export function mealMoodDisplayLabel(tag) {
  return MOOD_DISPLAY_LABELS[tag?.id] || tag?.label || '';
}
export const MEAL_SLOTS = Object.freeze(['早餐', '午餐', '晚餐', '加餐']);
export function mealTimeline(orders = [], posts = []) {
  const sharedOrders = new Set(posts.map(post => post.sourceOrderId).filter(Boolean));
  return [
    ...orders.filter(order => !sharedOrders.has(order.id)).map(order => ({ id: `order:${order.id}`, kind: 'plan', date: order.date, meal: order.meal, order, timestamp: order.createdAt || 0 })),
    ...posts.map(post => ({ id: `post:${post.id}`, kind: post.kind, date: post.date, meal: post.meal, post, timestamp: post.createdAt })),
  ].sort((a, b) => b.date.localeCompare(a.date) || MEAL_SLOTS.indexOf(b.meal) - MEAL_SLOTS.indexOf(a.meal) || b.timestamp - a.timestamp || a.id.localeCompare(b.id));
}
export function mealCheckinDays(posts = []) {
  return new Set(posts.filter(post => post.kind === 'actual' && post.status !== 'deleted').map(post => post.date)).size;
}

// Publication age is elapsed time, independent of the meal's selected date.
export function mealPublicationAge(createdAt, now = Date.now()) {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return '';
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 3600000) return `${Math.max(1, Math.floor(elapsed / 60000))}分钟前`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}小时前`;
  if (elapsed < 172800000) return '昨天';
  return `${Math.floor(elapsed / 86400000)}天前`;
}
