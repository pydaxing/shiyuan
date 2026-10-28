import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { runInNewContext, constants } from 'node:vm';
import { build } from 'esbuild';
import { decryptImage } from '../server/media-encryption.mjs';
import sharp from 'sharp';

const bundled = await build({ entryPoints: ['server/wechat.mjs'], bundle: true, platform: 'node', target: 'node18', format: 'cjs', write: false, external: ['wx-server-sdk', 'sharp', '@cloudbase/node-sdk'] });
const nodeRequire = createRequire(import.meta.url);

function entry(context) {
  const queries = [];
  const cloud = {
    init() {},
    getWXContext: () => context,
    database: () => ({ collection: collection => ({ where: query => ({ limit: () => ({ get: async () => { queries.push({ collection, query }); return { data: [] }; } }) }) }) }),
  };
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, process: { env: {} }, console: { error() {} }, Buffer, require: name => name === 'wx-server-sdk' ? cloud : nodeRequire(name) }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  return { ...module.exports, queries };
}

test('deployed CommonJS main resolves the SDK identity, never the SCF context or payload identity', async () => {
  const app = entry({ OPENID: 'verified-wechat-user' });
  const result = await app.main({ action: 'bootstrap', OPENID: 'forged-payload' }, { OPENID: 'forged-context' });
  const expectedId = createHash('sha256').update('verified-wechat-user').digest('hex');
  assert.equal(result.ok, true);
  assert.equal(result.data.needsFamily, true);
  assert.equal(result.data.userId, expectedId);
  assert.equal(app.queries[0].query._id, expectedId);
});

