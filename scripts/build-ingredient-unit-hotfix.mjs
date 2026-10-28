import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { UNITS } from '../src/domain/kitchen.js';
import { INGREDIENT_UNITS_VERSION, LEGACY_INGREDIENT_UNITS } from '../src/domain/ingredient-units.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildIngredientUnitHotfix(baseline, protocolSource) {
  const unitsDeclaration = baseline.match(/^var UNITS = (\[[^\n]+\]);$/m);
  assert.ok(unitsDeclaration, '生产代码单位定义不符，停止热修复');
  assert.deepEqual(JSON.parse(unitsDeclaration[1]), LEGACY_INGREDIENT_UNITS, '生产单位版本已变化，必须重新核对');
  const originalInvoke = 'const invoke = () => application(event, import_wx_server_sdk.default.getWXContext());';
  assert.equal(baseline.split(originalInvoke).length, 2, '生产请求入口不唯一，停止热修复');
  assert.ok(!baseline.includes('ingredientUnitsProtocol'));
  const importLine = "import { UNITS } from './kitchen.js';";
  assert.equal(protocolSource.split(importLine).length, 2);
  const protocol = await transform(protocolSource.replace(importLine, ''), { loader: 'js', format: 'iife', globalName: 'ingredientUnitsProtocol', target: 'node18', charset: 'ascii' });
  const invoke = 'const invoke = async () => { const response = await application(ingredientUnitsProtocol.restoreIngredientCommand(event), import_wx_server_sdk.default.getWXContext()); return response.ok ? { ...response, data: ingredientUnitsProtocol.legacyIngredientAmounts(response.data, event?.ingredientUnitsVersion) } : response; };';
  const patched = baseline.replace(unitsDeclaration[0], `var UNITS = ${JSON.stringify(UNITS)};`).replace(originalInvoke, invoke);
  assert.equal(patched.replace(`var UNITS = ${JSON.stringify(UNITS)};`, unitsDeclaration[0]).replace(invoke, originalInvoke), baseline, '热修复必须只修改单位和兼容入口');
  return `${patched}\n${protocol.code}`;
}

async function run() {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  assert.ok(process.argv.includes('--baseline') && process.argv.includes('--output') && process.argv.includes('--expected-baseline-sha'));
  const baselinePath = path.resolve(option('--baseline'));
  const output = path.resolve(option('--output'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.equal(sha256(baseline), option('--expected-baseline-sha'));
  const source = await readFile('src/domain/ingredient-units.js', 'utf8');
  const code = await buildIngredientUnitHotfix(baseline, source);
  const directory = path.join(output, 'unit-hotfix/kitchen-v2');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'index.js');
  await writeFile(file, code, { flag: 'wx', mode: 0o600 });
  const receipt = { state: 'prepared_not_deployed', method: 'production_baseline_units_only', baselinePath, baselineSha256: sha256(baseline), artifactPath: file, sha256: sha256(code), ingredientUnitsVersion: INGREDIENT_UNITS_VERSION, units: UNITS };
  await writeFile(path.join(output, 'unit-hotfix-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { console.error(error); process.exitCode = 1; });
