<script setup>
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { computed, ref, watch } from 'vue';
import { selectImagePaths, persistSelectedImages, previewImages, imageUploadLabel } from '../services/images.js';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
const props = defineProps({ modelValue: { type: Array, default: () => [] }, fallbackImages: { type: Array, default: () => [] }, reservedCount: { type: Number, default: 0 }, label: String, purpose: { type: String, default: '' }, variant: String, iconOnly: Boolean, disabled: Boolean });
const emit = defineEmits(['update:modelValue', 'busy', 'incomplete']);
useSheetContentResize();
const choosing = ref(false);
const entries = ref(props.modelValue.map((image, index) => ({ id: `saved-${index}`, image, status: 'done' })));
const busy = computed(() => choosing.value || entries.value.some(item => item.status === 'uploading'));
const error = ref('');
const pendingPhotos = computed(() => entries.value.filter(item => item.status !== 'done'));
const failedPaths = computed(() => entries.value.filter(item => item.status === 'failed').map(item => item.path));
const capacity = computed(() => Math.max(0, 9 - (props.reservedCount || 0) - entries.value.length));
const visibleFallbacks = computed(() => !entries.value.length ? (props.fallbackImages || []).slice(0, 9) : []);
watch(() => props.modelValue, value => {
  const saved = entries.value.filter(item => item.status === 'done').map(item => item.image);
  if (value.length === saved.length && value.every((image, index) => image === saved[index])) return;
  if (!busy.value && !pendingPhotos.value.length) entries.value = value.map((image, index) => ({ id: `saved-${index}`, image, status: 'done' }));
}, { flush: 'sync' });
let sequence = 0;
let reportedBusy = false;
function reportBusy() {
  if (reportedBusy === busy.value) return;
  reportedBusy = busy.value;
  emit('busy', reportedBusy);
}
function publish() {
  emit('update:modelValue', entries.value.filter(item => item.status === 'done').map(item => item.image));
  emit('incomplete', pendingPhotos.value.length > 0);
  reportBusy();
}
async function upload(entry) {
  entry.status = 'uploading';
  publish();
  try {
    const images = await persistSelectedImages([entry.path], ({ items }) => {
      const status = items[0];
      if (status) Object.assign(entry, { preview: status.preview, progress: status.progress, stage: status.status });
    }, [], '', props.purpose);
    entry.image = images[0];
    entry.status = 'done';
  } catch (failure) {
    entry.status = 'failed';
    error.value = failure.message || '照片上传失败，请重试';
  } finally { publish(); }
}
async function choose(retry = false) {
  if (props.disabled || choosing.value) return;
  error.value = '';
  if (retry) {
    entries.value.filter(item => item.status === 'failed').forEach(item => { void upload(item); });
    return;
  }
  if (!capacity.value) return;
  choosing.value = true; reportBusy();
  try {
    const paths = await selectImagePaths(capacity.value, ['album', 'camera']);
    for (const path of paths.slice(0, capacity.value)) {
      entries.value.push({ id: `photo-${++sequence}`, path, image: '', status: 'uploading', stage: 'processing', progress: 0 });
      void upload(entries.value[entries.value.length - 1]);
    }
  } catch (failure) { error.value = failure.message; }
  finally { choosing.value = false; reportBusy(); }
}
function removeEntry(id) {
  if (props.disabled) return;
  const entry = entries.value.find(item => item.id === id);
  if (!entry || entry.status === 'uploading') return;
  entries.value = entries.value.filter(item => item.id !== id);
  if (!failedPaths.value.length) error.value = '';
  publish();
}
function preview(image) { void previewImages(props.modelValue, image); }
function previewFallback(image) { void previewImages(props.fallbackImages || [], image); }
function remove(index) {
  const entry = entries.value.filter(item => item.status === 'done')[index];
  if (entry) removeEntry(entry.id);
}
</script>

<template>
  <view class="step-photo-picker" :class="{ 'is-meal': variant === 'meal' }">
    <view class="step-photo-grid">
      <view v-for="(image, index) in visibleFallbacks" :key="`fallback-${index}-${image}`" class="step-photo-tile step-photo-fallback">
        <button role="button" class="step-photo-preview" :aria-label="`查看餐单照片第${index + 1}张`" @click="previewFallback(image)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><LazyImage :src="image" variant="card" mode="aspectFill" /></button>
      </view>
      <view v-for="(photo, index) in entries" :key="photo.id" class="step-photo-tile" :class="{ 'photo-processing-tile': photo.status !== 'done' }">
        <button v-if="photo.status === 'done'" role="button" class="step-photo-preview" :aria-label="`查看${label}第${index + 1}张`" @click="preview(photo.image)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><LazyImage :src="photo.image" variant="card" mode="aspectFill" /></button>
        <image v-else :src="photo.preview || photo.path" mode="aspectFill" />
        <ImageUploadProgress v-if="photo.status === 'uploading'" :value="imageUploadLabel({ ...photo, status: photo.stage })" compact />
        <button v-if="photo.status !== 'uploading'" role="button" class="card-remove" :disabled="disabled" :aria-label="`移除${label}第${index + 1}张`" @click="$feedback(); removeEntry(photo.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close-inverse" :size="18" /></button>
      </view>
      <button v-if="capacity > 0" role="button" class="step-photo-add" :aria-label="`添加${label}`" :disabled="choosing || disabled" @click="choose(false)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view v-if="variant === 'meal' || iconOnly" class="meal-photo-plus" aria-hidden="true" /><text v-if="variant === 'meal'" class="meal-photo-label">实拍</text><template v-if="variant !== 'meal' && !iconOnly"><AppIcon name="camera" :size="24" active /><text v-if="!busy">添加图片</text></template></button>
    </view>
    <text v-if="!capacity" class="muted">最多 9 张图片（含菜品图）</text><text v-if="error" class="error-message" role="alert">{{ error }}</text><button v-if="failedPaths.length" class="text-button" :disabled="disabled" @click="choose(true)" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重试未成功的图片</button>
  </view>
</template>

<style scoped>
.step-photo-picker.is-meal { --step-photo-size: var(--meal-photo-size, 96px); }
.is-meal .step-photo-grid { gap: 6px; }
.is-meal .step-photo-tile, .is-meal .step-photo-add { border-radius: 3px; }
.is-meal .step-photo-add { border: 0; background: var(--control-surface); color: var(--muted); }
.meal-photo-label { font-size: var(--type-caption); line-height: 18px; }
.meal-photo-plus { position: relative; width: 30px; height: 30px; }
.meal-photo-plus::before, .meal-photo-plus::after { content: ''; position: absolute; background: currentColor; border-radius: 1px; }
.meal-photo-plus::before { top: 14px; left: 0; width: 30px; height: 2px; }
.meal-photo-plus::after { top: 0; left: 14px; width: 2px; height: 30px; }
</style>
