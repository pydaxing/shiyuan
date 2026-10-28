import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { emptySnapshot } from '../src/domain/empty.js';
import { createSeed } from '../src/data/seed.js';
import { matchesImportedSource } from '../src/domain/kitchen.js';

const bundled = await build({ entryPoints: ['src/services/cloud.js'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_DATA_MODE: 'cloud', VITE_CLOUD_ENV: 'test-only' }) } });
let sequence = 0;
const stockBatch = { name: '玉米', quantity: 2, unit: '根', location: '冷藏', expiresOn: '', image: '' };

test('cloud client routes to the configured replacement function without changing the environment', async () => {
  const configured = await build({ entryPoints: ['src/services/cloud.js'], bundle: true, platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_DATA_MODE: 'cloud', VITE_CLOUD_ENV: 'test-only', VITE_CLOUD_FUNCTION: 'kitchen-v2' }) } });
  let environment;
  let functionName;
  globalThis.wx = { cloud: { init(options) { environment = options.env; }, async callFunction(options) { functionName = options.name; return { result: { ok: true, data: {} } }; } } };
  const app = await import(`data:text/javascript;base64,${Buffer.from(configured.outputFiles[0].text).toString('base64')}`);
  await app.invokeCloud('bootstrap');
  assert.equal(environment, 'test-only');
  assert.equal(functionName, 'kitchen-v2');
});
function snapshot(revision = 1) {
  return { snapshot: emptySnapshot(), revision, userId: 'alice', familyId: 'family-1', media: {} };
}
async function client(handler, { storage = new Map(), cold = false } = {}) {
  const calls = [];
  globalThis.wx = { cloud: { init() {}, async callFunction({ data }) { calls.push(data); return { result: await handler(data) }; } } };
  if (storage) Object.assign(wx, { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: key => storage.delete(key) });
  const module = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}#${++sequence}`);
  const state = { value: emptySnapshot() };
  module.bindCloudState(state);
  if (!cold) module.cloudStatus.value = { phase: 'ready', revision: 1, familyId: 'family-1', userId: 'alice', busy: false, error: '' };
  return { ...module, state, calls };
}

test('unchanged and equal snapshots preserve page arrays, comments and image bindings', async () => {
  let unchanged = true;
  const app = await client(async () => ({ ok: true, data: unchanged ? { unchanged: true, familyId: 'family-1', userId: 'alice', revision: 1 } : snapshot() }));
  const original = app.state.value;
  const recipes = original.recipes;
  const images = app.mediaUrls.value;
  original.comments = [{ id: 'comment-1' }];
  await app.refreshCloud({ background: true });
  assert.equal(app.calls[0].knownRevision, 1);
  assert.equal(app.calls[0].knownFamilyId, 'family-1');
  unchanged = false;
  await app.cloudCall('bootstrap');
  app.rememberMedia({ photo: { protected: true } });
  assert.equal(app.state.value, original);
  assert.equal(app.state.value.recipes, recipes);
  assert.equal(app.state.value.comments[0].id, 'comment-1');
  assert.equal(app.mediaUrls.value, images);
});

test('changed snapshots update only changed lists and a family change replaces all private state', async () => {
  const next = snapshot(2);
  next.snapshot.recipes = [{ id: 'new-recipe' }];
  const app = await client(async () => ({ ok: true, data: next }));
  const original = app.state.value;
  const orders = original.orders;
  await app.cloudCall('command');
  assert.equal(app.state.value, original);
  assert.equal(app.state.value.orders, orders);
  assert.equal(app.state.value.recipes[0].id, 'new-recipe');
  next.familyId = 'family-2';
  next.snapshot = emptySnapshot();
  await app.cloudCall('bootstrap');
  assert.notEqual(app.state.value, original);
  assert.deepEqual(app.state.value.recipes, []);
});

test('confirmed patches update only changed fields and preserve unrelated lists and posts', async () => {
  const family = { ...emptySnapshot().family, name: '新名称' };
  const app = await client(async data => {
    assert.equal(data.responseMode, 'changes');
    return { ok: true, data: { familyId: 'family-1', userId: 'alice', baseRevision: 1, revision: 2, changes: { family }, postChanges: { upsert: [{ id: 'post-1', importedFamilyCount: 9 }], remove: ['post-2'] }, value: 'saved' } };
  });
  const recipes = app.state.value.recipes;
  app.state.value.posts = [{ id: 'post-1' }, { id: 'post-2' }, { id: 'post-3' }];
  app.state.value.comments = [{ id: 'comment', postId: 'post-2' }];
  assert.equal(await app.remoteAction('customizeFamily', [family]), 'saved');
  assert.equal(app.state.value.family.name, '新名称');
  assert.equal(app.state.value.recipes, recipes);
  assert.deepEqual(app.state.value.posts, [{ id: 'post-1', importedFamilyCount: 9 }, { id: 'post-3' }]);
  assert.deepEqual(app.state.value.comments, []);
  assert.equal(app.cloudStatus.value.revision, 2);
  assert.equal(app.calls.length, 1);
});

test('incompatible partial responses refresh authoritatively without repeating the saved command', async () => {
  for (const mismatched of [{ familyId: 'family-2', baseRevision: 1 }, { familyId: 'family-1', baseRevision: 0 }]) {
    const app = await client(async data => ({ ok: true, data: data.action === 'bootstrap' ? snapshot(3) : { ...mismatched, revision: 2, changes: { recipes: [{ id: 'incorrect' }] }, value: 7 } }));
    assert.equal(await app.remoteAction('setFeature', ['fridge', true]), 7);
    assert.deepEqual(app.state.value.recipes, []);
    assert.deepEqual(app.calls.map(item => item.action), ['command', 'bootstrap']);
    assert.equal(app.cloudStatus.value.revision, 3);
  }
});

