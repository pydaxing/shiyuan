<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { profileNameError } from '../domain/family.js';
import { accountProfile, accountProfilePreview, cloudStatus, saveAccountProfile } from '../services/cloud.js';
import { state, activeMember, notify } from '../store.js';
import { presentMutation } from '../services/mutation-feedback.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import Sheet from './Sheet.vue';
import ProfileFields from './ProfileFields.vue';
import InlinePhotoEditor from './InlinePhotoEditor.vue';
import LazyImage from './LazyImage.vue';
import AppIcon from './AppIcon.vue';
import FamilyAppearanceDetails from './FamilyAppearanceDetails.vue';
import FamilyEditor from './FamilyEditor.vue';
defineProps({ page: Boolean });
const emit = defineEmits(['close']);
function currentProfile() {
  const current = accountProfilePreview.value || accountProfile.value;
  return current.name ? { name: current.name, avatar: current.avatar || '' } : { name: activeMember.value?.name || '', avatar: activeMember.value?.avatar || '' };
}
let disposed = false;
onUnmounted(() => { disposed = true; });
const saved = ref(currentProfile());
const initial = ref({ ...saved.value });
const name = ref(saved.value.name);
const avatar = ref(saved.value.avatar);
const section = ref('');
const appearanceSection = ref('');
const busy = ref(false);
const uploading = ref(false);
const confirming = ref(false);
const error = ref('');
const profile = ref(null);
const photo = ref(null);
const cropDirty = ref(false);
const submitted = ref(false);
const nameError = computed(() => submitted.value ? profileNameError(name.value) : '');
const locked = computed(() => busy.value || uploading.value || confirming.value);
const dirty = computed(() => section.value === 'avatar' ? (cropDirty.value || avatar.value !== initial.value.avatar) : section.value === 'nickname' && name.value !== initial.value.name);
function openEditor(field) {
  if (locked.value || cloudStatus.value.busy || section.value || appearanceSection.value || !['avatar', 'nickname'].includes(field)) return;
  saved.value = currentProfile();
  initial.value = { ...saved.value };
  name.value = saved.value.name; avatar.value = saved.value.avatar;
  error.value = ''; submitted.value = false;
  cropDirty.value = false; section.value = field;
}
function openAppearance(field) {
  if (locked.value || cloudStatus.value.busy || section.value || appearanceSection.value || !['name', 'cover'].includes(field)) return;
  if (field === 'name' && state.value.family.kind === 'personal') return;
  appearanceSection.value = field;
}
function finishEditing() {
  dismissFocusedKeyboard();
  section.value = ''; error.value = ''; submitted.value = false;
}
async function cancelEditing() {
  if (locked.value) return;
  if (dirty.value) {
    confirming.value = true;
    try {
      const discard = await new Promise(resolve => uni.showModal({
        title: '放弃未保存的修改？', content: '返回后将保留原来的个人资料。',
        confirmText: '放弃修改', cancelText: '继续编辑',
        confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted,
        success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false),
      }));
      if (!discard) return;
    } finally { confirming.value = false; }
  }
  name.value = saved.value.name; avatar.value = saved.value.avatar;
  finishEditing();
}
function close() { if (!uploading.value && !confirming.value && !section.value && !appearanceSection.value) emit('close'); }
async function save() {
  if (locked.value || !section.value) return;
  submitted.value = true;
  // Preserve the latest confirmed value of the field that is not being edited.
  const current = currentProfile();
  const payload = section.value === 'nickname' ? { name: name.value.trim(), avatar: current.avatar } : { name: current.name, avatar: avatar.value };
  if (profileNameError(payload.name)) {
    if (section.value === 'nickname') { await nextTick(); profile.value?.reveal(); }
    else error.value = '请先设置昵称，再更换头像';
    return;
  }
  busy.value = true; error.value = '';
  const field = section.value;
  const draft = { name: name.value, avatar: avatar.value };
  const userId = cloudStatus.value.userId;
  try {
    if (field === 'avatar' && cropDirty.value) {
      payload.avatar = await photo.value.save();
      draft.avatar = payload.avatar;
      payload.name = currentProfile().name;
    }
    if (disposed || userId !== cloudStatus.value.userId) throw new Error('登录状态已变化，请重新编辑');
    await presentMutation(saveAccountProfile(payload, { ...currentProfile(), [field === 'nickname' ? 'name' : 'avatar']: initial.value[field === 'nickname' ? 'name' : 'avatar'] }), () => { saved.value = payload; finishEditing(); });
  }
  catch (failure) {
    if (userId !== cloudStatus.value.userId) return;
    const message = failure.message || '资料未保存，请重试';
    if (disposed) { notify(message); return; }
    saved.value = currentProfile();
    initial.value = { ...saved.value };
    section.value = field;
    name.value = draft.name; avatar.value = draft.avatar;
    submitted.value = true; error.value = message;
  }
  finally { busy.value = false; }
}
</script>

