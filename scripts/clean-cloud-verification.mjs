import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const directory = `${process.cwd()}/artifacts/deployment/live-cloud`;
const ledger = JSON.parse(await readFile(`${directory}/business-ledger.json`, 'utf8'));
assert.equal(ledger.finished, true, '验收未完成，请先检查失败步骤');
assert.equal(ledger.cleaned, undefined, '已经清理过，不重复执行');
const cli = process.env.TCB_BIN;
assert.ok(cli, '请显式提供已授权的 TCB_BIN 路径');
const allowed = ['recipes', 'meal_sets', 'orders', 'inventory', 'purchases', 'posts', 'comments'];
for (const record of ledger.records) {
  assert.ok(allowed.includes(record.collection));
  assert.match(record.id, /^[\w-]+$/);
}
function execute(commands) {
  const output = execFileSync(cli, ['db', 'nosql', 'execute', '-e', 'cloudbase-d8gqg3oqed7609824', '--instance-id', 'flexdb', '--database-name', 'tnt-87gpjklua', '--command', JSON.stringify(commands), '--json'], { encoding: 'utf8', timeout: 120000 });
  const result = JSON.parse(output.slice(output.indexOf('{')));
  assert.ok(result.data?.results, JSON.stringify(result));
  return result;
}
const queries = ledger.records.map(record => ({ TableName: record.collection, CommandType: 'QUERY', Command: JSON.stringify({ find: record.collection, filter: { _id: record.id }, limit: 1 }) }));
const before = execute(queries);
await writeFile(`${directory}/cleanup-before.json`, JSON.stringify(before, null, 2));
const commands = [];
for (let index = 0; index < ledger.records.length; index += 1) {
  const record = ledger.records[index];
  const rows = before.data.results[index];
  assert.ok(Array.isArray(rows) && rows.length <= 1);
  if (!rows.length) continue;
  const row = rows[0];
  assert.equal(row._id, record.id);
  if (record.collection === 'comments') {
    assert.equal(row.memberId, ledger.userId);
    assert.ok(ledger.records.some(entry => entry.collection === 'posts' && entry.id === row.postId));
    assert.ok(row.text.startsWith('验收'));
  } else {
    assert.equal(row.familyId, ledger.familyId);
    if (['recipes', 'meal_sets'].includes(record.collection)) assert.ok(row.value.title.startsWith('验收'));
    if (record.collection === 'posts') assert.ok(row.title.startsWith('验收'));
  }
  const scope = record.collection === 'comments' ? { memberId: ledger.userId } : { familyId: ledger.familyId };
  commands.push({ TableName: record.collection, CommandType: 'DELETE', Command: JSON.stringify({ delete: record.collection, deletes: [{ q: { _id: record.id, ...scope }, limit: 1 }] }) });
}
await writeFile(`${directory}/cleanup-result.json`, JSON.stringify(execute(commands), null, 2));
const after = execute(queries);
assert.ok(after.data.results.every(rows => Array.isArray(rows) && rows.length === 0));
ledger.cleaned = new Date().toISOString();
await writeFile(`${directory}/business-ledger.json`, JSON.stringify(ledger, null, 2));
console.log(`已核对并清理 ${commands.length} 条本轮验收记录，原有家庭和设置未删除。`);
