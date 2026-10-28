import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmedUploadResult } from '../scripts/weixin-upload-result.mjs';

test('pending confirmation success is not a completed upload', () => {
  for (const status of ['pending', 'failed', 'cancelled']) {
    assert.throws(() => confirmedUploadResult({ ok: true, result: { success: true, taskId: 'confirmation_upload', status } }));
  }
});
test('completed asynchronous upload requires nested success', () => {
  const receipt = { success: true, info: { size: { total: 1868235 } } };
  assert.equal(confirmedUploadResult({ ok: true, result: { success: true, taskId: 'confirmation_upload', status: 'success', result: receipt } }), receipt);
  assert.throws(() => confirmedUploadResult({ ok: true, result: { success: true, taskId: 'confirmation_upload', status: 'success' } }));
});
test('synchronous upload requires a real package receipt', () => {
  assert.throws(() => confirmedUploadResult({ ok: true, result: { success: true } }));
  assert.equal(confirmedUploadResult({ ok: true, result: { success: true, info: { size: { total: 42 } } } }).info.size.total, 42);
});
