<script setup>
import { computed, getCurrentInstance, onMounted, onUnmounted, ref } from 'vue';
import Sheet from './Sheet.vue';
import { coverFrameStyle, cropFocus, cropFromBounds, fitCropImage } from '../domain/image-crop.js';
import { renderImageCrop, releaseCropFile } from '../services/image-crop.js';
import { afterNativeRender } from '../composables/nativeRender.js';

const props = defineProps({ source: Object, frame: { type: String, default: 'recipe' } });
const emit = defineEmits(['confirm', 'cancel']);
const instance = getCurrentInstance();
const viewport = ref(null);
const placement = ref(null);
const zoom = ref(1);
const busy = ref(false);
const error = ref('');
const geometryVersion = ref(0);
const safeBottom = (uni.getWindowInfo?.() || uni.getSystemInfoSync()).safeAreaInsets?.bottom || 0;
const sheetHeight = computed(() => Math.ceil(viewport.value?.height || 260) + 226 + safeBottom);
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
async function confirm() {
  if (busy.value || !placement.value) return;
  busy.value = true; error.value = '';
  try {
    const [frameBounds, imageBounds] = await readBounds();
    if (disposed) return;
    const previewPath = await renderImageCrop(props.source, cropFromBounds(frameBounds, imageBounds));
    if (disposed) releaseCropFile(previewPath, props.source.original);
    else emit('confirm', { previewPath });
  } catch (failure) { if (!disposed) error.value = failure.message || '取景保存失败，请重试'; }
  finally { busy.value = false; }
}
onMounted(() => { void measure(); uni.onWindowResize?.(measure); });
onUnmounted(() => { disposed = true; uni.offWindowResize?.(measure); });
</script>

<template>
  <Sheet :title="frame === 'family' ? '调整首页封面' : '调整图片取景'" :preferred-height="sheetHeight" :fit-content="false" @close="!busy && $emit('cancel')">
    <text class="crop-instruction">单指拖动位置，双指捏合缩放</text>
    <view class="cover-crop-frame" :style="coverFrameStyle(frame)">
      <movable-area v-if="placement" :key="geometryVersion" class="crop-area" :style="areaStyle" :scale-area="true" @touchstart.stop @touchmove.stop @touchend.stop @touchcancel.stop>
        <movable-view class="crop-image" direction="all" :x="placement.x" :y="placement.y" :style="imageStyle" :inertia="false" :out-of-bounds="false" :animation="false" :disabled="busy" :scale="true" :scale-min="1" :scale-max="3" :scale-value="zoom" aria-label="图片取景，单指拖动，双指缩放">
          <image :src="source.preview" mode="scaleToFill" class="crop-photo" :draggable="false" />
        </movable-view>
      </movable-area>
      <view class="crop-guide" aria-hidden="true"><view class="crop-guide-horizontal" /><view class="crop-guide-vertical" /></view>
      <view v-if="busy" class="crop-busy-mask" @touchstart.stop.prevent @touchmove.stop.prevent @touchend.stop.prevent />
    </view>
    <text class="crop-note">{{ frame === 'family' ? '取景比例与首页一致，原图会保留。' : '取景比例与封面展示一致，点开图片仍可查看原图。' }}</text>
    <text v-if="error" class="error-message" role="alert">{{ error }}</text>
    <template #footer><view class="crop-footer"><button role="button" class="secondary-button" :disabled="busy" @click="$emit('cancel')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">取消</button><button role="button" class="primary-button" :disabled="busy || !placement" :aria-busy="busy" @click="confirm" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '正在处理…' : '使用此取景' }}</button></view></template>
  </Sheet>
</template>

<style scoped>
.crop-instruction { display: block; margin: 0 0 14px; text-align: center; color: var(--ink); font-size: var(--type-control); }
.cover-crop-frame { position: relative; width: 100%; overflow: hidden; border-radius: var(--radius-card); background: var(--paper); touch-action: none; }
.crop-area { position: absolute; top: 0; left: 0; overflow: hidden; }
.crop-photo { display: block; width: 100%; height: 100%; pointer-events: none; }
.crop-guide { position: absolute; inset: 0; pointer-events: none; border: 1px solid rgba(255, 255, 255, .7); border-radius: inherit; }
.crop-guide-horizontal { position: absolute; inset: 33.333% 0; border-top: 1px solid rgba(255, 255, 255, .45); border-bottom: 1px solid rgba(255, 255, 255, .45); }
.crop-guide-vertical { position: absolute; inset: 0 33.333%; border-left: 1px solid rgba(255, 255, 255, .45); border-right: 1px solid rgba(255, 255, 255, .45); }
.crop-busy-mask { position: absolute; inset: 0; z-index: 2; }
.crop-note { display: block; margin-top: 14px; text-align: center; font-size: var(--type-caption); color: var(--muted); }
.crop-footer { display: flex; gap: 12px; }
.crop-footer > .secondary-button, .crop-footer > .primary-button { flex: 1; min-width: 0; }
</style>
