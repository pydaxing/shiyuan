import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { computed, ref, reactive, watch, nextTick, effectScope } from 'vue';
import { createMediaCache } from '../src/services/media-cache.js';
import { imageVersion } from '../src/domain/image-variants.js';
import { imageFrameStyle } from '../src/domain/image-crop.js';

const script = readFileSync(new URL('../src/components/LazyImage.vue', import.meta.url), 'utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
function mount(src, cache, overrides = {}, sheetReady = null) {
  const scope = effectScope();
  let intersect;
  let mounted;
  let unmount;
  let observerOptions;
  let disconnects = 0;
  let resizeRequests = 0;
  const props = reactive({ src, variant: 'detail', mode: 'widthFix', ...overrides });
  const mediaRecovery = ref(0);
  const mediaScopeRevision = ref(0);
  const observer = { relativeToViewport() { return observer; }, observe(selector, callback) { intersect = callback; }, disconnect() { disconnects += 1; } };
  const component = scope.run(() => runInNewContext(`${script}\n;({ image, retry, failed, retrying, imageError, imageLoaded, frameStyle, avatarFallbackVisible });`, {
    computed, ref, watch, nextTick, imageVersion, imageFrameStyle,
    inject: () => sheetReady,
    afterNativeRender: nextTick,
    defineProps: () => props,
    getCurrentInstance: () => ({ proxy: {} }),
    useSheetContentResize: enabled => () => { if (enabled()) resizeRequests += 1; },
    onMounted: callback => { mounted = callback; },
    onUnmounted: callback => { unmount = callback; },
    resolveImage: (fileId, variant, options) => fileId ? cache.resolve(imageVersion(fileId, variant), options) : '',
    peekImage: (fileId, variant) => fileId ? cache.peek(imageVersion(fileId, variant)) : '',
    loadImage: (fileId, variant, options) => fileId ? cache.load(imageVersion(fileId, variant), options) : Promise.resolve(''),
    mediaFailures: ref({}),
    mediaRecovery,
    mediaScopeRevision,
    uni: { createIntersectionObserver: (owner, options) => { observerOptions = options; return observer; } },
  }));
  mounted();
  return { ...component, props, resizes: () => resizeRequests, observerOptions: () => observerOptions, reconnect: () => { mediaRecovery.value += 1; }, resetScope: () => { mediaScopeRevision.value += 1; }, enter: () => intersect?.({ intersectionRatio: 1 }), leave: () => intersect?.({ intersectionRatio: 0 }), disconnects: () => disconnects, stop: () => { unmount(); scope.stop(); } };
}

test('image visibility requests the native observer instead of the compatibility slow path', () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('photo', cache);
  try { assert.equal(photo.observerOptions().nativeMode, true); }
  finally { photo.stop(); }
});

test('sheet thumbnails wait for the portal and use its visible viewport instead of native ancestor clipping', async () => {
  const sheetReady = ref(false);
  const requests = [];
  const cache = createMediaCache({ urls: ref({}), fetchImage: async key => { requests.push(key); return 'photo'; }, writeImage: async () => '/sheet-photo', removeImage() {} });
  const photo = mount('cloud://family/sheet-photo.png', cache, { mode: 'aspectFill' }, sheetReady);
  try {
    assert.equal(photo.observerOptions(), undefined);
    assert.deepEqual(requests, []);
    sheetReady.value = true;
    await nextTick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(photo.observerOptions().nativeMode, false);
    photo.enter();
    await nextTick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(photo.image.value, '/sheet-photo');
    assert.equal(requests.length, 1);
  } finally { photo.stop(); }
});

test('closing a measuring sheet cannot create a late image observer', async () => {
  const sheetReady = ref(false);
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/sheet-photo', removeImage() {} });
  const photo = mount('photo', cache, {}, sheetReady);
  sheetReady.value = true;
  await nextTick();
  photo.stop();
  await nextTick();
  assert.equal(photo.observerOptions(), undefined);
});

test('fixed-height sheets wait for native portal placement even without content measuring', async () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('photo', cache, {}, ref(true));
  try {
    assert.equal(photo.observerOptions(), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(photo.observerOptions().nativeMode, false);
    photo.enter();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(photo.image.value, '/photo');
  } finally { photo.stop(); }
});

