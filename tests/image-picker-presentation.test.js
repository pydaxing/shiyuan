import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computed, reactive, ref } from 'vue';
import { parse } from '@vue/compiler-sfc';
import { DEFAULT_DISH_COVER, DEFAULT_SET_COVER } from '../src/domain/presentation.js';
import { imageUploadLabel } from '../src/services/images.js';

const source = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
const script = parse(source).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');

function picker(context, options = {}, chooseLocalImage = async () => null) {
  const props = reactive({ modelValue: '', frame: 'recipe', fallback: '', compact: false, emptyCover: false, disabled: false, ...options });
  const events = [];
  const cleanups = [];
  const bindings = {
    computed, ref, chooseLocalImage,
    defineProps: () => props,
    defineEmits: () => (name, value) => { events.push([name, value]); if (name === 'update:modelValue') props.modelValue = value; },
    useSheetContentResize() {},
    onUnmounted: callback => cleanups.push(callback),
    releaseCropFile() {},
    imageUploadLabel,
  };
  const model = new Function(...Object.keys(bindings), `${script}\nreturn { defaultCover, preview, busy, error, progress, choose };`)(...Object.values(bindings));
  context.after(() => cleanups.forEach(cleanup => cleanup()));
  return { props, events, ...model };
}

test('family, dish and set default illustrations are muted without becoming uploaded values', context => {
  for (const options of [{ frame: 'family' }, { fallback: DEFAULT_DISH_COVER }, { fallback: DEFAULT_SET_COVER }, { emptyCover: true }]) {
    const current = picker(context, options);
    assert.equal(current.defaultCover.value, true);
    assert.equal(current.props.modelValue, '');
    assert.deepEqual(current.events, []);
    current.props.modelValue = 'cloud://user-photo';
    assert.equal(current.defaultCover.value, false);
    current.props.modelValue = '';
    assert.equal(current.defaultCover.value, true);
  }
});

test('compact pickers and empty frames without an illustration do not get the default-photo tint', context => {
  for (const options of [{ compact: true, fallback: DEFAULT_DISH_COVER }, {}]) {
    assert.equal(picker(context, options).defaultCover.value, false);
  }
});

test('upload previews are full color and cancellation restores the original default state', async context => {
  let finish;
  const current = picker(context, { fallback: DEFAULT_SET_COVER }, (sources, progress) => {
    assert.deepEqual(sources, ['album', 'camera']);
    progress({ items: [{ preview: 'temporary-photo' }] });
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = current.choose();
  assert.equal(current.busy.value, true);
  assert.equal(current.preview.value, 'temporary-photo');
  assert.equal(current.defaultCover.value, false);
  finish(null);
  await pending;
  assert.equal(current.defaultCover.value, true);
  assert.equal(current.busy.value, false);
  assert.equal(current.props.modelValue, '');
  assert.ok(current.events.every(([name]) => name !== 'update:modelValue'));
});

test('successful selection removes the tint while failed replacement preserves the existing photo', async context => {
  const selected = picker(context, { frame: 'family' }, async () => 'cloud://new-photo');
  await selected.choose();
  assert.equal(selected.props.modelValue, 'cloud://new-photo');
  assert.equal(selected.defaultCover.value, false);
  const failed = picker(context, { modelValue: 'cloud://existing-photo' }, async () => { throw new Error('上传失败，请重试'); });
  await failed.choose();
  assert.equal(failed.props.modelValue, 'cloud://existing-photo');
  assert.equal(failed.defaultCover.value, false);
  assert.equal(failed.error.value, '上传失败，请重试');
  assert.equal(failed.busy.value, false);
});

test('cover progress follows upload stages and clears the temporary preview after confirmation', async context => {
  let report;
  let finish;
  const current = picker(context, { modelValue: 'cloud://previous-cover' }, (sources, onProgress) => {
    report = onProgress;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = current.choose();
  assert.equal(current.progress.value, '0%');
  for (const [status, progress, expected] of [['processing', 0, '0%'], ['uploading', 45.6, '46%'], ['uploading', 100, '99%'], ['saving', 100, '99%'], ['done', 100, '100%']]) {
    report({ items: [{ preview: 'temporary-cover', status, progress }] });
    assert.equal(current.progress.value, expected);
    assert.equal(current.preview.value, 'temporary-cover');
    assert.equal(current.props.modelValue, 'cloud://previous-cover');
    assert.equal(current.busy.value, true);
  }
  finish('cloud://confirmed-cover');
  await pending;
  assert.equal(current.props.modelValue, 'cloud://confirmed-cover');
  assert.equal(current.preview.value, '');
  assert.equal(current.busy.value, false);
});
