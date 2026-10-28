import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatRepository } from '../server/wechat-repository.mjs';
import { readDocuments, readDocumentResults } from '../server/repository-reads.mjs';
import { createImageSigner } from '../server/image-delivery.mjs';
import { diagnose } from '../server/performance.mjs';

function databaseFixture() {
  const calls = [];
  const records = new Map();
  const handle = scope => ({
    collection(collection) {
      const query = { scope, collection };
      return {
        where(where) { query.where = where; return this; },
        orderBy(field, direction) { query.order = { field, direction }; return this; },
        limit(limit) { query.limit = limit; return this; },
        field(fields) { query.fields = fields; return this; },
        async get() {
          calls.push(query);
          const ids = query.where._id?.values || [query.where._id];
          const data = ids.toReversed().map(id => records.get(`${collection}:${id}`)).filter(Boolean).map(row => query.fields ? Object.fromEntries(['_id', ...Object.keys(query.fields)].filter(field => row[field] !== undefined).map(field => [field, row[field]])) : row);
          return { data };
        },
      };
    },
  });
  const database = { ...handle('database'), command: { in: values => ({ values }) }, runTransaction: callback => callback(handle('transaction')) };
  return { calls, records, repository: createWechatRepository(database) };
}

test('batch repository reads deduplicate IDs, reject unsafe IDs and project only authorization fields', async () => {
  const server = databaseFixture();
  server.records.set('posts:post-a', { _id: 'post-a', status: 'published', assetIds: ['asset-a'], recipes: ['large-private-payload'] });
  server.records.set('posts:post-b', { _id: 'post-b', status: 'deleted', assetIds: ['asset-b'] });
  const records = await readDocuments(server.repository, 'posts', ['post-a', 'post-b', 'post-a', '../not-an-id', 'bad.id', {}, '', 'missing'], { fields: ['status', 'assetIds'] });
  assert.equal(server.calls.length, 1);
  assert.deepEqual(server.calls[0].where._id.values, ['post-a', 'post-b', 'missing']);
  assert.equal(server.calls[0].limit, 3);
  assert.deepEqual(server.calls[0].fields, { status: true, assetIds: true });
  assert.deepEqual([...records.keys()], ['post-a', 'post-b', 'missing']);
  assert.equal(records.get('post-a').recipes, undefined);
  assert.equal(records.get('post-b').status, 'deleted');
  assert.equal(records.get('missing'), null);
  assert.equal((await readDocuments(server.repository, 'posts', [])).size, 0);
  assert.deepEqual(await server.repository.getMany('posts', ['../invalid', null]), []);
  assert.equal(server.calls.length, 1);
});

test('batch repository queries stay bounded and diagnostics never include document IDs or fields', async () => {
  const server = databaseFixture();
  const ids = Array.from({ length: 103 }, (_, index) => `private-id-${index}`);
  for (const id of ids) server.records.set(`media:${id}`, { _id: id, encryptionKey: 'private-encryption-key' });
  const result = await diagnose(async () => ({ ok: true, data: { count: (await server.repository.getMany('media', ids)).length } }), false);
  assert.equal(result.data.count, 103);
  assert.deepEqual(server.calls.map(call => call.limit), [50, 50, 3]);
  assert.deepEqual(result.diagnostics.spans.map(span => span.operation), ['db.getMany.media', 'db.getMany.media', 'db.getMany.media']);
  assert.equal(JSON.stringify(result.diagnostics).includes('private-id'), false);
  assert.equal(JSON.stringify(result).includes('private-encryption-key'), false);
});

test('single projected reads and transaction reads use their own repository handles', async () => {
  const server = databaseFixture();
  server.records.set('families:family-a', { _id: 'family-a', name: '家', members: ['private-member-list'] });
  assert.equal(await server.repository.get('families', '../invalid'), null);
  const family = await server.repository.get('families', 'family-a', { fields: ['name'] });
  assert.deepEqual(family, { _id: 'family-a', name: '家' });
  const result = await server.repository.transaction(transaction => transaction.get('families', 'family-a'));
  assert.deepEqual(result.members, ['private-member-list']);
  assert.deepEqual(server.calls.map(call => call.scope), ['database', 'transaction']);
});

test('request-scoped metadata results preserve per-image failures and retry a failed batch as individual reads', async () => {
  const reads = [];
  const error = Object.assign(new Error('database not available for one image'), { code: 'DB_UNAVAILABLE' });
  const repository = {
    async getMany() { reads.push('batch'); throw new Error('batch unavailable'); },
    async get(collection, id) { reads.push(id); if (id === 'bad') throw error; return id === 'missing' ? null : { _id: id }; },
  };
  const results = await readDocumentResults(repository, 'media', ['good', 'bad', 'good', 'missing']);
  assert.deepEqual(reads, ['batch', 'good', 'bad', 'missing']);
  assert.deepEqual(results.get('good'), { value: { _id: 'good' } });
  assert.equal(results.get('bad').error, error);
  assert.deepEqual(results.get('missing'), { value: null });
  reads.length = 0;
  await readDocumentResults(repository, 'media', ['good', 'good']);
  assert.deepEqual(reads, ['good']);
});

test('repository helpers keep old adapters compatible without storing cross-request authorization results', async () => {
  let current = { _id: 'post-a', status: 'published' };
  let calls = 0;
  const repository = { async get(collection, id) { calls += 1; return id === 'post-a' ? current : null; } };
  assert.equal((await readDocuments(repository, 'posts', ['post-a', 'post-a', 'missing'])).get('post-a').status, 'published');
  assert.equal(calls, 2);
  current = { ...current, status: 'deleted' };
  assert.equal((await readDocumentResults(repository, 'posts', ['post-a'])).get('post-a').value.status, 'deleted');
  assert.equal(calls, 3);
});

test('the signer deduplicates only pending work and requests fresh five-minute URLs after completion', async () => {
  const batches = [];
  let finish;
  const sign = createImageSigner(async files => {
    batches.push(files);
    await new Promise(resolve => { finish = resolve; });
    return files.map(file => ({ fileID: file.fileID, status: 0, tempFileURL: 'https://storage.example.test/signed', maxAge: 300 }));
  });
  const first = sign('same-file');
  const duplicate = sign('same-file');
  await new Promise(resolve => setTimeout(resolve, 5));
  const lateDuplicate = sign('same-file');
  assert.equal(first, duplicate);
  assert.equal(first, lateDuplicate);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [{ fileID: 'same-file', maxAge: 300 }]);
  finish();
  await Promise.all([first, duplicate, lateDuplicate]);
  const refreshed = sign('same-file');
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(batches.length, 2);
  finish();
  await refreshed;
});

test('failed signing clears all duplicate waiters and can be retried', async () => {
  let calls = 0;
  const sign = createImageSigner(async files => {
    calls += 1;
    if (calls === 1) throw new Error('offline');
    return files.map(file => ({ fileID: file.fileID, status: 0 }));
  });
  const failures = await Promise.allSettled([sign('same-file'), sign('same-file')]);
  assert.ok(failures.every(result => result.status === 'rejected' && result.reason.message === 'offline'));
  assert.equal(calls, 1);
  assert.equal((await sign('same-file')).fileID, 'same-file');
  assert.equal(calls, 2);
});
