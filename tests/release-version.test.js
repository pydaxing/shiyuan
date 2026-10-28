import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseVersions, validateCompiledVersion } from '../scripts/check-release-version.mjs';

function candidate(version, versionCode) {
  return [{ version }, { version, packages: { '': { version } } }, { versionName: version, versionCode: String(versionCode) }];
}

test('release upload rejects the observed 0.6.0 downgrade and equal versions', () => {
  assert.throws(() => validateReleaseVersions(...candidate('0.6.0', 600), '0.6.1'), /必须高于/);
  assert.throws(() => validateReleaseVersions(...candidate('0.6.1', 601), '0.6.1'), /必须高于/);
  assert.equal(validateReleaseVersions(...candidate('1.0.0', 10000), '0.6.1').version, '1.0.0');
});

test('release comparison is numeric across digit lengths and major boundaries', () => {
  assert.equal(validateReleaseVersions(...candidate('0.10.0', 1000), '0.9.0').version, '0.10.0');
  assert.equal(validateReleaseVersions(...candidate('2.0.0', 20000), '1.99.99').version, '2.0.0');
  assert.throws(() => validateReleaseVersions(...candidate('1.9.0', 10900), '1.10.0'), /必须高于/);
});

test('every source metadata mismatch blocks release upload', () => {
  for (const change of [
    ([, lock]) => { lock.version = '0.6.0'; },
    ([, lock]) => { lock.packages[''].version = '0.6.0'; },
    ([,, manifest]) => { manifest.versionName = '0.6.0'; },
    ([,, manifest]) => { manifest.versionCode = '60'; },
  ]) {
    const inputs = candidate('1.0.0', 10000);
    change(inputs);
    assert.throws(() => validateReleaseVersions(...inputs, '0.6.1'));
  }
});

test('invalid or ambiguous versions cannot pass the release check', () => {
  for (const version of ['1.0', '1.0.0-beta', '01.0.0', '1.100.0', '1.0.100']) {
    assert.throws(() => validateReleaseVersions(...candidate(version, 10000), '0.6.1'));
  }
});

test('a source version bump cannot upload an old compiled package', () => {
  const version = { version: '1.0.0', versionCode: 10000 };
  assert.throws(() => validateCompiledVersion('appVersion:"0.6.0",appVersionCode:"60"', version), /编译版本已过期/);
  assert.throws(() => validateCompiledVersion('appVersion:"1.0.0",appVersionCode:"60"', version), /编译版本号已过期/);
  assert.throws(() => validateCompiledVersion('', version), /编译版本已过期/);
  assert.throws(() => validateCompiledVersion('appVersion:"1.0.0",appVersionCode:"10000";appVersion:"0.6.0",appVersionCode:"60"', version), /编译版本已过期/);
  assert.doesNotThrow(() => validateCompiledVersion('appVersion:"1.0.0",appVersionCode:"10000"', version));
});
