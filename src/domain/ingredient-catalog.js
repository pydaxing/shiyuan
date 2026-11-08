import { ingredientArt } from './ingredient-art.js';
import { DIRECTORY_GROUPS, DIRECTORY_ALIASES, directoryImage } from './ingredient-directory.js';
import { stockReminder } from './stock-reminders.js';
import { normalizeName } from './kitchen.js';

const originalIngredients = [
  { name: '番茄', quantity: 500, image: ingredientArt['番茄'], aliases: ['西红柿'], unit: 'g', location: '冷藏' },
  { name: '鸡蛋', quantity: 6, image: ingredientArt['鸡蛋'], aliases: [], unit: '个', location: '冷藏' },
  { name: '土豆', quantity: 2, image: ingredientArt['土豆'], aliases: ['马铃薯'], unit: '个', location: '常温' },
  { name: '胡萝卜', quantity: 2, image: ingredientArt['胡萝卜'], aliases: [], unit: '根', location: '冷藏' },
  { name: '黄瓜', quantity: 2, image: ingredientArt['黄瓜'], aliases: [], unit: '根', location: '冷藏' },
  { name: '西兰花', quantity: 500, image: ingredientArt['西兰花'], aliases: [], unit: 'g', location: '冷藏' },
  { name: '白菜', quantity: 1, image: ingredientArt['白菜'], aliases: [], unit: '棵', location: '冷藏' },
  { name: '菠菜', quantity: 1, image: ingredientArt['菠菜'], aliases: [], unit: '把', location: '冷藏' },
  { name: '香菇', quantity: 200, image: ingredientArt['香菇'], aliases: [], unit: 'g', location: '冷藏' },
  { name: '豆腐', quantity: 1, image: ingredientArt['豆腐'], aliases: [], unit: '块', location: '冷藏' },
  { name: '鸡肉', quantity: 500, image: ingredientArt['鸡肉'], aliases: [], unit: 'g', location: '冷冻' },
  { name: '鸡腿肉', quantity: 500, image: ingredientArt['鸡腿肉'], aliases: [], unit: 'g', location: '冷冻' },
  { name: '牛肉', quantity: 500, image: ingredientArt['牛肉'], aliases: [], unit: 'g', location: '冷冻' },
  { name: '猪肉', quantity: 500, image: ingredientArt['猪肉'], aliases: [], unit: 'g', location: '冷冻' },
  { name: '排骨', quantity: 500, image: ingredientArt['排骨'], aliases: [], unit: 'g', location: '冷冻' },
  { name: '鱼', quantity: 1, image: ingredientArt['鱼'], aliases: [], unit: '条', location: '冷冻' },
  { name: '大米', quantity: 500, image: ingredientArt['大米'], aliases: [], unit: 'g', location: '常温' },
  { name: '面条', quantity: 500, image: ingredientArt['面条'], aliases: [], unit: 'g', location: '常温' },
  { name: '牛奶', quantity: 250, image: ingredientArt['牛奶'], aliases: [], unit: 'ml', location: '冷藏' },
  { name: '食用油', quantity: 500, image: ingredientArt['食用油'], aliases: [], unit: 'ml', location: '常温' },
  { name: '盐', quantity: 100, image: ingredientArt['盐'], aliases: ['食盐'], unit: 'g', location: '常温' },
  { name: '酱油', quantity: 500, image: ingredientArt['酱油'], aliases: [], unit: 'ml', location: '常温' },
  { name: '生抽', quantity: 500, image: ingredientArt['生抽'], aliases: [], unit: 'ml', location: '常温' },
  { name: '小葱', quantity: 3, image: ingredientArt['小葱'], aliases: ['青葱', '香葱'], unit: '根', location: '冷藏' },
  { name: '姜', quantity: 1, image: ingredientArt['姜'], aliases: ['生姜'], unit: '块', location: '常温' },
  { name: '蒜', quantity: 6, image: ingredientArt['蒜'], aliases: ['大蒜'], unit: '瓣', location: '常温' },
  { name: '苹果', quantity: 2, image: ingredientArt['苹果'], aliases: [], unit: '个', location: '常温' },
  { name: '香蕉', quantity: 3, image: ingredientArt['香蕉'], aliases: [], unit: '根', location: '常温' },
];

