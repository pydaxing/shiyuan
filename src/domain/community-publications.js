export function publicationKey(kind, itemId) {
  return ['dish', 'set'].includes(kind) && typeof itemId === 'string' && itemId ? `${kind}:${itemId}` : '';
}

export function familyPublications(snapshot) {
  if (Array.isArray(snapshot.sharedItems)) return snapshot.sharedItems.filter(item => publicationKey(item.kind, item.itemId) && item.postId);
  return (snapshot.posts || []).filter(post => post.familyItemId && (!post.status || post.status === 'published') && (Boolean(snapshot.family?.id) && post.familyId === snapshot.family.id)).map(post => ({
    kind: post.familyKind || (post.kind === 'menu' ? 'set' : 'dish'), itemId: post.familyItemId, postId: post.id,
  })).filter(item => publicationKey(item.kind, item.itemId));
}

export function publishedFamilyKeys(snapshot) {
  return new Set(familyPublications(snapshot).map(item => publicationKey(item.kind, item.itemId)));
}
