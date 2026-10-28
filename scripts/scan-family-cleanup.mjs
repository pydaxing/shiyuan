import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadEnv } from 'vite';
import { verifyPreviewTarget } from './preview-weixin.mjs';
import { createCleanupReader, readAllCleanup } from './family-cleanup-db.mjs';

const root = process.cwd();
const config = { ...loadEnv('production', root, ''), ...process.env };
assert.equal(config.VITE_DATA_MODE, 'cloud');
const preview = await verifyPreviewTarget(root, config);
const target = { appid: preview.appid, env: preview.environment };
const output = resolve(root, process.argv[2] || `artifacts/family-cleanup-20261027/scan-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const call = createCleanupReader(target, output);
const structure = await call('cloud_db_read_struct', ['--action', 'listCollections', '--limit', '100', '--offset', '0']);
await writeFile(join(output, 'structure.json'), JSON.stringify({ target, structure }, null, 2) + '\n', { mode: 0o600 });
if (process.argv.includes('--structure-only')) {
  console.log(JSON.stringify({ output, structure }));
} else {
  const namesArgument = process.argv.find(value => value.startsWith('--collections='));
  assert.ok(namesArgument, '先核对结构，再显式提供完整集合名称');
  const names = namesArgument.slice('--collections='.length).split(',');
  assert.equal(new Set(names).size, names.length);
  const collections = {};
  const actualNames = structure.collections.map(entry => entry.TableName).sort();
  assert.equal(structure.pager.Total, actualNames.length, '集合结构分页不完整');
  assert.deepEqual([...names].sort(), actualNames, '必须完整备份全部现有集合');
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_-]+$/);
    const rows = await readAllCleanup(call, name);
    collections[name] = rows;
    await writeFile(join(output, `${name}.json`), JSON.stringify(rows, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ collection: name, count: rows.length }));
  }
  const backup = { target, preview, capturedAt: new Date().toISOString(), collections };
  await writeFile(join(output, 'backup.json'), JSON.stringify(backup, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ state: 'read_only_backup_complete', output, counts: Object.fromEntries(Object.entries(collections).map(([name, rows]) => [name, rows.length])) }));
}
