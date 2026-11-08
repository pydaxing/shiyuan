import test from 'node:test';
import assert from 'node:assert/strict';
import { deployMealArchive, ARCHIVE_DEPLOYMENT as c, deploymentHash } from '../scripts/meal-archive-deployment.mjs';

function fixture({ existing = false, alteredConfig = false, alteredCode = false, badTrigger = false, lostEnable = false, concurrentChange = false, description = c.cron } = {}) {
  const token = 'ab'.repeat(32), code = `${c.tokenKey};${c.triggerName};latest`, old = `${c.tokenKey};${c.triggerName};previous`;
  const shape = text => ({ Status: 'Active', CodeInfo: text, Runtime: c.runtime, Handler: c.handler, Timeout: c.timeout, MemorySize: c.memorySize, Environment: { Variables: [{ Key: c.tokenKey, Value: deploymentHash(token) }] } });
  let fn = existing ? shape(old) : null, gets = 0;
  let triggers = existing ? [{ Type: 'timer', TriggerName: c.triggerName, TriggerDesc: description, CustomArgument: token, Enable: 1 }] : [];
  const calls = [], proofs = [];
  async function api(action, body) {
    calls.push({ action, body: structuredClone(body) });
    if (body.FunctionName) assert.equal(body.FunctionName, c.functionName, 'must never mutate main cloud function');
    if (action === 'ListFunctions') return { Functions: fn ? [{ FunctionName: c.functionName }] : [], TotalCount: Number(Boolean(fn)) };
    if (action === 'GetFunction') {
      gets += 1;
      if (concurrentChange && gets === 2) fn.CodeInfo = 'concurrent update';
      return structuredClone(fn);
    }
    if (action === 'ListTriggers') return { Triggers: structuredClone(triggers) };
    if (action === 'CreateFunction' || action === 'UpdateFunctionCode') {
      fn = shape(alteredCode ? 'wrong code' : code);
      if (alteredConfig) fn.Environment.Variables = [];
      return {};
    }
    if (action === 'CreateTrigger') {
      triggers = [{ ...body, TriggerDesc: description, CustomArgument: badTrigger ? 'wrong' : body.CustomArgument, Enable: 0 }]; return {};
    }
    if (action === 'UpdateTrigger') { if (!(lostEnable && body.Enable === 'OPEN')) triggers[0].Enable = body.Enable === 'OPEN' ? 1 : 0; return {}; }
    throw new Error(`unexpected API ${action}`);
  }
  const options = { api, namespace: 'test-env', token, code, zip: Buffer.from('package'), evidence: async (name, value) => proofs.push({ name, value: structuredClone(value) }), ...(existing ? { expectedBaseline: deploymentHash(old) } : {}) };
  return { options, calls, proofs, token };
}

test('new archive deployment creates closed trigger and verifies code/auth before opening', async () => {
  const f = fixture(); const receipt = await deployMealArchive(f.options);
  const actions = f.calls.map(call => call.action);
  assert.equal(actions[0], 'ListFunctions');
  const create = f.calls.find(call => call.action === 'CreateTrigger');
  assert.equal(create.body.Enable, 'CLOSE'); assert.equal(create.body.CustomArgument, f.token);
  const enabling = f.calls.findIndex(call => call.action === 'UpdateTrigger' && call.body.Enable === 'OPEN');
  assert.equal(actions[enabling - 1], 'GetFunction'); assert.equal(actions[enabling + 1], 'ListTriggers');
  assert.equal(receipt.triggerEnabled, true); assert.equal(JSON.stringify(receipt).includes(f.token), false);
  assert.ok(f.proofs.some(proof => proof.name === 'deployment-receipt'));
});

test('existing deployment backs up and closes trigger before code change', async () => {
  const f = fixture({ existing: true }); await deployMealArchive(f.options);
  const close = f.calls.findIndex(call => call.action === 'UpdateTrigger' && call.body.Enable === 'CLOSE');
  const update = f.calls.findIndex(call => call.action === 'UpdateFunctionCode');
  assert.ok(close > 0 && close < update);
  assert.ok(f.proofs.some(proof => proof.name.endsWith('GetFunction') && proof.value.CodeInfo.endsWith('previous')));
  assert.equal(f.calls.some(call => call.action === 'CreateFunction' || call.action === 'UpdateFunctionConfiguration'), false);
});

for (const [field, message] of [['alteredConfig', /认证配置/], ['alteredCode', /代码.*不一致/], ['badTrigger', /认证参数/]]) {
  test(`does not enable trigger when ${field} fails verification`, async () => {
    const f = fixture({ [field]: true }); await assert.rejects(deployMealArchive(f.options), message);
    assert.equal(f.calls.some(call => call.action === 'UpdateTrigger' && call.body.Enable === 'OPEN'), false);
  });
}

test('unconfirmed OPEN is not reported successful', async () => {
  const f = fixture({ lostEnable: true }); await assert.rejects(deployMealArchive(f.options), /启停状态/);
  assert.equal(f.proofs.some(proof => proof.name === 'deployment-receipt'), false);
});

test('existing unknown baseline is never overwritten', async () => {
  const f = fixture({ existing: true }); delete f.options.expectedBaseline;
  await assert.rejects(deployMealArchive(f.options), /代码哈希/);
  assert.equal(f.calls.some(call => /^(Create|Update)/.test(call.action)), false);
});

test('concurrent deployment cannot be overwritten after backup', async () => {
  const f = fixture({ existing: true, concurrentChange: true });
  await assert.rejects(deployMealArchive(f.options), /发生变化/);
  assert.equal(f.calls.some(call => call.action === 'UpdateFunctionCode'), false);
});

test('bad local secret fails without leaking its value or touching cloud', async () => {
  const f = fixture(); f.options.token = 'DO_NOT_PRINT_THIS_SECRET';
  await assert.rejects(deployMealArchive(f.options), error => { assert.ok(!String(error).includes(f.options.token)); return true; });
  assert.equal(f.calls.length, 0);
});

test('wrong build entry fails before cloud operations', async () => {
  const f = fixture(); f.options.code = 'main interactive entry';
  await assert.rejects(deployMealArchive(f.options), /独立归档入口/); assert.equal(f.calls.length, 0);
});

for (const existing of [false, true]) {
  test(`accepts SCF JSON cron description with existing=${existing}`, async () => {
    const f = fixture({ existing, description: JSON.stringify({ cron: c.cron }) });
    assert.equal((await deployMealArchive(f.options)).triggerEnabled, true);
  });
  for (const description of ['0 */5 * * * * *', '{"cron":"0 */5 * * * * *"}', '{}', '[]', 'null', '{"cron":123}', '{"cron":"0 * * * * * *","extra":true}']) {
    test(`rejects altered/malformed cron ${description} with existing=${existing}`, async () => {
      const f = fixture({ existing, description });
      await assert.rejects(deployMealArchive(f.options), /时间不匹配/);
      assert.equal(f.calls.some(call => call.action === 'UpdateTrigger' && call.body.Enable === 'OPEN'), false);
    });
  }
}

test('JSON description does not bypass independent token verification', async () => {
  const f = fixture({ description: JSON.stringify({ cron: c.cron }), badTrigger: true });
  await assert.rejects(deployMealArchive(f.options), /认证参数不匹配/);
  assert.equal(f.calls.some(call => call.action === 'UpdateTrigger' && call.body.Enable === 'OPEN'), false);
});
