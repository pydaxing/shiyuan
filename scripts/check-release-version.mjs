import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function numericVersion(version) {
  assert.match(version || '', /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '版本号必须为三段数字，例如 1.0.0');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger) && parts[1] < 100 && parts[2] < 100, '次版本和修订号必须小于 100');
  const code = parts[0] * 10000 + parts[1] * 100 + parts[2];
  assert.ok(Number.isSafeInteger(code), '版本号过大');
  return code;
}

export function validateReleaseVersions(pkg, lock, manifest, publishedVersion) {
  const version = pkg.version;
  const versionCode = numericVersion(version);
  assert.equal(lock.version, version, 'package-lock.json 顶层版本与 package.json 不一致');
  assert.equal(lock.packages?.['']?.version, version, 'package-lock.json 根包版本与 package.json 不一致');
  assert.equal(manifest.versionName, version, 'src/manifest.json 版本与 package.json 不一致');
  assert.equal(String(manifest.versionCode), String(versionCode), 'versionCode 必须为 主版本×10000 + 次版本×100 + 修订号');
  if (publishedVersion !== undefined) assert.ok(versionCode > numericVersion(publishedVersion), `待上传版本 ${version} 必须高于已核实的线上版本 ${publishedVersion}`);
  return { version, versionCode, ...(publishedVersion === undefined ? {} : { publishedVersion }) };
}

export async function checkReleaseVersion(root, publishedVersion) {
  const [pkg, lock, manifest] = await Promise.all(['package.json', 'package-lock.json', 'src/manifest.json'].map(async file => JSON.parse(await readFile(resolve(root, file), 'utf8'))));
  return validateReleaseVersions(pkg, lock, manifest, publishedVersion);
}

export function validateCompiledVersion(source, { version, versionCode }) {
  const versions = [...source.matchAll(/\bappVersion\s*:\s*["']([^"']+)["']/g)].map(match => match[1]);
  const codes = [...source.matchAll(/\bappVersionCode\s*:\s*["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(versions.length > 0 && versions.every(value => value === version), 'dist/release 编译版本已过期，请重新构建并同步发布包');
  assert.ok(codes.length > 0 && codes.every(value => value === String(versionCode)), 'dist/release 编译版本号已过期，请重新构建并同步发布包');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--published-version'), '用法：npm run release:check -- --published-version 已核实的线上版本');
  console.log(JSON.stringify(await checkReleaseVersion(process.cwd(), args[1])));
}
