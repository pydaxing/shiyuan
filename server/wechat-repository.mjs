import { measure } from './performance.mjs';
import { retryTransaction } from './transaction-retry.mjs';
import { validDocumentId } from './repository-reads.mjs';

const project = (selection, fields) => fields ? selection.field(Object.fromEntries(fields.map(field => [field, true]))) : selection;
const duplicateWrite = error => error?.code === 'DATABASE_DUPLICATE_WRITE' || error?.errCode === 'DATABASE_DUPLICATE_WRITE' || Number(error?.code) === 11000 || Number(error?.errCode) === 11000 || /\bE11000\s+duplicate key\b/i.test(`${error?.message || ''} ${error?.errMsg || ''}`);

export function createWechatRepository(database, handle = database, scope = 'db') {
  function queryWhere(where) {
    return Object.fromEntries(Object.entries(where).map(([key, value]) => [key, value?.regex !== undefined ? database.RegExp({ regexp: value.regex, options: 'i' }) : value?.contains !== undefined ? database.command.all([value.contains]) : value]));
  }
  return {
    async get(collection, id, { fields, direct = false } = {}) {
      if (!validDocumentId(id)) return null;
      if (direct) {
        let result;
        try {
          result = await measure(`${scope}.get.${collection}`, () => handle.collection(collection).doc(id).get());
        } catch (error) {
          // wx-server-sdk 4.x configures not-found behavior on database(), not get().
          const missing = `document.get:fail document with _id ${id} does not exist`;
          if (Number(error.errCode) === -1 && (error.message === missing || error.errMsg === missing)) return null;
          throw error;
        }
        const row = result.data || null;
        return row && fields ? Object.fromEntries(['_id', ...fields].filter(field => row[field] !== undefined).map(field => [field, row[field]])) : row;
      }
      const selection = project(handle.collection(collection).where({ _id: id }).limit(1), fields);
      const result = await measure(`${scope}.get.${collection}`, () => selection.get());
      return result.data[0] || null;
    },
    async getMany(collection, ids, { fields } = {}) {
      const unique = [...new Set(ids.filter(validDocumentId))];
      const rows = [];
      for (let offset = 0; offset < unique.length; offset += 50) {
        const batch = unique.slice(offset, offset + 50);
        const selection = project(handle.collection(collection).where({ _id: database.command.in(batch) }).limit(batch.length), fields);
        const result = await measure(`${scope}.getMany.${collection}`, () => selection.get());
        rows.push(...result.data);
      }
      return rows;
    },
    async set(collection, id, value) {
      const { _id, ...data } = value;
      await measure(`${scope}.set.${collection}`, () => handle.collection(collection).doc(id).set({ data }));
    },
    async insert(collection, id, value) {
      const { _id, ...data } = value;
      try {
        await measure(`${scope}.insert.${collection}`, () => handle.collection(collection).add({ data: { ...data, _id: id } }));
      } catch (error) {
        if (!duplicateWrite(error)) throw error;
        throw Object.assign(new Error('Document already exists', { cause: error }), { code: 'DOCUMENT_ALREADY_EXISTS' });
      }
    },
    async remove(collection, id) {
      await measure(`${scope}.remove.${collection}`, () => handle.collection(collection).doc(id).remove());
    },
    async list(collection, where = {}, { after = '', limit = 100, fields, order, idRange } = {}) {
      const query = queryWhere(where);
      const clauses = [query];
      const command = database.command;
      if (order === 'published' && after) {
        const undated = command.or([{ createdAt: command.exists(false) }, { createdAt: null }]);
        clauses.push(after.createdAt === null
          ? command.and([undated, { _id: command.lt(after.id) }])
          : command.or([{ createdAt: command.lt(after.createdAt) }, { createdAt: after.createdAt, _id: command.lt(after.id) }, undated]));
      } else if (after) query._id = command.gt(after);
      if (idRange?.from) clauses.push({ _id: command.gte(idRange.from) });
      if (idRange?.before) clauses.push({ _id: command.lt(idRange.before) });
      let selection = handle.collection(collection).where(clauses.length > 1 ? command.and(clauses) : query);
      selection = order === 'published' ? selection.orderBy('createdAt', 'desc').orderBy('_id', 'desc') : selection.orderBy('_id', 'asc');
      selection = project(selection.limit(limit), fields);
      return (await measure(`${scope}.list.${collection}`, () => selection.get())).data;
    },
    async sample(collection, where = {}, { fields = ['_id'] } = {}) {
      const selection = handle.collection(collection).aggregate().match(queryWhere(where)).sample({ size: 1 }).project(Object.fromEntries(fields.map(field => [field, 1])));
      const result = await measure(`${scope}.sample.${collection}`, () => selection.end());
      return (result.list || result.data || [])[0] || null;
    },
    transaction: callback => measure('db.transaction', () => retryTransaction(() => database.runTransaction(transaction => callback(createWechatRepository(database, transaction, 'transaction'))))),
  };
}