const aliasOwners = new Map(Object.entries(DIRECTORY_ALIASES).flatMap(([name, aliases]) => aliases.map(alias => [alias, name])));
// Preserve the existing canonical names when merging the expanded directory.
for (const entry of originalIngredients) for (const alias of entry.aliases) aliasOwners.set(alias, entry.name);
const entries = new Map();
for (const [category, storageProfile, location, unit, quantity, , names] of DIRECTORY_GROUPS) {
  for (const raw of names.split(' ')) {
    const name = aliasOwners.get(raw) || raw;
    if (entries.has(name)) continue;
    entries.set(name, { name, category, storageProfile, location, unit, quantity,
      aliases: [...(DIRECTORY_ALIASES[name] || [])], image: ingredientArt[name] || directoryImage(raw),
      imageKind: ingredientArt[name] ? 'ingredient' : 'category' });
  }
}
for (const entry of originalIngredients) {
  const existing = entries.get(entry.name) || entries.get(aliasOwners.get(entry.name));
  entries.set(entry.name, { ...existing, ...entry, category: existing?.category || '其他',
    storageProfile: existing?.storageProfile || 'unknown', imageKind: 'ingredient',
    aliases: [...new Set([...(existing?.aliases || []), ...entry.aliases])] });
}
export const COMMON_INGREDIENTS = [...originalIngredients.map(entry => entries.get(entry.name)),
  ...[...entries.values()].filter(entry => !originalIngredients.some(original => original.name === entry.name))];
export const INGREDIENT_CATEGORIES = [...new Set(COMMON_INGREDIENTS.map(entry => entry.category))];
const nameIndex = new Map(COMMON_INGREDIENTS.flatMap(entry => [entry.name, ...entry.aliases].map(name => [normalizeName(name), entry.name])));

const DEFAULT_SUGGESTION_LIMIT = 8;

function familyUsage(source) {
  const counts = new Map();
  const ingredients = [
    ...(source.inventory || []),
    ...(source.recipes || []).flatMap(recipe => recipe.ingredients || []),
  ];
  for (const ingredient of ingredients) {
    const raw = normalizeName(ingredient.name);
    const name = nameIndex.get(raw) || raw;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

export function ingredientSuggestions(query = '', source = {}, limit = DEFAULT_SUGGESTION_LIMIT, category = '全部') {
  if (!Number.isInteger(limit) || limit < 0) return [];
  const normalizedQuery = normalizeName(query).toLocaleLowerCase();
  const usage = familyUsage(source);
  return COMMON_INGREDIENTS
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (category === '全部' || entry.category === category) && (!normalizedQuery || [entry.name, ...entry.aliases]
      .some(value => normalizeName(value).toLocaleLowerCase().includes(normalizedQuery))))
    .sort((left, right) => Number([right.entry.name, ...right.entry.aliases].some(name => normalizeName(name).toLocaleLowerCase() === normalizedQuery)) - Number([left.entry.name, ...left.entry.aliases].some(name => normalizeName(name).toLocaleLowerCase() === normalizedQuery)) || (usage.get(right.entry.name) || 0) - (usage.get(left.entry.name) || 0) || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => ({ ...entry, aliases: [...entry.aliases] }));
}

// Quantity and reminder date are shown for confirmation before any mutation.
export function stockFromIngredient(entry, location, today) {
  const place = ['冷藏', '冷冻', '常温'].includes(location) ? location : entry.location;
  return { name: entry.name, quantity: entry.quantity, unit: entry.unit,
    location: place, image: entry.image, expiresOn: stockReminder(entry, place, today).date };
}
