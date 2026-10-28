import { CATEGORIES } from './kitchen.js';
import { pageHeaderHeight, sheetTopInset } from './mobile.js';

export const HOME_MENU_CATEGORIES = [...CATEGORIES, '套餐'];

export function homeMenuGeometry(windowInfo = {}, capsule = null) {
  const width = Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375;
  const safeTop = windowInfo.uniPlatform === 'mp-weixin' ? sheetTopInset(windowInfo, capsule || {}) : 0;
  const headerHeight = pageHeaderHeight(windowInfo, capsule);
  const toolsHeight = width > 760 ? 60 : 54;
  return { safeTop, headerHeight, toolsHeight, searchTop: headerHeight, listTop: headerHeight + toolsHeight, kitchenTop: headerHeight + 12 };
}

export function homeMenuCategory(entry) {
  if (entry.kind === 'set') return '套餐';
  const category = entry.category || entry.label;
  return CATEGORIES.includes(category) ? category : '其他';
}

export function groupHomeMenu(entries, search = '') {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const groups = HOME_MENU_CATEGORIES.map((category, index) => ({ id: `home-menu-group-${index}`, category, entries: [] }));
  const byCategory = new Map(groups.map(group => [group.category, group]));
  for (const entry of entries) {
    const recipes = entry.recipes || [entry];
    const text = [entry.title, ...recipes.flatMap(recipe => [recipe.title, ...(recipe.ingredients || []).map(ingredient => ingredient.name)])].join(' ').toLocaleLowerCase();
    if (terms.every(term => text.includes(term))) byCategory.get(homeMenuCategory(entry)).entries.push(entry);
  }
  return groups;
}

export function firstHomeMenuCategory(groups) {
  return groups.find(group => group.entries.length)?.category || HOME_MENU_CATEGORIES[0];
}

export function homeMenuCategoryAtScroll(positions, scrollTop, offset = 24) {
  let category = positions[0]?.category || '';
  for (const position of positions) {
    if (position.top > scrollTop + offset) break;
    category = position.category;
  }
  return category;
}