test('even small photos upload as files, cache locally and never send base64 through callFunction', async () => {
  let rejected = false;
  const uploads = [];
  const app = await client(async data => {
    assert.equal(data.base64, undefined);
    assert.equal(data.familyId, 'family-1');
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket', path: 'private/photo.jpg' } };
    assert.equal(data.action, 'mediaConfirm');
    return rejected ? { ok: false, code: 'IMAGE_FORMAT', message: '图片格式不支持' } : { ok: true, data: { fileId: 'cloud://env/approved/direct.bin', protected: true } };
  });
  wx.env = { USER_DATA_PATH: '/device' };
  wx.getFileSystemManager = () => ({ readFile() { assert.fail('must not serialize photos'); }, stat: options => options.success({ stats: { size: 3 } }), readdirSync: () => [], copyFile(options) { options.success(); } });
  wx.cloud.uploadFile = async options => { uploads.push(options); return { fileID: 'cloud://env/private/photo.jpg' }; };
  assert.equal(await app.uploadCloudImage('/source.jpg', { cardPath: '/source-card.jpg' }), 'cloud://env/approved/direct.bin');
  assert.deepEqual(uploads.map(({ cloudPath, filePath }) => ({ cloudPath, filePath })), [{ cloudPath: 'private/photo.jpg', filePath: '/source.jpg' }]);
  assert.equal(typeof uploads[0].success, 'function');
  assert.equal(typeof uploads[0].fail, 'function');
  assert.equal(app.calls.length, 2);
  assert.match(app.resolveImage('cloud://env/approved/direct.bin'), /^\/device\//);
  rejected = true;
  await assert.rejects(app.uploadCloudImage('/source.jpg'), /图片格式不支持/);
  assert.equal(app.calls.length, 4);
});

test('photo and avatar RPC payloads stay below 1 KiB even with a stricter WeChat bridge limit', async () => {
  const uploads = [];
  const app = await client(async data => {
    if (Buffer.byteLength(JSON.stringify(data)) > 100 * 1024) throw { errMsg: 'cloud.callFunction:fail Error: data exceed max size' };
    assert.ok(Buffer.byteLength(JSON.stringify(data)) < 1024);
    assert.equal(data.base64, undefined);
    if (data.action.endsWith('Ticket')) return { ok: true, data: { id: 'ticket', path: 'private/large.jpg' } };
    return { ok: true, data: { fileId: 'cloud://env/approved/photo.bin', protected: true } };
  });
  wx.env = { USER_DATA_PATH: '/device' };
  wx.getFileSystemManager = () => ({ readFile() { assert.fail('base64 upload is forbidden'); }, stat: options => options.success({ stats: { size: 480 * 1024 } }), readdirSync: () => [], copyFile: options => options.success() });
  wx.cloud.uploadFile = async options => { uploads.push(options); return { fileID: 'cloud://env/private/large.jpg' }; };
  assert.equal(await app.uploadCloudImage('/cover.jpg'), 'cloud://env/approved/photo.bin');
  app.cloudStatus.value = { phase: 'onboarding', userId: 'alice', familyId: '' };
  assert.equal(await app.uploadProfileAvatar('/avatar.jpg'), 'cloud://env/approved/photo.bin');
  assert.deepEqual(uploads.map(item => item.filePath), ['/cover.jpg', '/avatar.jpg']);
  assert.deepEqual(app.calls.map(item => item.action), ['mediaTicket', 'mediaConfirm', 'profileMediaTicket', 'profileMediaConfirm']);
});

test('profile uploads forward real transfer progress and wait for server confirmation before resolving', async () => {
  const stages = [];
  let confirm;
  let resolved = false;
  const app = await client(async data => {
    if (data.action === 'profileMediaTicket') return { ok: true, data: { id: 'avatar-ticket', path: 'private/avatar.jpg' } };
    assert.equal(data.action, 'profileMediaConfirm');
    assert.equal(data.ticket, 'avatar-ticket');
    return new Promise(resolve => { confirm = resolve; });
  });
  wx.cloud.uploadFile = options => {
    queueMicrotask(() => options.success({ fileID: 'cloud://env/private/avatar.jpg' }));
    return { onProgressUpdate(listener) { listener({ progress: 37 }); listener({ progress: 100 }); } };
  };
  const pending = app.uploadProfileAvatar('/avatar.jpg', { onStage: stage => stages.push(stage) }).then(fileId => { resolved = true; return fileId; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(stages, [{ status: 'uploading', progress: 37 }, { status: 'uploading', progress: 100 }, { status: 'saving' }]);
  assert.equal(resolved, false);
  confirm({ ok: true, data: { fileId: 'cloud://env/approved/avatar.bin', protected: true } });
  assert.equal(await pending, 'cloud://env/approved/avatar.bin');
  assert.equal(resolved, true);
});

test('new family covers use private request-scoped uploads without changing the active family', async () => {
  const requestId = 'family-cover-client-001';
  const uploads = [];
  const stages = [];
  const app = await client(async data => {
    assert.equal(data.requestId, requestId);
    assert.equal(data.familyId, undefined);
    if (data.action === 'familyCoverTicket') return { ok: true, data: { id: 'draft-ticket', path: 'private/draft.jpg', previewPath: 'private/draft-preview.jpg' } };
    assert.equal(data.action, 'familyCoverConfirm');
    assert.equal(data.previewFileId, 'cloud://env/private/draft-preview.jpg');
    return { ok: true, data: { fileId: 'cloud://env/approved/draft.bin', protected: true } };
  });
  wx.cloud.uploadFile = async options => { uploads.push(options.filePath); return { fileID: `cloud://env/${options.cloudPath}` }; };
  assert.equal(await app.uploadFamilyCoverDraft('/original.jpg', requestId, { previewPath: '/cropped.jpg', onStage: stage => stages.push(stage) }), 'cloud://env/approved/draft.bin');
  assert.deepEqual(uploads, ['/original.jpg', '/cropped.jpg']);
  assert.deepEqual(app.calls.map(item => item.action), ['familyCoverTicket', 'familyCoverConfirm']);
  assert.equal(stages.at(-1).status, 'saving');
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.accountProfile.value.avatar, '');
});

test('family cover uploads reject completion after switching accounts', async () => {
  const app = await client(async data => data.action === 'familyCoverTicket' ? { ok: true, data: { id: 'draft-ticket', path: 'private/draft.jpg' } } : { ok: true, data: { fileId: 'cloud://env/approved/draft.bin', protected: true } });
  wx.cloud.uploadFile = async () => { app.cloudStatus.value.userId = 'another-user'; return { fileID: 'cloud://env/private/draft.jpg' }; };
  await assert.rejects(app.uploadFamilyCoverDraft('/photo.jpg', 'family-cover-client-002'), /登录状态已变更/);
});

test('family appearance creation uses its dedicated action so older servers cannot silently drop the cover or title', async () => {
  const app = await client(async () => ({ ok: false, code: 'INVALID', message: '请更新家庭服务后重试' }));
  await assert.rejects(app.manageFamily('createFamily', { familyName: '新家', cover: '', coverTitle: '一起吃饭', requestId: 'family-create-version-001' }), /请更新家庭服务/);
  assert.deepEqual(app.calls.map(item => item.action), ['createFamilyWithAppearance']);
  assert.equal(app.calls[0].coverTitle, '一起吃饭');
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.cloudStatus.value.busy, false);
});

test('subtitle-aware saves update family copy immediately and retain it in the durable cache', async () => {
  const storage = new Map();
  const appearance = { name: '新的小家', cover: '', coverTitle: '都是我喜欢的味道！', coverSubtitle: '一日三餐四季，都要好好吃饭' };
  const app = await client(async data => {
    assert.equal(data.name, 'customizeFamilyWithSubtitle');
    assert.deepEqual(data.args, [appearance]);
    return { ok: true, data: { familyId: 'family-1', userId: 'alice', baseRevision: 1, revision: 2, changes: { family: { ...emptySnapshot().family, ...appearance } }, value: 'saved' } };
  }, { storage });
  const recipes = app.state.value.recipes;
  assert.equal(await app.remoteAction('customizeFamily', [appearance]), 'saved');
  assert.equal(app.state.value.family.coverTitle, appearance.coverTitle);
  assert.equal(app.state.value.family.coverSubtitle, appearance.coverSubtitle);
  assert.equal(app.state.value.recipes, recipes);
  app.flushCloudCache();
  const saved = JSON.parse(storage.get('shiyuan-snapshot-v1-units2-test-only-kitchen')).entries[0][1].value;
  assert.equal(saved.snapshot.family.coverSubtitle, appearance.coverSubtitle);
  assert.equal(saved.revision, 2);
});

test('older cloud functions cannot silently accept and discard the new subtitle', async () => {
  const appearance = { name: '我们的小家', cover: '', coverTitle: '想吃的都在这里', coverSubtitle: '一起来吃饭' };
  const app = await client(async data => ({ ok: false, code: 'INVALID', message: data.action === 'command' ? '不支持的操作' : '不支持的请求' }));
  const before = JSON.stringify(app.state.value);
  await assert.rejects(app.remoteAction('customizeFamily', [appearance]), /请更新家庭服务后再保存主副标题/);
  assert.deepEqual(app.calls.map(item => item.name), ['customizeFamilyWithSubtitle']);
  assert.equal(JSON.stringify(app.state.value), before);
  assert.equal(app.cloudStatus.value.busy, false);
  await app.dismissMutation(app.mutationStatus.value.failures[0].id);
  await assert.rejects(app.manageFamily('createFamily', { familyName: appearance.name, ...appearance, requestId: 'subtitle-client-create-001' }), /请更新家庭服务后再创建带主副标题的小家/);
  assert.deepEqual(app.calls.map(item => item.action), ['command', 'createFamilyWithSubtitle']);
  assert.equal(JSON.stringify(app.state.value), before);
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.cloudStatus.value.busy, false);
});

