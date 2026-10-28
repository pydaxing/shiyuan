import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse } from '@vue/compiler-sfc';
import { selectImagePaths, chooseLocalImage, chooseLocalImages, imageUploadLabel } from '../src/services/images.js';
import { focusKeyboardField } from '../src/services/keyboard.js';

const originalUni = globalThis.uni;
const originalWx = globalThis.wx;
afterEach(() => { globalThis.uni = originalUni; globalThis.wx = originalWx; });

test('every mixed-source selection visibly offers camera and album before opening either', async () => {
  const calls = [];
  globalThis.uni = {
    showActionSheet: async options => { calls.push(options.itemList); return { tapIndex: 0 }; },
    chooseImage: async options => { calls.push(options); return { tempFilePaths: ['camera-original.jpg', 'extra.jpg'] }; },
  };
  assert.deepEqual(await selectImagePaths(9), ['camera-original.jpg']);
  assert.deepEqual(calls, [
    ['拍照', '从相册选择'],
    { count: 1, sizeType: ['original'], sourceType: ['camera'] },
  ]);
});

test('album selection preserves remaining slots and does not launch the camera', async () => {
  const requests = [];
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 1 }),
    chooseImage: async options => { requests.push(options); return { tempFilePaths: ['one.jpg', 'two.jpg', 'three.jpg'] }; },
  };
  assert.deepEqual(await selectImagePaths(2), ['one.jpg', 'two.jpg']);
  assert.deepEqual(requests[0], { count: 2, sizeType: ['original'], sourceType: ['album'] });
  await selectImagePaths(30);
  assert.equal(requests[1].count, 9);
});

test('explicit single sources skip the source menu and no remaining slots open nothing', async () => {
  const requests = [];
  globalThis.uni = {
    showActionSheet: () => assert.fail('a resolved source must not open another menu'),
    chooseImage: async options => { requests.push(options); return { tempFilePaths: ['original.jpg'] }; },
  };
  await selectImagePaths(5, ['camera']);
  await selectImagePaths(5, ['album']);
  assert.equal(requests[0].count, 1);
  assert.equal(requests[1].count, 5);
  for (const count of [0, -1, NaN]) assert.deepEqual(await selectImagePaths(count), []);
  assert.equal(requests.length, 2);
});

test('cancelling source selection leaves single and multiple photos untouched and skips crop/upload', async () => {
  globalThis.uni = {
    showActionSheet: async () => { throw { errMsg: 'showActionSheet:fail cancel' }; },
    chooseImage: () => assert.fail('cancel must not open camera or album'),
  };
  assert.equal(await chooseLocalImage(undefined, undefined, () => assert.fail('cancel must not crop')), '');
  assert.deepEqual(await chooseLocalImages(3), []);
});

test('camera cancellation and empty captures never create or replace an image', async () => {
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 0 }),
    chooseImage: async () => { throw new Error('chooseImage:fail cancel'); },
  };
  assert.equal(await chooseLocalImage(), '');
  globalThis.uni.chooseImage = async () => ({ tempFilePaths: [] });
  assert.deepEqual(await selectImagePaths(), []);
});

test('source-menu errors and permission failures are distinct and can be retried', async () => {
  globalThis.uni = { showActionSheet: async () => { throw new Error('not ready'); } };
  await assert.rejects(selectImagePaths(), /选择菜单/);
  globalThis.uni.chooseImage = async () => { throw { errMsg: 'chooseImage:fail auth deny' }; };
  globalThis.uni.showActionSheet = async () => ({ tapIndex: 0 });
  await assert.rejects(selectImagePaths(), /相机权限/);
  globalThis.uni.showActionSheet = async () => ({ tapIndex: 1 });
  await assert.rejects(selectImagePaths(), /照片访问权限/);
  globalThis.uni.chooseImage = async () => ({ tempFilePaths: ['retried.jpg'] });
  assert.deepEqual(await selectImagePaths(), ['retried.jpg']);
});

test('selecting a photo releases the current keyboard before the native source menu', async () => {
  const events = [];
  focusKeyboardField('image-source-test', () => events.push('blur'));
  globalThis.uni = {
    hideKeyboard: () => events.push('hideKeyboard'),
    showActionSheet: async () => { events.push('source'); return { tapIndex: 0 }; },
    chooseImage: async () => { events.push('camera'); return { tempFilePaths: [] }; },
  };
  await selectImagePaths();
  assert.deepEqual(events, ['blur', 'hideKeyboard', 'source', 'camera']);
});

test('camera photos go through the same cover-crop and original-preserving upload path', async () => {
  let original;
  globalThis.uni = {
    showActionSheet: async () => ({ tapIndex: 0 }),
    chooseImage: async options => {
      assert.deepEqual(options.sourceType, ['camera']);
      assert.deepEqual(options.sizeType, ['original']);
      return { tempFilePaths: ['camera-original.jpg'] };
    },
  };
  assert.equal(await chooseLocalImage(undefined, undefined, async path => { original = path; return null; }), '');
  assert.equal(original, 'camera-original.jpg');
});

