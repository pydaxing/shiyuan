import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatRepository } from '../server/wechat-repository.mjs';

function fixture(sampleKey = 'list') {
  const calls = [];
  const command = Object.fromEntries(['gt', 'gte', 'lt', 'exists', 'or', 'and', 'all'].map(operator => [operator, value => ({ [operator]: value })]));
  const database = {
    command,
    RegExp: value => ({ regexp: value }),
    collection(name) {
      const query = { name, order: [] };
      return {
        where(value) { query.where = value; return this; },
        orderBy(field, direction) { query.order.push([field, direction]); return this; },
        limit(value) { query.limit = value; return this; },
        field(value) { query.fields = value; return this; },
        async get() { calls.push(query); return { data: [] }; },
        aggregate() { query.aggregate = true; return this; },
        match(value) { query.where = value; return this; },
        sample(value) { query.sample = value; return this; },
        project(value) { query.fields = value; return this; },
        async end() { calls.push(query); return { [sampleKey]: [{ _id: 'random-pivot' }] }; },
      };
    },
  };
  return { calls, repository: createWechatRepository(database) };
}

test('cloud latest query uses descending timestamp plus ID and a strict tuple cursor including legacy records', async () => {
  const current = fixture();
  await current.repository.list('posts', { status: 'published' }, { order: 'published', after: { id: 'last-post', createdAt: 1200 }, fields: ['card', 'createdAt'], limit: 17 });
  const query = current.calls[0];
  assert.deepEqual(query.order, [['createdAt', 'desc'], ['_id', 'desc']]);
  assert.equal(query.limit, 17);
  assert.deepEqual(query.fields, { card: true, createdAt: true });
  assert.deepEqual(query.where.and[0], { status: 'published' });
  assert.deepEqual(query.where.and[1].or.slice(0, 2), [{ createdAt: { lt: 1200 } }, { createdAt: 1200, _id: { lt: 'last-post' } }]);
  assert.deepEqual(query.where.and[1].or[2], { or: [{ createdAt: { exists: false } }, { createdAt: null }] });
});

test('cloud undated cursor does not reintroduce dated posts', async () => {
  const current = fixture();
  await current.repository.list('posts', { status: 'published' }, { order: 'published', after: { id: 'legacy-boundary', createdAt: null } });
  assert.deepEqual(current.calls[0].where.and[1], { and: [{ or: [{ createdAt: { exists: false } }, { createdAt: null }] }, { _id: { lt: 'legacy-boundary' } }] });
});

test('cloud recommendation range composes its cursor and wrap boundary without replacing publication filters', async () => {
  const current = fixture();
  await current.repository.list('posts', { status: 'published', categories: { contains: '荤菜' } }, { after: 'post-010', idRange: { before: 'post-030' }, limit: 17, fields: ['card'] });
  assert.deepEqual(current.calls[0].where, { and: [{ status: 'published', categories: { all: ['荤菜'] }, _id: { gt: 'post-010' } }, { _id: { lt: 'post-030' } }] });
  assert.deepEqual(current.calls[0].order, [['_id', 'asc']]);
  assert.equal(current.calls[0].limit, 17);
  await current.repository.list('posts', { status: 'published' }, { idRange: { from: 'pivot' }, limit: 17 });
  assert.deepEqual(current.calls[1].where.and[1], { _id: { gte: 'pivot' } });
});

test('random start samples only one matching ID and handles both supported SDK response envelopes', async () => {
  for (const sampleKey of ['list', 'data']) {
    const current = fixture(sampleKey);
    const result = await current.repository.sample('posts', { status: 'published', kind: 'dish', search: { regex: '汤' } });
    assert.equal(result._id, 'random-pivot');
    assert.deepEqual(current.calls[0].sample, { size: 1 });
    assert.deepEqual(current.calls[0].fields, { _id: 1 });
    assert.equal(current.calls[0].where.status, 'published');
    assert.equal(current.calls[0].where.kind, 'dish');
    assert.deepEqual(current.calls[0].where.search, { regexp: { regexp: '汤', options: 'i' } });
  }
});