test('file transfer failures never confirm or fall back to base64 and keep error text understandable', async () => {
  const app = await client(async data => {
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket', path: 'private/large.jpg' } };
    assert.equal(data.action, 'mediaConfirm');
    return { ok: true, data: { fileId: 'cloud://env/approved/large.bin', protected: true } };
  });
  wx.env = { USER_DATA_PATH: '/device' };
  wx.getFileSystemManager = () => ({ stat: options => options.success({ stats: { size: 480000 } }), readdirSync: () => [], copyFile(options) { options.success(); } });
  wx.cloud.uploadFile = async () => ({ fileID: 'cloud://env/private/large.jpg' });
  await app.uploadCloudImage('/large.jpg');
  assert.deepEqual(app.calls.map(item => item.action), ['mediaTicket', 'mediaConfirm']);
  wx.cloud.uploadFile = async () => { throw { errMsg: 'uploadFile:fail no such file or directory' }; };
  await assert.rejects(app.uploadCloudImage('/missing.jpg'), /无法读取/);
  assert.equal(app.calls.length, 3);
  wx.cloud.uploadFile = async () => { throw { errMsg: 'uploadFile:fail network timeout (trace: something)' }; };
  await assert.rejects(app.uploadCloudImage('/offline.jpg'), error => /检查网络/.test(error.message) && !/trace|uploadFile/.test(error.message));
  assert.equal(app.calls.length, 4);
});

test('a local cache failure does not turn a confirmed upload into another download or a failed save', async () => {
  const app = await client(async data => {
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket', path: 'private/photo.jpg' } };
    assert.equal(data.action, 'mediaConfirm');
    return { ok: true, data: { fileId: 'cloud://env/approved/photo.bin', protected: true } };
  });
  wx.cloud.uploadFile = async () => ({ fileID: 'cloud://env/private/photo.jpg' });
  wx.getFileSystemManager = () => ({ stat: options => options.fail({ errMsg: 'ENOSPC' }) });
  assert.equal(await app.uploadCloudImage('/photo.jpg'), 'cloud://env/approved/photo.bin');
  assert.deepEqual(app.calls.map(item => item.action), ['mediaTicket', 'mediaConfirm']);
});

test('a family switch during file transfer cannot return the photo to the wrong editor', async () => {
  const app = await client(async data => data.action === 'mediaTicket' ? { ok: true, data: { id: 'ticket', path: 'private/photo.jpg' } } : { ok: true, data: { fileId: 'cloud://env/approved/photo.bin', protected: true } });
  wx.cloud.uploadFile = async () => { app.cloudStatus.value.familyId = 'family-2'; return { fileID: 'cloud://env/private/photo.jpg' }; };
  await assert.rejects(app.uploadCloudImage('/photo.jpg'), /家庭已变更/);
  assert.ok(app.calls.every(item => item.familyId === 'family-1'));
});

test('background refreshes deduplicate and a manual sync still requests the full snapshot', async () => {
  const finish = [];
  const app = await client(() => new Promise(resolve => finish.push(resolve)));
  const first = app.refreshCloud({ background: true });
  const second = app.refreshCloud({ background: true });
  assert.equal(first, second);
  const manual = app.refreshCloud();
  assert.equal(app.calls.length, 1);
  finish[0]({ ok: true, data: { unchanged: true, familyId: 'family-1', revision: 1 } });
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].knownRevision, undefined);
  finish[1]({ ok: true, data: snapshot() });
  await manual;
  app.cloudStatus.value.busy = true;
  await app.refreshCloud({ background: true });
  assert.equal(app.calls.length, 2);
});

test('new approved uploads reuse a private local copy and never refetch the uploaded photo', async () => {
  const fileId = 'cloud://env/approved/image.bin';
  const copies = [];
  let rejected = false;
  const app = await client(async data => {
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket', path: 'private/alice/photo.jpg' } };
    if (data.action === 'mediaConfirm') return rejected ? { ok: false, code: 'IMAGE_FORMAT', message: '图片格式不支持' } : { ok: true, data: { fileId, protected: true } };
    throw new Error('unexpected extra cloud request');
  });
  wx.env = { USER_DATA_PATH: '/private-device' };
  wx.getFileSystemManager = () => ({ readdirSync: () => [], stat: options => options.success({ stats: { size: 120000 } }), copyFile(options) { copies.push(options); options.success(); }, unlink: options => options.success() });
  wx.cloud.uploadFile = async () => ({ fileID: 'cloud://env/private/alice/photo.jpg' });
  assert.equal(await app.uploadCloudImage('/selected.jpg', { cardPath: '/selected-card.jpg' }), fileId);
  assert.deepEqual(app.calls.map(entry => entry.action), ['mediaTicket', 'mediaConfirm']);
  assert.equal(copies[0].srcPath, '/selected-card.jpg');
  assert.equal(app.resolveImage(fileId), copies[0].destPath);
  rejected = true;
  await assert.rejects(app.uploadCloudImage('/unapproved.jpg'), /图片格式不支持/);
  assert.equal(copies.length, 1);
});

test('cloud client retains uncertain IDs and holds subsequent commands until explicit retry', async () => {
  let fail = true;
  const app = await client(async data => {
    if (data.name === 'addStock' && fail) throw new Error('network lost after commit');
    return { ok: true, data: { ...snapshot(2), value: 'saved' } };
  });
  const first = app.remoteAction('addStock', [stockBatch]);
  assert.equal(first.accepted, true);
  await assert.rejects(first, /network/);
  const later = app.remoteAction('setChef', [true]);
  assert.equal(later.accepted, true);
  assert.equal(app.calls.length, 1);
  assert.equal(app.mutationStatus.value.failures[0].status, 'uncertain');
  await assert.rejects(app.dismissMutation(first.operationId), /不能放弃/);
  fail = false;
  assert.equal(await app.retryMutation(first.operationId), 'saved');
  await later;
  assert.equal(app.calls[0].requestId, app.calls[1].requestId);
  assert.equal(app.calls[0].revision, app.calls[1].revision);
  assert.equal(app.cloudStatus.value.busy, false);
});

