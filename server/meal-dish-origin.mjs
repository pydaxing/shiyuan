import { createHash } from 'node:crypto';
import { isPrivateRecipeCollection, sameRecipeContent } from '../src/domain/recipe-identity.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && /^[\w-]{1,200}$/.test(value) ? value : '';
const list = value => Array.isArray(value) ? value : [];
const sameContent = (left, right) => {
  if (![left, right].every(recipe => recipe && Array.isArray(recipe.ingredients) && Array.isArray(recipe.steps))) return false;
  try { return sameRecipeContent(left, right); } catch { return false; }
};

// This is presentation provenance, not permission to read a recipe or its media.
// Cache within one response only: later publication/withdrawal must be visible
// on refresh. A page can repeat the same dish across several recorded meals.
export function createMealDishOrigins(db) {
  const reads = new Map();
  const waiting = [];
  let active = 0;
  function advance() {
    while (active < 6 && waiting.length) {
      const { run, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active -= 1; advance(); });
    }
  }
  function read(key, run) {
    if (!reads.has(key)) reads.set(key, new Promise((resolve, reject) => { waiting.push({ run, resolve, reject }); advance(); }));
    return reads.get(key);
  }
  const currentRecipe = (spaceId, recipeId) => read(`recipe:${spaceId}:${recipeId}`, async () => {
    const row = await db.get('recipes', hash(`${spaceId}:${recipeId}`));
    return row?.familyId === spaceId && row.value?.id === recipeId ? row.value : null;
  });
  const publishedRecipe = (spaceId, recipeId) => read(`published-recipe:${spaceId}:${recipeId}`, async () => (
    await db.list('posts', { familyId: spaceId, status: 'published', 'recipes.id': recipeId }, { limit: 1, fields: ['_id'] })
  ).length > 0);
  const publishedItem = (spaceId, recipeId) => read(`published-item:${spaceId}:${recipeId}`, async () => {
    const rows = await db.list('posts', { familyId: spaceId, familyItemId: recipeId, status: 'published' }, { limit: 2, fields: ['familyKind', 'kind'] });
    return rows.some(row => (row.familyKind || (row.kind === 'menu' ? 'set' : 'dish')) === 'dish');
  });
  const sourcePost = postId => read(`source-post:${postId}`, () => db.get('posts', postId));
  const publishedSources = (spaceId, recipeId) => read(`published-sources:${spaceId}:${recipeId}`, () => db.list('posts',
    { familyId: spaceId, status: 'published', 'recipes.id': recipeId },
    { limit: 100, fields: ['id', 'familyId', 'status', 'sourceKind', 'format', 'recipes'] }));

  async function importedPublication(snapshot, versions) {
    for (const recipe of versions) {
      const sourceId = identity(recipe.sourceId) || identity(recipe.communityRecipeId);
      const sourceFamilyId = identity(recipe.sourceFamilyId);
      const sourcePostId = identity(recipe.sourcePostId);
      if (!sourceId || sourcePostId.startsWith('friend-')) continue;
      const matches = post => post?.status === 'published' && !isPrivateRecipeCollection(post)
        && (!sourceFamilyId || post.familyId === sourceFamilyId)
        && list(post.recipes).some(item => [identity(item?.id), identity(item?.canonicalRecipeId)].some(id => id && id === sourceId)
          && sameContent(snapshot, item));
      if (sourcePostId) {
        const post = await sourcePost(sourcePostId);
        // Friend shares live in a different collection. Matching only the
        // exact recipe ID is not enough: old clients edited imported copies
        // without clearing source links. Compare the recorded content too.
        if (matches(post)) return true;
        continue;
      }
      if (sourceFamilyId && (await publishedSources(sourceFamilyId, sourceId)).some(matches)) return true;
    }
    return false;
  }

  async function origin(source, post, fallbackRecipeId) {
    const recipeId = identity(source?.id) || identity(fallbackRecipeId);
    if (!source || !recipeId || !identity(post.spaceId)) return { kind: '', label: '' };
    // Origin belongs to the recorded recipe. An in-place edit made by an old
    // client must not relabel an earlier meal that used the unchanged import.
    const custom = source.recipeOrigin === 'custom' || Boolean(identity(source.forkedFromRecipeId));
    if (!custom && source.identityVersion === 2 && source.recipeOrigin === 'community') return { kind: 'community', label: '' };
    const current = await currentRecipe(post.spaceId, recipeId);
    const versions = [source, ...(sameContent(source, current) ? [current] : [])];
    // Forks retain attribution to the original recipe, but are a new creation.
    // Their historical source links cannot make the edited ID a public dish.
    const imported = versions.some(recipe => recipe.sourceId || recipe.sourcePostId || recipe.sourceFamilyId);
    const shareIds = [...new Set([recipeId, ...versions.map(recipe => identity(recipe.shareId)).filter(Boolean)])];
    const shared = await Promise.all([
      publishedItem(post.spaceId, recipeId),
      ...shareIds.map(id => publishedRecipe(post.spaceId, id)),
      ...(!custom && imported ? [importedPublication(source, versions)] : []),
    ]);
    if (shared.some(Boolean)) return { kind: 'community', label: '' };
    // Old incomplete/withdrawn source links do not prove a recipe was never
    // published. Keep the neutral custom badge but do not assert that history.
    if (imported && !custom) return { kind: 'custom', label: '' };
    const mode = post.mealContext === 'personal' || !post.mealContext && post.author?.mode === 'personal' ? '个人' : '家庭';
    const created = custom || versions.some(recipe => identity(recipe.createdBy) && Number.isFinite(recipe.createdAt) && recipe.createdAt > 0);
    return { kind: 'custom', label: `${mode}${created ? '创建' : ''}菜品 · 暂未发布到美食` };
  };
  // Resolve a published post by identity only, never by a matching title.
  origin.communityPostId = async (source, meal) => {
    if (!source || (await origin(source, meal)).kind !== 'community') return '';
    const current = await currentRecipe(meal.spaceId, identity(source.id));
    const versions = [source, ...(sameContent(source, current) ? [current] : [])];
    const canonical = source.identityVersion === 2 && source.recipeOrigin === 'community'
      ? identity(source.canonicalRecipeId) || identity(source.id) : '';
    for (const recipe of versions) {
      const id = identity(recipe.sourcePostId);
      if (!id || id.startsWith('friend-') || source.recipeOrigin === 'custom' || source.forkedFromRecipeId) continue;
      const published = await sourcePost(id);
      if (published?.status === 'published' && !isPrivateRecipeCollection(published)
        && (!recipe.sourceFamilyId || published.familyId === recipe.sourceFamilyId)
        && list(published.recipes).some(item => canonical ? [item.id, item.canonicalRecipeId].includes(canonical)
          : [recipe.sourceId, recipe.communityRecipeId].filter(Boolean).includes(item.id) && sameContent(source, item))) return published.id;
    }
    const ids = [...new Set([canonical, identity(source.id), ...versions.map(recipe => identity(recipe.shareId))].filter(Boolean))];
    for (const id of ids) {
      const rows = await read(`public-target:${meal.spaceId}:${id}:${canonical}`, () => db.list('posts',
        { status: 'published', ...(!canonical ? { familyId: meal.spaceId } : {}), 'recipes.id': id }, { limit: 100 }));
      const published = rows.filter(row => !isPrivateRecipeCollection(row)).sort((a, b) => Number(a.kind !== 'dish') - Number(b.kind !== 'dish')).find(row =>
        list(row.recipes).some(item => item.id === id));
      if (published) return published.id;
    }
    // Older imports without a post ID still carry an exact source family/recipe link.
    for (const recipe of versions) {
      if (source.recipeOrigin === 'custom' || source.forkedFromRecipeId || !identity(recipe.sourceFamilyId)) continue;
      const id = identity(recipe.sourceId) || identity(recipe.communityRecipeId);
      if (!id) continue;
      const published = (await publishedSources(recipe.sourceFamilyId, id)).find(row => !isPrivateRecipeCollection(row)
        && list(row.recipes).some(item => item.id === id && sameContent(source, item)));
      if (published) return published.id;
    }
    return '';
  };
  return origin;

}
