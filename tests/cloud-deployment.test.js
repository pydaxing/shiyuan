import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collections } from '../server/application.mjs';

test('cloud deployment uses a supported runtime and the authenticated main entry', async () => {
  const config = JSON.parse(await readFile('cloudbaserc.json', 'utf8'));
  const active = config.functions.find(item => item.name === 'kitchen-v2');
  assert.equal(active.runtime, 'Nodejs20.19');
  assert.equal(active.handler, 'index.main');
  assert.equal(active.timeout, 60);
  assert.equal(active.installDependency, true);
  const builder = await readFile('scripts/build-cloud.mjs', 'utf8');
  assert.equal(builder.includes('exports.main = exports.handler'), false);
});

test('deployment manifest includes every server collection and denies all client database access', async () => {
  const manifest = JSON.parse(await readFile('deployment/database.json', 'utf8'));
  const rules = JSON.parse(await readFile('deployment/database-rules.json', 'utf8'));
  assert.deepEqual(manifest.collections.map(item => item.name).sort(), [...collections].sort());
  assert.deepEqual(rules, { read: false, write: false });
  assert.equal(new Set(manifest.collections.map(item => item.name)).size, collections.length);
  const publicationIndexes = manifest.collections.find(item => item.name === 'posts').indexes;
  assert.ok(publicationIndexes.some(fields => JSON.stringify(fields) === JSON.stringify(['familyId', 'status', '_id'])));
  assert.ok(publicationIndexes.some(fields => JSON.stringify(fields) === JSON.stringify(['familyId', 'familyItemId', 'status', '_id'])));
});

test('optional custom storage policy denies direct reads and writes to approved assets; free deployment also needs encryption', async () => {
  const rules = JSON.parse(await readFile('deployment/storage-rules.json', 'utf8'));
  assert.equal(rules.read, false);
  const allowed = new Function('auth', 'resource', `return ${rules.write}`);
  assert.equal(allowed({ openid: 'alice' }, { openid: 'alice', path: 'private/alice/photo.jpg' }), true);
  assert.equal(allowed({ openid: 'bob' }, { openid: 'alice', path: 'private/alice/photo.jpg' }), false);
  assert.equal(allowed({ openid: 'alice' }, { openid: 'alice', path: 'approved/family/photo.jpg' }), false);
  assert.equal(allowed(null, { openid: 'alice', path: 'private/alice/photo.jpg' }), false);
});

test('cloud dependency lock uses reachable public package URLs and pins the audited SDK', async () => {
  const lock = JSON.parse(await readFile('cloudfunctions/kitchen/package-lock.json', 'utf8'));
  assert.equal(lock.packages[''].dependencies['wx-server-sdk'], '4.0.2');
  assert.equal(lock.packages[''].dependencies.sharp, '0.34.3');
  assert.equal(lock.packages[''].dependencies['@img/sharp-linux-x64'], '0.34.3');
  assert.equal(lock.packages[''].dependencies['@img/sharp-libvips-linux-x64'], '1.2.0');
  for (const entry of Object.values(lock.packages)) if (entry.resolved) assert.ok(entry.resolved.startsWith('https://registry.npmjs.org/'));
});

test('verified deployment includes Linux dependencies, uses an explicit code source and verifies active code', async () => {
  const script = await readFile('scripts/deploy-cloud-verified.mjs', 'utf8');
  assert.match(script, /CodeSource: 'ZipFile'/);
  assert.match(script, /InstallDependency: 'FALSE'/);
  assert.match(script, /'--os=linux', '--cpu=x64', '--libc=glibc'/);
  assert.match(script, /7f454c46/);
  assert.match(script, /deployed.Status === 'Active' && hash\(deployed.CodeInfo \|\| ''\) === expected/);
  assert.match(script, /assert.ok\(verified/);
});