test('cloud client admits rapid saves, projects immediately and serializes confirmed revisions', async () => {
  const finishes = [];
  const app = await client(() => new Promise(resolve => { finishes.push(resolve); }));
  const saving = app.remoteAction('setChef', [true]);
  const second = app.remoteAction('setChef', [false]);
  assert.equal(saving.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(app.cloudStatus.value.busy, false);
  assert.equal(app.cloudStatus.value.syncing, true);
  assert.equal(app.state.value.family.members[0].isChef, false);
  assert.equal(app.calls.length, 1);
  const confirmed = snapshot(2);
  confirmed.snapshot.family.members[0].isChef = true;
  finishes[0]({ ok: true, data: confirmed });
  await saving;
  assert.equal(app.cloudStatus.value.revision, 2);
  assert.equal(app.state.value.family.members[0].isChef, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].revision, 2);
  finishes[1]({ ok: true, data: snapshot(3) });
  await second;
  assert.equal(app.commandQueueStatus.value.pendingCount, 0);
});

test('unrelated revision conflicts refresh and rebase once with the same request identity', async () => {
  let stale = true;
  const app = await client(async data => {
    if (data.action === 'command' && stale) { stale = false; return { ok: false, code: 'CONFLICT', message: '家人已更新' }; }
    return { ok: true, data: snapshot(data.action === 'command' ? 6 : 5) };
  });
  await app.remoteAction('setChef', [true]);
  assert.equal(app.calls[1].action, 'bootstrap');
  assert.equal(app.cloudStatus.value.revision, 6);
  assert.equal(app.calls[0].requestId, app.calls[2].requestId);
  assert.equal(app.calls[2].revision, 5);
});

test('duplicate sharing refreshes authoritative status without silently retrying the publish', async () => {
  const result = snapshot(5);
  result.snapshot.sharedItems = [{ itemId: 'dish-1', kind: 'dish', postId: 'already-published' }];
  const app = await client(async data => data.action === 'command' ? { ok: false, code: 'ALREADY_SHARED', message: '这道菜品已分享' } : { ok: true, data: result });
  app.state.value.recipes = [{ ...createSeed().recipes[0], id: 'dish-1' }];
  await assert.rejects(app.remoteAction('publishToCommunity', ['dish-1', 'dish']), error => error.code === 'ALREADY_SHARED');
  assert.deepEqual(app.calls.map(call => call.action), ['command', 'bootstrap']);
  assert.deepEqual(app.state.value.sharedItems, result.snapshot.sharedItems);
  assert.equal(app.cloudStatus.value.busy, false);
  assert.equal(app.cloudStatus.value.revision, 5);
});

test('bootstrap requests missing publication metadata for old caches, then reuses the saved summary', async () => {
  const result = snapshot();
  result.snapshot.sharedItems = [{ itemId: 'menu-1', kind: 'set', postId: 'shared-menu' }];
  const app = await client(async () => ({ ok: true, data: result }));
  await app.cloudCall('bootstrap', { knownFamilyId: 'family-1', knownRevision: 1 });
  assert.equal(app.calls[0].includeSharedItems, true);
  await app.cloudCall('bootstrap', { knownFamilyId: 'family-1', knownRevision: 1 });
  assert.equal(app.calls[1].includeSharedItems, false);
  assert.deepEqual(app.state.value.sharedItems, result.snapshot.sharedItems);
});

test('deleting a share removes only its publication status and keeps all other family statuses', async () => {
  const app = await client(async () => ({ ok: true, data: { familyId: 'family-1', userId: 'alice', baseRevision: 1, revision: 2, changes: { family: emptySnapshot().family }, postChanges: { upsert: [], remove: ['post-1'] } } }));
  app.state.value.sharedItems = [{ itemId: 'dish-1', kind: 'dish', postId: 'post-1' }, { itemId: 'menu-1', kind: 'set', postId: 'post-2' }];
  await app.remoteAction('deleteCommunityPost', ['post-1']);
  assert.deepEqual(app.state.value.sharedItems, [{ itemId: 'menu-1', kind: 'set', postId: 'post-2' }]);
});

test('revocation clears visible private data, but an ordinary forbidden action does not sign out', async () => {
  let code = 'FORBIDDEN';
  const app = await client(async () => ({ ok: false, code, message: '没有权限' }));
  await assert.rejects(app.remoteAction('deleteCommunityPost', ['post-1']));
  assert.equal(app.cloudStatus.value.phase, 'ready');
  code = 'NO_FAMILY';
  await assert.rejects(app.cloudCall('bootstrap'));
  assert.equal(app.cloudStatus.value.phase, 'onboarding');
  assert.equal(app.cloudStatus.value.familyId, '');
  assert.deepEqual(app.state.value.recipes, []);
});

test('older bootstrap responses cannot replace newer state and refresh preserves loaded comments', async () => {
  const finish = [];
  const app = await client(() => new Promise(resolve => finish.push(resolve)));
  app.state.value.comments = [{ id: 'comment-1' }];
  const first = app.cloudCall('bootstrap');
  const second = app.cloudCall('bootstrap');
  finish[1]({ ok: true, data: snapshot(4) });
  await second;
  finish[0]({ ok: true, data: snapshot(3) });
  await first;
  assert.equal(app.cloudStatus.value.revision, 4);
  assert.equal(app.state.value.comments[0].id, 'comment-1');
});

test('uncertain internal failures keep their retry key and cloud media uses only approved ID', async () => {
  let failed = true;
  const app = await client(async data => {
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket-1', path: 'private/alice/test.jpg' } };
    if (data.action === 'mediaConfirm') return { ok: true, data: { fileId: 'cloud://env/approved/family/test.jpg' } };
    if (data.action === 'mediaUrl') return { ok: true, data: { media: { [data.fileId]: 'signed-url' } } };
    return failed ? { ok: false, code: 'INTERNAL', message: '未知结果' } : { ok: true, data: snapshot(2) };
  });
  const first = app.remoteAction('addStock', [stockBatch]);
  await assert.rejects(first);
  failed = false;
  await app.retryMutation(first.operationId);
  assert.equal(app.calls[0].requestId, app.calls[1].requestId);
  wx.cloud.uploadFile = async () => ({ fileID: 'cloud://env/private/alice/test.jpg' });
  wx.getFileSystemManager = () => ({});
  assert.equal(await app.uploadCloudImage('/temp.jpg'), 'cloud://env/approved/family/test.jpg');
  assert.equal(app.calls.at(-1).fileId, 'cloud://env/approved/family/test.jpg');
});

test('protected cloud photos are downloaded through authenticated content and cached in private device files', async () => {
  const fileId = 'cloud://env/approved/family/encrypted.bin';
  const removed = [];
  const writes = [];
  const app = await client(async data => {
    if (data.action === 'mediaTicket') return { ok: true, data: { id: 'ticket', path: 'private/alice/image.jpg' } };
    if (data.action === 'mediaConfirm') return { ok: true, data: { fileId } };
    if (data.action === 'mediaUrl') return { ok: true, data: { media: { [fileId]: { protected: true } } } };
    if (data.action === 'mediaContent') return { ok: true, data: { base64: 'cGhvdG8=', contentType: 'image/jpeg' } };
    if (data.action === 'mediaBatch') return { ok: true, data: { images: data.images.map(() => ({ ok: true, data: { base64: 'cGhvdG8=', contentType: 'image/jpeg' } })) } };
    return { ok: true, data: { needsFamily: true } };
  });
  wx.env = { USER_DATA_PATH: '/private-device' };
  wx.getFileSystemManager = () => ({
    readdirSync: () => ['shiyuan-photo-123-1.jpg', 'unrelated.txt'],
    unlink: ({ filePath, success }) => { removed.push(filePath); success(); },
    writeFile(options) { writes.push(options); options.success(); },
  });
  wx.cloud.uploadFile = async () => ({ fileID: 'cloud://env/private/alice/image.jpg' });
  assert.equal(await app.uploadCloudImage('/selected.jpg'), fileId);
  assert.equal(app.calls.at(-1).action, 'mediaBatch');
  assert.match(app.resolveImage(fileId), /^\/private-device\/shiyuan-cache-photo-[\d-]+\.jpg$/);
  assert.equal(writes[0].encoding, 'base64');
  assert.equal(writes[0].data, 'cGhvdG8=');
  assert.deepEqual(removed, ['/private-device/shiyuan-photo-123-1.jpg']);
  await app.cloudCall('bootstrap');
  assert.equal(app.cloudStatus.value.phase, 'onboarding');
  assert.deepEqual(app.mediaUrls.value, {});
  assert.ok(removed.includes(writes[0].filePath));
});

