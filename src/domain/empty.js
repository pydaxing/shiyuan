import { FAMILY_APPEARANCE_DEFAULTS } from './family.js';

export function emptySnapshot() {
  return { version: 1, family: { ...FAMILY_APPEARANCE_DEFAULTS, members: [{ id: 'guest', name: '我', isChef: false }], features: { fridge: false, shopping: false } }, activeMemberId: 'guest', recipes: [], mealSets: [], orders: [], inventory: [], purchases: [], posts: [], comments: [] };
}
