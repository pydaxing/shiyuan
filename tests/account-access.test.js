import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { ACCOUNT_PRIVACY_VERSION } from '../server/account-access.mjs';
const hash = id => createHash('sha256').update(id).digest('hex');
const privacyVersion = ACCOUNT_PRIVACY_VERSION;
function fixture(exchange) {
  const repository = memoryRepository();
  let exchanges = 0;
  const app = createApplication({ repository, now: () => 1794200000000, appId: 'test-app', signFiles: async () => ({}), exchangePhone: async code => { exchanges++; return exchange ? exchange(code) : { phoneInfo: { purePhoneNumber: '13800000000', countryCode: '86', watermark: { appid: 'test-app' } } }; } });
  const call = (action, payload = {}, user = 'alice') => app({ action, ...payload }, { OPENID: user });
  const bind = (user = 'alice') => call('bindAccountPhone', { code: 'one-time-code', privacyVersion }, user);
  return { repository, call, bind, exchanges: () => exchanges };
}
test('new and existing users both require phone, legacy bootstrap remains compatible', async () => {
  const f = fixture();
  assert.equal((await f.call('accountAccess')).data.phoneBound, false);
  assert.equal((await f.call('bootstrap', { accountLoginVersion: 1 })).code, 'PHONE_REQUIRED');
  assert.equal((await f.call('bootstrap')).data.needsFamily, true);
  assert.equal((await f.call('createFamily', { name: 'Alice', familyName: 'Home' })).ok, true);
  assert.equal((await f.call('accountAccess')).data.phoneBound, false);
  assert.equal((await f.call('bootstrap', { accountLoginVersion: 1 })).code, 'PHONE_REQUIRED');
  assert.equal((await f.bind()).data.phoneBound, true);
  assert.equal((await f.call('bootstrap', { accountLoginVersion: 1 })).ok, true);
});
test('binding preserves all existing relationships, profile and ID; private data never enters bootstrap', async () => {
  const f = fixture();
  await f.call('createFamily', { name: 'Alice', familyName: 'Home' });
  const before = await f.repository.get('users', hash('alice'));
  const bound = await f.bind();
  assert.equal(bound.ok, true);
  const after = await f.repository.get('users', hash('alice'));
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value);
  assert.equal(after.privateContact.phoneNumber, '13800000000');
  const boot = await f.call('bootstrap');
  assert.equal(JSON.stringify(boot).includes('13800000000'), false);
  assert.equal(JSON.stringify(boot).includes('privateContact'), false);
  assert.equal(JSON.stringify(bound).includes('13800000000'), false);
});
test('openid is authoritative; supplied IDs and raw phone numbers cannot change another account', async () => {
  const f = fixture();
  assert.equal((await f.call('bindAccountPhone', { code: 'token', privacyVersion, userId: hash('bob'), phoneNumber: '13911112222' })).ok, true);
  assert.equal((await f.repository.get('users', hash('alice'))).privateContact.phoneNumber, '13800000000');
  assert.equal(await f.repository.get('users', hash('bob')), null);
  assert.equal((await f.call('accountAccess', {}, '')).code, 'UNAUTHENTICATED');
});
test('phone binding requires consent and a one-time code', async () => {
  const f = fixture();
  for (const payload of [{ code: 'x' }, { privacyVersion }, { privacyVersion, code: 12 }]) assert.equal((await f.call('bindAccountPhone', payload)).ok, false);
  assert.equal(f.exchanges(), 0);
});
test('retries after successful binding do not exchange the consumed code again', async () => {
  const f = fixture();
  await f.bind(); await f.bind();
  assert.equal(f.exchanges(), 1);
});
for (const [name, exchange] of [
  ['provider failure', () => { throw new Error('sensitive provider payload'); }],
  ['wrong app', () => ({ phoneInfo: { purePhoneNumber: '13800000000', countryCode: '86', watermark: { appid: 'other' } } })],
  ['missing watermark', () => ({ phoneInfo: { purePhoneNumber: '13800000000', countryCode: '86' } })],
  ['invalid number', () => ({ phoneInfo: { purePhoneNumber: 'fake', countryCode: '86', watermark: { appid: 'test-app' } } })],
  ['wechat error', () => ({ errcode: 40029 })],
]) test(`phone rejects ${name} without storing data or leaking provider errors`, async () => {
  const f = fixture(exchange); const result = await f.bind();
  assert.equal(result.code, 'PHONE_EXCHANGE_FAILED');
  assert.equal(await f.repository.get('users', hash('alice')), null);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
test('same phone on different WeChat accounts never merges identities', async () => {
  const f = fixture(); await f.bind('alice'); await f.bind('bob');
  assert.ok(await f.repository.get('users', hash('alice')));
  assert.ok(await f.repository.get('users', hash('bob')));
});
test('phone binding before accepting an invitation preserves the invited destination', async () => {
  const f = fixture(); const family = (await f.call('createFamily', { name: 'Alice', familyName: 'Home' })).data.familyId;
  const invite = (await f.call('prepareInvite')).data;
  await f.bind('bob');
  const joined = await f.call('joinFamily', { name: 'Bob', token: invite.token }, 'bob');
  assert.equal(joined.ok, true); assert.equal(joined.data.familyId, family);
  assert.equal((await f.call('accountAccess', {}, 'bob')).data.phoneBound, true);
});
