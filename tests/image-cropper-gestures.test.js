import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { computed, ref } from 'vue';
import { coverFrameStyle, cropFocus, cropFromBounds, fitCropImage } from '../src/domain/image-crop.js';

const source = readFileSync(new URL('../src/components/ImageCropper.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
function fixture(render) {
  let regions = [{ left: 16, top: 110, width: 320, height: 160 }, null];
  let unmount;
  const events = [];
  const crops = [];
  const released = [];
  const component = runInNewContext(`${script}\n;({ measure, confirm, placement, viewport, busy, error, sheetHeight });`, {
    computed, ref, getCurrentInstance: () => ({ proxy: {} }),
    defineProps: () => ({ source: { width: 800, height: 800, original: 'original.jpg', preview: 'preview.jpg' }, frame: 'family' }),
    defineEmits: () => (...args) => events.push(args), onMounted: () => {}, onUnmounted: callback => { unmount = callback; },
    afterNativeRender: async () => {}, coverFrameStyle, cropFocus, cropFromBounds, fitCropImage, setTimeout, clearTimeout,
    renderImageCrop: async (image, crop) => { crops.push({ image, crop }); return render ? render() : 'cropped.jpg'; },
    releaseCropFile: (...args) => released.push(args),
    uni: { getWindowInfo: () => ({ safeAreaInsets: { bottom: 0 } }), createSelectorQuery: () => {
      const query = { in: () => query, select: () => query, boundingClientRect: () => query, exec: callback => callback(regions) };
      return query;
    } },
  });
  return { ...component, crops, events, released, setRegions: value => { regions = value; }, unmount: () => unmount() };
}

test('native gesture export measures the actual zoomed image instead of its original layout box', async () => {
  const cropper = fixture(); await cropper.measure();
  assert.equal(cropper.sheetHeight.value, 386);
  cropper.setRegions([{ left: 16, top: 210, width: 320, height: 160 }, { left: -144, top: -110, width: 640, height: 640 }]);
  await cropper.confirm();
  assert.deepEqual({ ...cropper.crops[0].crop }, { x: .25, y: .5, width: .5, height: .25 });
  assert.equal(cropper.events[0][0], 'confirm');
  assert.equal(cropper.events[0][1].previewPath, 'cropped.jpg');
});

test('missing rendered geometry leaves the cropper available for retry without uploading', async () => {
  const cropper = fixture(); await cropper.measure();
  await cropper.confirm();
  assert.equal(cropper.crops.length, 0);
  assert.match(cropper.error.value, /尺寸/);
  assert.equal(cropper.busy.value, false);
});

test('confirm cannot run twice, and closing during export releases only the derived preview', async () => {
  let resolve;
  const cropper = fixture(() => new Promise(done => { resolve = done; }));
  await cropper.measure();
  cropper.setRegions([{ left: 0, top: 0, width: 320, height: 160 }, { left: 0, top: -80, width: 320, height: 320 }]);
  const saving = cropper.confirm();
  await cropper.confirm(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cropper.crops.length, 1);
  cropper.unmount(); resolve('cropped.jpg'); await saving;
  assert.equal(cropper.events.length, 0);
  assert.deepEqual(cropper.released, [['cropped.jpg', 'original.jpg']]);
});
