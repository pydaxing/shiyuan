export function memoryRepository() {
  let tables = new Map();
  let queue = Promise.resolve();
  const clone = value => structuredClone(value);
  function adapter(data) {
    function table(name) { if (!data.has(name)) data.set(name, new Map()); return data.get(name); }
    const matches = (row, where) => Object.entries(where).every(([key, value]) => value?.regex !== undefined ? new RegExp(value.regex, 'i').test(row[key]) : value?.contains !== undefined ? row[key]?.includes(value.contains) : row[key] === value);
    const project = (rows, fields) => fields ? rows.map(row => Object.fromEntries(['_id', ...fields].filter(field => row[field] !== undefined).map(field => [field, row[field]]))) : rows;
    return {
      async get(name, id) { return clone(table(name).get(id) || null); },
      async set(name, id, value) { table(name).set(id, clone({ ...value, _id: id })); },
      async insert(name, id, value) {
        if (table(name).has(id)) throw Object.assign(new Error('Document already exists'), { code: 'DOCUMENT_ALREADY_EXISTS' });
        table(name).set(id, clone({ ...value, _id: id }));
      },
      async remove(name, id) { table(name).delete(id); },
      async list(name, where = {}, { after = '', limit = 100, fields, order, idRange } = {}) {
        const timestamp = row => row.createdAt ?? -1;
        const compare = (left, right) => order === 'published' ? timestamp(right) - timestamp(left) || right._id.localeCompare(left._id) : left._id.localeCompare(right._id);
        const rows = clone([...table(name).values()].filter(row => matches(row, where) && (!after || (order === 'published' ? compare(row, { _id: after.id, createdAt: after.createdAt }) > 0 : row._id > after)) && (!idRange?.from || row._id >= idRange.from) && (!idRange?.before || row._id < idRange.before)).sort(compare).slice(0, limit));
        return project(rows, fields);
      },
      async sample(name, where = {}, { fields } = {}) {
        const rows = [...table(name).values()].filter(row => matches(row, where));
        const row = rows[Math.floor(Math.random() * rows.length)];
        return row ? project([clone(row)], fields)[0] : null;
      },
    };
  }
  return {
    get: (...args) => adapter(tables).get(...args), set: (...args) => adapter(tables).set(...args), insert: (...args) => adapter(tables).insert(...args), list: (...args) => adapter(tables).list(...args), sample: (...args) => adapter(tables).sample(...args), remove: (...args) => adapter(tables).remove(...args),
    transaction(callback) {
      const result = queue.then(async () => { const next = clone(tables); const output = await callback(adapter(next)); tables = next; return output; });
      queue = result.catch(() => {});
      return result;
    },
  };
}
