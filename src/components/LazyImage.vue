<script setup>
import { computed, getCurrentInstance, inject, onMounted, onUnmounted, ref, watch, nextTick } from 'vue';
import { resolveImage, peekImage, loadImage, mediaFailures, mediaRecovery, mediaScopeRevision } from '../services/cloud.js';
import { imageVersion } from '../domain/image-variants.js';
import { imageFrameStyle } from '../domain/image-crop.js';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { afterNativeRender } from '../composables/nativeRender.js';
const props = defineProps({ src: String, mode: { type: String, default: 'aspectFill' }, variant: { type: String, default: 'card' }, round: Boolean, thumbnail: Boolean, avatar: Boolean, fallback: String });
const resizeSheet = useSheetContentResize(() => props.mode === 'widthFix');
const sheetReady = inject('sheetReady', null);
const visible = ref(false);
const failed = ref(false);
const retrying = ref(false);
const lastImage = ref('');
const naturalRatio = ref(0);
const frameStyle = computed(() => props.mode === 'widthFix' ? imageFrameStyle(naturalRatio.value) : {});
let sequence = 0;
let automaticRetries = 0;
let brokenFile = false;
let disposed = false;
const instance = getCurrentInstance();
function imageDemand() {
  const token = sequence;
  return () => !disposed && visible.value && token === sequence;
}
const image = computed(() => visible.value ? resolveImage(props.src, props.variant, { isNeeded: imageDemand() }) : peekImage(props.src, props.variant) || lastImage.value);
const imageLoaded = computed(() => {
  const path = image.value;
  const token = sequence;
  return event => {
    if (disposed || token !== sequence || path !== image.value) return;
    const width = Number(event?.detail?.width);
    const height = Number(event?.detail?.height);
    if (props.mode === 'widthFix' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) naturalRatio.value = width / height;
    resizeSheet();
  };
});
watch(image, path => { if (path) { lastImage.value = path; failed.value = false; } });
const error = computed(() => visible.value && (failed.value || mediaFailures.value[imageVersion(props.src, props.variant)]));
const avatarFallbackVisible = computed(() => Boolean(props.avatar && (!props.src || error.value)));
const imageError = computed(() => {
  const path = image.value;
  const token = sequence;
  return () => {
    if (disposed || token !== sequence || path !== image.value) return;
    failed.value = true;
    brokenFile = true;
    if (visible.value && !retrying.value && automaticRetries < 1) {
      automaticRetries += 1;
      void recover(true);
    }
  };
});
let observer;
function observe() {
  observer?.disconnect();
  if (disposed || (sheetReady && !sheetReady.value)) return;
  if (props.avatar || !uni.createIntersectionObserver) { visible.value = true; return; }
  observer = uni.createIntersectionObserver(instance.proxy, { nativeMode: !sheetReady });
  observer.relativeToViewport({ top: 240, bottom: 240 }).observe('.lazy-photo', result => {
    visible.value = result.intersectionRatio > 0;
  });
}
async function observeAfterRender() {
  await afterNativeRender();
  observe();
}
onMounted(() => { if (sheetReady?.value) void observeAfterRender(); else observe(); });
if (sheetReady) watch(sheetReady, ready => { if (ready) void observeAfterRender(); });
async function resetImage() {
  const token = ++sequence;
  visible.value = false;
  lastImage.value = '';
  naturalRatio.value = 0;
  failed.value = false;
  retrying.value = false;
  automaticRetries = 0;
  brokenFile = false;
  await nextTick();
  if (!disposed && token === sequence) observe();
}
watch(() => [props.src, props.variant], resetImage, { flush: 'sync' });
watch(visible, entered => {
  if (!entered) return;
  automaticRetries = 0;
  void recover(brokenFile);
});
watch(mediaRecovery, () => { if (visible.value && error.value) { automaticRetries = 0; void recover(brokenFile); } });
watch(mediaScopeRevision, resetImage, { flush: 'sync' });
async function recover(force = false) {
  if (!props.src || retrying.value) return;
  const token = sequence;
  retrying.value = true;
  failed.value = false;
  try {
    const path = await loadImage(props.src, props.variant, { force, isNeeded: imageDemand() });
    if (disposed || token !== sequence) return;
    if (path) { lastImage.value = path; failed.value = false; brokenFile = false; }
  }
  catch { if (!disposed && token === sequence) failed.value = true; }
  finally { if (!disposed && token === sequence) retrying.value = false; }
}
function retry() { automaticRetries = 0; return recover(true); }
onUnmounted(() => { disposed = true; sequence += 1; observer?.disconnect(); });
</script>

<template>
  <view class="lazy-photo" :class="{ 'natural-photo': mode === 'widthFix', 'sized-photo': mode === 'widthFix' && naturalRatio, 'round-photo': round, 'thumbnail-photo': thumbnail, 'has-fallback': fallback || avatar }" :style="frameStyle">
    <image v-if="image && !failed" :key="image" class="lazy-photo-image" :src="image" :mode="mode" :lazy-load="false" @load="imageLoaded" @error="imageError" />
    <text v-else-if="fallback" class="lazy-photo-fallback">{{ fallback }}</text>
    <view v-else-if="!avatar" class="lazy-photo-placeholder" />
    <view v-if="avatarFallbackVisible" class="lazy-avatar-fallback" aria-hidden="true"><view class="lazy-avatar-head" /><view class="lazy-avatar-shoulders" /></view>
    <view v-if="error && !retrying && !fallback && !avatar" role="button" aria-label="重新加载图片" class="lazy-photo-retry" @click.stop="retry">轻触重试</view>
  </view>
</template>

<style scoped>
.lazy-photo { position: relative; display: block; width: 100%; height: 100%; min-height: 0; overflow: hidden; border-radius: inherit; background: var(--paper); }
.lazy-photo-image { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
.thumbnail-photo, .thumbnail-photo .lazy-photo-image, .thumbnail-photo .lazy-photo-placeholder, .thumbnail-photo .lazy-photo-retry { border-radius: var(--food-photo-radius); }
.round-photo, .round-photo .lazy-photo-image, .round-photo .lazy-photo-placeholder, .round-photo .lazy-photo-retry { border-radius: 50%; }
.natural-photo { height: auto; min-height: 132px; }
.natural-photo .lazy-photo-image { position: relative; height: auto; }
.natural-photo.sized-photo .lazy-photo-image { position: absolute; height: 100%; }
.lazy-photo-placeholder { min-height: 160px; }
.has-fallback { background: transparent; }
.lazy-photo-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: inherit; font-size: inherit; }
.lazy-avatar-fallback { position: absolute; inset: 0; border-radius: 50%; background: var(--paper); color: var(--avatar-placeholder-ink); pointer-events: none; }
.lazy-avatar-head { position: absolute; top: 18%; left: 36%; width: 28%; height: 28%; box-sizing: border-box; border: 1.25px solid currentColor; border-radius: 50%; background: transparent; }
.lazy-avatar-shoulders { position: absolute; bottom: 18%; left: 23%; width: 54%; height: 27%; box-sizing: border-box; border: 1.25px solid currentColor; border-bottom: 0; border-radius: 999px 999px 0 0; background: transparent; }
.lazy-photo-retry { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: var(--type-control); background: var(--paper); }
</style>
