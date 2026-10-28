import test from 'node:test';
import assert from 'node:assert/strict';
import { retryTransaction } from '../server/transaction-retry.mjs';

test('retry transient WeChat transaction errors with bounded backoff', async () => {
  let calls = 0;
  const waits = [];
  const result = await retryTransaction(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error('temporary transaction failure'), { errCode: -501001 });
    return 'committed';
  }, { wait: async delay => waits.push(delay) });
  assert.equal(result, 'committed');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 60 && waits[1] >= 120);
});

test('transaction retries stop after three attempts and preserve the final error', async () => {
  const error = Object.assign(new Error('conflict'), { code: 'DATABASE_TRANSACTION_CONFLICT' });
  let calls = 0;
  await assert.rejects(retryTransaction(() => { calls += 1; throw error; }, { wait: async () => {} }), candidate => candidate === error);
  assert.equal(calls, 3);
});

test('permission and validation failures are never retried', async () => {
  let calls = 0;
  await assert.rejects(retryTransaction(() => { calls += 1; throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }); }), /forbidden/);
  assert.equal(calls, 1);
});
