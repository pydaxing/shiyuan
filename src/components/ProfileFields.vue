<script setup>
import { nextTick, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import FormField from './FormField.vue';
import ImageUploadProgress from './ImageUploadProgress.vue';
import { chooseLocalImage, compressNativePhoto, selectImagePaths, imageUploadLabel } from '../services/images.js';
import { cloudMode, uploadProfileAvatar } from '../services/cloud.js';
const props = defineProps({ name: String, avatar: String, nameError: String, disabled: Boolean, mode: String });
const emit = defineEmits(['update:name', 'update:avatar', 'busy']);
const nativeAvatarPicker = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
const preview = ref('');
const pendingPreview = ref('');
const progress = ref('0%');
const uploading = ref(false);
const nicknameFocused = ref(props.mode === 'nickname');
const nicknameField = ref(null);
const uploadError = ref('');
defineExpose({ reveal() { nicknameField.value?.reveal(); } });
function blurNickname(event) {
  nicknameFocused.value = false;
  if (typeof event.detail?.value === 'string') emit('update:name', event.detail.value);
}
async function clearNickname() {
  if (props.disabled) return;
  nicknameFocused.value = false;
  emit('update:name', '');
  await nextTick();
  nicknameFocused.value = true;
}
async function uploadAvatar(path) {
  pendingPreview.value = path;
  const thumbnail = await compressNativePhoto(path, 'avatar');
  pendingPreview.value = props.mode === 'avatar' ? path : thumbnail;
  const fileId = await uploadProfileAvatar(path, { cardPath: thumbnail, avatarPath: thumbnail, onStage: stage => { progress.value = imageUploadLabel(stage); } });
  progress.value = '100%';
  preview.value = props.mode === 'avatar' ? path : thumbnail;
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
  <view class="profile-fields" :class="{ 'is-avatar-editor': mode === 'avatar', 'is-nickname-editor': mode === 'nickname' }">
    <view v-if="mode !== 'nickname'" class="profile-photo-actions">
      <button role="button" class="profile-avatar-button" :class="{ 'is-uploading': uploading }" :aria-label="uploading ? '头像上传中' : '编辑头像'" :aria-busy="uploading" :disabled="uploading || disabled" :open-type="nativeAvatarPicker ? 'chooseAvatar' : undefined" @click="choosePhoto" @chooseavatar="choose" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <view class="profile-avatar-portrait">
          <view class="profile-avatar-frame"><view v-if="mode === 'avatar' && avatar && !pendingPreview && !preview" class="profile-avatar-original"><LazyImage :src="avatar" variant="original" mode="aspectFit" avatar /></view><image class="profile-avatar-image" v-else-if="pendingPreview || preview || avatar" :src="pendingPreview || preview || $image(avatar, 'avatar')" :mode="mode === 'avatar' ? 'aspectFit' : 'aspectFill'" /><text v-else class="avatar">我</text><ImageUploadProgress v-if="uploading" :value="progress" compact /></view>
          <view v-if="!uploading && mode !== 'avatar'" class="profile-avatar-camera" aria-hidden="true"><AppIcon name="camera-inverse" :size="12" /></view>
        </view>
        <view v-if="mode === 'avatar'" class="profile-avatar-change"><AppIcon name="camera-inverse" :size="18" /><text>{{ uploading ? '正在上传…' : '更换头像' }}</text></view>
      </button>
    </view>
    <text v-if="uploadError" class="field-error profile-upload-error" role="alert">{{ uploadError }}</text>
    <view v-if="mode !== 'avatar'" class="field-label profile-nickname-field" @click.stop>
      <text v-if="mode !== 'nickname'" class="subheading profile-field-heading">昵称</text>
      <view class="profile-nickname-input"><FormField ref="nicknameField" :model-value="name" :error="nameError" :disabled="disabled" :focus="nicknameFocused" :variant="mode === 'nickname' ? 'profile-nickname' : undefined" @update:model-value="$emit('update:name', $event)" @focus="nicknameFocused = true" @blur="blurNickname" type="nickname" :field-class="mode === 'nickname' ? 'input profile-nickname-native-input' : 'input'" placeholder="可使用微信昵称，也可自己填写" maxlength="16" aria-label="昵称" /></view>
      <button v-if="mode === 'nickname' && name" role="button" class="profile-nickname-clear" aria-label="清空昵称" :disabled="disabled" @click.stop="clearNickname" hover-class="touch-feedback"><view class="profile-clear-icon" aria-hidden="true"><view class="profile-clear-line" /><view class="profile-clear-line is-cross" /></view></button>
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
.is-nickname-editor .profile-nickname-field { flex-direction: row; align-items: center; gap: 4px; padding: 4px 12px 4px 20px; background: var(--white); }
.profile-nickname-clear { display: flex; align-items: center; justify-content: center; flex: 0 0 44px; width: 44px; min-height: 52px; margin: 0; padding: 0; color: var(--muted); background: transparent; }
.profile-clear-icon { position: relative; width: 18px; height: 18px; border-radius: 50%; background: var(--border-strong); }
.profile-clear-line { position: absolute; top: 8px; left: 4px; width: 10px; height: 1.5px; border-radius: 1px; background: var(--white); transform: rotate(45deg); }
.profile-clear-line.is-cross { transform: rotate(-45deg); }
.is-avatar-editor { gap: 20px; }
.is-avatar-editor .profile-photo-actions .profile-avatar-button { display: flex; flex-direction: column; width: 100%; height: auto; min-height: 0; padding: 0; border-radius: 0; background: transparent; color: var(--ink); }
.is-avatar-editor .profile-avatar-portrait { width: 100%; }
.is-avatar-editor .profile-avatar-frame { width: 100%; height: 100vw; border-radius: 0; background: var(--avatar-viewer-surface); }
.profile-avatar-original { flex: 0 0 100%; width: 100%; height: 100%; }
.is-avatar-editor .profile-avatar-change { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; margin-top: 28px; padding: 0 18px; border-radius: var(--radius-control); color: var(--white); background: var(--photo-action-surface); font-size: var(--type-body); }
.is-avatar-editor .profile-upload-error { margin: 0 20px; padding: 10px 14px; border-radius: var(--radius-control); color: var(--danger); background: var(--danger-light); }
@media (max-width: 360px) {
  .profile-nickname-field { flex-direction: column; align-items: stretch; gap: 8px; }
  .profile-field-heading { flex-basis: auto; }
}
</style>
