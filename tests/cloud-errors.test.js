import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudErrorMessage, cloudTransportError } from '../src/services/cloud-errors.js';
test('transport errors hide SDK traces and remain uncertain network outcomes', () => {
  const raw = { errMsg: 'cloud.callFunction:fail Error: Failed to fetch (callId: 123) (trace: timeout, retry, abort)' };
  const error = cloudTransportError(raw);
  assert.equal(error.code, 'NETWORK');
  assert.equal(error.cause, raw);
  assert.equal(error.serverRejected, undefined);
  assert.equal(error.message, '网络连接暂时不稳定，请稍后重试确认同步结果');
  assert.equal(cloudErrorMessage(raw.errMsg), error.message);
});
test('business messages remain actionable', () => {
  assert.equal(cloudErrorMessage('这餐已取消，不能加菜'), '这餐已取消，不能加菜');
  assert.equal(cloudErrorMessage('cloud.callFunction:fail system error'), '云服务暂时连接不上，请稍后重试确认同步结果');
});
