import { ref } from 'vue';
import { createPersistentCache } from './persistent-cache.js';

const feedCache = createPersistentCache(`shiyuan-feed-v3-${import.meta.env?.VITE_CLOUD_ENV || 'local'}-${import.meta.env?.VITE_CLOUD_FUNCTION || 'kitchen'}`, { maxChars: 180000, writeDelay: 150, validate: entry => Number.isFinite(entry?.savedAt) && Array.isArray(entry.posts) && entry.posts.every(post => typeof post?.id === 'string' && Array.isArray(post.recipes)) });
const requestsByCache = new WeakMap();
let cacheRevision = 0;
export const communityFeedRevision = ref(0);
export function invalidateCommunityFeed({ reset = true } = {}) { feedCache.clear(); cacheRevision += 1; if (reset) communityFeedRevision.value += 1; }

export function createCommunityFeed({ request, cache = feedCache, now = Date.now }) {
  if (!requestsByCache.has(cache)) requestsByCache.set(cache, new Map());
  const pending = requestsByCache.get(cache);
  const state = ref({ posts: [], cursor: '', loading: true, ready: false, error: '' });
  let sequence = 0;
  let timer;
  let selected;
  let failedMore = false;

  async function fetchPage(more, token, generation) {
    if (token !== sequence || generation !== communityFeedRevision.value) return;
    const current = selected;
    const cacheGeneration = cacheRevision;
    const previousPosts = more ? state.value.posts : [];
    const cursor = more ? state.value.cursor : '';
    const requestKey = JSON.stringify([current.key, cursor, generation, cacheGeneration]);
    try {
      if (!pending.has(requestKey)) {
        const promise = Promise.resolve(request({ ...current.query, cursor })).finally(() => { if (pending.get(requestKey) === promise) pending.delete(requestKey); });
        pending.set(requestKey, promise);
      }
      const result = await pending.get(requestKey);
      const posts = [...new Map([...previousPosts, ...result.posts].map(post => [post.id, post])).values()];
      if (generation === communityFeedRevision.value && cacheGeneration === cacheRevision && posts.length <= 64) {
        cache.set(current.key, { posts, cursor: result.cursor || '', savedAt: now() });
        if (cache.size > 12) cache.delete(cache.keys().next().value);
      }
      if (token !== sequence || generation !== communityFeedRevision.value) return;
      state.value = { posts, cursor: result.cursor || '', loading: false, ready: true, error: '' };
    } catch (error) {
      if (token === sequence) {
        failedMore = more;
        state.value = { ...state.value, loading: false, error: error.message || '暂时没加载出来，请重试' };
      }
    }
  }

  function select(query, scope, { delay = 0, retain = false } = {}) {
    const key = JSON.stringify([scope, query]);
    if (retain && selected?.key === key && selected.generation === communityFeedRevision.value) return;
    clearTimeout(timer);
    const token = ++sequence;
    failedMore = false;
    selected = { query: { ...query }, key, generation: communityFeedRevision.value };
    const emptyAll = cache.get(JSON.stringify([scope, { ...query, type: '全部', category: '全部', search: '' }]));
    const saved = cache.get(selected.key) || (emptyAll && !emptyAll.posts.length && !emptyAll.cursor ? emptyAll : undefined);
    const fresh = saved && now() >= saved.savedAt && now() - saved.savedAt < 120000;
    state.value = { posts: saved?.posts || [], cursor: saved?.cursor || '', loading: !fresh, ready: Boolean(saved), error: '' };
    if (fresh) return;
    const generation = selected.generation;
    if (delay) timer = setTimeout(() => { void fetchPage(false, token, generation); }, delay);
    else return fetchPage(false, token, generation);
  }

  function refresh(more = false) {
    if (!selected || state.value.loading || (more && !state.value.cursor)) return;
    clearTimeout(timer);
    state.value = { ...state.value, loading: true, error: '' };
    return fetchPage(more, ++sequence, communityFeedRevision.value);
  }

  function dispose() { clearTimeout(timer); sequence += 1; }
  return { state, select, refresh, retry: () => refresh(failedMore), dispose };
}
