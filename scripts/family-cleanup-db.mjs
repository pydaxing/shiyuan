import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Send CLI stdout straight to a private regular file. The installed CLI can
// terminate before a large piped stdout buffer is drained (64 KiB truncation).
export async function runIdeToFile(target, directory, label, tool, args) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rawPath = join(directory, `${label}.raw.json`);
  const stderrPath = join(directory, `${label}.stderr`);
  const out = await open(rawPath, 'wx', 0o600);
  const err = await open(stderrPath, 'wx', 0o600);
  let code;
  try {
    assert.ok(target || tool === 'polling_task_result', 'Only task polling may omit target');
    const child = spawn('/usr/local/bin/wechatide', ['-c', 'Codex', tool, ...(target ? ['--appid', target.appid, '--env', target.env] : []), ...args], { stdio: ['ignore', out.fd, err.fd], timeout: 90000 });
    code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  } finally { await out.close(); await err.close(); }
  assert.equal(code, 0, `CLI failed; inspect ${stderrPath}`);
  const raw = await readFile(rawPath, 'utf8');
  const start = raw.indexOf('{');
  assert.ok(start >= 0, `Missing JSON in ${rawPath}`);
  const response = JSON.parse(raw.slice(start));
  return { response, rawPath, stderrPath };
}

export function createCleanupReader(target, directory) {
  let sequence = 0;
  return async (tool, args) => {
    assert.ok(['cloud_db_read_doc', 'cloud_db_read_struct'].includes(tool), 'read-only client');
    const result = await runIdeToFile(target, directory, `read-${String(++sequence).padStart(5, '0')}`, tool, args);
    await writeFile(result.rawPath + '.request.json', JSON.stringify({ target, tool, args }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assert.equal(result.response.ok, true, 'IDE read failed');
    assert.equal(result.response.result?.success, true, 'Cloud read failed');
    return result.response.result;
  };
}

export async function readAllCleanup(call, name, query = {}, projection) {
  const rows = [];
  let total;
  const limit = 100;
  while (rows.length < 100000) {
    const result = await call('cloud_db_read_doc', ['--collection-name', name, '--query', JSON.stringify(query), '--sort', '[{"key":"_id","direction":1}]', '--limit', String(limit), '--offset', String(rows.length), ...(projection ? ['--projection', JSON.stringify(projection)] : [])]);
    assert.ok(Array.isArray(result.data));
    assert.ok(Number.isSafeInteger(result.total) && result.total >= 0);
    total ??= result.total;
    assert.equal(result.total, total, `${name}: count changed during read`);
    rows.push(...result.data);
    assert.ok(rows.every(row => typeof row._id === 'string' && row._id));
    assert.equal(new Set(rows.map(row => row._id)).size, rows.length);
    if (rows.length === total || result.data.length < limit) {
      assert.equal(rows.length, total, `${name}: incomplete read`);
      return rows;
    }
  }
  throw new Error(`${name}: exceeds complete-backup capacity`);
}
