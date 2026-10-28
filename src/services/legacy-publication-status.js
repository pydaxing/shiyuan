import { publicationKey } from '../domain/community-publications.js';

const fail = (message, code = 'PUBLICATION_SYNC_FAILED') => { throw Object.assign(new Error(message), { code }); };
const postKey = post => publicationKey(post.familyKind || (post.kind === 'menu' ? 'set' : post.kind), post.familyItemId);

export function publicationStatusMatches(status, snapshot) {
  return Boolean(status?.familyId && status.memberId && Number.isSafeInteger(status.revision)
    && status.familyId === snapshot.family?.id && status.memberId === snapshot.activeMemberId
    && status.revision === snapshot.family.revision);
}

export async function readLegacyPublicationStatus({ request, getSnapshot, isActive = () => true }) {
  const snapshot = getSnapshot();
  const scope = { familyId: snapshot.family?.id, memberId: snapshot.activeMemberId, revision: snapshot.family?.revision };
  const check = () => {
    if (!isActive() || !publicationStatusMatches(scope, getSnapshot())) fail('家庭信息已变化，请重新同步分享状态', 'PUBLICATION_SCOPE_CHANGED');
  };
  check();
  const wanted = new Set([
    ...(snapshot.recipes || []).map(item => publicationKey('dish', item.id)),
    ...(snapshot.mealSets || []).map(item => publicationKey('set', item.id)),
  ].filter(Boolean));
  const found = new Map();
  const visited = new Set();
  const checkedPosts = new Set();
  let cursor = '';
  while (found.size < wanted.size) {
    if (visited.has(cursor) || visited.size >= 100) fail('分享清单未能完整核对，请稍后重新同步');
    visited.add(cursor);
    check();
    const page = await request('feed', { type: '全部', category: '全部', search: '', cursor, compact: true, includeImageManifests: false });
    check();
    if (!Array.isArray(page?.posts) || typeof page.cursor !== 'string') fail('分享清单返回不完整，请重新同步');
    for (const card of page.posts) {
      if (!card || typeof card.id !== 'string' || !card.id) fail('分享清单返回不完整，请重新同步');
      const key = postKey(card);
      if (!wanted.has(key) || found.has(key) || checkedPosts.has(card.id)) continue;
      checkedPosts.add(card.id);
      const detail = await request('readPost', { postId: card.id, includeComments: false, paginateComments: true, includeImageManifests: false });
      check();
      const post = detail?.post;
      if (!post || post.id !== card.id || typeof post.familyId !== 'string' || !post.familyId || typeof post.status !== 'string' || !post.status || postKey(post) !== key) fail('分享记录已变化，请重新同步');
      if (post.familyId === scope.familyId && post.status === 'published') {
        found.set(key, { kind: key.startsWith('set:') ? 'set' : 'dish', itemId: post.familyItemId, postId: post.id });
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  check();
  const current = await request('bootstrap', { knownFamilyId: scope.familyId, knownRevision: scope.revision, includeFeed: false, includeImageManifests: false });
  check();
  if (current?.familyId !== scope.familyId || current.userId !== scope.memberId || current.revision !== scope.revision) {
    fail('家人更新了分享记录，请重新同步', 'PUBLICATION_CHANGED');
  }
  return { ...scope, items: [...found.values()] };
}