test('deployed main rejects unauthenticated calls even when the caller supplies an identity', async () => {
  const app = entry({});
  const result = await app.main({ action: 'bootstrap', OPENID: 'forged-payload' }, { OPENID: 'forged-context' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNAUTHENTICATED');
  assert.equal(app.queries.length, 0);
});

test('compiled diagnostics are opt-in, authenticated and do not expose query arguments', async () => {
  const app = entry({ OPENID: 'verified-wechat-user' });
  const result = await app.main({ action: 'bootstrap', diagnostics: true });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.firstInvocation, true);
  assert.equal(result.diagnostics.spans[0].operation, 'db.get.users');
  assert.equal(JSON.stringify(result.diagnostics).includes(result.data.userId), false);
  assert.equal((await app.main({ action: 'bootstrap', diagnostics: true })).diagnostics.firstInvocation, false);
  assert.equal((await app.main({ action: 'bootstrap' })).diagnostics, undefined);
  assert.equal((await entry({}).main({ action: 'bootstrap', diagnostics: true })).diagnostics, undefined);
});

test('compiled family saves work without accessing any WeChat openapi service', async () => {
  const userId = createHash('sha256').update('verified-wechat-user').digest('hex');
  const rows = new Map([
    [`users:${userId}`, { familyId: 'family-test' }],
    ['families:family-test', { id: 'family-test', name: '原名字', cover: '', coverTitle: '', revision: 1, members: [{ id: userId, name: '我' }] }],
  ]);
  const database = {
    collection(name) {
      return {
        where(query) { return { limit: () => ({ get: async () => ({ data: rows.has(`${name}:${query._id}`) ? [structuredClone(rows.get(`${name}:${query._id}`))] : [] }) }) }; },
        doc(id) { return { set: async ({ data }) => { rows.set(`${name}:${id}`, structuredClone(data)); }, remove: async () => rows.delete(`${name}:${id}`) }; },
      };
    },
    runTransaction: callback => callback(database),
  };
  let openapiAccesses = 0;
  const cloud = {
    init() {}, getWXContext: () => ({ OPENID: 'verified-wechat-user' }), database: () => database,
    get openapi() { openapiAccesses += 1; throw new Error('openapi must not be accessed'); },
  };
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, process: { env: {} }, console: { error() {} }, Buffer, structuredClone, require: name => name === 'wx-server-sdk' ? cloud : nodeRequire(name) }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const result = await module.exports.main({ action: 'command', name: 'customizeFamily', args: [{ name: '新名字', cover: '', coverTitle: '好好吃饭' }], revision: 1, requestId: 'family-sdk-test-001', responseMode: 'changes' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(openapiAccesses, 0);
  assert.equal(rows.get('families:family-test').name, '新名字');
  assert.equal(rows.get('families:family-test').coverTitle, '好好吃饭');
  assert.equal(rows.get('families:family-test').revision, 2);
});

test('compiled entry contains no content-check calls or quota gates', () => {
  assert.doesNotMatch(bundled.outputFiles[0].text, /msgSecCheck|imgSecCheck|CONTENT_REVIEW|CONTENT_CHECK|moderationText/);
});

test('explicitly configured private delivery preserves encrypted originals and private thumbnail copies', async () => {
  const userId = createHash('sha256').update('verified-wechat-user').digest('hex');
  const rows = new Map([
    [`users:${userId}`, { familyId: 'family-test' }],
    ['families:family-test', { id: 'family-test', members: [{ id: userId }] }],
  ]);
  const storage = [];
  let openapiAccesses = 0;
  const database = {
    collection(name) {
      return {
        where(query) { return { limit: () => ({ get: async () => ({ data: rows.has(`${name}:${query._id}`) ? [rows.get(`${name}:${query._id}`)] : [] }) }) }; },
        doc(id) { return { set: async ({ data }) => { rows.set(`${name}:${id}`, data); }, remove: async () => rows.delete(`${name}:${id}`) }; },
      };
    },
    runTransaction: callback => callback(database),
  };
  const cloud = {
    init() {}, getWXContext: () => ({ OPENID: 'verified-wechat-user' }), database: () => database,
    get openapi() { openapiAccesses += 1; throw new Error('openapi must not be accessed'); },
    uploadFile: async options => { storage.push(options); return { fileID: `cloud://env/approved/test-${storage.length}.bin` }; },
    downloadFile: async ({ fileID }) => ({ fileContent: storage[Number(fileID.match(/test-(\d+)/)[1]) - 1].fileContent }),
  };
  const module = { exports: {} };
  runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, process: { env: { IMAGE_DELIVERY_PRIVATE: '1' } }, console: { error() {} }, Buffer, require: name => name === 'wx-server-sdk' ? cloud : nodeRequire(name) }, { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
  const bytes = await sharp({ create: { width: 1500, height: 1000, channels: 3, background: '#658059' } }).jpeg().toBuffer();
  const result = await module.exports.main({ action: 'mediaUpload', base64: bytes.toString('base64') });
  assert.equal(result.ok, true);
  assert.equal(storage.length, 5);
  assert.match(storage[0].cloudPath, /^approved\/family-test\/.+\.bin$/);
  assert.notDeepEqual(storage[0].fileContent, bytes);
  const record = rows.get(`media:${createHash('sha256').update(result.data.fileId).digest('hex')}`);
  assert.deepEqual(decryptImage(storage[0].fileContent, record.encryptionKey), bytes);
  assert.equal(JSON.stringify(result).includes(record.encryptionKey), false);
  for (const variant of ['card', 'detail']) {
    assert.equal(record.variants[variant].delivery.version, 1);
    assert.equal(record.variants[variant].delivery.contentType, 'image/jpeg');
    const response = await module.exports.main({ action: 'mediaContent', fileId: result.data.fileId, variant });
    assert.equal(response.ok, true);
    const metadata = await sharp(Buffer.from(response.data.base64, 'base64')).metadata();
    assert.equal(metadata.width, variant === 'card' ? 480 : 960);
    assert.equal(JSON.stringify(response).includes(record.variants[variant].encryptionKey), false);
  }
  delete record.variants.card;
  record.retainedField = 'must-survive';
  const lazyReads = await Promise.all(Array.from({ length: 3 }, () => module.exports.main({ action: 'mediaContent', fileId: result.data.fileId, variant: 'card' })));
  assert.ok(lazyReads.every(response => response.ok));
  assert.equal(storage.length, 7);
  const updated = rows.get(`media:${createHash('sha256').update(result.data.fileId).digest('hex')}`);
  assert.equal(updated.retainedField, 'must-survive');
  assert.equal(updated.variants.card.formatVersion, 1);
  assert.equal(updated.variants.detail.fileId, record.variants.detail.fileId);
  const original = await module.exports.main({ action: 'mediaContent', fileId: result.data.fileId });
  assert.deepEqual(Buffer.from(original.data.base64, 'base64'), bytes);
  assert.equal((await module.exports.main({ action: 'mediaUpload', base64: bytes.toString('base64') })).ok, true);
  assert.equal(storage.length, 12);
  assert.equal((await module.exports.main({ action: 'mediaUpload', base64: Buffer.from('not an image').toString('base64') })).code, 'IMAGE_FORMAT');
  assert.equal(storage.length, 12);
  assert.equal(openapiAccesses, 0);
});