<template>
  <Sheet :page="page" title="我的资料" variant="settings" :footer-visible="false" @close="close">
    <FamilyAppearanceDetails :family="state.family" @edit="openAppearance">
    <view class="profile-info-list">
      <button role="button" class="profile-info-row profile-info-avatar-row" aria-label="查看和更换头像" @click="openEditor('avatar')" hover-class="touch-feedback">
        <text class="profile-info-label">头像</text><view class="profile-info-photo"><LazyImage :src="saved.avatar" variant="avatar" avatar round /></view><AppIcon name="chevron" :size="16" />
      </button>
      <button role="button" class="profile-info-row" aria-label="编辑昵称" @click="openEditor('nickname')" hover-class="touch-feedback">
        <text class="profile-info-label">昵称</text><text class="profile-info-value">{{ saved.name || '未设置' }}</text><AppIcon name="chevron" :size="16" />
      </button>
    </view>
    </FamilyAppearanceDetails>
  </Sheet>
  <FamilyEditor v-if="appearanceSection" page :initial-tab="appearanceSection" @close="appearanceSection = ''" />
  <Sheet v-if="section" page :title="section === 'avatar' ? '个人头像' : '设置昵称'" :variant="section === 'avatar' ? 'profile-avatar' : 'profile-editor'" :footer-visible="false" @close="cancelEditing">
    <InlinePhotoEditor v-if="section === 'avatar'" ref="photo" :value="avatar" avatar :disabled="locked" @dirty="cropDirty = $event" @busy="uploading = $event" />
    <ProfileFields v-else ref="profile" v-model:name="name" v-model:avatar="avatar" :name-error="nameError" :mode="section" :disabled="locked" @busy="uploading = $event" />
    <view class="profile-edit-controls" :class="{ 'is-avatar-controls': section === 'avatar' }">
      <text v-if="error" class="error-message profile-save-error" role="alert">{{ error }}</text>
      <view class="profile-edit-actions">
        <button role="button" class="secondary-button profile-edit-cancel" :disabled="locked" aria-label="取消编辑" @click.stop="cancelEditing" hover-class="touch-feedback">取消</button>
        <button role="button" class="primary-button profile-edit-save" :class="{ 'is-busy': busy }" :disabled="locked" :aria-busy="busy || uploading" aria-label="完成编辑" @click.stop="save" hover-class="touch-feedback">{{ busy ? '保存中…' : uploading && section === 'avatar' ? '准备中…' : '完成' }}</button>
      </view>
    </view>
  </Sheet>
</template>

<style scoped>
.profile-info-list { background: var(--white); }
.profile-info-row { display: flex; align-items: center; gap: 14px; width: 100%; box-sizing: border-box; min-height: 58px; margin: 0; padding: 13px 20px; border-radius: 0; background: var(--white); text-align: left; font-size: var(--type-body); font-weight: 400; }
.profile-info-avatar-row { border-bottom: 1px solid var(--paper); }
.profile-info-label { flex: 1; min-width: 0; line-height: 24px; color: var(--ink); }
.profile-info-value { max-width: 70%; font-size: var(--type-meta); line-height: 24px; overflow-wrap: anywhere; color: var(--muted); text-align: right; }
.profile-info-photo { flex: 0 0 32px; width: 32px; height: 32px; overflow: hidden; border-radius: 50%; }
.profile-info-row :deep(.app-icon) { flex-shrink: 0; }
.profile-edit-controls { margin: 24px 20px 0; }
.profile-edit-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; width: 100%; }
.profile-edit-cancel, .profile-edit-save { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 46px; margin: 0; padding: 0 16px; border-radius: var(--radius-control); font-size: var(--type-body); font-weight: 500; }
.profile-edit-save.is-busy { opacity: 1; }
.is-avatar-controls .profile-edit-cancel { color: var(--white); background: var(--photo-action-surface); border-color: transparent; }
.profile-save-error { display: block; margin: 0 0 12px; padding: 10px 14px; border-radius: var(--radius-control); background: var(--danger-light); }
</style>
