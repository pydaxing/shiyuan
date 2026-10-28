<script setup>
import { computed, onUnmounted, ref } from 'vue';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { chooseLocalImage, imageUploadLabel } from '../services/images.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import { prepareCropSource, releaseCropFile } from '../services/image-crop.js';
import ImageCropper from './ImageCropper.vue';
import FamilyCoverImage from './FamilyCoverImage.vue';
import LazyImage from './LazyImage.vue';
import AppIcon from './AppIcon.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
const props = defineProps({ modelValue: { type: String, default: '' }, label: { type: String, default: '添加图片' }, fallback: { type: String, default: '' }, frame: { type: String, default: 'recipe' }, familyDraftRequest: { type: String, default: '' }, validationError: { type: String, default: '' }, emptyCover: Boolean, compact: Boolean, disabled: Boolean });
const emit = defineEmits(['update:modelValue', 'busy']);
useSheetContentResize();
const busy = ref(false);
const error = ref('');
const progress = ref('0%');
const preview = ref('');
const cropSource = ref(null);
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
  source = await prepareCropSource(path);
  if (disposed) { release(); return null; }
  cropSource.value = source;
  return new Promise(resolve => {
    cropFinish = result => {
      croppedPath = result?.previewPath || '';
      cropSource.value = null;
      cropFinish = null;
      resolve(result);
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
    <view class="image-picker-frame">
    <button role="button" class="image-upload" :class="{ filled: preview || modelValue || fallback || familyCover }" :style="coverFrameStyle(frameKind)" :aria-label="label" :aria-invalid="Boolean(error || validationError)" :disabled="busy || disabled" @click="choose" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
      <image v-if="preview" :src="preview" mode="aspectFill" class="upload-preview" />
      <FamilyCoverImage v-else-if="familyCover" :src="modelValue || fallback" variant="detail" />
      <view v-else-if="modelValue || fallback" class="upload-preview"><LazyImage :src="modelValue || fallback" variant="detail" mode="aspectFill" /></view>
      <image v-else-if="emptyCover && !compact" class="upload-preview upload-placeholder" src="/static/cover-upload-background.jpg" mode="aspectFill" aria-hidden="true" />
      <view v-if="defaultCover" class="upload-default-tint" aria-hidden="true" />
      <view v-if="!busy" class="upload-caption" aria-hidden="true"><AppIcon name="camera-inverse" :size="compact ? 14 : 16" /><text v-if="!compact" class="upload-caption-label">拍照/相册</text></view>
    </button>
    <ImageUploadProgress v-if="busy" :value="progress" :compact="compact" />
    </view>
    <text v-if="error || validationError" class="error-message" role="alert">{{ error || validationError }}</text>
    <ImageCropper v-if="cropSource" :source="cropSource" :frame="frameKind" @confirm="cropFinish?.($event)" @cancel="cropFinish?.(null)" />
  </view>
</template>

<style scoped>
.image-picker-frame { position: relative; }
.cover-image-picker .image-upload { display: block; padding: 0; border: 0; }
.cover-image-picker .upload-placeholder { pointer-events: none; }
.upload-default-tint { position: absolute; inset: 0; border-radius: inherit; background: var(--paper); opacity: .42; pointer-events: none; }
.cover-image-picker:not(.compact-image-picker) .upload-caption { top: 50%; left: 50%; right: auto; bottom: auto; transform: translate(-50%, -50%); width: auto; min-width: 128px; height: 44px; gap: 8px; padding: 0 16px; border-radius: 999px; background: var(--photo-action-surface); }
.upload-caption-label { font-family: var(--font-body); font-size: var(--type-control); font-weight: 500; line-height: 20px; white-space: nowrap; }
</style>
