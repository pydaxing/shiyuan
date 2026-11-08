// Keep the original dish index: omitted covers and duplicate images must never
// send a tap to a different dish. Actual photos are not recipe thumbnails.
export function mealPostMedia(post) {
  if (post?.kind === 'plan' && Array.isArray(post.dishes) && post.dishes.length) {
    return post.dishes.slice(0, 9).map((dish, dishIndex) => ({
      image: typeof dish.image === 'string' ? dish.image.trim() : '', dishIndex,
      title: dish.title || '菜品', isDish: true, defaultCover: typeof dish.image !== 'string' || !dish.image.trim(),
      sourceLabel: dish.sourceKind === 'community' ? '美食' : dish.sourceKind === 'custom' ? '自建' : '',
      canOpenRecipe: dish.sourceKind === 'community' && typeof dish.image === 'string' && Boolean(dish.image.trim()),
    }));
  }
  return (post?.images || []).map(image => ({ image, isDish: false, ...(post?.kind === 'actual' ? { sourceLabel: '实拍' } : {}) }));
}
