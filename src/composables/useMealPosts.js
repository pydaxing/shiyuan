import { DEFAULT_FAMILY_COVER } from '../domain/family.js';
import { computed, onUnmounted, ref, watch } from 'vue';
import { cloudMode, cloudStatus, invokeCloud, currentIdentity } from '../services/cloud.js';

const mealError = (failure, fallback) => failure.message === '不支持的请求' ? '餐食分享暂不可用，请稍后重试' : failure.message || fallback;

// Cache belongs to the page and current identity, never to another workspace.
export function useMealPosts(kind, enabled) {
  const posts = ref([]), cursor = ref(null), loading = ref(false), loaded = ref(false), error = ref('');
  const busy = ref({});
  const diaryManagementVersion = ref(0);
  const diaryArchiveComplete = ref(false);
  const suppressedOrderIds = ref([]);
  // Keep confirmed tombstones for this scope too: an eventually consistent read
  // or a late cross-page update must not resurrect a deleted diary entry.
  const deletions = ref(new Map());
  const visibleSuppressedOrderIds = computed(() => [...new Set([
    ...suppressedOrderIds.value, ...[...deletions.value.values()].map(item => item.orderId).filter(Boolean),
  ])]);
  // Only fields explicitly linked by the server can use local optimistic profile
  // changes. Missing flags from an old backend keep its compatible snapshot.
  const presentedPosts = computed(() => posts.value.map(post => {
    const identity = currentIdentity?.value, author = post.author;
    if (!identity || !author) return post;
    if (author.mode === 'family' && author.currentSpace && identity.family?.id === cloudStatus.value.familyId) {
      return { ...post, author: { ...author, name: identity.family.name, avatar: identity.family.cover && identity.family.cover !== DEFAULT_FAMILY_COVER ? identity.family.cover : author.avatar } };
    }
    if (author.mode === 'personal' && author.currentUser && identity.profile?.name) {
      return { ...post, author: { ...author, name: identity.profile.name, avatar: identity.profile.avatar || '' } };
    }
    return post;
  }));
  const scope = computed(() => `${cloudStatus.value.userId}:${cloudStatus.value.familyId}:${cloudStatus.value.mealSharingVersion || 0}`);
  let revision = 0, generation = 0, lastLoadedAt = 0;
  let disposed = false;
  let failedRead = null;
  const optimistic = new Map();
  const likeWrites = new Map();
  const postVersions = new Map();
  const canShow = post => Boolean(post?.id) && !deletions.value.has(post.id) && post.status !== 'deleted' && (kind === 'mine' || post.visibility === 'public');
  const reactionValues = post => ({ liked: post.liked, likeCount: post.likeCount, ...(Array.isArray(post.likeUsers) ? { likeUsers: post.likeUsers } : {}), reactions: post.reactions });
  function invalidatePost(id) { postVersions.set(id, (postVersions.get(id) || 0) + 1); optimistic.delete(id); }
  async function readPage({ more, refresh, pageCursor }) {
    if (disposed || (loading.value && !refresh) || (more && !pageCursor)) return;
    if (!cloudMode || cloudStatus.value.phase !== 'ready') { failedRead = { more, refresh, pageCursor }; error.value = '连接微信云端后即可查看餐食记录'; return; }
    const request = ++revision, context = scope.value;
    loading.value = true; error.value = ''; failedRead = null;
    try {
      const result = await invokeCloud(kind === 'mine' ? 'myMealPosts' : 'mealFeed', { spaceId: cloudStatus.value.familyId, mealLikesVersion: 1, ...(kind === 'mine' ? { diaryManagementVersion: 1, userSummaryVersion: 1 } : {}), ...(cloudStatus.value.mealSharingVersion === 2 ? { mealSharingVersion: 2 } : {}), ...(more && pageCursor ? { cursor: pageCursor } : {}) });
      if (disposed || request !== revision || context !== scope.value) return;
      // A reaction in flight never grants visibility or replaces fresh content.
      const hiddenIds = new Set(result.posts.filter(post => post?.id && !canShow(post)).map(post => post.id));
      hiddenIds.forEach(invalidatePost);
      const incoming = result.posts.filter(canShow).map(post => optimistic.has(post.id) ? { ...post, ...reactionValues(optimistic.get(post.id)) } : post);
      posts.value = [...new Map([...(more ? posts.value.filter(post => !hiddenIds.has(post.id)) : []), ...incoming].filter(canShow).map(post => [post.id, post])).values()];
      diaryManagementVersion.value = result.diaryManagementVersion === 1 ? 1 : 0;
      diaryArchiveComplete.value = result.diaryArchiveComplete === true;
      suppressedOrderIds.value = [...new Set([...(more ? suppressedOrderIds.value : []), ...(result.suppressedOrderIds || [])])];
      cursor.value = result.cursor; loaded.value = true; lastLoadedAt = Date.now();
    } catch (failure) {
      if (!disposed && request === revision && context === scope.value) {
        failedRead = { more, refresh, pageCursor };
        error.value = mealError(failure, '餐食加载失败，请重试');
      }
    }
    finally { if (request === revision) loading.value = false; }
  }
  function load(more = false, refresh = false) { return readPage({ more, refresh, pageCursor: more ? cursor.value : null }); }
  function retry() { if (!loading.value) return failedRead ? readPage(failedRead) : load(false, true); }
  function refreshIfStale() { if (!loading.value && (!loaded.value || Date.now() - lastLoadedAt > 30000)) return load(); }
  function likeValue(post, selected) {
    const others = (post.likeUsers || []).filter(user => !user.self);
    return { ...post, liked: selected,
      ...(Array.isArray(post.likeUsers) ? { likeUsers: selected ? [...others, { key: 'self', self: true, name: currentIdentity?.value?.profile?.name || '我' }] : others } : {}),
      likeCount: Math.max(0, (post.likeCount || 0) + Number(selected) - Number(Boolean(post.liked))) };
  }
  function setLike(post, selected) {
    if (disposed || !post?.id || busy.value[post.id]) return;
    const current = posts.value.find(item => item.id === post.id);
    if (!current) return;
    const existing = likeWrites.get(post.id);
    if (existing?.selected === selected) return;
    const next = likeValue(current, selected);
    revision += 1; loading.value = false; error.value = ''; failedRead = null;
    optimistic.set(post.id, next);
    posts.value = posts.value.map(item => item.id === post.id ? next : item);
    if (existing) { existing.selected = selected; return; }
    const state = { selected, confirmed: current, retries: 0 };
    likeWrites.set(post.id, state);
    const context = scope.value, epoch = generation, version = postVersions.get(post.id) || 0;
    const valid = () => !disposed && context === scope.value && epoch === generation && version === (postVersions.get(post.id) || 0);
    return (async () => {
      try {
        while (valid()) {
          const sent = state.selected;
          let result;
          try {
            result = await invokeCloud('setMealLike', { spaceId: cloudStatus.value.familyId, mealLikesVersion: 1, mealReactionVersion: 1, postId: post.id, selected: sent });
            if (!valid()) return;
            const ack = result.reaction || result.post;
            if (ack?.id !== post.id || ack.liked !== sent) throw new Error('点赞状态尚未确认，请重试');
            const confirmed = likeValue(state.confirmed, sent);
            state.confirmed = { ...confirmed, ...(result.reaction ? { liked: ack.liked, likeCount: ack.likeCount } : reactionValues(ack)) };
          } catch (failure) {
            if (!valid()) return;
            // A newer tap still needs its own idempotent write, even if the
            // previous response was lost after the server committed it.
            if (sent !== state.selected) { state.retries = 0; continue; }
            if (failure.code === 'NETWORK' && state.retries++ < 1) continue;
            revision += 1; loading.value = false;
            posts.value = posts.value.map(item => item.id === post.id ? { ...item, ...reactionValues(state.confirmed) } : item);
            error.value = mealError(failure, '点赞没有保存成功，请重试');
            return;
          }
          state.retries = 0;
          if (sent !== state.selected) continue;
          revision += 1; loading.value = false;
          const latest = posts.value.find(item => item.id === post.id);
          if (!latest) return;
          const updated = { ...latest, ...reactionValues(state.confirmed) };
          posts.value = posts.value.map(item => item.id === post.id ? updated : item);
          return { post: updated };
        }
      } finally {
        if (likeWrites.get(post.id) === state) { likeWrites.delete(post.id); optimistic.delete(post.id); }
      }
    })();
  }
  async function mutate(action, post, changes = {}) {
    if (action === 'setMealLike') return setLike(post, changes.selected);
    if (disposed || !post?.id || busy.value[post.id]) return;
    const context = scope.value, epoch = generation;
    const postVersion = postVersions.get(post.id) || 0;
    const reaction = action === 'setMealLike' || action === 'setMealReaction';
    const before = posts.value.find(item => item.id === post.id);
    const deleting = action === 'deleteMealPost';
    const beforeIndex = posts.value.findIndex(item => item.id === post.id);
    let next;
    if (before && action === 'setMealReaction') next = { ...before, reactions: (before.reactions || []).map(tag => tag.id === changes.tagId ? { ...tag, selected: changes.selected, count: Math.max(0, (tag.count || 0) + Number(changes.selected) - Number(Boolean(tag.selected))) } : tag) };
    // Immediate feedback; invalidate older reads and protect this state during paging.
    revision += 1; loading.value = false;
    if (next) { optimistic.set(post.id, next); posts.value = posts.value.map(item => item.id === post.id ? next : item); }
    if (deleting) {
      deletions.value.set(post.id, { orderId: post.sourceOrderId });
      removePost(post.id);
    }
    busy.value = { ...busy.value, [post.id]: true }; error.value = ''; failedRead = null;
    try {
      const result = await invokeCloud(action, { spaceId: cloudStatus.value.familyId, mealLikesVersion: 1, postId: post.id, ...(diaryManagementVersion.value === 1 ? { diaryManagementVersion: 1, userSummaryVersion: 1 } : {}), ...changes });
      if (disposed || epoch !== generation || context !== scope.value) return;
      if (reaction && postVersion !== (postVersions.get(post.id) || 0)) return;
      if (deleting && result?.deletedId !== post.id) throw new Error('删除状态尚未确认，请重试');
      if (action === 'setMealVisibility' && (result.post?.id !== post.id || result.post.visibility !== changes.visibility)) throw new Error('可见范围尚未确认，请刷新后重试');
      revision += 1; loading.value = false;
      if (result.deletedId || !canShow(result.post)) {
        suppressedOrderIds.value = [...new Set([...suppressedOrderIds.value, ...(result.suppressedOrderIds || []), ...(post.sourceOrderId ? [post.sourceOrderId] : [])])];
        removePost(post.id);
      }
      else if (reaction) {
        const current = posts.value.find(item => item.id === post.id);
        if (!current) return;
        const updated = { ...current, ...reactionValues(result.post) };
        posts.value = posts.value.map(item => item.id === post.id ? updated : item);
        // Parent caches must receive current privacy and author details too.
        return { ...result, post: updated };
      }
      else { invalidatePost(post.id); posts.value = posts.value.map(item => item.id === post.id ? result.post : item); }
      return result;
    } catch (failure) {
      if (!disposed && epoch === generation && context === scope.value && (!reaction || postVersion === (postVersions.get(post.id) || 0))) {
        revision += 1; loading.value = false;
        if (deleting) {
          deletions.value.delete(post.id);
          if (before && !posts.value.some(item => item.id === post.id)) {
            const restored = [...posts.value];
            restored.splice(Math.min(beforeIndex, restored.length), 0, before);
            posts.value = restored.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
          }
        }
        if (next) posts.value = posts.value.map(item => item.id === post.id ? { ...item, ...reactionValues(before) } : item);
        error.value = mealError(failure, '没有保存成功，请重试');
      }
      return undefined;
    } finally { if (!disposed && epoch === generation && context === scope.value) { optimistic.delete(post.id); const pending = { ...busy.value }; delete pending[post.id]; busy.value = pending; } }
  }
  function syncReactions(post) {
    if (disposed || busy.value[post.id] || optimistic.has(post.id) || !posts.value.some(item => item.id === post.id)) return;
    revision += 1; loading.value = false;
    // A late like acknowledgement from another view cannot restore old visibility.
    posts.value = posts.value.map(item => item.id === post.id ? { ...item, liked: post.liked, likeCount: post.likeCount, ...(Array.isArray(post.likeUsers) ? { likeUsers: post.likeUsers } : {}), reactions: post.reactions } : item);
  }
  function removePost(id) { if (disposed || !id) return; invalidatePost(id); revision += 1; loading.value = false; posts.value = posts.value.filter(post => post.id !== id); }
  function acceptPost(post) {
    if (disposed || !post?.id || deletions.value.has(post.id)) return;
    if (!canShow(post)) { removePost(post.id); return; }
    invalidatePost(post.id);
    revision += 1; loading.value = false;
    posts.value = [post, ...posts.value.filter(item => item.id !== post.id)].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  function reset() { generation += 1; revision += 1; lastLoadedAt = 0; failedRead = null; likeWrites.clear(); deletions.value.clear(); optimistic.clear(); postVersions.clear(); posts.value = []; diaryManagementVersion.value = 0; diaryArchiveComplete.value = false; suppressedOrderIds.value = []; cursor.value = null; error.value = ''; loading.value = false; loaded.value = false; busy.value = {}; }
  watch(scope, () => { reset(); if (enabled.value) void load(); }, { flush: 'sync' });
  watch(() => cloudStatus.value.phase, phase => { if (phase === 'ready' && enabled.value && !loaded.value) void load(); });
  watch(enabled, active => { if (active) void refreshIfStale(); }, { immediate: true });
  onUnmounted(() => { disposed = true; generation += 1; revision += 1; });
  return { posts: presentedPosts, diaryManagementVersion, diaryArchiveComplete, suppressedOrderIds: visibleSuppressedOrderIds, cursor, loading, loaded, error, busy, load, retry, refreshIfStale, mutate, acceptPost, removePost, syncReactions };
}