test('display rendering batches thumbnails, caches by size and only downloads an original when explicitly opened', async () => {
  const app = await client(async data => {
    if (data.action === 'mediaBatch') return { ok: true, data: { images: data.images.map(request => ({ ok: true, data: { base64: 'cGhvdG8=', contentType: 'image/jpeg', version: `${request.fileId}#display-${request.variant}-v1` } })) } };
    if (data.action === 'mediaContent') return { ok: true, data: { base64: 'b3JpZ2luYWw=', contentType: 'image/jpeg', version: data.fileId } };
    return { ok: true, data: { needsFamily: true } };
  });
  wx.env = { USER_DATA_PATH: '/private-device' };
  const disk = new Map();
  wx.getFileSystemManager = () => ({ readdirSync: () => [], stat: options => disk.has(options.path) ? options.success({ stats: { size: disk.get(options.path) } }) : options.fail({ errMsg: 'ENOENT' }), statSync: path => { if (!disk.has(path)) throw new Error('ENOENT'); return { size: disk.get(path) }; }, writeFile: options => { disk.set(options.filePath, Buffer.from(options.data, 'base64').length); options.success(); }, unlink: options => { disk.delete(options.filePath); options.success(); } });
  const ids = Array.from({ length: 6 }, (_, index) => `cloud://env/approved/${index}.bin`);
  ids.forEach(id => assert.equal(app.resolveImage(id), ''));
  const paths = await Promise.all(ids.map(id => app.loadImage(id, 'card')));
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].action, 'mediaBatch');
  assert.equal(app.calls[0].images.length, 6);
  ids.forEach((id, index) => assert.equal(app.resolveImage(id), paths[index]));
  await app.loadImage(ids[0], 'detail');
  assert.equal(app.calls[1].images[0].variant, 'detail');
  await app.loadImage(ids[0]);
  assert.equal(app.calls.length, 2, 'implicit image loads reuse the thumbnail and never fetch the original');
  await app.loadImage(ids[0], 'original');
  assert.equal(app.calls[2].action, 'mediaContent');
  assert.equal(app.calls[2].variant, 'original');
  assert.equal(app.calls.filter(call => call.action === 'mediaContent').length, 1);
  await app.loadImage(ids[0], 'original');
  assert.equal(app.calls.length, 3);
  assert.equal(app.resolveImage(ids[0], 'card'), paths[0], 'opening an original must not replace card thumbnails');
  disk.delete(paths[0]);
  const recovered = await app.loadImage(ids[0], 'card');
  assert.notEqual(recovered, paths[0]);
  assert.equal(app.calls.length, 4);
  assert.equal(app.calls[3].images[0].knownVersion, '');
  assert.equal(app.resolveImage(ids[0], 'card'), recovered);
});

function privateSnapshot(userId = 'alice') {
  const result = snapshot(7);
  result.userId = userId;
  result.snapshot.family.id = result.familyId;
  result.snapshot.family.members = [{ id: userId, name: '我' }];
  result.snapshot.activeMemberId = userId;
  result.snapshot.recipes = [{ id: 'recipe', title: '番茄炒蛋' }];
  return result;
}

function inlineImage(fileId = 'cloud://inline-photo') {
  return { fileId, variant: 'card', version: `${fileId}#display-card-v1`, url: 'https://storage.example.test/photo', urlExpiresAt: Date.now() + 300000, bytes: 8, contentType: 'image/jpeg' };
}

function nativeImageDisk() {
  const disk = new Map();
  wx.env = { USER_DATA_PATH: '/private-device' };
  wx.downloadFile = options => { disk.set('/tmp/photo.jpg', 8); options.success({ statusCode: 200, tempFilePath: '/tmp/photo.jpg' }); };
  wx.getFileSystemManager = () => ({
    readdirSync: () => [],
    stat: options => options.success({ stats: { size: disk.get(options.path) } }),
    copyFile: options => { disk.set(options.destPath, disk.get(options.srcPath)); options.success(); },
    unlink: options => { disk.delete(options.filePath); options.success(); },
  });
  return disk;
}

test('feed and detail consume inline image manifests without another cloud authorization or persisting signed URLs', async () => {
  const app = await client(async data => {
    assert.ok(['feed', 'readPost'].includes(data.action));
    assert.equal(data.includeImageManifests, true);
    return { ok: true, data: { posts: [], imageManifests: [inlineImage()] } };
  });
  nativeImageDisk();
  for (const action of ['feed', 'readPost']) {
    const result = await app.invokeCloud(action);
    assert.equal(result.imageManifests, undefined);
    assert.ok(await app.loadImage('cloud://inline-photo', 'card'));
  }
  assert.deepEqual(app.calls.map(call => call.action), ['feed', 'readPost']);
});

test('a rejected inline URL is discarded before retrying with fresh cloud authorization', async () => {
  const original = inlineImage();
  const refreshed = { ...original, url: 'https://storage.example.test/refreshed-photo' };
  const app = await client(async data => {
    if (data.action === 'feed') return { ok: true, data: { posts: [], imageManifests: [original] } };
    assert.equal(data.action, 'mediaBatch');
    assert.equal(data.images.length, 1);
    assert.equal(data.images[0].fileId, original.fileId);
    assert.equal(data.images[0].knownVersion, '');
    return { ok: true, data: { images: [{ ok: true, data: refreshed }] } };
  });
  const disk = nativeImageDisk();
  const downloads = [];
  wx.downloadFile = options => {
    downloads.push(options.url);
    if (options.url === original.url) return options.success({ statusCode: 403 });
    disk.set('/tmp/refreshed-photo.jpg', original.bytes);
    options.success({ statusCode: 200, tempFilePath: '/tmp/refreshed-photo.jpg' });
  };
  await app.invokeCloud('feed');
  const path = await app.loadImage(original.fileId, 'card');
  assert.equal(disk.get(path), original.bytes);
  assert.deepEqual(downloads, [original.url, refreshed.url]);
  assert.deepEqual(app.calls.map(call => call.action), ['feed', 'mediaBatch']);
  assert.equal(app.mediaFailures.value[original.version], undefined);
});

test('cold bootstrap registers manifests only after the verified identity activates the media cache', async () => {
  const app = await client(async () => ({ ok: true, data: { ...privateSnapshot(), imageManifests: [inlineImage()] } }), { cold: true });
  nativeImageDisk();
  await app.refreshCloud({ background: true });
  assert.equal(app.calls[0].includeImageManifests, true);
  assert.ok(await app.loadImage('cloud://inline-photo', 'card'));
  assert.equal(app.calls.length, 1);
});

