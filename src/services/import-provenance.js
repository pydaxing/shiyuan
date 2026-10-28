const fields = ['recipes', 'mealSets'];
const sourceFields = ['sourceFamilyId', 'sourcePostId'];
const identifier = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const receiptKey = entry => JSON.stringify([entry.field, entry.id]);
const legacy = entry => entry && [...sourceFields, 'shareId'].every(field => entry[field] === undefined);
const completeSnapshot = snapshot => identifier(snapshot?.family?.id) && fields.every(field => Array.isArray(snapshot[field]));
const validReceipt = entry => entry && fields.includes(entry.field)
  && ['id', 'sourceId', 'sourceFamilyId', 'sourcePostId'].every(field => identifier(entry[field]))
  && (entry.field === 'recipes' ? entry.id === `import-${entry.sourceId}` : entry.sourceId === entry.sourcePostId);

// Receipts are local evidence from an acknowledged command, never an inference
// from a recipe title, a reused source ID, or an unrelated bootstrap response.
export function createImportProvenance({ cache }) {
  function read(scope) {
    const saved = cache.get(scope);
    if (saved === undefined) return undefined;
    if (saved?.version !== 1 || saved.scope !== scope || !identifier(saved.familyId)
      || !Array.isArray(saved.entries) || !saved.entries.every(validReceipt)
      || new Set(saved.entries.map(receiptKey)).size !== saved.entries.length) {
      cache.delete(scope);
      return undefined;
    }
    return saved;
  }

  // Call only after a successful command, with its direct changes merged into
  // the exact before snapshot. A bootstrap fallback cannot prove this delta.
  function record(scope, before, next, collection) {
    if (!identifier(scope) || !completeSnapshot(before) || !completeSnapshot(next)
      || before.family.id !== next.family.id || !identifier(collection?.id)
      || !identifier(collection.familyId) || !Array.isArray(collection.recipes)
      || !collection.recipes.length || !collection.recipes.every(recipe => identifier(recipe?.id))) return 0;
    const sourceIds = new Set(collection.recipes.map(recipe => recipe.id));
    if (sourceIds.size !== collection.recipes.length) return 0;
    const saved = read(scope);
    if (saved && saved.familyId !== next.family.id) return 0;
    const receipts = new Map((saved?.entries || []).map(entry => [receiptKey(entry), entry]));
    const isMenu = collection.kind === 'menu' || (!collection.kind && collection.recipes.length > 1);
    let added = 0;
    for (const field of fields) {
      if (field === 'mealSets' && !isMenu) continue;
      const previousIds = new Set(before[field].map(entry => entry.id));
      const counts = new Map();
      for (const entry of next[field]) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
      for (const entry of next[field]) {
        if (!legacy(entry) || !identifier(entry.id) || previousIds.has(entry.id) || counts.get(entry.id) !== 1) continue;
        if (field === 'recipes' ? !sourceIds.has(entry.sourceId) || entry.id !== `import-${entry.sourceId}` : entry.sourceId !== collection.id) continue;
        const receipt = { field, id: entry.id, sourceId: entry.sourceId, sourceFamilyId: collection.familyId, sourcePostId: collection.id };
        receipts.set(receiptKey(receipt), receipt);
        added += 1;
      }
    }
    if (added) cache.set(scope, { version: 1, scope, familyId: next.family.id, entries: [...receipts.values()] });
    return added;
  }

  // Use a complete, reconciled family snapshot. Observed removals invalidate
  // receipts, so a later record with the same legacy ID cannot inherit them.
  function apply(scope, snapshot) {
    if (!identifier(scope) || !completeSnapshot(snapshot)) return snapshot;
    const saved = read(scope);
    if (!saved || saved.familyId !== snapshot.family.id) return snapshot;
    const retained = [];
    const replacements = new Map(fields.map(field => [field, new Map()]));
    for (const receipt of saved.entries) {
      const matches = snapshot[receipt.field].filter(entry => entry.id === receipt.id);
      const entry = matches[0];
      if (matches.length !== 1 || entry.sourceId !== receipt.sourceId
        || sourceFields.some(field => entry[field] !== undefined && entry[field] !== receipt[field])) continue;
      retained.push(receipt);
      if (sourceFields.some(field => entry[field] === undefined)) {
        replacements.get(receipt.field).set(entry.id, { ...entry, sourceFamilyId: receipt.sourceFamilyId, sourcePostId: receipt.sourcePostId });
      }
    }
    if (retained.length !== saved.entries.length) {
      if (retained.length) cache.set(scope, { ...saved, entries: retained });
      else cache.delete(scope);
    }
    let next = snapshot;
    for (const field of fields) {
      const updates = replacements.get(field);
      if (updates.size) {
        if (next === snapshot) next = { ...snapshot };
        next[field] = snapshot[field].map(entry => updates.get(entry.id) || entry);
      }
    }
    return next;
  }

  return { record, apply };
}
