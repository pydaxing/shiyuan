<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import ImageCropSurface from './ImageCropSurface.vue';
import LazyImage from './LazyImage.vue';
import { DEFAULT_FAMILY_COVER, DEFAULT_PERSONAL_COVER } from '../domain/family.js';
import { loadImage, cloudMode, uploadProfileAvatar } from '../services/cloud.js';
import { selectImagePaths, compressNativePhoto, persistSelectedImages } from '../services/images.js';
import { prepareCropSource, releaseCropFile } from '../services/image-crop.js';
const props = defineProps({ value: String, personal: Boolean, avatar: Boolean, disabled: Boolean, familyDraftRequest: { type: String, default: '' } });
const emit = defineEmits(['dirty', 'busy']);
const surface = ref(null);
const source = ref(null);
const error = ref('');
const working = ref(false);
const dirty = ref(false);
const version = ref(0);
const fallback = computed(() => props.value || (props.avatar ? '' : props.personal ? DEFAULT_PERSONAL_COVER : DEFAULT_FAMILY_COVER));
const nativeAvatarPicker = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
let disposed = false;
let request = 0;
let cachedUpload = '';
let revision = 0;
let uploadedRevision = -1;
function markDirty() { dirty.value = true; revision++; emit('dirty', true); }
function releaseSource(value) { if (value) releaseCropFile(value.preview, value.original); }
async function prepare(path, selected = false) {
  const current = ++request;
  working.value = true; emit('busy', true); error.value = '';
  let next;
  try {
    if (!path) { releaseSource(source.value); source.value = null; return; }
    // Cover is the highest-resolution saved crop. An old cover's original may
    // have a different composition and no crop coordinates to restore it.
    const resolved = selected ? path : await loadImage(path, props.avatar ? 'original' : 'cover');
    // getImageInfo localizes remote images before getFileInfo/compression.
    const local = await uni.getImageInfo({ src: resolved });
    next = await prepareCropSource(local.path || resolved, props.avatar ? 'detail' : 'cover', { highResolution: true });
    if (disposed || current !== request) { releaseSource(next); return; }
    releaseSource(source.value);
    source.value = next; version.value++;
    if (selected) markDirty();
  } catch (failure) {
    if (!disposed && current === request) error.value = failure.message || '图片读取失败，请重新选择';
  } finally {
    if (!disposed && current === request) { working.value = false; emit('busy', false); }
  }
}
watch(fallback, value => {
  dirty.value = false; emit('dirty', false); cachedUpload = ''; uploadedRevision = -1;
  void prepare(value);
}, { immediate: true });
async function choose(event) {
  if (working.value || props.disabled) return;
  const path = event.detail?.avatarUrl;
  if (path) await prepare(path, true);
}
async function select() {
  if (working.value || props.disabled || (props.avatar && nativeAvatarPicker)) return;
  working.value = true; emit('busy', true); error.value = '';
  try {
    const [path] = await selectImagePaths();
    if (path && !disposed) await prepare(path, true);
  } catch (failure) { if (!disposed) error.value = failure.message || '选图失败，请重试'; }
  finally { if (!disposed) { working.value = false; emit('busy', false); } }
}
async function save() {
  if (!dirty.value) return props.value || '';
  if (working.value || !surface.value) throw new Error('图片尚未准备好，请稍后再试');
  if (uploadedRevision === revision && cachedUpload) return cachedUpload;
  let cropped = '';
  let thumbnail = '';
  try {
    cropped = await surface.value.exportCrop();
    if (props.avatar) {
      thumbnail = await compressNativePhoto(cropped, 'avatar');
      cachedUpload = cloudMode ? await uploadProfileAvatar(cropped, { cardPath: thumbnail, avatarPath: thumbnail }) : cropped;
    } else {
      [cachedUpload] = await persistSelectedImages([source.value.original], undefined, [{ previewPath: cropped, variant: 'cover' }], props.familyDraftRequest);
    }
    if (!cachedUpload) throw new Error('图片未保存，请重试');
    uploadedRevision = revision;
    return cachedUpload;
  } finally {
    if (cloudMode) {
      releaseCropFile(thumbnail, cropped);
      releaseCropFile(cropped);
    }
  }
}
function reset() {
  dirty.value = false; emit('dirty', false); cachedUpload = ''; uploadedRevision = -1;
  void prepare(fallback.value);
}
defineExpose({ save, reset });
onUnmounted(() => { disposed = true; request++; releaseSource(source.value); });
</script>

<template>
  <view class="inline-photo-editor">
    <ImageCropSurface v-if="source" :key="version" ref="surface" :source="source" :frame="avatar ? 'square' : 'family'" :round="avatar" :disabled="disabled || working" @change="markDirty" />
    <view v-else class="inline-photo-placeholder" :class="{ 'is-round': avatar, 'is-cover': !avatar }">
      <LazyImage v-if="fallback" :src="fallback" :variant="avatar ? 'original' : 'cover'" :avatar="avatar" :round="avatar" />
    </view>
    <text class="inline-photo-hint">{{ working ? '正在准备图片…' : '拖动调整位置 · 双指缩放' }}</text>
    <text v-if="error" class="inline-photo-error" role="alert">{{ error }}</text>
    <button class="inline-photo-select" :aria-label="avatar ? '选择微信头像' : '拍照/相册'" :disabled="disabled || working" :open-type="avatar && nativeAvatarPicker ? 'chooseAvatar' : undefined" @chooseavatar="choose" @click="select" hover-class="touch-feedback">{{ avatar ? '更换头像' : '更换封面' }}</button>
  </view>
</template>

<style scoped>
.inline-photo-editor { width: 100%; }
.inline-photo-placeholder { width: 100%; height: 100vw; overflow: hidden; background: var(--photo-action-surface); }
.inline-photo-placeholder.is-round { border-radius: 50%; }
.inline-photo-placeholder.is-cover { height: 61.8034vw; }
.inline-photo-hint { display: block; text-align: center; margin: 18px 20px 12px; font-size: var(--type-caption); color: rgba(255,255,255,.6); }
.inline-photo-select { display: flex; align-items: center; justify-content: center; min-height: 44px; margin: 0 20px; padding: 0 18px; background: var(--photo-action-surface); color: var(--white); border-radius: var(--radius-control); font-size: var(--type-body); }
.inline-photo-error { display: block; margin: 12px 20px; color: var(--danger); font-size: var(--type-caption); }
</style>
