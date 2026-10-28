<script setup>
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { ref } from 'vue';
import { chooseLocalImages, persistSelectedImages, previewImages, imageUploadLabel } from '../services/images.js';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
const props = defineProps({ modelValue: { type: Array, default: () => [] }, label: String });
const emit = defineEmits(['update:modelValue', 'busy']);
useSheetContentResize();
const busy = ref(false);
const error = ref('');
const pendingPhotos = ref([]);
const failedPaths = ref([]);
async function choose(retry = false) {
  if (busy.value || props.modelValue.length >= 9) return;
  busy.value = true; emit('busy', true); error.value = '';
  try {
    const report = ({ items }) => { pendingPhotos.value = items; };
    const images = retry ? await persistSelectedImages(failedPaths.value, report) : await chooseLocalImages(9 - props.modelValue.length, ['album', 'camera'], report);
    if (images.length) emit('update:modelValue', [...props.modelValue, ...images]);
    failedPaths.value = [];
  } catch (failure) {
    if (failure.images?.length) emit('update:modelValue', [...props.modelValue, ...failure.images]);
    error.value = failure.images?.length ? `部分图片未上传成功：${failure.message}` : failure.message;
    failedPaths.value = failure.failedPaths || [];
  }
  finally { pendingPhotos.value = []; busy.value = false; emit('busy', false); }
}
function preview(image) { void previewImages(props.modelValue, image); }
</script>

<template>
  <view class="step-photo-picker">
    <view class="step-photo-grid">
      <view v-for="(image, index) in modelValue" :key="`${index}-${image}`" class="step-photo-tile">
        <button role="button" class="step-photo-preview" :aria-label="`查看${label}第${index + 1}张`" @click="preview(image)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><LazyImage :src="image" variant="card" mode="aspectFill" /></button>
        <button role="button" class="card-remove" :disabled="busy" :aria-label="`移除${label}第${index + 1}张`" @click="$feedback(); $emit('update:modelValue', modelValue.filter((_, position) => position !== index))" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close-inverse" :size="18" /></button>
      </view>
      <view v-for="photo in pendingPhotos" :key="photo.path" class="step-photo-tile photo-processing-tile"><image :src="photo.preview || photo.path" mode="aspectFill" /><ImageUploadProgress v-if="photo.status !== 'failed'" :value="imageUploadLabel(photo)" compact /></view>
      <button v-if="modelValue.length + pendingPhotos.length < 9" role="button" class="step-photo-add" :aria-label="`添加${label}`" :disabled="busy" @click="choose(false)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="camera" :size="24" active /><text v-if="!busy">添加图片</text></button>
    </view>
    <text v-if="error" class="error-message" role="alert">{{ error }}</text><button v-if="failedPaths.length && !busy" class="text-button" @click="choose(true)" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重试未成功的图片</button>
  </view>
</template>
