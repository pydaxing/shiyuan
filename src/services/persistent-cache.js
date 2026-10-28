const pendingFlushes = new Set();
export function flushPersistentCaches() { for (const flush of [...pendingFlushes]) flush(); }

export function createPersistentCache(key, { platform = () => typeof wx !== 'undefined' ? wx : undefined, now = Date.now, maxEntries = 12, maxChars = 200000, maxAge = 7 * 86400000, validate = () => true, writeDelay = 0 } = {}) {
  let entries;
  let timer;
  function load() {
    if (entries) return;
    entries = new Map();
    try {
      const raw = platform()?.getStorageSync?.(key);
      if (typeof raw !== 'string' || raw.length > maxChars) return;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !Array.isArray(saved.entries)) return;
      for (const [name, entry] of saved.entries.slice(-maxEntries)) {
        if (typeof name === 'string' && entry?.value !== undefined && validate(entry.value) && Number.isFinite(entry.savedAt) && entry.savedAt <= now() && now() - entry.savedAt < maxAge) entries.set(name, entry);
      }
    } catch { entries.clear(); }
  }
  function persist() {
    try {
      let raw = JSON.stringify({ version: 1, entries: [...entries] });
      while (entries.size && (entries.size > maxEntries || raw.length > maxChars)) {
        entries.delete(entries.keys().next().value);
        raw = JSON.stringify({ version: 1, entries: [...entries] });
      }
      if (entries.size) platform()?.setStorageSync?.(key, raw);
      else platform()?.removeStorageSync?.(key);
    } catch {}
  }
  function flush() { clearTimeout(timer); pendingFlushes.delete(flush); persist(); }
  function schedulePersist() {
    if (!writeDelay) { flush(); return; }
    clearTimeout(timer);
    pendingFlushes.add(flush);
    timer = setTimeout(flush, writeDelay);
  }
  return {
    get size() { load(); return entries.size; },
    keys() { load(); return entries.keys(); },
    get(name) {
      load();
      const entry = entries.get(name);
      if (!entry || entry.savedAt > now() || now() - entry.savedAt >= maxAge) return undefined;
      return JSON.parse(JSON.stringify(entry.value));
    },
    set(name, value) {
      load();
      try {
        const copy = JSON.parse(JSON.stringify(value));
        if (!validate(copy)) return;
        entries.delete(name);
        entries.set(name, { value: copy, savedAt: now() });
        schedulePersist();
      } catch {}
    },
    delete(name) { load(); entries.delete(name); schedulePersist(); },
    clear() { entries = new Map(); flush(); },
    flush,
  };
}
