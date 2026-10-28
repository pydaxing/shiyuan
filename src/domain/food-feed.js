import { CATEGORIES } from './kitchen.js';

export const FOOD_CATEGORIES = [...CATEGORIES, '套餐'];

export function foodFeedFilter(category) {
  if (category === '套餐') return { type: '套餐', category: '全部' };
  if (CATEGORIES.includes(category)) return { type: '菜品', category };
  return { type: '全部', category: '全部' };
}

export function foodFeedQuery(mode, category, seed) {
  if (mode === 'category') return foodFeedFilter(category);
  return { type: '全部', category: '全部', sort: mode === 'recommended' ? 'recommended' : 'latest', ...(mode === 'recommended' ? { seed } : {}) };
}

export function shuffleFoodPosts(posts, seed) {
  let random = 2166136261;
  for (const character of String(seed)) random = Math.imul(random ^ character.charCodeAt(0), 16777619) >>> 0;
  const result = [...posts];
  for (let index = result.length - 1; index > 0; index -= 1) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const target = Math.floor(random / 4294967296 * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

export function orderFoodPosts(posts, mode, seed) {
  if (mode === 'recommended') return shuffleFoodPosts(posts, seed);
  if (mode !== 'latest') return posts;
  const timestamp = post => {
    const value = post.publishedAt ?? post.sharedAt ?? post.createdAt;
    return (typeof value === 'number' ? value : Date.parse(value)) || 0;
  };
  return [...posts].sort((left, right) => timestamp(right) - timestamp(left) || String(right.id).localeCompare(String(left.id)));
}

// Raise shorter covers while keeping the tallest: cover heights now differ by at most 7%.
const coverRatios = [0.86, 0.92, 0.89, 0.88, 0.91, 0.9];

export function buildFoodWaterfall(posts) {
  const lanes = [[], []];
  const heights = [0, 0];
  posts.forEach((post, index) => {
    const coverRatio = coverRatios[index % coverRatios.length];
    const lane = heights[0] <= heights[1] ? 0 : 1;
    lanes[lane].push({ post, coverRatio, coverPadding: `${100 / coverRatio}%` });
    heights[lane] += 1 / coverRatio + 0.44;
  });
  return lanes;
}
