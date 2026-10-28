export const OFFICIAL_PUBLISHER_ID = 'official:shiyuan';
export const OFFICIAL_PUBLISHER_NAME = '食愿小灶';

export function isOfficialPost(post) {
  return post?.publisherType === 'official' || post?.publisherId === OFFICIAL_PUBLISHER_ID;
}

export function communityPublisherName(post) {
  if (!isOfficialPost(post)) return post?.author || '';
  const sourceAuthor = post.recipes?.length === 1 ? post.recipes[0].provenance?.attribution : '';
  return (typeof sourceAuthor === 'string' && sourceAuthor.trim()) || post.author || OFFICIAL_PUBLISHER_NAME;
}

export function canDeleteCommunityPost(post, memberId, familyId) {
  return Boolean(post && typeof familyId === 'string' && familyId && post.familyId === familyId && typeof memberId === 'string' && memberId && post.publisherId === memberId && !isOfficialPost(post));
}

export function editableCommunityEntry(post, state) {
  if (!canDeleteCommunityPost(post, state?.activeMemberId, state?.family?.id) || !post.familyItemId) return null;
  if (!['dish', 'menu'].includes(post.kind)) return null;
  const kind = post.kind === 'menu' ? 'set' : 'dish';
  const entries = kind === 'set' ? state.mealSets : state.recipes;
  const entry = entries?.find(item => item.id === post.familyItemId);
  return entry ? { ...entry, kind } : null;
}