test('member avatars load immediately without waiting for a small nested frame intersection', async () => {
  const requests = [];
  const cache = createMediaCache({ urls: ref({}), fetchImage: async key => { requests.push(key); return 'avatar'; }, writeImage: async () => '/member-avatar', removeImage() {} });
  const profile = { avatar: true, round: true, mode: 'aspectFill', variant: 'card' };
  const kitchen = mount('cloud://family/member.png', cache, profile);
  const family = mount('cloud://family/member.png', cache, profile);
  try {
    await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick();
    assert.equal(kitchen.image.value, '/member-avatar');
    assert.equal(family.image.value, '/member-avatar');
    assert.deepEqual(requests, [imageVersion('cloud://family/member.png', 'card')]);
    assert.equal(kitchen.observerOptions(), undefined, 'avatars must not be gated by list or sticky-scroll geometry');
    assert.equal(family.observerOptions(), undefined);
  } finally { kitchen.stop(); family.stop(); }
});

test('a member with an avatar is not presented as anonymous while its photo is loading', async () => {
  let finish;
  const cache = createMediaCache({ urls: ref({}), fetchImage: () => new Promise(resolve => { finish = resolve; }), writeImage: async () => '/member-avatar', removeImage() {} });
  const photo = mount('cloud://family/member.png', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  try {
    assert.equal(photo.avatarFallbackVisible.value, false);
    await nextTick();
    finish?.('avatar');
    await new Promise(resolve => setImmediate(resolve)); await nextTick();
    assert.equal(photo.avatarFallbackVisible.value, false, 'a cached photo must never be covered by an anonymous icon before its native load event');
  } finally { finish?.('avatar'); photo.stop(); }
});

test('an avatar arriving after login loads without scrolling or another profile refresh', async () => {
  const requests = [];
  const cache = createMediaCache({ urls: ref({}), fetchImage: async key => { requests.push(key); return 'avatar'; }, writeImage: async () => '/authorized-avatar', removeImage() {} });
  const photo = mount('', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  try {
    await nextTick();
    assert.equal(photo.avatarFallbackVisible.value, true);
    assert.deepEqual(requests, []);
    photo.props.src = 'cloud://family/authorized-avatar.png';
    await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick();
    assert.equal(photo.image.value, '/authorized-avatar');
    assert.equal(photo.avatarFallbackVisible.value, false);
    assert.deepEqual(requests, [imageVersion(photo.props.src, 'card')]);
  } finally { photo.stop(); }
});

test('small avatars use the cached card variant and keep a readable fallback on missing or broken files', async () => {
  let fetches = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => { fetches += 1; throw new Error('offline'); }, writeImage: async () => '/avatar', removeImage() {} });
  const photo = mount('cloud://family/avatar.png', cache);
  photo.props.variant = 'card'; photo.props.fallback = '家';
  try {
    await nextTick(); photo.enter(); await nextTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(photo.image.value, '');
    assert.equal(photo.props.fallback, '家');
    assert.ok(fetches > 0);
    const template = readFileSync(new URL('../src/components/LazyImage.vue', import.meta.url), 'utf8');
    assert.match(template, /v-else-if="fallback" class="lazy-photo-fallback">{{ fallback }}/);
    assert.match(template, /v-if="error && !retrying && !fallback && !avatar"/);
    assert.match(template, /round-photo/);
  } finally { photo.stop(); }
});

