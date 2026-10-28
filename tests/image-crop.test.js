import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COVER_RATIOS, coverFrameStyle, imageFrameStyle, fitCropImage, cropOffset, cropRectangle, cropFocus, cropPixels, cropFromBounds } from '../src/domain/image-crop.js';
import { renderImageCrop, prepareCropSource, releaseCropFile } from '../src/services/image-crop.js';
import { chooseLocalImage } from '../src/services/images.js';

test('one golden-ratio frame is shared by family, recipe and set uploads, crops and detail covers', () => {
  assert.equal(COVER_RATIOS.family, (1 + Math.sqrt(5)) / 2);
  assert.equal(COVER_RATIOS.recipe, COVER_RATIOS.family);
  assert.deepEqual(coverFrameStyle('family'), { height: '0px', minHeight: '0px', paddingTop: `${100 / COVER_RATIOS.family}%` });
  assert.deepEqual(coverFrameStyle(), coverFrameStyle('family'));
  assert.deepEqual(coverFrameStyle('recipe'), coverFrameStyle('family'));
  assert.equal(coverFrameStyle('square').paddingTop, '100%');
  for (const path of ['components/ImagePicker.vue', 'components/ImageCropper.vue', 'components/RecipeCover.vue', 'components/FamilyView.vue']) assert.match(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), /coverFrameStyle/);
  const setDetail = readFileSync(new URL('../src/components/SetSheet.vue', import.meta.url), 'utf8');
  assert.match(setDetail, /<FoodDetailSheet[^>]*:image="mealSet.image"[^>]*kind="set"/);
  assert.match(readFileSync(new URL('../src/components/FoodDetailSheet.vue', import.meta.url), 'utf8'), /<RecipeCover :image="image" :kind="kind"/);
  assert.doesNotMatch(setDetail, /set-cover-grid|set-detail-cover/);
  assert.match(readFileSync(new URL('../src/components/FamilyEditor.vue', import.meta.url), 'utf8'), /v-model="cover" frame="family"/);
});

test('portrait, landscape and square photos fill every crop frame without blank edges', () => {
  for (const source of [{ width: 4032, height: 3024 }, { width: 3024, height: 4032 }, { width: 1200, height: 1200 }, { width: 10000, height: 1200 }]) {
    for (const ratio of Object.values(COVER_RATIOS)) for (const width of [288, 328, 358, 398, 542]) for (const zoom of [1, 1.5, 3]) {
      const frame = { width, height: width / ratio };
      const image = fitCropImage(source, frame, zoom);
      assert.ok(image.width >= frame.width - 1e-8 && image.height >= frame.height - 1e-8);
      for (const offset of [image, { x: 999999, y: 999999 }, { x: -999999, y: -999999 }]) {
        const crop = cropRectangle(image, frame, offset);
        assert.ok(crop.x >= -1e-8 && crop.y >= -1e-8);
        assert.ok(crop.x + crop.width <= 1.000001 && crop.y + crop.height <= 1.000001);
        const pixels = cropPixels(source, crop);
        assert.ok(Math.abs(pixels.width / pixels.height - ratio) < 1e-8);
      }
    }
  }
});

test('drag position and zoom retain the selected focal point, with out-of-range movement clamped', () => {
  const source = { width: 3000, height: 4000 };
  const frame = { width: 360, height: 180 };
  const image = fitCropImage(source, frame);
  const offset = cropOffset(image, frame, { x: -300, y: -180 });
  assert.equal(offset.x, 0);
  const focus = cropFocus(image, frame, offset);
  const zoomed = fitCropImage(source, frame, 2, focus);
  assert.deepEqual(cropFocus(zoomed, frame), focus);
  assert.equal(cropRectangle(image, frame, { x: 0, y: -10000 }).y + cropRectangle(image, frame, { x: 0, y: -10000 }).height, 1);
});

