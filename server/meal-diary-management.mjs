import { createHash } from 'node:crypto';
import { personalSpaceId } from './workspaces.mjs';
import { canReadMealPost, isSharedFamilyMeal } from './meal-access.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export const mealDiaryRelationId = (postId, userId) => hash(`${postId}:${userId}`);
const aliveFamily = family => family && !family.deletedAt && family.status !== 'deleted' && family.kind !== 'personal';

// Scope is always derived from the authenticated workspace and canonical meal;
// accepting a client-supplied scope would let a personal delete erase a family.
export async function mealDiaryCapabilities(db, post, userId, family) {
  const none = { canDelete: false, canChangeVisibility: false, deleteScope: 'own' };
  if (!post || !await canReadMealPost(db, post, userId, family)) return none;
  const owns = post.authorId === userId;
  if (family.kind === 'personal') {
    if (post.spaceId === family.id) return { canDelete: owns, canChangeVisibility: owns, deleteScope: 'own' };
    // Former members keep their own archive reference, but may no longer
    // change the visibility of the shared source meal.
    const hasReference = owns || isSharedFamilyMeal(post) && post.participantUserIds?.includes(userId);
    if (!hasReference) return none;
    const source = await db.get('families', post.spaceId);
    const member = aliveFamily(source) && source.members?.some(item => item.id === userId);
    return { canDelete: true, canChangeVisibility: Boolean(member && (post.visibility !== 'private' || owns)), deleteScope: 'personal' };
  }
  if (post.spaceId !== family.id) {
    // A mixed diary can contain this user's personal meals or archived meals
    // from a former family. Resolve rights as a personal reference there.
    return mealDiaryCapabilities(db, post, userId, { id: personalSpaceId(userId), kind: 'personal' });
  }
  const canManage = owns || post.visibility === 'public' || isSharedFamilyMeal(post) && post.visibility === 'family';
  return { canDelete: canManage, canChangeVisibility: canManage, deleteScope: 'shared' };
}

export async function hidePersonalMeal(db, post, userId, now) {
  const id = mealDiaryRelationId(post.id, userId);
  const previous = await db.get('meal_reactions', id) || { postId: post.id, userId, liked: false, tags: [] };
  await db.set('meal_reactions', id, { ...previous, diaryHiddenAt: previous.diaryHiddenAt || now() });
  return { deletedId: post.id, deleteScope: 'personal' };
}

// Keep the minimal source reference on a tombstone, so old orders cannot
// recreate a deleted diary entry at the next automatic archival pass.
export async function deleteCanonicalMeal(db, post, userId, now, scope) {
  const deletedAt = now();
  const keys = ['id', 'spaceId', 'authorId', 'kind', 'orderId', 'date', 'meal', 'createdAt', 'mealSharingVersion', 'mealContext', 'participantUserIds'];
  const tombstone = Object.fromEntries(keys.filter(key => post[key] !== undefined).map(key => [key, post[key]]));
  await db.set('meal_posts', post.id, { ...tombstone, status: 'deleted', deletedAt, deletedByUserId: userId });
  if (post.orderId && post.spaceId) {
    const orderKey = hash(`${post.spaceId}:${post.orderId}`);
    const row = await db.get('orders', orderKey);
    if (row?.familyId === post.spaceId && row.value?.id === post.orderId) {
      await db.set('orders', orderKey, { ...row, value: { ...row.value, diaryDeletedAt: deletedAt, mealPostId: row.value.mealPostId || post.id } });
    }
  }
  const source = await db.get('families', post.spaceId);
  if (source) await db.set('families', post.spaceId, { ...source, socialWriteVersion: (source.socialWriteVersion || 0) + 1, revision: (source.revision || 0) + 1, updatedAt: deletedAt });
  return { deletedId: post.id, ...(scope ? { deleteScope: scope } : {}), ...(post.orderId ? { suppressedOrderIds: [post.orderId] } : {}) };
}
