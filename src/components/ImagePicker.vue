<script setup>
import { computed, onUnmounted, ref } from 'vue';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { chooseLocalImage, imageUploadLabel } from '../services/images.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import { prepareCropSource, releaseCropFile } from '../services/image-crop.js';
import ImageCropper from './ImageCropper.vue';
import ImageCropSurface from './ImageCropSurface.vue';
import FamilyCoverImage from './FamilyCoverImage.vue';
import LazyImage from './LazyImage.vue';
import AppIcon from './AppIcon.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
const props = defineProps({ modelValue: { type: String, default: '' }, label: { type: String, default: '添加图片' }, caption: { type: String, default: '拍照/相册' }, captionError: Boolean, fallback: { type: String, default: '' }, frame: { type: String, default: 'recipe' }, familyDraftRequest: { type: String, default: '' }, validationError: { type: String, default: '' }, inlineCrop: Boolean, emptyCover: Boolean, compact: Boolean, disabled: Boolean });
const emit = defineEmits(['update:modelValue', 'busy']);
useSheetContentResize();
const busy = ref(false);
const error = ref('');
const progress = ref('0%');
const preview = ref('');
const cropSource = ref(null);
const cropSurface = ref(null);
const cropSaving = ref(false);
async function confirmInlineCrop() {
  if (cropSaving.value || !cropSurface.value) return;
  cropSaving.value = true; error.value = '';
  try { const previewPath = await cropSurface.value.exportCrop(); if (!disposed) cropFinish?.({ previewPath }); else releaseCropFile(previewPath); }
  catch (failure) { if (!disposed) error.value = failure.message || '取景处理失败，请重试'; }
  finally { cropSaving.value = false; }
}
const frameKind = computed(() => props.compact ? 'square' : props.frame);
const familyCover = computed(() => frameKind.value === 'family');
const defaultCover = computed(() => !props.compact && !preview.value && !props.modelValue && Boolean(familyCover.value || props.fallback || props.emptyCover));
let cropFinish;
let source;
let croppedPath;
let disposed = false;
function release() {
  releaseCropFile(croppedPath, source?.original);
  if (source) releaseCropFile(source.preview, source.original);
  croppedPath = ''; source = null;
}
async function requestCrop(path) {
  progress.value = '0%';
  dismissFocusedKeyboard();
  source = await prepareCropSource(path, familyCover.value ? 'cover' : undefined);
  if (disposed) { release(); return null; }
  cropSource.value = source;
  return new Promise(resolve => {
    cropFinish = result => {
      croppedPath = result?.previewPath || '';
      cropSource.value = null;
      cropFinish = null;
      resolve(result ? { ...result, variant: familyCover.value ? 'cover' : 'detail' } : result);
    };
  });
}
function updateProgress({ items }) { preview.value = items?.[0]?.preview || ''; progress.value = imageUploadLabel(items?.[0]); }
async function choose() {
  if (busy.value || props.disabled) return;
  busy.value = true;
  emit('busy', true);
  error.value = '';
  progress.value = '0%';
  try {
    const image = await chooseLocalImage(['album', 'camera'], updateProgress, requestCrop, props.familyDraftRequest);
    if (image && !disposed) emit('update:modelValue', image);
  } catch (failure) { if (!disposed) error.value = failure.message; }
  finally { release(); preview.value = ''; busy.value = false; if (!disposed) emit('busy', false); }
}
onUnmounted(() => { disposed = true; cropFinish?.(null); release(); });
</script>

<template>
  <view class="image-picker cover-image-picker" :class="{ 'compact-image-picker': compact, 'family-cover-picker': familyCover }">
    <view v-if="!inlineCrop || !cropSource" class="image-picker-frame">
    <button role="button" class="image-upload" :class="{ filled: preview || modelValue || fallback || familyCover }" :style="coverFrameStyle(frameKind)" :aria-label="label" :aria-invalid="Boolean(error || validationError)" :disabled="busy || disabled" @click="choose" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
      <image v-if="preview" :src="preview" mode="aspectFill" class="upload-preview" />
      <FamilyCoverImage v-else-if="familyCover" :src="modelValue || fallback" variant="cover" />
      <view v-else-if="modelValue || fallback" class="upload-preview"><LazyImage :src="modelValue || fallback" variant="detail" mode="aspectFill" /></view>
      <image v-else-if="emptyCover && !compact" class="upload-preview upload-placeholder" src="/static/cover-upload-background.jpg" mode="aspectFill" aria-hidden="true" />
      <view v-if="defaultCover" class="upload-default-tint" aria-hidden="true" />
      <view v-if="!busy" class="upload-caption" aria-hidden="true"><AppIcon name="camera-inverse" :size="compact ? 14 : 16" /><text v-if="!compact" class="upload-caption-label" :style="captionError ? 'color: #ef8e83' : ''">{{ caption }}</text></view>
    </button>
    <ImageUploadProgress v-if="busy" :value="progress" :compact="compact" />
    </view>
    <text v-if="error || validationError" class="error-message" role="alert">{{ error || validationError }}</text>
    <view v-if="inlineCrop && cropSource" class="image-picker-inline-crop">
      <ImageCropSurface ref="cropSurface" :source="cropSource" :frame="frameKind" :disabled="cropSaving" />
      <text class="inline-crop-hint">拖动调整位置 · 双指缩放</text>
      <view class="inline-crop-actions"><button class="secondary-button" :disabled="cropSaving" @click="cropFinish?.(null)">取消</button><button class="primary-button" :disabled="cropSaving" @click="confirmInlineCrop">{{ cropSaving ? '正在处理…' : '确认' }}</button></view>
    </view>
    <ImageCropper v-if="cropSource && !inlineCrop" :source="cropSource" :frame="frameKind" @confirm="cropFinish?.($event)" @cancel="cropFinish?.(null)" />
  </view>
</template>

<style scoped>
.inline-crop-hint { display: block; margin: 12px 0; text-align: center; color: var(--muted); font-size: var(--type-caption); }
.inline-crop-actions { display: flex; gap: 12px; padding: 0 20px 16px; }
.inline-crop-actions > .secondary-button, .inline-crop-actions > .primary-button { flex: 1; }
.image-picker-frame { position: relative; }
.cover-image-picker .image-upload { display: block; padding: 0; border: 0; }
.cover-image-picker .upload-placeholder { pointer-events: none; }
.upload-default-tint { position: absolute; inset: 0; border-radius: inherit; background: var(--paper); opacity: .42; pointer-events: none; }
.cover-image-picker:not(.compact-image-picker) .upload-caption { top: 50%; left: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%); width: auto; min-width: 128px; height: 44px; gap: 8px; padding: 0 16px; border-radius: 999px; background: var(--photo-action-surface); }
.upload-caption-label { font-family: var(--font-body); font-size: var(--type-control); font-weight: 500; line-height: 20px; white-space: nowrap; }
</style>
