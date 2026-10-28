import { createHash } from 'node:crypto';
import { validDocumentId } from './repository-reads.mjs';
import { shuffleFoodPosts } from '../src/domain/food-feed.js';

function invalidCursor() { throw Object.assign(new Error('美食列表已更新，请重新选择筛选'), { code: 'INVALID' }); }
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function decode(cursor, scope) {
  if (!cursor) return null;
  try {
    if (typeof cursor !== 'string' || cursor.length > 2048) return invalidCursor();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.version !== 1 || value.scope !== scope || !validDocumentId(value.after?.id)) return invalidCursor();
    return value;
  } catch { return invalidCursor(); }
}

export async function readCommunityFeedPage(repository, { where, limit, fields, sort, seed = '', cursor = '' }) {
  if (!sort) {
    const rows = await repository.list('posts', where, { after: cursor, limit: limit + 1, ...(fields ? { fields } : {}) });
    return { rows: rows.slice(0, limit), cursor: rows.length > limit ? rows[limit - 1]._id : '' };
  }
  if (!['latest', 'recommended'].includes(sort) || typeof seed !== 'string' || seed.length > 64 || !/^[\w-]*$/.test(seed)) return invalidCursor();
  const scope = createHash('sha256').update(JSON.stringify([where, sort, seed])).digest('hex').slice(0, 24);
  const previous = decode(cursor, scope);
  const options = { limit: limit + 1, ...(fields ? { fields: [...fields, 'createdAt'] } : {}) };
  if (sort === 'latest') {
    if (previous && previous.after.createdAt !== null && (!Number.isFinite(previous.after.createdAt) || previous.after.createdAt < 0)) return invalidCursor();
    const rows = await repository.list('posts', where, { ...options, order: 'published', after: previous?.after || '' });
    const last = rows[limit - 1];
    return { rows: rows.slice(0, limit), cursor: rows.length > limit ? encode({ version: 1, scope, after: { id: last._id, createdAt: last.createdAt ?? null } }) : '' };
  }
  if (previous && (!validDocumentId(previous.pivot) || typeof previous.wrapped !== 'boolean')) return invalidCursor();
  const pivot = previous?.pivot || (await repository.sample('posts', where, { fields: ['_id'] }))?._id;
  if (!pivot) return { rows: [], cursor: '' };
  const wrapped = previous?.wrapped || false;
  let page = (await repository.list('posts', where, { ...options, after: previous?.after.id || '', idRange: wrapped ? { before: pivot } : { from: pivot } })).map(row => ({ row, wrapped }));
  if (!wrapped && page.length <= limit) {
    const remaining = await repository.list('posts', where, { ...options, limit: limit + 1 - page.length, idRange: { before: pivot } });
    page = [...page, ...remaining.map(row => ({ row, wrapped: true }))];
  }
  const selected = page.slice(0, limit);
  const last = selected.at(-1);
  return {
    rows: shuffleFoodPosts(selected.map(entry => entry.row), `${seed}:${pivot}:${previous?.after.id || ''}`),
    cursor: page.length > limit ? encode({ version: 1, scope, pivot, wrapped: last.wrapped, after: { id: last.row._id } }) : '',
  };
}
