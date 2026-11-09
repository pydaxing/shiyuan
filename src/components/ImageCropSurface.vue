<script setup>
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import { coverFrameStyle, cropFocus, cropFromBounds, fitCropImage } from '../domain/image-crop.js';
import { renderImageCrop, releaseCropFile } from '../services/image-crop.js';
import { afterNativeRender } from '../composables/nativeRender.js';

const props = defineProps({ source: Object, frame: { type: String, default: 'recipe' }, round: Boolean, disabled: Boolean });
const emit = defineEmits(['change']);
const instance = getCurrentInstance();
const viewport = ref(null);
const placement = ref(null);
const zoom = ref(1);
const busy = ref(false);
const error = ref('');
const geometryVersion = ref(0);
let touching = false;
let disposed = false;
let measuring = 0;
const imageStyle = computed(() => placement.value ? { width: `${placement.value.width}px`, height: `${placement.value.height}px` } : {});
const areaStyle = computed(() => viewport.value ? { width: `${viewport.value.width}px`, height: `${viewport.value.height}px` } : {});
async function readBounds() {
  await afterNativeRender();
  if (disposed) throw new Error('取景已关闭');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('无法读取图片位置，请重试')), 1500);
    try {
      const query = uni.createSelectorQuery().in(instance.proxy);
      query.select('.cover-crop-frame').boundingClientRect();
      query.select('.crop-photo').boundingClientRect();
      query.exec(regions => { clearTimeout(timer); resolve(regions || []); });
    } catch (failure) { clearTimeout(timer); reject(failure); }
  });
}
async function measure() {
  if (disposed || busy.value) return;
  const request = ++measuring;
  try {
    const [frameBounds, imageBounds] = await readBounds();
    if (disposed || request !== measuring || !frameBounds?.width || !frameBounds?.height) return;
    if (viewport.value?.width === frameBounds.width && viewport.value?.height === frameBounds.height) return;
    const center = imageBounds?.width && viewport.value ? cropFocus(imageBounds, viewport.value, { x: imageBounds.left - frameBounds.left, y: imageBounds.top - frameBounds.top }) : undefined;
    zoom.value = placement.value && imageBounds?.width ? Math.min(3, Math.max(1, imageBounds.width / placement.value.width)) : 1;
    viewport.value = { width: frameBounds.width, height: frameBounds.height };
    const base = fitCropImage(props.source, viewport.value);
    const positioned = fitCropImage(props.source, viewport.value, zoom.value, center);
    placement.value = { ...base, x: positioned.x, y: positioned.y };
    geometryVersion.value += 1;
  } catch (failure) { if (!disposed && request === measuring) error.value = failure.message; }
}
async function exportCrop() {
  if (busy.value || !placement.value) throw new Error('图片尚未准备好，请稍后再试');
  busy.value = true; error.value = '';
  try {
    const [frameBounds, imageBounds] = await readBounds();
    const path = await renderImageCrop(props.source, cropFromBounds(frameBounds, imageBounds));
    if (disposed) { releaseCropFile(path, props.source.original); throw new Error('取景已关闭'); }
    return path;
  } finally { busy.value = false; }
}
function changed(event) {
  if (['touch', 'touch-out-of-bounds'].includes(event.detail?.source)) emit('change');
}
function scaled() { if (touching) emit('change'); }
defineExpose({ exportCrop });
onMounted(() => { void measure(); uni.onWindowResize?.(measure); });
onUnmounted(() => { disposed = true; uni.offWindowResize?.(measure); });
</script>

<template>
    <view class="cover-crop-frame" :class="{ 'is-round': round }" :style="coverFrameStyle(frame)">
      <movable-area v-if="placement" :key="geometryVersion" class="crop-area" :style="areaStyle" :scale-area="true" @touchstart.stop="touching = true" @touchmove.stop @touchend.stop="touching = false" @touchcancel.stop="touching = false">
        <movable-view class="crop-image" direction="all" :x="placement.x" :y="placement.y" :style="imageStyle" :inertia="false" :out-of-bounds="false" :animation="false" :disabled="busy || disabled" @change="changed" @scale="scaled" :scale="!disabled && !busy" :scale-min="1" :scale-max="3" :scale-value="zoom" aria-label="图片取景，单指拖动，双指缩放">
          <image :src="source.preview" mode="aspectFill" class="crop-photo" :style="imageStyle" :draggable="false" />
        </movable-view>
      </movable-area>
      <view class="crop-guide" aria-hidden="true"><view class="crop-guide-horizontal" /><view class="crop-guide-vertical" /></view>
      <view v-if="busy" class="crop-busy-mask" @touchstart.stop.prevent @touchmove.stop.prevent @touchend.stop.prevent />
    </view>
<text v-if="error" class="error-message">{{ error }}</text>
</template>

<style scoped>
.cover-crop-frame { position: relative; width: 100%; overflow: hidden; border-radius: 0; background: var(--paper); touch-action: none; }
.crop-area { position: absolute; top: 0; left: 0; overflow: hidden; }
.crop-photo { display: block; width: 100%; height: 100%; pointer-events: none; }
.crop-guide { position: absolute; inset: 0; pointer-events: none; border: 0.5px solid rgba(255, 255, 255, .42); border-radius: inherit; }
.crop-guide-horizontal { position: absolute; inset: 33.333% 0; border-top: 0.5px solid rgba(255, 255, 255, .3); border-bottom: 0.5px solid rgba(255, 255, 255, .3); }
.crop-guide-vertical { position: absolute; inset: 0 33.333%; border-left: 0.5px solid rgba(255, 255, 255, .3); border-right: 0.5px solid rgba(255, 255, 255, .3); }
.crop-busy-mask { position: absolute; inset: 0; z-index: 2; }
.cover-crop-frame.is-round { border-radius: 50%; clip-path: circle(50% at 50% 50%); }
</style>
