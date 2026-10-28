export function validDocumentId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[/.]/.test(id);
}

export async function readDocuments(repository, collection, ids, options) {
  const unique = [...new Set(ids.filter(validDocumentId))];
  if (!unique.length) return new Map();
  if (unique.length > 1 && repository.getMany) {
    const rows = await repository.getMany(collection, unique, options);
    const indexed = new Map(rows.map(row => [row._id, row]));
    return new Map(unique.map(id => [id, indexed.get(id) || null]));
  }
  return new Map(await Promise.all(unique.map(async id => [id, await repository.get(collection, id, options)])));
}

export async function readDocumentResults(repository, collection, ids, options) {
  const unique = [...new Set(ids.filter(validDocumentId))];
  if (unique.length > 1 && repository.getMany) {
    try {
      const records = await readDocuments(repository, collection, unique, options);
      return new Map([...records].map(([id, value]) => [id, { value }]));
    } catch {}
  }
  return new Map(await Promise.all(unique.map(async id => {
    try { return [id, { value: await repository.get(collection, id, options) }]; }
    catch (error) { return [id, { error }]; }
  })));
}