test('invalid crop requests fail instead of silently stretching or replacing the selected image', () => {
  assert.throws(() => fitCropImage({ width: 0, height: 300 }, { width: 100, height: 100 }), /尺寸/);
  for (const crop of [null, { x: -.1, y: 0, width: .5, height: .5 }, { x: .8, y: 0, width: .5, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) assert.throws(() => cropPixels({ width: 100, height: 100 }, crop), /取景/);
});

test('cancelling the crop prevents all persistence and keeps the current image untouched', async context => {
  const previous = globalThis.uni;
  context.after(() => { globalThis.uni = previous; });
  let prepared = 0;
  globalThis.uni = { chooseImage: async () => ({ tempFilePaths: ['original.jpg'] }), getImageInfo() { assert.fail('cancel must not persist'); } };
  assert.equal(await chooseLocalImage(['album'], () => assert.fail('cancel must not enqueue an upload'), async path => { assert.equal(path, 'original.jpg'); prepared += 1; return null; }), '');
  assert.equal(prepared, 1);
});

test('native crop uses the exact selected source rectangle and exports only a bounded preview', async context => {
  const previous = { wx: globalThis.wx, uni: globalThis.uni };
  context.after(() => Object.assign(globalThis, previous));
  const draws = [];
  const deleted = [];
  const canvas = { width: 1, height: 1, createImage: () => ({ set src(value) { assert.equal(value, 'oriented-preview.jpg'); queueMicrotask(() => this.onload()); } }), getContext: () => ({ fillRect() {}, drawImage(...args) { draws.push(args.slice(1)); } }) };
  globalThis.wx = { createOffscreenCanvas: () => canvas, canvasToTempFilePath: options => { assert.equal(options.width, 960); assert.equal(options.height, 480); options.success({ tempFilePath: 'cropped-preview.jpg' }); }, getFileSystemManager: () => ({ unlink: ({ filePath }) => deleted.push(filePath) }) };
  globalThis.uni = { getFileInfo: async () => ({ size: 100000 }) };
  const source = { preview: 'oriented-preview.jpg', original: 'original.heic', width: 1400, height: 1800 };
  assert.equal(await renderImageCrop(source, { x: 0, y: .5, width: 1, height: 700 / 1800 }), 'cropped-preview.jpg');
  assert.deepEqual(draws[0], [0, 900, 1400, 700, 0, 0, 960, 480]);
  assert.equal(canvas.width, 1);
  assert.equal(canvas.height, 1);
  releaseCropFile('original.heic', 'original.heic');
  assert.deepEqual(deleted, []);
  releaseCropFile('cropped-preview.jpg', 'original.heic');
  assert.deepEqual(deleted, ['cropped-preview.jpg']);
});

test('crop preparation measures the orientation-normalized preview rather than raw camera dimensions', async context => {
  const previous = globalThis.uni;
  context.after(() => { globalThis.uni = previous; });
  globalThis.uni = {
    getFileInfo: async () => ({ size: 100000 }),
    getImageInfo: async ({ src }) => src === 'portrait.jpg' ? { width: 4032, height: 3024, type: 'jpeg' } : { width: 1000, height: 1400, type: 'jpeg' },
    compressImage: async () => ({ tempFilePath: 'oriented.jpg' }),
  };
  assert.deepEqual(await prepareCropSource('portrait.jpg'), { original: 'portrait.jpg', preview: 'oriented.jpg', width: 1000, height: 1400 });
});

test('the cropper uses native drag and pinch without sliders or redundant adjustment controls', () => {
  const source = readFileSync(new URL('../src/components/ImageCropper.vue', import.meta.url), 'utf8');
  assert.match(source, /<movable-area/);
  assert.match(source, /<movable-view[^>]*direction="all"/);
  assert.match(source, /:out-of-bounds="false"/);
  assert.match(source, /:animation="false"/);
  assert.match(source, /:scale-area="true"/);
  for (const attribute of [':scale="true"', ':scale-min="1"', ':scale-max="3"', ':scale-value="zoom"']) assert.ok(source.includes(attribute));
  assert.match(source, /单指拖动位置，双指捏合缩放/);
  assert.doesNotMatch(source, /<slider|重置取景|crop-control|nudge\(|changeZoom\(|vibrate|requestAnimationFrame|@change="moved"/);
});

test('the saved crop uses rendered bounds after native pinch, dragging and layout translation', () => {
  for (const ratio of Object.values(COVER_RATIOS)) for (const scale of [1, 1.2, 2, 3]) {
    const frame = { left: 24, top: 186, width: 328, height: 328 / ratio };
    const placed = fitCropImage({ width: 1800, height: 2600 }, frame, scale, { x: .7, y: .8 });
    const rendered = { width: placed.width, height: placed.height, left: frame.left + placed.x, top: frame.top + placed.y };
    const crop = cropFromBounds(frame, rendered);
    const expected = cropRectangle(placed, frame);
    for (const key of Object.keys(expected)) assert.ok(Math.abs(crop[key] - expected[key]) < 1e-8);
    const pixels = cropPixels({ width: 1800, height: 2600 }, crop);
    assert.ok(Math.abs(pixels.width / pixels.height - ratio) < 1e-8);
  }
});

test('unmeasured or uncovered crops fail rather than silently exporting a different region', () => {
  const frame = { left: 20, top: 200, width: 320, height: 160 };
  assert.throws(() => cropFromBounds(frame, null), /尺寸/);
  assert.throws(() => cropFromBounds(frame, { ...frame, left: NaN }), /位置/);
  assert.throws(() => cropFromBounds(frame, { ...frame, left: 30 }), /铺满/);
  assert.throws(() => cropFromBounds(frame, { ...frame, height: 100 }), /铺满/);
});

test('the compact family thumbnail shares the upload ratio and cached display image', () => {
  const family = readFileSync(new URL('../src/components/FamilyView.vue', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  const picker = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
  const artwork = readFileSync(new URL('../src/components/FamilyCoverImage.vue', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(family, /class="family-banner-frame" :style="coverFrameStyle\('family'\)"/);
  assert.match(family, /<FamilyCoverImage class="family-cover" :src="state\.family\.cover" variant="card"/);
  assert.doesNotMatch(home, /class="hero photo-hero"|FamilyCoverImage/);
  assert.doesNotMatch(family, /photo-hero|hero-edit|hero-cover-edit/);
  assert.match(picker, /<FamilyCoverImage v-else-if="familyCover" :src="modelValue \|\| fallback" variant="detail"/);
  assert.match(artwork, /<LazyImage v-if="src" :src="src" :variant="variant" mode="aspectFill"/);
  assert.match(artwork, /class="family-cover-default"/);
  assert.match(artwork, /class="family-cover-photo" :src="DEFAULT_FAMILY_COVER" mode="aspectFill"/);
  assert.match(artwork, /\.family-cover-photo\s*\{[^}]*inset: 0; width: 100%; height: 100%;/);
  assert.doesNotMatch(artwork, /tomato\.png|family-cover-illustration/);
  const invite = readFileSync(new URL('../src/pages/invite/index.vue', import.meta.url), 'utf8');
  assert.match(invite, /<FamilyCoverImage :src="invite\?\.familyCover" variant="detail"/);
  assert.match(invite, /class="invitation-cover" :style="coverFrameStyle\('family'\)"/);
  assert.doesNotMatch(home, /state\.family\.cover \? coverFrameStyle|class="hero-art"/);
  assert.doesNotMatch(css, /--home-cover-height/);
  assert.doesNotMatch(css, /\.family-banner > image/);
});

test('family and recipe cover crops select the same region at upload, detail and thumbnail widths', () => {
  for (const source of [{ width: 4032, height: 3024 }, { width: 3024, height: 4032 }, { width: 2400, height: 1200 }]) {
    for (const kind of ['family', 'recipe']) for (const zoom of [1, 1.75, 3]) {
      const crops = [92, 288, 358, 398, 568].map(width => {
        const frame = { width, height: width / COVER_RATIOS[kind] };
        return cropRectangle(fitCropImage(source, frame, zoom, { x: .35, y: .6 }), frame);
      });
      for (const crop of crops) for (const coordinate of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(crop[coordinate] - crops[0][coordinate]) < 1e-10);
    }
  }
});

test('natural image frames accept portrait, landscape and panorama ratios without fixed minimum heights', () => {
  for (const ratio of [.5, .75, 1, 4 / 3, 2, 8]) {
    assert.deepEqual(imageFrameStyle(ratio), { height: '0px', minHeight: '0px', paddingTop: `${100 / ratio}%` });
  }
  for (const ratio of [0, -1, NaN, Infinity, undefined, '4:3']) assert.deepEqual(imageFrameStyle(ratio), {});
});
