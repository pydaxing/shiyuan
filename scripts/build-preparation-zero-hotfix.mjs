import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const names = ['ingredientFieldErrors', 'preparationFieldErrors', 'shoppingDraftFieldErrors'];

function declaration(source, name) {
  const matches = [...source.matchAll(new RegExp(`^function ${name}\\([^]*?^}`, 'gm'))];
  assert.equal(matches.length, 1, `云端 ${name} 定义不唯一，停止热修复`);
  return matches[0][0];
}

export async function buildPreparationZeroHotfix(baseline) {
  assert.ok(!declaration(baseline, 'ingredientFieldErrors').includes('allowZero'), '生产代码已支持零用量，请重新核对');
  const built = await build({ entryPoints: [path.join(root, 'server/wechat.mjs')], bundle: true, write: false, platform: 'node', target: 'node18', format: 'cjs', external: ['wx-server-sdk', 'sharp'] });
  const source = built.outputFiles[0].text;
  const replacements = names.map(name => ({ before: declaration(baseline, name), after: declaration(source, name) }));
  for (const { before, after } of replacements.slice(1)) assert.equal(after.replace('ingredientFieldErrors(ingredient, true, true)', 'ingredientFieldErrors(ingredient, true)'), before, '备菜与采购校验只能启用零用量选项');
  let patched = baseline;
  for (const { before, after } of replacements) patched = patched.replace(before, () => after);
  let restored = patched;
  for (const { before, after } of replacements.toReversed()) restored = restored.replace(after, () => before);
  assert.equal(restored, baseline, '补丁不得修改数量校验之外的线上代码');
  return patched;
}

async function run() {
  const option = name => {
    const index = process.argv.indexOf(name);
    assert.ok(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `缺少参数 ${name}`);
    return process.argv[index + 1];
  };
  const baselinePath = path.resolve(option('--baseline'));
  const output = path.resolve(option('--output'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.equal(sha256(baseline), option('--expected-baseline-sha'), '生产代码摘要不一致，停止热修复');
  const code = await buildPreparationZeroHotfix(baseline);
  const directory = path.join(output, 'preparation-zero-hotfix/kitchen-v2');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'index.js');
  await writeFile(file, code, { flag: 'wx', mode: 0o600 });
  const receipt = { state: 'prepared_not_deployed', method: 'production_baseline_quantity_validation_only', baselinePath, baselineSha256: sha256(baseline), artifactPath: file, sha256: sha256(code), functions: names };
  await writeFile(path.join(output, 'preparation-zero-hotfix-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { console.error(error); process.exitCode = 1; });
