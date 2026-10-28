import { isTransientMediaError } from './media-batch.js';

export function createMediaCache({ urls, fetchImage, writeImage, removeImage, prepareImage = image => image, releaseImage = () => {}, hasImage = () => true, checkImage, imageSize = () => 0, readEntries = () => [], saveEntries = () => {}, flushCache = () => {}, onError = () => {}, onSuccess = () => {}, now = Date.now, maxEntries = 100, maxBytes = 8 * 1024 * 1024, concurrency = 3, priority = () => false }) {
  const entries = new Map();
  const pending = new Map();
  const retryAfter = new Map();
  const queue = [];
  const removals = new Set();
  let diskQueue = Promise.resolve();
  let totalBytes = 0;
  let active = 0;
  let epoch = 0;
  let scope = '';
  function expiresAt(image) {
    const expiry = Math.min(now() + 300000, Number.isFinite(image?.urlExpiresAt) ? image.urlExpiresAt : Infinity);
    if (expiry <= now()) throw Object.assign(new Error('图片授权已过期，请重试'), { code: 'IMAGE_URL' });
    return expiry;
  }
  function persist() { if (scope) saveEntries(scope, [...entries].map(([fileId, entry]) => ({ fileId, ...entry }))); }
  function schedule(job, urgent) {
    return new Promise((resolve, reject) => { const task = { job, resolve, reject, urgent }; if (urgent) queue.unshift(task); else queue.push(task); drain(); });
  }
  function drain() {
    while (queue.length && active < concurrency + (queue[0].urgent ? 1 : 0)) {
      const task = queue.shift();
      active += 1;
      Promise.resolve().then(task.job).then(task.resolve, task.reject).finally(() => { active -= 1; drain(); });
    }
  }
  function remove(path) {
    const removal = Promise.resolve(removeImage(path));
    removals.add(removal);
    removal.then(() => removals.delete(removal), () => removals.delete(removal));
    return removal;
  }
  function discard(fileId) {
    const entry = entries.get(fileId);
    if (!entry) return Promise.resolve();
    totalBytes -= entry.bytes;
    entries.delete(fileId);
    persist();
    delete urls.value[fileId];
    return remove(entry.path);
  }
  function serializeDisk(job) {
    const result = diskQueue.then(job);
    diskQueue = result.catch(() => {});
    return result;
  }
  async function makeRoom(bytes) {
    await Promise.all(removals);
    while (entries.size && (entries.size >= maxEntries || totalBytes + bytes > maxBytes)) await discard(entries.keys().next().value);
  }
  async function write(image, bytes, version) {
    await makeRoom(bytes);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (version !== epoch) return '';
      try { return await writeImage(image); }
      catch (error) {
        if (version !== epoch || error.code !== 'CACHE_QUOTA' || !entries.size || attempt === 2) throw error;
        const target = attempt === 0 ? Math.max(bytes, totalBytes / 2) : totalBytes;
        let freed = 0;
        while (entries.size && freed < target) {
          const oldest = entries.keys().next().value;
          freed += entries.get(oldest).bytes;
          await discard(oldest);
        }
        if (!freed && entries.size) await discard(entries.keys().next().value);
      }
    }
  }
  function load(fileId, localImage, force = false, revalidate = false, isNeeded = () => true) {
    const stored = entries.get(fileId);
    const available = stored && !checkImage && hasImage(stored.path, stored.bytes);
    if (!force && !revalidate && available && stored.expiresAt > now()) {
      entries.delete(fileId);
      entries.set(fileId, stored);
      persist();
      return Promise.resolve(stored.path);
    }
    if (pending.has(fileId)) {
      const request = pending.get(fileId);
      request.demands.add(isNeeded);
      return request.promise;
    }
    const version = epoch;
    const demands = new Set([isNeeded]);
    const requested = () => [...demands].some(check => check());
    const promise = schedule(async () => {
      if (version !== epoch || !requested()) return '';
      const exists = stored && !force && (checkImage ? await checkImage(stored.path, stored.bytes) : hasImage(stored.path, stored.bytes));
      if (version !== epoch || !requested()) return '';
      const cached = exists && entries.get(fileId) === stored ? stored : undefined;
      if (!revalidate && cached?.expiresAt > now()) {
        entries.delete(fileId);
        entries.set(fileId, cached);
        urls.value[fileId] = cached.path;
        persist();
        onSuccess(fileId);
        return cached.path;
      }
      let image = localImage || await fetchImage(fileId, cached && !force ? fileId : '');
      if (version !== epoch || !requested()) return '';
      let prepared;
      if (!image?.unchanged) {
        try { prepared = await prepareImage(image); }
        catch (error) {
          if (error.code !== 'IMAGE_URL' || version !== epoch) throw error;
          image = await fetchImage(fileId, '');
          if (version !== epoch) return '';
          prepared = await prepareImage(image);
        }
      }
      try { return await serializeDisk(async () => {
        if (version !== epoch) return '';
        if (image?.unchanged) {
          if (image.version === fileId && cached && entries.get(fileId) === cached && (checkImage ? await checkImage(cached.path, cached.bytes) : hasImage(cached.path, cached.bytes))) {
            if (version !== epoch) return '';
            cached.expiresAt = expiresAt(image);
            entries.delete(fileId);
            entries.set(fileId, cached);
            persist();
            urls.value[fileId] = cached.path;
            retryAfter.delete(fileId);
            onSuccess(fileId);
            return cached.path;
          }
          image = await fetchImage(fileId, '');
          if (version !== epoch) return '';
          if (image?.unchanged) throw Object.assign(new Error('图片响应缺少内容，请重试'), { code: 'IMAGE_RESPONSE' });
          prepared = await prepareImage(image);
        }
        image = prepared;
        const bytes = await imageSize(image);
        if (version !== epoch) return '';
        await discard(fileId);
        const path = await write(image, bytes, version);
        if (version !== epoch) { if (path) await remove(path); return ''; }
        let deadline;
        try { deadline = expiresAt(image); }
        catch (error) { if (path) await remove(path); throw error; }
        retryAfter.delete(fileId);
        entries.set(fileId, { path, bytes, expiresAt: deadline });
        totalBytes += bytes;
        persist();
        onSuccess(fileId);
        urls.value[fileId] = path;
        return path;
      }); } finally { if (prepared) await releaseImage(prepared); }
    }, priority(fileId)).catch(error => {
      if (version === epoch) {
        retryAfter.set(fileId, now() + 30000);
        if (!isTransientMediaError(error)) void discard(fileId).catch(() => {});
        onError(error, fileId);
      }
      throw error;
    }).finally(() => { if (pending.get(fileId)?.promise === promise) pending.delete(fileId); });
    pending.set(fileId, { promise, demands });
    return promise;
  }
  function resolve(fileId, { isNeeded } = {}) {
    const visiblePath = urls.value[fileId];
    const entry = entries.get(fileId);
    if (entry?.expiresAt > now() && visiblePath) {
      entries.delete(fileId);
      entries.set(fileId, entry);
      if (entry.expiresAt - now() < 60000 && (retryAfter.get(fileId) || 0) <= now()) void load(fileId, undefined, false, true, isNeeded).catch(() => {});
      return visiblePath || '';
    }
    if ((retryAfter.get(fileId) || 0) <= now()) void load(fileId, undefined, false, false, isNeeded).catch(() => {});
    return '';
  }
  function clear() {
    epoch += 1;
    const paths = [...entries.values()].map(entry => entry.path);
    entries.clear();
    totalBytes = 0;
    for (const path of paths) void remove(path).catch(() => {});
    pending.clear();
    retryAfter.clear();
    urls.value = {};
    saveEntries(scope, []); flushCache();
  }
  function activate(nextScope) {
    if (nextScope === scope) return;
    const restored = readEntries(nextScope);
    clear(); scope = nextScope;
    for (const item of restored) {
      if (!item || typeof item.fileId !== 'string' || typeof item.path !== 'string' || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !Number.isFinite(item.expiresAt)) continue;
      if (entries.has(item.fileId) || entries.size >= maxEntries || totalBytes + item.bytes > maxBytes) continue;
      entries.set(item.fileId, { path: item.path, bytes: item.bytes, expiresAt: Math.min(item.expiresAt, now() + 300000) });
      totalBytes += item.bytes;
    }
    urls.value = checkImage ? {} : Object.fromEntries([...entries].map(([fileId, entry]) => [fileId, entry.path]));
    persist();
  }
  return { load: (fileId, { force = false, isNeeded } = {}) => load(fileId, undefined, force, false, isNeeded), prime: (fileId, localPath) => load(fileId, { localPath }), peek: fileId => entries.get(fileId)?.expiresAt > now() ? urls.value[fileId] || '' : '', resolve, clear, activate, flush: () => { persist(); flushCache(); } };
}