test('avatar decoding retries do not imply anonymity and exhausted failures use the fallback', async () => {
  let writes = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'avatar', writeImage: async () => `/avatar-${++writes}`, removeImage() {} });
  const photo = mount('cloud://family/avatar.png', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.enter();
    await settle();
    assert.equal(photo.image.value, '/avatar-1');
    assert.equal(photo.avatarFallbackVisible.value, false, 'the native image can render without a silhouette covering its loading state');
    const oldLoad = photo.imageLoaded.value;
    oldLoad({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.imageError.value();
    assert.equal(photo.avatarFallbackVisible.value, false, 'the first decoding failure retries without changing member identity');
    await settle();
    assert.equal(photo.image.value, '/avatar-2');
    oldLoad({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.imageLoaded.value({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.imageError.value();
    await settle();
    assert.equal(photo.failed.value, true);
    assert.equal(photo.avatarFallbackVisible.value, true);
    oldLoad({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, true, 'a delayed successful event cannot hide the current failure');
    assert.equal(writes, 2, 'decoding errors keep the existing one-automatic-retry limit');
  } finally { photo.stop(); }
});

test('missing and unavailable avatars show the anonymous icon without a nickname initial', async () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => { throw new Error('offline'); }, writeImage: async () => '/avatar', removeImage() {} });
  const missing = mount('', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  const broken = mount('cloud://family/avatar.png', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  try {
    assert.equal(missing.avatarFallbackVisible.value, true);
    assert.equal(missing.props.fallback, undefined);
    broken.enter();
    await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick();
    assert.equal(broken.failed.value, true);
    assert.equal(broken.avatarFallbackVisible.value, true);
    assert.equal(broken.props.fallback, undefined);
  } finally { missing.stop(); broken.stop(); }
});

test('updated avatar sources load immediately and ignore delayed events from the old photo', async () => {
  let writes = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'avatar', writeImage: async () => `/avatar-${++writes}`, removeImage() {} });
  const photo = mount('cloud://family/old-avatar.png', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    photo.enter(); await settle();
    const oldLoad = photo.imageLoaded.value;
    oldLoad({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.props.src = 'cloud://family/new-avatar.png';
    await settle();
    assert.equal(photo.image.value, '/avatar-2');
    assert.equal(photo.avatarFallbackVisible.value, false);
    oldLoad({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.imageLoaded.value({ detail: { width: 256, height: 256 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.props.src = '';
    await nextTick();
    assert.equal(photo.image.value, '');
    assert.equal(photo.avatarFallbackVisible.value, true);
  } finally { photo.stop(); }
});

test('returning from a share or family scope refresh does not cover a cached avatar with anonymity', async () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'avatar', writeImage: async () => '/cached-avatar', removeImage() {} });
  const photo = mount('cloud://family/member.png', cache, { avatar: true, round: true, mode: 'aspectFill', variant: 'card' });
  try {
    await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick();
    photo.imageLoaded.value({ detail: { width: 128, height: 128 } });
    assert.equal(photo.avatarFallbackVisible.value, false);
    photo.resetScope();
    await nextTick();
    assert.equal(photo.image.value, '/cached-avatar');
    assert.equal(photo.avatarFallbackVisible.value, false, 'an unchanged image source will not emit another native load event');
  } finally { photo.stop(); }
});

test('scrolling beyond the cache limit does not reload offscreen photos in an eviction loop', async () => {
  let fetches = 0;
  let writes = 0;
  const cache = createMediaCache({ urls: ref({}), maxEntries: 2, fetchImage: async () => { fetches += 1; return 'photo'; }, writeImage: async () => `/photo-${++writes}`, removeImage() {} });
  const photos = Array.from({ length: 140 }, (_, index) => mount(`image-${index}`, cache));
  try {
    let previous;
    for (const [index, photo] of photos.entries()) {
      previous?.leave();
      photo.enter();
      await nextTick();
      await cache.load(imageVersion(`image-${index}`, 'detail'));
      await nextTick();
      assert.ok(photo.image.value);
      assert.equal(photo.disconnects(), 0);
      previous = photo;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fetches, 140);
    assert.equal(writes, 140);
    assert.ok(photos[0].image.value, 'offscreen widthFix image keeps its layout instead of collapsing');
    previous.leave();
    photos[0].enter();
    await nextTick();
    await cache.load(imageVersion('image-0', 'detail'));
    await nextTick();
    assert.equal(fetches, 141);
    assert.equal(photos[0].image.value, '/photo-141');
  } finally { photos.forEach(photo => photo.stop()); }
});

test('tap retry fetches a fresh file after a native image decoding failure', async () => {
  let writes = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => `/photo-${++writes}`, removeImage() {} });
  const photo = mount('photo', cache);
  try {
    photo.enter();
    await nextTick();
    await cache.load(imageVersion('photo', 'detail'));
    await nextTick();
    photo.failed.value = true;
    await photo.retry();
    await nextTick();
    assert.equal(photo.image.value, '/photo-2');
    assert.equal(photo.failed.value, false);
  } finally { photo.stop(); }
});

test('native image errors recover once automatically and stale decode events cannot hide the replacement', async () => {
  let writes = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => `/photo-${++writes}`, removeImage() {} });
  const photo = mount('photo', cache);
  const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    photo.enter();
    await settle();
    const oldError = photo.imageError.value;
    oldError();
    await settle();
    assert.equal(photo.image.value, '/photo-2');
    assert.equal(photo.failed.value, false);
    oldError();
    assert.equal(photo.failed.value, false);
    photo.imageError.value();
    await settle();
    assert.equal(writes, 2);
    assert.equal(photo.failed.value, true);
    await photo.retry();
    assert.equal(writes, 3);
  } finally { photo.stop(); }
});

test('returning to a failed image or restoring network retries only visible images', async () => {
  let offline = true;
  let fetches = 0;
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => { fetches += 1; if (offline) throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); return 'photo'; }, writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('photo', cache);
  const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    photo.enter();
    await settle();
    assert.equal(photo.failed.value, true);
    photo.leave();
    await settle();
    photo.reconnect();
    await settle();
    assert.equal(fetches, 1);
    photo.enter();
    await settle();
    assert.equal(fetches, 2);
    offline = false;
    photo.reconnect();
    await settle();
    assert.equal(photo.image.value, '/photo');
    assert.equal(photo.failed.value, false);
    assert.equal(fetches, 3);
  } finally { photo.stop(); }
});

