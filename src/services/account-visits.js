// A foreground visit belongs to the user. Workspace only validates the request;
// all modes reuse the same date union and cached total.
const dayAt = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const valid = value => Number.isSafeInteger(value?.days) && value.days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(value.lastDay || '') && Number.isFinite(value.serverTime);
export function createAccountVisitTracker({ invoke, cache, publish, now = Date.now }) {
  let visible = false, userId = '', spaceId = '', ready = false, generation = 0, pending = null;
  const confirmations = new Map(), attempts = new Map();
  const key = () => userId;
  function identity(id, space, isReady) {
    if (id !== userId || space !== spaceId) {
      userId = id || ''; spaceId = space || ''; generation++; pending = null;
      const saved = userId && spaceId && cache.get(key());
      publish(saved?.userId === userId && valid(saved) ? saved.days : null);
    }
    ready = isReady;
    return tick();
  }
  async function tick() {
    if (!visible || !ready || !userId || !spaceId) return;
    if (pending) return pending;
    const scope = key(), confirmed = confirmations.get(scope), attempt = attempts.get(scope);
    if (confirmed && confirmed.lastDay >= dayAt(now() + confirmed.clockOffset)) return;
    if (attempt !== undefined && now() - attempt >= 0 && now() - attempt < 30000) return;
    attempts.set(scope, now());
    const token = generation, id = userId, space = spaceId;
    const task = (async () => {
      try {
        const result = await invoke(space);
        if (token !== generation || id !== userId || space !== spaceId) return;
        if (result?.userId !== id || result.spaceId !== space || !valid(result)) throw new Error('相伴天数暂不可用');
        const clockOffset = result.serverTime - now();
        confirmations.set(scope, { ...result, clockOffset }); cache.set(scope, result); publish(result.days);
      } catch { /* Do not invent a successful day; retry while foreground. */ }
      finally { if (token === generation) pending = null; }
    })();
    pending = task;
    return task;
  }
  function setVisible(value) { visible = value; return tick(); }
  return { identity, tick, setVisible };
}
