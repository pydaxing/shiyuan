// Internal snapshots never enter mealPostView's public field allowlist.
export const mealRecipeSnapshots = order => structuredClone((order?.items || []).slice(0, 50).map(item => item.recipe || null));
export function matchMealRecipes(post, recipes) {
  const dishes = post.dishes || [];
  const positional = dishes.length === recipes.length && dishes.every((dish, index) => dish.title?.trim() === recipes[index]?.title?.slice(0, 30).trim()
    && (!dish.image || dish.image === recipes[index]?.image));
  return dishes.map((dish, index) => {
    if (dish.recipeId) {
      const matches = recipes.filter(recipe => recipe?.id === dish.recipeId);
      return matches.length === 1 ? matches[0] : null;
    }
    return positional && dish.title?.trim() ? recipes[index] : null;
  });
}

// Preserve legacy records transactionally before an order changes or disappears.
export async function preserveMealRecipes(db, spaceId, order) {
  const posts = await db.list('meal_posts', { spaceId, orderId: order.id, status: 'published' });
  for (const post of posts) {
    if (post.kind !== 'plan' || post.recipeSnapshots || post.date !== order.date || post.meal !== order.meal) continue;
    const recipeSnapshots = matchMealRecipes(post, mealRecipeSnapshots(order));
    await db.set('meal_posts', post.id || post._id, { ...post, recipeSnapshots });
  }
}
