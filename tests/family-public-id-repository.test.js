import test from 'node:test';
import assert from 'node:assert/strict';
import { createWechatRepository } from '../server/wechat-repository.mjs';

function fixture({ failure, readFailure, row = null } = {}) {
  const calls = [];
  const handle = scope => ({
    collection(name) {
      return {
        async add(options) {
          calls.push({ scope, operation: 'add', name, options });
          if (failure) throw failure;
          return { _id: options.data._id };
        },
        doc(id) {
          return {
            async get(...args) {
              assert.equal(args.length, 0, 'wx-server-sdk DocumentReference.get does not accept per-call options');
              calls.push({ scope, operation: 'get', name, id });
              if (readFailure) throw readFailure;
              if (!row) throw Object.assign(new Error(`document.get:fail document with _id ${id} does not exist`), { errCode: -1 });
              return { data: row };
            },
            set() { assert.fail('Reservation must not use an upsert'); },
          };
        },
        where() { assert.fail('Direct reservation reads must use a document lookup'); },
      };
    },
  });
  const database = { ...handle('database'), runTransaction: callback => callback(handle('transaction')) };
  return { calls, repository: createWechatRepository(database) };
}

test('reservations use add with the caller key inside the active transaction', async () => {
  const server = fixture();
  await server.repository.transaction(db => db.insert('family_public_ids', 'sy-abc123', { _id: 'untrusted-id', familyId: 'family-internal', createdAt: 1 }));
  assert.deepEqual(server.calls, [{ scope: 'transaction', operation: 'add', name: 'family_public_ids', options: { data: { _id: 'sy-abc123', familyId: 'family-internal', createdAt: 1 } } }]);
});

test('direct missing-key reads use doc.get and normalize only the SDK exact not-found exception', async () => {
  const server = fixture();
  assert.equal(await server.repository.transaction(db => db.get('family_public_ids', 'sy-abc123', { direct: true })), null);
  assert.deepEqual(server.calls, [{ scope: 'transaction', operation: 'get', name: 'family_public_ids', id: 'sy-abc123' }]);
  assert.equal(await server.repository.get('family_public_ids', '../unsafe', { direct: true }), null);
  assert.equal(server.calls.length, 1);
});

for (const details of [
  { errCode: -1, message: 'document.get:fail document with _id sy-other0 does not exist' },
  { errCode: -1, message: 'document.get:fail permission denied' },
  { errCode: -502001, message: 'document.get:fail document with _id sy-abc123 does not exist' },
]) {
  test(`direct reads preserve non-missing errors (${JSON.stringify(details)})`, async () => {
    const failure = Object.assign(new Error('read failed'), details);
    const server = fixture({ readFailure: failure });
    await assert.rejects(server.repository.get('family_public_ids', 'sy-abc123', { direct: true }), error => error === failure);
  });
}

test('direct reads retain the normal projection contract', async () => {
  const server = fixture({ row: { _id: 'sy-abc123', familyId: 'family-internal', createdAt: 1, privateField: 'private' } });
  assert.deepEqual(await server.repository.get('family_public_ids', 'sy-abc123', { direct: true, fields: ['familyId'] }), { _id: 'sy-abc123', familyId: 'family-internal' });
});

for (const details of [
  { code: 'DATABASE_DUPLICATE_WRITE' },
  { errCode: 'DATABASE_DUPLICATE_WRITE' },
  { code: 11000 },
  { errCode: 11000 },
  { errCode: -501001, message: 'collection.add:fail E11000 duplicate key error collection: db.family_public_ids index: _id_ dup key: { _id: "sy-abc123" }' },
  { code: 'FailedOperation.Insert', message: 'FailedOperation.Insert: multiple write errors: [{write errors: [{E11000 duplicate key error collection: fixture.family_public_ids index: _id_ dup key: { _id: "sy-abc123" }}]}, {<nil>}]' },
]) {
  test(`a definite duplicate insert keeps its original cause (${JSON.stringify(details)})`, async () => {
    const failure = Object.assign(new Error('insert failed'), details);
    const server = fixture({ failure });
    await assert.rejects(server.repository.insert('family_public_ids', 'sy-abc123', { familyId: 'family-internal' }), error => error.code === 'DOCUMENT_ALREADY_EXISTS' && error.cause === failure);
    assert.equal(server.calls.length, 1);
  });
}

for (const details of [
  { code: 'PERMISSION_DENIED', message: 'permission denied' },
  { errCode: -501001, message: 'request failed' },
  { errCode: -502001, message: 'database request failed' },
  { code: 'DATABASE_REQUEST_FAILED', message: 'duplicate-looking request failed' },
  { code: 'ETIMEDOUT', message: 'connection timed out' },
]) {
  test(`unrelated insert failures are not converted to collisions (${JSON.stringify(details)})`, async () => {
    const failure = Object.assign(new Error('insert failed'), details);
    const server = fixture({ failure });
    await assert.rejects(server.repository.insert('family_public_ids', 'sy-abc123', { familyId: 'family-internal' }), error => error === failure);
    assert.equal(server.calls.length, 1);
  });
}
