import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';

function mount(overrides = {}, props = { value: 'cloud://saved', avatar: true }) {
  const events = [];
  const released = [];
  const modules = {
    ...Vue, watch() {}, onUnmounted() {},
    DEFAULT_FAMILY_COVER: '/static/default.jpg', cloudMode: true,
    loadImage: async path => path,
    prepareCropSource: async path => ({ original: path, preview: path, width: 800, height: 800 }),
    releaseCropFile: path => { if (path) released.push(path); },
    compressNativePhoto: async () => 'thumb.jpg',
    uploadProfileAvatar: async () => 'cloud://cropped',
    persistSelectedImages: async () => ['cloud://cover'],
    selectImagePaths: async () => ['chosen.jpg'],
    ...overrides,
  };
  const uni = { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }), getImageInfo: async ({ src }) => ({ path: src }) };
  const descriptor = parse(readFileSync('src/components/InlinePhotoEditor.vue', 'utf8')).descriptor;
  let code = compileScript(descriptor, { id: 'inline-photo-test' }).content;
  code = code.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', 'uni', code.replace('export default', 'return'))(modules, uni);
  const api = component.setup(props, { expose() {}, emit: (...args) => events.push(args) });
  return { api, events, released };
}

test('unchanged completion reuses the saved image without cropping or uploading', async () => {
  const { api } = mount({ uploadProfileAvatar() { assert.fail('unexpected upload'); } });
  assert.equal(await api.save(), 'cloud://saved');
});

test('editor loads original avatars and the saved cover crop, then prepares high-resolution working pixels', async () => {
  for (const avatar of [true, false]) {
    const { api } = mount({
      loadImage: async (path, variant) => {
        assert.equal(path, 'cloud://saved');
        assert.equal(variant, avatar ? 'original' : 'cover');
        return 'saved-frame.jpg';
      },
      prepareCropSource: async (path, variant, options) => {
        assert.equal(path, 'saved-frame.jpg');
        assert.equal(variant, avatar ? 'detail' : 'cover');
        assert.deepEqual(options, { highResolution: true });
        return { original: path, preview: path, width: 1440, height: 890, variant };
      },
    }, { value: 'cloud://saved', avatar });
    await api.prepare('cloud://saved');
    assert.equal(api.source.value.preview, 'saved-frame.jpg');
    assert.equal(api.dirty.value, false);
  }
});

test('native WeChat selection keeps a local draft until completion; retries reuse the upload', async () => {
  let uploads = 0;
  const { api, events } = mount({ uploadProfileAvatar: async (path, variants) => {
    uploads++; assert.equal(path, 'crop.jpg'); assert.equal(variants.avatarPath, 'thumb.jpg'); return 'cloud://cropped';
  } });
  await api.choose({ detail: { avatarUrl: 'wechat.jpg' } });
  assert.equal(uploads, 0);
  assert.equal(api.source.value.original, 'wechat.jpg');
  assert.ok(events.some(event => event[0] === 'dirty' && event[1]));
  api.surface.value = { exportCrop: async () => 'crop.jpg' };
  assert.equal(await api.save(), 'cloud://cropped');
  assert.equal(await api.save(), 'cloud://cropped');
  assert.equal(uploads, 1);
  api.markDirty();
  await api.save();
  assert.equal(uploads, 2);
});

test('failed upload preserves the crop draft and supports retry', async () => {
  let attempts = 0;
  const { api } = mount({ uploadProfileAvatar: async () => {
    if (++attempts === 1) throw new Error('network'); return 'cloud://retry';
  } });
  await api.choose({ detail: { avatarUrl: 'chosen.jpg' } });
  api.surface.value = { exportCrop: async () => 'crop.jpg' };
  await assert.rejects(api.save(), /network/);
  assert.equal(api.dirty.value, true);
  assert.equal(api.source.value.original, 'chosen.jpg');
  assert.equal(await api.save(), 'cloud://retry');
});

test('cover completion retains the source and sends its rectangular crop as the cover variant', async () => {
  let calls = 0;
  const { api } = mount({ persistSelectedImages: async (paths, progress, previews) => {
    calls++; assert.deepEqual(paths, ['chosen.jpg']);
    assert.deepEqual(previews, [{ previewPath: 'cover-crop.jpg', variant: 'cover' }]);
    return ['cloud://cover'];
  } }, { value: '', avatar: false });
  await api.select();
  assert.equal(calls, 0);
  api.surface.value = { exportCrop: async () => 'cover-crop.jpg' };
  assert.equal(await api.save(), 'cloud://cover');
  assert.equal(calls, 1);
});

test('both editors use an inline crop surface without a second sheet', () => {
  const source = readFileSync('src/components/InlinePhotoEditor.vue', 'utf8');
  assert.match(source, /<ImageCropSurface/);
  assert.doesNotMatch(source, /<Sheet|<ImageCropper/);
  assert.match(source, /:frame="avatar \? 'square' : 'family'"/);
  assert.match(source, /:round="avatar"/);
  assert.match(source, /chooseAvatar/);
});


test('new family cover uploads remain scoped to their creation request', async () => {
  const { api } = mount({ persistSelectedImages: async (paths, progress, previews, requestId) => {
    assert.equal(requestId, 'create-family-test');
    assert.equal(previews[0].variant, 'cover');
    return ['cloud://family-draft'];
  } }, { value: '', avatar: false, familyDraftRequest: 'create-family-test' });
  await api.select();
  api.surface.value = { exportCrop: async () => 'crop.jpg' };
  assert.equal(await api.save(), 'cloud://family-draft');
});
