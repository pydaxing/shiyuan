<script setup>
import { ref } from 'vue';
import AppIcon from './AppIcon.vue';
import FormField from './FormField.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
import { chooseLocalImage, compressNativePhoto, selectImagePaths, imageUploadLabel } from '../services/images.js';
import { cloudMode, uploadProfileAvatar } from '../services/cloud.js';
const props = defineProps({ name: String, avatar: String, nameError: String, disabled: Boolean });
const emit = defineEmits(['update:name', 'update:avatar', 'busy']);
const nativeAvatarPicker = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
const preview = ref('');
const pendingPreview = ref('');
const progress = ref('0%');
const uploading = ref(false);
const nicknameFocused = ref(false);
const nicknameField = ref(null);
const uploadError = ref('');
defineExpose({ reveal() { nicknameField.value?.reveal(); } });
function blurNickname(event) {
  nicknameFocused.value = false;
  if (typeof event.detail?.value === 'string') emit('update:name', event.detail.value);
}
async function uploadAvatar(path) {
  pendingPreview.value = path;
  const thumbnail = await compressNativePhoto(path, 'card');
  pendingPreview.value = thumbnail;
  const fileId = await uploadProfileAvatar(path, { cardPath: thumbnail, onStage: stage => { progress.value = imageUploadLabel(stage); } });
  progress.value = '100%';
  preview.value = thumbnail;
  emit('update:avatar', fileId);
}
async function choosePhoto() {
  if (nativeAvatarPicker || uploading.value || props.disabled) return;
  uploadError.value = '';
  progress.value = '0%'; uploading.value = true; emit('busy', true);
  try {
    if (cloudMode) {
      const [path] = await selectImagePaths();
      if (path) await uploadAvatar(path);
    } else {
      const image = await chooseLocalImage(['album', 'camera'], ({ items }) => { pendingPreview.value = items?.[0]?.preview || items?.[0]?.path || ''; progress.value = imageUploadLabel(items?.[0]); });
      if (image) { preview.value = image; emit('update:avatar', image); }
    }
  } catch (error) { uploadError.value = error.message || '头像上传失败，请重试'; }
  finally { pendingPreview.value = ''; uploading.value = false; emit('busy', false); }
}
async function choose(event) {
  if (!event.detail?.avatarUrl || uploading.value || props.disabled) return;
  uploadError.value = '';
  progress.value = '0%'; uploading.value = true; emit('busy', true);
  try {
    await uploadAvatar(event.detail.avatarUrl);
  } catch (error) { uploadError.value = error.message || '头像上传失败，请重试'; }
  finally { pendingPreview.value = ''; uploading.value = false; emit('busy', false); }
}
</script>

<template>
  <view class="profile-fields">
    <view class="profile-photo-actions">
      <button role="button" class="profile-avatar-button" :class="{ 'is-uploading': uploading }" :aria-label="uploading ? '头像上传中' : '编辑头像'" :aria-busy="uploading" :disabled="uploading || disabled" :open-type="nativeAvatarPicker ? 'chooseAvatar' : undefined" @click="choosePhoto" @chooseavatar="choose" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <view class="profile-avatar-portrait">
          <view class="profile-avatar-frame"><image class="profile-avatar-image" v-if="pendingPreview || preview || avatar" :src="pendingPreview || preview || $image(avatar)" mode="aspectFill" /><text v-else class="avatar">我</text><ImageUploadProgress v-if="uploading" :value="progress" compact /></view>
          <view v-if="!uploading" class="profile-avatar-camera" aria-hidden="true"><AppIcon name="camera-inverse" :size="12" /></view>
        </view>
      </button>
    </view>
    <text v-if="uploadError" class="field-error profile-upload-error" role="alert">{{ uploadError }}</text>
    <view class="field-label profile-nickname-field" @click.stop>
      <text class="subheading profile-field-heading">昵称</text>
      <view class="profile-nickname-input"><FormField ref="nicknameField" :model-value="name" :error="nameError" :disabled="disabled" :focus="nicknameFocused" @update:model-value="$emit('update:name', $event)" @focus="nicknameFocused = true" @blur="blurNickname" type="nickname" field-class="input" placeholder="可使用微信昵称，也可自己填写" maxlength="16" aria-label="昵称" /></view>
    </view>
  </view>
</template>

<style scoped>
.profile-fields { display: flex; flex-direction: column; gap: 16px; padding: 0; }
.profile-photo-actions { display: flex; align-items: center; justify-content: center; gap: 16px; }
.profile-upload-error { text-align: center; margin: -4px 0 0; }
.profile-field-heading { flex: 0 0 48px; margin: 0; }
.profile-photo-actions .profile-avatar-button { flex: none; width: 72px; height: 72px; min-height: 72px; margin: 0; padding: 4px; gap: 0; overflow: visible; border-radius: 50%; }
.profile-photo-actions .profile-avatar-button.is-uploading { opacity: 1; }
.profile-avatar-portrait { position: relative; display: flex; align-items: center; justify-content: center; }
.profile-avatar-frame { position: relative; display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 64px; height: 64px; overflow: hidden; border-radius: 50%; }
.profile-avatar-image, .profile-avatar-frame .avatar { width: 100%; height: 100%; }
.profile-avatar-camera { position: absolute; right: -2px; bottom: -2px; display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; background: var(--photo-action-surface); pointer-events: none; }
.profile-photo-actions .profile-avatar-camera :deep(.app-icon) { border-radius: 0; background: transparent; }
.profile-nickname-field { display: flex; align-items: center; gap: 16px; margin: 0; }
.profile-nickname-input { flex: 1; min-width: 0; }
.profile-nickname-input :deep(.input) { margin-top: 0; }
@media (max-width: 360px) {
  .profile-nickname-field { flex-direction: column; align-items: stretch; gap: 8px; }
  .profile-field-heading { flex-basis: auto; }
}
</style>
