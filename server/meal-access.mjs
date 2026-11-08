// A meal has one canonical record. Participant IDs are server-owned archive
// references, not copies and not a replacement for its current visibility.
export const isSharedFamilyMeal = post => post?.mealSharingVersion === 2 && post.mealContext === 'family';
export async function canReadMealPost(db, post, userId, knownFamily) {
  if (post?.status !== 'published') return false;
  if (post.visibility === 'public' || post.authorId === userId) return true;
  if (post.visibility !== 'family' || !isSharedFamilyMeal(post)) return false;
  if (post.participantUserIds?.includes(userId)) return true;
  const family = knownFamily?.id === post.spaceId ? knownFamily : await db.get('families', post.spaceId);
  return Boolean(family && !family.deletedAt && family.status !== 'deleted' && family.kind !== 'personal' && family.members?.some(member => member.id === userId));
}
