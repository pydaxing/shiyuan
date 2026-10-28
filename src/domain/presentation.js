export const DEFAULT_DISH_COVER = '/static/dish-default.jpg';
export const DEFAULT_SET_COVER = '/static/meal-set-default.jpg';

export function foodCover(image, kind = 'dish') {
  return image || (kind === 'set' || kind === 'menu' ? DEFAULT_SET_COVER : DEFAULT_DISH_COVER);
}

export function foodMinutesLabel(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : '';
}

export function validateImage(image) {
  if (image === undefined || image === '') return;
  if (typeof image === 'string' && image.length <= 1000 && /^cloud:\/\/[\w.-]+\/[\w/.-]+$/.test(image) && !image.includes('..')) return;
  if (typeof image !== 'string' || image.length > 500000 || !/^(\/static\/[\w/-]+\.png|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|wxfile:\/\/(usr\/|store_).+|https?:\/\/(usr|store)\/.+)$/.test(image)) throw new Error('图片无效，请重新选择照片');
}

export function cleanSteps(steps) {
  return steps.map((step) => ({ title: (step.title || '').trim(), text: (step.text || '').trim(), ...(step.images !== undefined ? { images: Array.isArray(step.images) ? [...step.images] : step.images } : { image: step.image || '' }) })).filter((step) => step.title || step.text || stepImages(step).length || step.images !== undefined && !Array.isArray(step.images));
}

export function stepImages(step) {
  return Array.isArray(step.images) ? step.images : step.image ? [step.image] : [];
}

export function recipeStepTitle(step) {
  const title = String(step.title || '').trim();
  return /^(?:步骤\s*[\d零〇一二三四五六七八九十百]+|第?\s*[\d零〇一二三四五六七八九十百]+\s*步|step\s*\d+|\d+)\s*[.、:：。]?$/i.test(title) ? '' : title;
}

export function ingredientImage(name) {
  const clean = String(name || '').trim();
  if (/番茄|西红柿/.test(clean)) return '/static/ingredient-tomato.png';
  if (/蛋/.test(clean)) return '/static/ingredient-eggs.png';
  if (/鸡|牛肉|排骨|猪肉|鱼|虾/.test(clean)) return '/static/ingredient-meat.png';
  if (/油|生抽|酱油|醋|牛奶/.test(clean)) return '/static/ingredient-bottle.png';
  if (/盐|糖|米|面/.test(clean)) return '/static/ingredient-jar.png';
  return '/static/ingredient-greens.png';
}

export function filterPosts(posts, type, category, search = '') {
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return posts.filter((post) => {
    if (!matchesMenuFilter(post, type, category)) return false;
    const content = [post.title, ...post.recipes.flatMap((recipe) => [recipe.title, ...recipe.ingredients.map((item) => item.name)])].join(' ').toLocaleLowerCase();
    return terms.every((term) => content.includes(term));
  });
}

export function matchesMenuFilter(entry, type, category) {
  const isSet = entry.kind === 'menu' || entry.kind === 'set';
  const setsOnly = ['套餐', '菜单'].includes(type);
  if (type !== '全部' && setsOnly !== isSet) return false;
  return setsOnly || category === '全部' || (!isSet && entry.recipes[0]?.category === category);
}

export function mealDishRows(items, entries = []) {
  const sets = entries.filter((entry) => entry.kind === 'set').map((entry, index) => ({ id: entry.id, title: entry.title, recipeIds: entry.recipeIds || [], tone: index % 5, position: index }));
  const unique = new Map();
  for (const item of items) {
    if (!unique.has(item.recipe.id)) unique.set(item.recipe.id, { ...item, groups: sets.filter((group) => group.recipeIds.includes(item.recipe.id)) });
  }
  return [...unique.values()].sort((left, right) => (left.groups[0]?.position ?? sets.length) - (right.groups[0]?.position ?? sets.length));
}

export function mealVoterRows(rows, members = []) {
  const profiles = new Map(members.map((member, index) => [member.id, { ...member, tone: index % 5 }]));
  return rows.map((row) => {
    const voters = new Map();
    for (const member of row.chosenBy || []) {
      if (!member?.id || voters.has(member.id)) continue;
      const profile = profiles.get(member.id);
      const name = profile?.name?.trim() || member.name?.trim() || '家人';
      voters.set(member.id, { id: member.id, name, avatar: profile?.avatar || '', tone: profile?.tone || 0 });
    }
    return { ...row, voters: [...voters.values()] };
  });
}

export function removeDishSelection(cart, mealSets, recipeId) {
  const next = { ...cart };
  for (const mealSet of mealSets) {
    const key = `set:${mealSet.id}`;
    if (next[key] && mealSet.recipeIds.includes(recipeId)) {
      delete next[key];
      mealSet.recipeIds.filter((id) => id !== recipeId).forEach((id) => { next[id] = 1; });
    }
  }
  delete next[recipeId];
  return next;
}

export function commentThreads(comments) {
  return comments.filter((entry) => !entry.parentId).map((entry) => ({ ...entry, replies: comments.filter((reply) => reply.parentId === entry.id) }));
}