test('source changes ignore completion and error handlers from an earlier image', async () => {
  let rejectOld;
  const cache = createMediaCache({ urls: ref({}), fetchImage: key => key.includes('old') ? new Promise((resolve, reject) => { rejectOld = reject; }) : Promise.resolve('new'), writeImage: async () => '/new', removeImage() {} });
  const photo = mount('old', cache);
  const settle = async () => { await nextTick(); await new Promise(resolve => setImmediate(resolve)); await nextTick(); };
  try {
    photo.enter();
    await settle();
    const oldError = photo.imageError.value;
    photo.props.src = 'new';
    await settle();
    photo.enter();
    await settle();
    rejectOld(new Error('old failure'));
    oldError();
    await settle();
    assert.equal(photo.image.value, '/new');
    assert.equal(photo.failed.value, false);
  } finally { photo.stop(); }
});

test('intersection-managed images do not add a second native lazy-load gate', () => {
  const component = readFileSync(new URL('../src/components/LazyImage.vue', import.meta.url), 'utf8');
  assert.match(component, /:lazy-load="false"/);
  assert.doesNotMatch(component, /:lazy-load="true"/);
});

test('loaded step photos retain their real dimensions through failure and retries', async () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('photo', cache);
  try {
    photo.enter();
    await nextTick();
    await cache.load(imageVersion('photo', 'detail'));
    await nextTick();
    for (const dimensions of [{ width: 480, height: 960 }, { width: 960, height: 720 }, { width: 960, height: 120 }]) {
      photo.imageLoaded.value({ detail: dimensions });
      const expected = imageFrameStyle(dimensions.width / dimensions.height);
      assert.deepEqual(photo.frameStyle.value, expected);
      photo.failed.value = true;
      assert.deepEqual(photo.frameStyle.value, expected);
      await photo.retry();
      assert.deepEqual(photo.frameStyle.value, expected);
    }
  } finally { photo.stop(); }
});

test('fixed covers and avatars ignore natural image dimensions', () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('photo', cache);
  try {
    photo.props.mode = 'aspectFill';
    photo.imageLoaded.value({ detail: { width: 480, height: 960 } });
    assert.equal(Object.keys(photo.frameStyle.value).length, 0);
    assert.equal(photo.resizes(), 0);
    photo.props.mode = 'widthFix';
    assert.deepEqual(photo.frameStyle.value, {});
  } finally { photo.stop(); }
});

test('source changes clear old geometry and ignore stale load events', async () => {
  const cache = createMediaCache({ urls: ref({}), fetchImage: async () => 'photo', writeImage: async () => '/photo', removeImage() {} });
  const photo = mount('old-photo', cache);
  try {
    photo.imageLoaded.value({ detail: { width: 480, height: 960 } });
    assert.equal(photo.frameStyle.value.paddingTop, '200%');
    assert.equal(photo.resizes(), 1);
    const oldLoad = photo.imageLoaded.value;
    photo.props.src = 'new-photo';
    await nextTick();
    oldLoad({ detail: { width: 480, height: 960 } });
    assert.deepEqual(photo.frameStyle.value, {});
    assert.equal(photo.resizes(), 1);
    for (const dimensions of [{ width: 0, height: 100 }, { width: 100, height: NaN }, { width: Infinity, height: 100 }]) photo.imageLoaded.value({ detail: dimensions });
    assert.deepEqual(photo.frameStyle.value, {});
  } finally { photo.stop(); }
});
