import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, measure } from '../server/performance.mjs';

test('diagnostics leave normal responses and errors unchanged', async () => {
  const result = { ok: true, data: { value: 1 } };
  assert.equal(await measure('db.get.users', () => result), result);
  const failure = { ok: false, code: 'UNAUTHENTICATED' };
  assert.equal(await diagnose(() => failure, true), failure);
  await assert.rejects(measure('db.get.users', () => { throw new Error('unavailable'); }), /unavailable/);
});

test('diagnostics isolate concurrent requests and include only operation names and timings', async () => {
  const results = await Promise.all(['db.get.users', 'db.list.posts'].map(operation => diagnose(async () => {
    await measure(operation, () => new Promise(resolve => setTimeout(resolve, 5)));
    return { ok: true, data: {} };
  }, false)));
  results.forEach((result, index) => {
    assert.equal(result.diagnostics.spans.length, 1);
    assert.equal(result.diagnostics.spans[0].operation, ['db.get.users', 'db.list.posts'][index]);
    assert.deepEqual(Object.keys(result.diagnostics.spans[0]), ['operation', 'startMs', 'durationMs']);
    assert.equal(result.diagnostics.firstInvocation, false);
    assert.ok(result.diagnostics.serverMs >= 0);
  });
});

test('diagnostics bound the size of a response', async () => {
  const result = await diagnose(async () => {
    for (let index = 0; index < 300; index += 1) await measure('db.list.posts', () => []);
    return { ok: true, data: {} };
  }, true);
  assert.equal(result.diagnostics.spans.length, 256);
  assert.equal(result.diagnostics.omitted, 44);
});

test('authenticated failure diagnostics include only error codes, never image data or exception messages', async () => {
  const result = await diagnose(async () => {
    try { await measure('storage.upload', () => { throw Object.assign(new Error('private photo path'), { code: 'STORAGE_UNAVAILABLE' }); }); }
    catch { return { ok: false, code: 'INTERNAL' }; }
  }, false);
  assert.equal(result.diagnostics.spans[0].failed, true);
  assert.equal(result.diagnostics.spans[0].errorCode, 'STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private photo path'), false);
});