test('late feed manifests cannot cross a family change or revive a cleared image context', async () => {
  let finishFeed;
  const result = new Promise(resolve => { finishFeed = resolve; });
  const app = await client(async data => {
    if (data.action === 'feed') return result;
    if (data.action === 'bootstrap') return { ok: true, data: { ...privateSnapshot(), familyId: 'family-2' } };
    assert.equal(data.action, 'mediaBatch');
    return { ok: true, data: { images: [{ ok: false, code: 'FORBIDDEN', message: '无权查看图片' }] } };
  });
  nativeImageDisk();
  const loading = app.invokeCloud('feed');
  await app.cloudCall('bootstrap');
  finishFeed({ ok: true, data: { posts: [], imageManifests: [inlineImage()] } });
  await loading;
  await assert.rejects(app.loadImage('cloud://inline-photo', 'card'), { code: 'FORBIDDEN' });
  assert.deepEqual(app.calls.map(call => call.action), ['feed', 'bootstrap', 'mediaBatch']);
});

test('cold restart reuses durable family data only after verifying user, family and revision', async () => {
  const storage = new Map();
  const initial = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
  await initial.refreshCloud({ background: true });
  initial.flushCloudCache();
  assert.equal(storage.has('shiyuan-snapshot-v1-units2-test-only-kitchen'), true);
  let finish;
  const restarted = await client(() => new Promise(resolve => { finish = resolve; }), { storage, cold: true });
  assert.deepEqual(restarted.state.value.recipes, []);
  const loading = restarted.refreshCloud({ background: true });
  assert.equal(restarted.calls[0].knownFamilyId, 'family-1');
  assert.equal(restarted.calls[0].knownRevision, 7);
  assert.deepEqual(restarted.state.value.recipes, []);
  finish({ ok: true, data: { unchanged: true, familyId: 'family-1', userId: 'alice', revision: 7 } });
  await loading;
  assert.equal(restarted.state.value.recipes[0].title, '番茄炒蛋');
  assert.equal(restarted.cloudStatus.value.phase, 'ready');
  assert.equal(restarted.calls.length, 1);
  restarted.flushCloudCache();
});

test('same family but another authenticated member does not see a previous user snapshot', async () => {
  const storage = new Map();
  const initial = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
  await initial.refreshCloud({ background: true });
  initial.flushCloudCache();
  const restarted = await client(async data => ({ ok: true, data: data.knownRevision ? { unchanged: true, familyId: 'family-1', userId: 'bob', revision: 7 } : privateSnapshot('bob') }), { storage, cold: true });
  await restarted.refreshCloud({ background: true });
  assert.equal(restarted.calls.length, 2);
  assert.equal(restarted.calls[1].knownRevision, undefined);
  assert.equal(restarted.state.value.activeMemberId, 'bob');
  restarted.flushCloudCache();
});

test('new unit clients do not reuse legacy amount projections from a previous cache namespace', async () => {
  const storage = new Map();
  const initial = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
  await initial.refreshCloud({ background: true });
  initial.flushCloudCache();
  storage.set('shiyuan-snapshot-v1-test-only-kitchen', storage.get('shiyuan-snapshot-v1-units2-test-only-kitchen'));
  storage.delete('shiyuan-snapshot-v1-units2-test-only-kitchen');
  const restarted = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
  await restarted.refreshCloud({ background: true });
  assert.equal(restarted.calls[0].ingredientUnitsVersion, 2);
  assert.equal(restarted.calls[0].knownRevision, undefined);
  restarted.flushCloudCache();
});

test('revoked or unauthenticated users cannot restore cached family data and durable state is removed', async () => {
  for (const code of ['NO_FAMILY', 'UNAUTHENTICATED']) {
    const storage = new Map();
    const initial = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
    await initial.refreshCloud({ background: true }); initial.flushCloudCache();
    const restarted = await client(async () => ({ ok: false, code, message: '权限已失效' }), { storage, cold: true });
    await assert.rejects(restarted.refreshCloud({ background: true }), /权限/);
    assert.deepEqual(restarted.state.value.recipes, []);
    assert.equal(storage.has('shiyuan-snapshot-v1-units2-test-only-kitchen'), false);
    assert.equal(restarted.cloudStatus.value.familyId, '');
  }
});

test('a corrupt snapshot starts with a full refresh and rapid foregrounding skips duplicate background refreshes', async () => {
  const storage = new Map([['shiyuan-snapshot-v1-units2-test-only-kitchen', 'invalid']]);
  const app = await client(async () => ({ ok: true, data: privateSnapshot() }), { storage, cold: true });
  await app.refreshCloud({ background: true });
  assert.equal(app.calls[0].knownRevision, undefined);
  await app.refreshCloud({ background: true });
  await app.refreshCloud({ background: true });
  assert.equal(app.calls.length, 1);
  await app.refreshCloud();
  assert.equal(app.calls.length, 2);
  app.flushCloudCache();
});

test('confirmed family edits persist the new revision and detail mutations invalidate reopen caches', async () => {
  const storage = new Map();
  const app = await client(async data => ({ ok: true, data: data.action === 'readPost' ? { post: { id: 'post', recipes: [] }, comments: [] } : data.action === 'command' ? { familyId: 'family-1', userId: 'alice', baseRevision: 7, revision: 8, changes: { family: { ...privateSnapshot().snapshot.family, name: '新名称' } } } : privateSnapshot() }), { storage, cold: true });
  await app.refreshCloud({ background: true });
  await app.readCommunityPost('post');
  await app.readCommunityPost('post');
  assert.equal(app.calls.filter(call => call.action === 'readPost').length, 1);
  await app.remoteAction('addComment', ['post', '好吃']);
  assert.equal(app.peekCommunityPost('post'), undefined);
  await app.readCommunityPost('post');
  assert.equal(app.calls.filter(call => call.action === 'readPost').length, 2);
  app.flushCloudCache();
  const saved = JSON.parse(storage.get('shiyuan-snapshot-v1-units2-test-only-kitchen')).entries[0][1].value;
  assert.equal(saved.revision, 8);
  assert.equal(saved.snapshot.family.name, '新名称');
  assert.deepEqual(saved.snapshot.posts, []);
  app.flushCloudCache();
});

test('food detail caches separate comments-disabled reads from full reads without discarding saved comments', async () => {
  const comment = { id: 'comment', postId: 'post', text: '保留的评论' };
  const app = await client(async data => ({ ok: true, data: data.action === 'readPost' ? { post: { id: 'post', recipes: [] }, comments: data.includeComments === false ? [] : [comment], commentCursor: '', media: {} } : privateSnapshot() }), { cold: true });
  await app.cloudCall('bootstrap');
  const hidden = { includeComments: false };
  assert.deepEqual((await app.readCommunityPost('post', hidden)).comments, []);
  assert.equal(app.peekCommunityPost('post'), undefined);
  await app.readCommunityPost('post', hidden);
  assert.equal(app.calls.filter(call => call.action === 'readPost').length, 1);
  const full = await app.readCommunityPost('post');
  assert.equal(full.comments[0].text, comment.text);
  const reads = app.calls.filter(call => call.action === 'readPost');
  assert.deepEqual(reads.map(call => call.includeComments), [false, true]);
  assert.deepEqual(app.peekCommunityPost('post', hidden).comments, []);
  assert.equal(app.peekCommunityPost('post').comments[0].text, comment.text);
  app.flushCloudCache();
});

