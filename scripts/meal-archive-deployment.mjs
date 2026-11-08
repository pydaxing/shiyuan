import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ARCHIVE_DEPLOYMENT = Object.freeze({
  functionName: 'kitchen-diary-archive', triggerName: 'meal-diary-every-minute',
  cron: '0 * * * * * *', tokenKey: 'MEAL_ARCHIVE_TRIGGER_TOKEN_SHA256',
  runtime: 'Nodejs20.19', handler: 'index.main', timeout: 60, memorySize: 256,
});
export const deploymentHash = value => createHash('sha256').update(value).digest('hex');

// SCF returns the timer description either as the cron itself or a JSON
// object containing it. Normalize only these two documented/observed shapes.
function triggerCron(description) {
  if (typeof description !== 'string') return null;
  if (description === ARCHIVE_DEPLOYMENT.cron) return description;
  try {
    const value = JSON.parse(description);
    return value && !Array.isArray(value) && typeof value === 'object'
      && Object.keys(value).length === 1 && typeof value.cron === 'string' ? value.cron : null;
  } catch { return null; }
}

// All API responses (including trigger arguments) go only to a private evidence
// sink. The return value intentionally contains no token or environment values.
export async function deployMealArchive({ api, namespace, code, zip, token, expectedBaseline, evidence = async () => {}, wait = async () => {}, now = Date.now }) {
  const c = ARCHIVE_DEPLOYMENT;
  assert.ok(namespace && /^[\w-]{6,100}$/.test(namespace), '云环境无效');
  assert.ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), '必须使用独立的 256 位随机触发令牌');
  assert.ok(typeof code === 'string' && code.includes(c.tokenKey) && code.includes(c.triggerName), '构建产物不是独立归档入口');
  assert.ok(zip?.length > 0 && zip.length < 20 * 1024 * 1024, '云函数压缩包无效或超限');
  const codeHash = deploymentHash(code), tokenHash = deploymentHash(token);
  const target = { FunctionName: c.functionName, Namespace: namespace };
  const triggerTarget = { ...target, TriggerName: c.triggerName, Type: 'timer', Qualifier: '$LATEST' };
  let n = 0;
  async function call(action, body) {
    const response = await api(action, body);
    await evidence(`${String(++n).padStart(2, '0')}-${action}`, response);
    return response;
  }
  let found = false;
  for (let offset = 0; ; offset += 100) {
    const page = await call('ListFunctions', { Namespace: namespace, Limit: 100, Offset: offset });
    assert.ok(Array.isArray(page.Functions), '未取得云函数列表，停止部署');
    if (page.Functions.some(fn => fn.FunctionName === c.functionName)) found = true;
    if (page.Functions.length < 100 || offset + 100 >= page.TotalCount) break;
    assert.ok(offset < 10000, '云函数列表过大，停止部署');
  }
  const existing = found ? await call('GetFunction', { ...target, ShowCode: 'TRUE' }) : null;
  if (existing) {
    assert.ok(existing.Status === 'Active' && existing.CodeInfo, '现有定时函数未就绪或无法备份代码');
    assert.ok(expectedBaseline && deploymentHash(existing.CodeInfo) === expectedBaseline, '必须显式指定并匹配现有定时函数代码哈希');
    assert.ok(existing.Environment?.Variables?.some(v => v.Key === c.tokenKey && v.Value === tokenHash), '本地私有令牌不匹配现有函数；停止更新，不能盲目轮换');
  }
  const currentTriggers = found ? (await call('ListTriggers', { ...target, Limit: 100, Offset: 0 })).Triggers : [];
  assert.ok(Array.isArray(currentTriggers), '未取得现有触发器列表');
  assert.ok(currentTriggers.every(t => t.Type === 'timer' && t.TriggerName === c.triggerName && (!t.Qualifier || t.Qualifier === '$LATEST')), '存在不属于本流程的触发器，停止部署');
  const previousTrigger = currentTriggers[0];
  if (previousTrigger) {
    assert.ok(previousTrigger.CustomArgument === token, '现有触发令牌不匹配，停止更新');
    assert.ok(triggerCron(previousTrigger.TriggerDesc) === c.cron, '现有触发时间不匹配，停止更新');
    await call('UpdateTrigger', { ...triggerTarget, Enable: 'CLOSE' });
    await verifyTrigger('CLOSE');
  }
  const environment = { Variables: [{ Key: c.tokenKey, Value: tokenHash }] };
  if (existing) {
    // Re-read immediately before a mutation so a concurrent deployment cannot
    // be overwritten after the earlier backup.
    const latest = await call('GetFunction', { ...target, ShowCode: 'TRUE' });
    assert.ok(latest.Status === 'Active' && deploymentHash(latest.CodeInfo || '') === expectedBaseline, '备份后云端代码发生变化，停止更新');
    await call('UpdateFunctionCode', { ...target, Handler: c.handler, CodeSource: 'ZipFile', ZipFile: zip.toString('base64'), InstallDependency: 'FALSE', Publish: 'FALSE' });
  } else {
    await call('CreateFunction', { ...target, Description: '食愿日记跨天归档（独立定时入口）', Runtime: c.runtime, Handler: c.handler, Type: 'Event', Timeout: c.timeout, MemorySize: c.memorySize, Role: 'TCB_QcsRole', Stamp: 'MINI_QCBASE', Code: { ZipFile: zip.toString('base64') }, InstallDependency: 'FALSE', Environment: environment });
  }
  const deployed = await verifyFunction();
  if (!previousTrigger) {
    await call('CreateTrigger', { ...triggerTarget, TriggerDesc: c.cron, Enable: 'CLOSE', CustomArgument: token });
  }
  await verifyTrigger('CLOSE');
  // Only enable after the exact packaged code and authentication config are
  // independently read back. A failed deployment intentionally remains closed.
  await verifyFunction();
  await call('UpdateTrigger', { ...triggerTarget, Enable: 'OPEN' });
  await verifyTrigger('OPEN');
  const receipt = { functionName: c.functionName, environment: namespace, sha256: codeHash, runtime: deployed.Runtime, triggerName: c.triggerName, cron: c.cron, triggerEnabled: true, verifiedAt: new Date(now()).toISOString() };
  await evidence('deployment-receipt', receipt);
  return receipt;

  async function verifyFunction() {
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const detail = await call('GetFunction', { ...target, ShowCode: 'TRUE' });
      assert.ok(!/Failed|Error/i.test(detail.Status || ''), '归档函数部署失败，触发器保持关闭');
      if (detail.Status === 'Active') {
        assert.ok(deploymentHash(detail.CodeInfo || '') === codeHash, '云端代码与本次构建不一致，触发器保持关闭');
        assert.ok(detail.Runtime === c.runtime && detail.Handler === c.handler && detail.Timeout === c.timeout && detail.MemorySize === c.memorySize, '云端运行配置不匹配，触发器保持关闭');
        assert.ok(detail.Environment?.Variables?.some(v => v.Key === c.tokenKey && v.Value === tokenHash), '触发器认证配置不匹配，保持关闭');
        return detail;
      }
      await wait(5000);
    }
    throw new Error('归档函数状态未完成，触发器保持关闭');
  }
  async function verifyTrigger(expectedEnable) {
    const response = await call('ListTriggers', { ...target, Limit: 100, Offset: 0 });
    const triggers = response.Triggers;
    assert.ok(Array.isArray(triggers) && triggers.length === 1, '触发器数量不匹配');
    const trigger = triggers[0];
    assert.ok(trigger.TriggerName === c.triggerName && trigger.Type === 'timer' && triggerCron(trigger.TriggerDesc) === c.cron && (!trigger.Qualifier || trigger.Qualifier === '$LATEST'), '触发器名称或时间不匹配');
    assert.ok(trigger.CustomArgument === token, '触发器认证参数不匹配');
    assert.ok(trigger.Enable === (expectedEnable === 'OPEN' ? 1 : 0) || trigger.Enable === expectedEnable, '触发器启停状态未确认');
  }
}