function profileHarness({ cloud = true, platform = 'web', paths = ['camera-avatar.jpg'], failure, upload } = {}) {
  const events = [];
  let selections = 0;
  const script = parse(readFileSync(new URL('../src/components/ProfileFields.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content.replace(/^import .*;\n/gm, '');
  const profile = runInNewContext(`(() => { ${script}; return { choose, choosePhoto, preview, pendingPreview, progress, uploading, uploadError }; })()`, {
    ref: value => ({ value }),
    defineProps: () => ({}),
    defineExpose() {},
    defineEmits: () => (...args) => events.push(args),
    uni: { getSystemInfoSync: () => ({ uniPlatform: platform }) },
    cloudMode: cloud,
    imageUploadLabel,
    selectImagePaths: async () => { selections += 1; if (failure) throw failure; return paths; },
    chooseLocalImage: async () => { selections += 1; if (failure) throw failure; return paths[0] || ''; },
    compressNativePhoto: async (path, variant) => { events.push(['compress', path, variant]); return 'card-avatar.jpg'; },
    uploadProfileAvatar: async (path, previews) => { events.push(['upload', path, previews.cardPath]); return upload ? upload(path, previews) : 'cloud://profile/avatar.jpg'; },
    notify: message => events.push(['notice', message]),
  });
  return { profile, events, selections: () => selections };
}

test('native avatar taps and cancellation never open another picker or start an upload', async () => {
  const { profile, events, selections } = profileHarness({ platform: 'mp-weixin' });
  profile.preview.value = 'previous-avatar.jpg';
  await profile.choosePhoto();
  await profile.choose({ detail: {} });
  assert.equal(selections(), 0);
  assert.equal(profile.uploading.value, false);
  assert.equal(profile.pendingPreview.value, '');
  assert.equal(profile.preview.value, 'previous-avatar.jpg');
  assert.deepEqual(events, []);
});

test('native avatar selection uses one upload even if the result is delivered again while busy', async () => {
  let finish;
  const { profile, events, selections } = profileHarness({ platform: 'mp-weixin', upload: () => new Promise(resolve => { finish = resolve; }) });
  const event = { detail: { avatarUrl: 'wx-avatar.jpg' } };
  const first = profile.choose(event);
  await profile.choose(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(profile.uploading.value, true);
  assert.equal(selections(), 0);
  assert.equal(events.filter(item => item[0] === 'upload').length, 1);
  finish('cloud://profile/confirmed.jpg');
  await first;
  assert.equal(profile.uploading.value, false);
  assert.equal(events.filter(item => item[0] === 'update:avatar').length, 1);
});

test('profile camera photos preserve the dedicated profile upload ticket and busy state', async () => {
  const { profile, events, selections } = profileHarness();
  const first = profile.choosePhoto();
  await profile.choosePhoto();
  await first;
  assert.equal(selections(), 1);
  assert.deepEqual(events, [
    ['busy', true], ['compress', 'camera-avatar.jpg', 'card'],
    ['upload', 'camera-avatar.jpg', 'card-avatar.jpg'], ['update:avatar', 'cloud://profile/avatar.jpg'], ['busy', false],
  ]);
  assert.equal(profile.preview.value, 'card-avatar.jpg');
  assert.equal(profile.uploading.value, false);
});

test('profile cancellation and denied camera permission keep the current avatar', async () => {
  for (const options of [{ paths: [] }, { failure: new Error('相机权限未开启') }]) {
    const { profile, events } = profileHarness(options);
    profile.preview.value = 'previous-avatar.jpg';
    await profile.choosePhoto();
    assert.equal(profile.preview.value, 'previous-avatar.jpg');
    assert.equal(profile.uploading.value, false);
    assert.ok(!events.some(event => ['upload', 'update:avatar'].includes(event[0])));
  }
});

test('camera and WeChat avatar uploads expose only a percentage and keep the old avatar until confirmed', async () => {
  for (const nativeAvatar of [false, true]) {
    let finish;
    let report;
    const { profile, events } = profileHarness({ platform: nativeAvatar ? 'mp-weixin' : 'web', upload: (path, options) => {
      report = options.onStage;
      return new Promise(resolve => { finish = resolve; });
    } });
    profile.preview.value = 'previous-avatar.jpg';
    const pending = nativeAvatar ? profile.choose({ detail: { avatarUrl: 'wx-avatar.jpg' } }) : profile.choosePhoto();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(profile.uploading.value, true);
    assert.equal(profile.pendingPreview.value, 'card-avatar.jpg');
    assert.equal(profile.progress.value, '0%');
    report({ status: 'uploading', progress: 58.4 });
    assert.equal(profile.progress.value, '58%');
    report({ status: 'uploading', progress: 100 });
    assert.equal(profile.progress.value, '99%');
    report({ status: 'saving' });
    assert.equal(profile.progress.value, '99%');
    assert.equal(profile.preview.value, 'previous-avatar.jpg');
    assert.ok(!events.some(event => event[0] === 'update:avatar'));
    finish('cloud://profile/confirmed.jpg');
    await pending;
    assert.equal(profile.progress.value, '100%');
    assert.equal(profile.pendingPreview.value, '');
    assert.equal(profile.preview.value, 'card-avatar.jpg');
    assert.equal(profile.uploading.value, false);
    assert.ok(events.some(event => event[0] === 'update:avatar' && event[1] === 'cloud://profile/confirmed.jpg'));
  }
});

test('a failed avatar upload clears its pending overlay but retains the saved avatar and error feedback', async () => {
  const { profile, events } = profileHarness({ upload: async (path, options) => {
    options.onStage({ status: 'uploading', progress: 36 });
    throw new Error('上传未完成，请重试');
  } });
  profile.preview.value = 'previous-avatar.jpg';
  await profile.choosePhoto();
  assert.equal(profile.preview.value, 'previous-avatar.jpg');
  assert.equal(profile.pendingPreview.value, '');
  assert.equal(profile.uploading.value, false);
  assert.ok(!events.some(event => event[0] === 'update:avatar'));
  assert.equal(profile.uploadError.value, '上传未完成，请重试');
  assert.ok(!events.some(event => event[0] === 'notice'));
});

test('H5 profile previews stay local while the optional WeChat avatar path remains available', async () => {
  const local = profileHarness({ cloud: false, paths: ['data:image/jpeg;base64,photo'] });
  await local.profile.choosePhoto();
  assert.equal(local.profile.preview.value, 'data:image/jpeg;base64,photo');
  assert.ok(!local.events.some(event => event[0] === 'upload'));
  const native = profileHarness();
  await native.profile.choose({ detail: { avatarUrl: 'wx-avatar.jpg' } });
  assert.ok(native.events.some(event => event[0] === 'upload' && event[1] === 'wx-avatar.jpg'));
});

test('all app upload entry points share source selection, including profile and step photos', () => {
  const root = new URL('../src/', import.meta.url);
  const directChoosers = readdirSync(root, { recursive: true }).filter(path => /\.(js|vue)$/.test(path))
    .filter(path => /(?:uni|wx)\.choose(?:Image|Media)\s*\(/.test(readFileSync(new URL(path, root), 'utf8')));
  assert.deepEqual(directChoosers, ['services/images.js']);
  for (const name of ['RecipeEditor', 'SetEditor', 'FamilyEditor', 'StockEditor', 'InventoryView']) {
    assert.match(readFileSync(new URL(`components/${name}.vue`, root), 'utf8'), /<ImagePicker/);
  }
  assert.match(readFileSync(new URL('components/ImagePicker.vue', root), 'utf8'), /chooseLocalImage\(\['album', 'camera'\]/);
  assert.match(readFileSync(new URL('components/StepImagePicker.vue', root), 'utf8'), /chooseLocalImages\(9 - props.modelValue.length, \['album', 'camera'\]/);
  const profile = readFileSync(new URL('components/ProfileFields.vue', root), 'utf8');
  assert.match(profile, /@click="choosePhoto"/);
  assert.match(profile, /selectImagePaths\(\)/);
  assert.match(profile, /:open-type="nativeAvatarPicker \? 'chooseAvatar' : undefined"/);
  assert.match(profile, /if \(nativeAvatarPicker \|\| uploading\.value \|\| props\.disabled\) return;/);
});


test('WeChat uses image-only native media picker for both sources and preserves originals', async () => {
  for (const tapIndex of [0, 1]) {
    globalThis.uni = { showActionSheet: async () => ({ tapIndex }), chooseImage: () => assert.fail('legacy picker must not run') };
    globalThis.wx = { chooseMedia(options) {
      assert.deepEqual(options.mediaType, ['image']);
      assert.deepEqual(options.sizeType, ['original']);
      assert.deepEqual(options.sourceType, [tapIndex ? 'album' : 'camera']);
      assert.equal(options.count, tapIndex ? 3 : 1);
      options.success({ tempFiles: [{ tempFilePath: 'original.jpg' }] });
    } };
    assert.deepEqual(await selectImagePaths(3), ['original.jpg']);
  }
});

test('native cancellation is harmless; privacy and unknown failures retain diagnostics without fallback', async () => {
  globalThis.uni = { chooseImage: () => assert.fail('must not retry or bypass native rejection') };
  for (const reason of ['chooseMedia:fail cancel', 'chooseMedia:fail privacy permission is not authorized', 'chooseMedia:fail unexpected internal error']) {
    const failure = { errMsg: reason };
    globalThis.wx = { chooseMedia: options => options.fail(failure) };
    if (reason.includes('cancel')) assert.deepEqual(await selectImagePaths(1, ['album']), []);
    else await assert.rejects(selectImagePaths(1, ['album']), error => {
      assert.equal(error.cause, failure);
      assert.ok(error.message.includes(reason));
      assert.equal(error.message.includes('照片访问权限'), false);
      return true;
    });
  }
});