test('guest share image scopes stay isolated when onboarding creates a household', async () => {
  const storage = new Map();
  const app = await client(async data => ({ ok: true, data: data.action === 'createFamily' ? privateSnapshot() : { needsFamily: true, userId: 'alice', profile: { name: '我', avatar: '' } } }), { storage, cold: true });
  await app.cloudCall('bootstrap');
  const token = 'a'.repeat(48);
  app.setShareMediaToken(token);
  await app.manageFamily('createFamily', { familyName: '家', requestId: 'create-client-001' });
  app.flushCloudCache();
  const saved = () => JSON.parse(storage.get('shiyuan-image-index-v1')).entries[0][1].value;
  assert.equal(saved().scope, `test-only:kitchen:alice:family-1:share:${token}`);
  app.setShareMediaToken();
  app.flushCloudCache();
  assert.equal(saved().scope, 'test-only:kitchen:alice:family-1');
  assert.deepEqual(saved().entries, []);
});

test('invitation image access only accompanies media reads and has an isolated cache scope', async () => {
  const storage = new Map();
  const app = await client(async () => ({ ok: true, data: {} }), { storage });
  const token = 'b'.repeat(48);
  app.setInviteMediaToken(token);
  await app.invokeCloud('readInvite', { token });
  assert.equal(app.calls.at(-1).inviteToken, undefined);
  await app.invokeCloud('mediaContent', { fileId: 'cloud://env/cover', variant: 'detail' });
  assert.equal(app.calls.at(-1).inviteToken, token);
  app.flushCloudCache();
  const saved = () => JSON.parse(storage.get('shiyuan-image-index-v1')).entries[0][1].value;
  assert.equal(saved().scope, `test-only:kitchen:alice:family-1:invite:${token}`);
  app.setInviteMediaToken();
  app.flushCloudCache();
  assert.equal(saved().scope, 'test-only:kitchen:alice:family-1');
  await app.invokeCloud('mediaContent', { fileId: 'cloud://env/cover', variant: 'detail' });
  assert.equal(app.calls.at(-1).inviteToken, undefined);
});

test('family switches wait for an in-flight refresh and block simultaneous writes', async () => {
  let finish;
  const app = await client(data => data.action === 'bootstrap' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, data: { ...snapshot(), familyId: 'family-2' } }));
  const refresh = app.refreshCloud();
  const change = app.manageFamily('switchFamily', { familyId: 'family-2' });
  await assert.rejects(app.remoteAction('setChef', [true]), /正在保存/);
  assert.equal(app.calls.length, 1);
  finish({ ok: true, data: snapshot() });
  await refresh;
  await change;
  assert.equal(app.calls[1].familyId, 'family-2');
  assert.equal(app.cloudStatus.value.familyId, 'family-2');
});

for (const action of ['leaveFamily', 'deleteFamily']) {
  test(`${action} recovers a committed operation with authoritative reads without resending it`, async () => {
    let removed = false;
    const app = await client(async data => {
      if (data.action === `${action}WithCleanup`) { removed = true; throw new Error('response lost'); }
      if (data.action === 'listFamilies') return { ok: true, data: { families: [], pendingDeletions: [] } };
      if (data.action === 'continueFamilyDeletion') return { ok: true, data: { needsFamily: true, userId: 'alice', pendingDeletions: [], deletion: { familyId: 'family-1', status: 'complete', phase: 'complete' } } };
      return { ok: true, data: removed ? { needsFamily: true, userId: 'alice', profile: { name: '我', avatar: '' } } : privateSnapshot() };
    }, { cold: true });
    await app.cloudCall('bootstrap');
    assert.equal(app.state.value.recipes.length, 1);
    const recovered = await app.manageFamily(action, { familyId: 'family-1', expectedCurrentFamilyId: 'family-1', confirmName: '我们的小家' });
    assert.equal(recovered.removed, true);
    assert.deepEqual(app.calls.map(call => call.action), ['bootstrap', `${action}WithCleanup`, 'bootstrap', 'listFamilies', ...(action === 'deleteFamily' ? ['continueFamilyDeletion'] : [])]);
    assert.equal(app.cloudStatus.value.familyId, '');
    assert.equal(app.cloudStatus.value.phase, 'onboarding');
    assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
    assert.equal(app.cloudStatus.value.busy, false);
    assert.deepEqual(app.state.value.recipes, []);
    app.flushCloudCache();
  });
}

test('an unsuccessful family removal keeps its original error after authoritative recovery finds the family', async () => {
  const original = Object.assign(new Error('家庭名称已变化'), { code: 'CONFLICT' });
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') throw original;
    return { ok: true, data: data.action === 'listFamilies' ? { families: [{ id: 'family-1' }] } : privateSnapshot() };
  }, { cold: true });
  await app.cloudCall('bootstrap');
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'family-1' }), error => error === original);
  assert.deepEqual(app.calls.map(call => call.action), ['bootstrap', 'deleteFamilyWithCleanup', 'bootstrap', 'listFamilies']);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.cloudStatus.value.error, original.message);
  app.flushCloudCache();
});

test('recovering an exit from another family verifies the target list while retaining the current private snapshot', async () => {
  const app = await client(async data => {
    if (data.action === 'leaveFamilyWithCleanup') throw new Error('response lost');
    return { ok: true, data: data.action === 'listFamilies' ? { families: [{ id: 'family-1' }] } : privateSnapshot() };
  }, { cold: true });
  await app.cloudCall('bootstrap');
  const recovered = await app.manageFamily('leaveFamily', { familyId: 'family-other', expectedCurrentFamilyId: 'family-1' });
  assert.equal(recovered.removed, true);
  assert.equal(app.calls.filter(call => call.action === 'leaveFamilyWithCleanup').length, 1);
  assert.equal(app.calls.find(call => call.action === 'leaveFamilyWithCleanup').familyId, 'family-other');
  assert.equal(app.cloudStatus.value.familyId, 'family-1');
  assert.equal(app.state.value.family.id, 'family-1');
  assert.equal(app.state.value.recipes[0].id, 'recipe');
  assert.deepEqual(app.calls.slice(-2).map(call => call.action), ['bootstrap', 'listFamilies']);
  app.flushCloudCache();
});

