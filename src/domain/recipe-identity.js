import { stepImages } from './presentation.js';

const text = value => typeof value === 'string' ? value.trim() : '';

function ingredientContent(item) {
  const name = text(item.name);
  if (item.amountText === undefined) return { name, quantity: Number(item.quantity), unit: item.unit };
  const amountText = text(item.amountText);
  // Old cloud versions transport the generic spoon as text. The editor restores
  // this exact numeric form; it is a representation change, not a new recipe.
  const spoon = item.quantity == null && !item.unit && amountText.match(/^(\d+(?:\.\d+)?)\s*匙$/);
  if (spoon) return { name, quantity: Number(spoon[1]), unit: '匙' };
  return { name, amountText };
}

// Compare recipe content, not IDs, display names, audit timestamps or legacy
// image/image-array representations. This also identifies pre-v2 edited copies.
export function recipeContentKey(recipe) {
  if (!recipe) return '';
  return JSON.stringify({
    title: text(recipe.title), category: recipe.category, servings: Number(recipe.servings || 2),
    minutes: recipe.minutes == null || recipe.minutes === '' ? null : Number(recipe.minutes),
    image: recipe.image || '', guideImage: recipe.guideImage || '', nutrition: text(recipe.nutrition),
    ingredients: (recipe.ingredients || []).map(ingredientContent),
    steps: (recipe.steps || []).map(step => ({ title: text(step.title), text: text(step.text), images: stepImages(step).filter(Boolean) }))
      .filter(step => step.title || step.text || step.images.length),
    provenance: Object.fromEntries(['source', 'url', 'license', 'attribution', 'note'].map(key => [key, text(recipe.provenance?.[key])])),
  });
}

export const sameRecipeContent = (left, right) => recipeContentKey(left) === recipeContentKey(right);

export function canonicalRecipeId(recipe) {
  return recipe?.canonicalRecipeId || recipe?.communityRecipeId || (recipe?.identityVersion === 2 ? recipe.id : recipe?.shareId || recipe?.id) || '';
}

export function isPrivateRecipeCollection(collection) {
  return collection?.sourceKind === 'private' || String(collection?.id || '').startsWith('friend-')
    || (collection?.format === 'shiyuan-share' && collection.sourceKind !== 'community' && collection.status !== 'published');
}

export function isCommunityRecipe(recipe) {
  return recipe?.identityVersion === 2 && recipe.recipeOrigin === 'community';
}

export function sourceRecipeInPost(recipe, post) {
  if (!recipe || !post || isPrivateRecipeCollection(post) || post.status && !['published', 'deleted'].includes(post.status)) return undefined;
  // A bare legacy sourceId was not globally unique. Require its owning post
  // or household before treating it as an import from the public catalogue.
  if (!recipe.communityRecipeId && !recipe.sourcePostId && !recipe.sourceFamilyId) return undefined;
  if (recipe.sourcePostId && recipe.sourcePostId !== post.id) return undefined;
  if (recipe.sourceFamilyId && recipe.sourceFamilyId !== post.familyId && !recipe.communityRecipeId) return undefined;
  const ids = [recipe.communityRecipeId, recipe.sourceId].filter(Boolean);
  return post.recipes?.find(source => ids.includes(source.id) || ids.includes(source.canonicalRecipeId));
}

export function wasRecipePublished(recipe, posts = [], familyId) {
  if (!recipe || !familyId) return false;
  const ids = new Set([recipe.id, canonicalRecipeId(recipe)].filter(Boolean));
  return posts.some(post => post.familyId === familyId && !isPrivateRecipeCollection(post)
    && (!post.status || ['published', 'deleted'].includes(post.status))
    && (((post.familyKind || (post.kind === 'menu' ? 'set' : 'dish')) === 'dish' && post.familyItemId === recipe.id)
      || post.recipes?.some(source => ids.has(source.id) || ids.has(source.canonicalRecipeId))));
}

export function isUnchangedCommunityRecipe(recipe, posts = []) {
  if (isCommunityRecipe(recipe)) return true;
  if (!recipe || recipe.recipeOrigin === 'custom' || recipe.forkedFromRecipeId || String(recipe.sourcePostId || '').startsWith('friend-')) return false;
  return posts.some(post => {
    const source = sourceRecipeInPost(recipe, post);
    return source && Array.isArray(source.ingredients) && Array.isArray(source.steps) && sameRecipeContent(recipe, source);
  });
}

// A private fork keeps lineage for attribution, but lineage never grants public
// visibility. The public identity is removed until this new recipe is published.
export function privateRecipeIdentity(recipe, id, previous, { fork = false } = {}) {
  const result = { ...recipe, id, shareId: id, identityVersion: 2, recipeOrigin: 'custom' };
  delete result.communityRecipeId;
  delete result.canonicalRecipeId;
  delete result.publishedPostId;
  if (fork) {
    result.forkedFromRecipeId = previous.id;
    result.sourceId = previous.communityRecipeId || previous.sourceId || canonicalRecipeId(previous);
    if (previous.sourcePostId) result.sourcePostId = previous.sourcePostId;
    if (previous.sourceFamilyId) result.sourceFamilyId = previous.sourceFamilyId;
  }
  return result;
}
