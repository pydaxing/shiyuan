export function createCachedReads({ cache, now = Date.now, freshFor = 30000 }) {
  const pending = new Map();
  let generation = 0;
  const keyOf = (scope, id) => JSON.stringify([scope, id]);
  function peek(scope, id) { return cache.get(keyOf(scope, id))?.value; }
  function read(scope, id, request) {
    const key = keyOf(scope, id);
    const saved = cache.get(key);
    if (saved && now() >= saved.savedAt && now() - saved.savedAt < freshFor) return Promise.resolve(saved.value);
    if (pending.has(key)) return pending.get(key);
    const token = generation;
    const promise = Promise.resolve().then(request).then(value => {
      if (token !== generation) throw Object.assign(new Error('数据已更新'), { code: 'CACHE_SUPERSEDED' });
      cache.set(key, { value, savedAt: now() });
      return value;
    }).catch(error => {
      if (token !== generation) throw Object.assign(new Error('数据已更新'), { code: 'CACHE_SUPERSEDED' });
      if (['INVALID', 'FORBIDDEN', 'NO_FAMILY', 'UNAUTHENTICATED'].includes(error.code)) cache.delete(key);
      throw error;
    }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
    pending.set(key, promise);
    return promise;
  }
  function clear() { generation += 1; pending.clear(); cache.clear(); }
  return { peek, read, clear };
}