test('failed removal recovery blocks writes and retries only reads until the family state is known', async () => {
  let removed = false;
  let online = true;
  const app = await client(async data => {
    if (data.action === 'leaveFamilyWithCleanup') { removed = true; online = false; throw new Error('response lost'); }
    if (!online) throw new Error('offline');
    if (data.action === 'listFamilies') return { ok: true, data: { families: [] } };
    return { ok: true, data: removed ? { needsFamily: true, userId: 'alice' } : privateSnapshot() };
  }, { cold: true });
  await app.cloudCall('bootstrap');
  await assert.rejects(app.manageFamily('leaveFamily', { familyId: 'family-1' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  assert.equal(app.cloudStatus.value.busy, false);
  assert.match(app.cloudStatus.value.error, /重新同步家庭状态/);
  const count = app.calls.length;
  await assert.rejects(app.manageFamily('leaveFamily', { familyId: 'family-1' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  await assert.rejects(app.remoteAction('setChef', [true]), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.calls.length, count, 'unknown outcome must block another mutation before any request');
  await assert.rejects(app.recoverFamilyState(), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  online = true;
  const recovered = await app.refreshCloud();
  assert.equal(recovered.removed, true);
  assert.equal(app.calls.filter(call => call.action === 'leaveFamilyWithCleanup').length, 1);
  assert.deepEqual(app.calls.slice(count).map(call => call.action), ['bootstrap', 'bootstrap', 'listFamilies']);
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.cloudStatus.value.phase, 'onboarding');
  assert.equal(app.cloudStatus.value.error, '');
  assert.deepEqual(app.state.value.recipes, []);
  app.flushCloudCache();
});

test('a failed family-list recovery keeps an actionable connection state after bootstrap has removed the current family', async () => {
  let removed = false;
  let listAvailable = false;
  const app = await client(async data => {
    if (data.action === 'deleteFamilyWithCleanup') { removed = true; throw new Error('response lost'); }
    if (data.action === 'listFamilies') {
      if (!listAvailable) throw new Error('list unavailable');
      return { ok: true, data: { families: [], pendingDeletions: [] } };
    }
    if (data.action === 'continueFamilyDeletion') return { ok: true, data: { needsFamily: true, userId: 'alice', pendingDeletions: [], deletion: { familyId: 'family-1', status: 'complete', phase: 'complete' } } };
    return { ok: true, data: removed ? { needsFamily: true, userId: 'alice' } : privateSnapshot() };
  }, { cold: true });
  await app.cloudCall('bootstrap');
  await assert.rejects(app.manageFamily('deleteFamily', { familyId: 'family-1' }), { code: 'FAMILY_RECOVERY_REQUIRED' });
  assert.equal(app.cloudStatus.value.familyId, '');
  assert.equal(app.cloudStatus.value.phase, 'error', 'the connection screen must show its read-retry action');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, true);
  listAvailable = true;
  await app.recoverFamilyState();
  assert.equal(app.cloudStatus.value.phase, 'onboarding');
  assert.equal(app.cloudStatus.value.familyRecoveryRequired, false);
  assert.equal(app.calls.filter(call => call.action === 'deleteFamilyWithCleanup').length, 1);
  app.flushCloudCache();
});


function legacyImportFixture() {
  const recipe = { ...createSeed().recipes[0], id: 'legacy-source-recipe' };
  delete recipe.shareId;
  const post = { id: 'legacy-post', kind: 'dish', familyId: 'source-family', title: recipe.title, author: '分享者', recipes: [recipe] };
  const imported = { ...recipe, id: `import-${recipe.id}`, sourceId: recipe.id };
  return { recipe, post, imported };
}
function legacyFamilySnapshot(recipes) {
  const next = emptySnapshot();
  next.family.id = 'family-1';
  next.recipes = recipes;
  return next;
}

test('a confirmed legacy import reconciles provenance before resolving and survives raw bootstrap and restart', async () => {
  const { recipe, post, imported } = legacyImportFixture();
  const storage = new Map();
  let removed = false;
  let revision = 2;
  const handler = async data => ({ ok: true, data: data.action === 'command'
    ? { userId: 'alice', familyId: 'family-1', baseRevision: 1, revision: 2, changes: { recipes: [imported] }, value: 1 }
    : { ...snapshot(revision), snapshot: legacyFamilySnapshot(removed ? [] : [imported]) } });
  const app = await client(handler, { storage });
  app.state.value.family.id = 'family-1';
  app.state.value.posts = [post];
  assert.equal(await app.remoteAction('addCollection', [post]), 1);
  assert.equal(app.state.value.recipes[0].sourcePostId, post.id);
  assert.equal(matchesImportedSource(app.state.value.recipes[0], recipe.id, post), true);
  assert.equal(imported.sourceFamilyId, undefined, 'the provider result is not mutated');
  await app.cloudCall('bootstrap');
  assert.equal(matchesImportedSource(app.state.value.recipes[0], recipe.id, post), true);
  app.flushCloudCache();
  const restarted = await client(handler, { storage, cold: true });
  await restarted.cloudCall('bootstrap');
  assert.equal(matchesImportedSource(restarted.state.value.recipes[0], recipe.id, post), true);
  assert.equal(matchesImportedSource(restarted.state.value.recipes[0], recipe.id, { ...post, id: 'foreign-post', familyId: 'other-source' }), false);
  removed = true;
  revision = 3;
  await restarted.cloudCall('bootstrap');
  assert.equal(restarted.state.value.recipes.length, 0);
  removed = false;
  revision = 4;
  await restarted.cloudCall('bootstrap');
  assert.equal(matchesImportedSource(restarted.state.value.recipes[0], recipe.id, post), false, 'observed deletion invalidates the old receipt');
});

test('an existing ambiguous legacy record is not assigned to another post after a no-op import', async () => {
  const { recipe, post, imported } = legacyImportFixture();
  const app = await client(async () => ({ ok: true, data: { userId: 'alice', familyId: 'family-1', baseRevision: 1, revision: 2, changes: { recipes: [imported] }, value: 0 } }));
  app.state.value.family.id = 'family-1';
  app.state.value.recipes = [imported];
  await app.remoteAction('addCollection', [post]);
  assert.equal(app.state.value.recipes[0].sourceFamilyId, undefined);
  assert.equal(matchesImportedSource(app.state.value.recipes[0], recipe.id, post), false);
});

test('an import reconciled through fallback bootstrap cannot claim unrelated newly seen legacy records', async () => {
  const { post, imported } = legacyImportFixture();
  const app = await client(async data => ({ ok: true, data: data.action === 'command'
    ? { userId: 'alice', familyId: 'family-1', baseRevision: 0, revision: 2, changes: { recipes: [imported] }, value: 1 }
    : { ...snapshot(3), snapshot: legacyFamilySnapshot([imported]) } }));
  app.state.value.family.id = 'family-1';
  await app.remoteAction('addCollection', [post]);
  assert.equal(app.state.value.recipes[0].sourceFamilyId, undefined);
  assert.deepEqual(app.calls.map(call => call.action), ['command', 'bootstrap']);
});


test('editing an imported dish on the legacy provider keeps its confirmed source when shareId changes', async () => {
  const { recipe, post, imported } = legacyImportFixture();
  const edited = { ...imported, title: '调整后的家庭菜品', shareId: 'shared-dish-after-edit' };
  const app = await client(async data => ({ ok: true, data: data.action === 'bootstrap'
    ? { ...snapshot(3), snapshot: legacyFamilySnapshot([edited]) }
    : { userId: 'alice', familyId: 'family-1', baseRevision: data.name === 'addCollection' ? 1 : 2, revision: data.name === 'addCollection' ? 2 : 3, changes: { recipes: [data.name === 'addCollection' ? imported : edited] }, value: 1 } }));
  app.state.value.family.id = 'family-1';
  await app.remoteAction('addCollection', [post]);
  const { id, ...draft } = recipe;
  await app.remoteAction('saveRecipe', [{ ...draft, title: edited.title }, imported.id]);
  assert.equal(app.state.value.recipes[0].shareId, edited.shareId);
  assert.equal(app.state.value.recipes[0].sourcePostId, post.id);
  assert.equal(matchesImportedSource(app.state.value.recipes[0], recipe.id, post), true);
  await app.cloudCall('bootstrap');
  assert.equal(matchesImportedSource(app.state.value.recipes[0], recipe.id, post), true);
});
