export function familyShareContext(snapshot, session, selection) {
  if (session.phase !== 'ready' || !session.userId || !session.familyId || !selection) return null;
  const item = (selection.kind === 'set' ? snapshot.mealSets : snapshot.recipes).find(entry => entry.id === selection.itemId);
  if (!item) return null;
  const recipes = selection.kind === 'set' ? item.recipeIds.map(id => snapshot.recipes.find(recipe => recipe.id === id)) : [item];
  if (recipes.some(recipe => !recipe)) return null;
  return {
    scope: `${session.userId}:${session.familyId}`,
    familyId: session.familyId,
    itemId: item.id,
    kind: selection.kind,
    fingerprint: JSON.stringify({ item, recipes, author: snapshot.family.name }),
  };
}

export function createPreparedShares({ request, now = Date.now, maxEntries = 12, maxAge = 15 * 60000 }) {
  const entries = new Map();
  let scope = '';
  let generation = 0;
  const changed = () => new Error('菜品或家庭已变更，请重新分享');
  function clear() { generation += 1; entries.clear(); scope = ''; }
  function locate(context) {
    if (!context) return null;
    if (scope !== context.scope) { clear(); scope = context.scope; }
    const key = `${context.kind}:${context.itemId}`;
    const entry = entries.get(key);
    if (entry && (entry.fingerprint !== context.fingerprint || entry.until <= now())) entries.delete(key);
    return { key, entry: entries.get(key) };
  }
  function peek(context) { return locate(context)?.entry?.value || null; }
  function prepare(context) {
    const found = locate(context);
    if (!found) return Promise.reject(changed());
    if (found.entry) return found.entry.promise;
    const version = generation;
    const entry = { fingerprint: context.fingerprint, until: now() + maxAge };
    entries.set(found.key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    entry.promise = Promise.resolve().then(() => request({ familyId: context.familyId, itemId: context.itemId, kind: context.kind })).then(result => {
      if (version !== generation || entries.get(found.key) !== entry) throw changed();
      if (!/^[a-f0-9]{48}$/.test(result?.token || '') || !Number.isFinite(result.expiresAt) || result.expiresAt <= now() + 60000) throw new Error('暂时无法分享，请稍后重试');
      entry.until = Math.min(now() + maxAge, result.expiresAt - 60000);
      entry.value = result;
      return result;
    }).catch(error => {
      if (entries.get(found.key) === entry) entries.delete(found.key);
      throw error;
    });
    return entry.promise;
  }
  return { peek, prepare, clear };
}
