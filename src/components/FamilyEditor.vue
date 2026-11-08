<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { FAMILY_APPEARANCE_DEFAULTS, familyAppearance, familyAppearanceFieldErrors } from '../domain/family.js';
import { state, cloudMode, cloudStatus, customizeFamily, notify } from '../store.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { presentMutation } from '../services/mutation-feedback.js';
import FormField from './FormField.vue';
import Sheet from './Sheet.vue';
import InlinePhotoEditor from './InlinePhotoEditor.vue';
import FamilyManagement from './FamilyManagement.vue';
import FamilyAppearanceDetails from './FamilyAppearanceDetails.vue';
const props = defineProps({ page: Boolean, initialTab: { type: String, default: 'appearance' } });
const emit = defineEmits(['close']);
const sheet = ref(null);
const management = ref(null);
const field = ref(null);
const photo = ref(null);
const cropDirty = ref(false);
const fields = ['name', 'cover'];
const entry = props.initialTab || 'appearance';
const section = ref(fields.includes(entry) ? entry : '');
const isManagement = cloudMode && entry === 'management';
const spaceId = state.value.family.id;
const personal = computed(() => state.value.family.kind === 'personal');
const initial = ref(familyAppearance(state.value.family));
const name = ref(initial.value.name);
const cover = ref(initial.value.cover);
const drafts = { name, cover };
let disposed = false;
onUnmounted(() => { disposed = true; });
const creatingFamily = computed(() => isManagement && Boolean(management.value?.creating));
const busy = ref(false);
const saving = ref(false);
const managing = ref(false);
const confirming = ref(false);
const error = ref('');
const submitted = ref(false);
const locked = computed(() => busy.value || saving.value || managing.value || confirming.value);
const dirty = computed(() => Boolean(section.value && (cropDirty.value || drafts[section.value].value !== initial.value[section.value])));
const label = computed(() => section.value === 'name' ? '家庭名称' : personal.value ? '个人封面' : '家庭封面');
const title = computed(() => isManagement ? (creatingFamily.value ? '新建家庭' : '我的家庭') : section.value ? label.value : '封面与名称');
const fieldErrors = computed(() => {
  if (!submitted.value || section.value !== 'name') return {};
  const errors = familyAppearanceFieldErrors({ name: name.value });
  return errors.name ? { name: errors.name } : {};
});
const textDraft = computed({ get: () => drafts[section.value]?.value || '', set: value => { if (section.value && section.value !== 'cover') drafts[section.value].value = value; } });
function resetScroll() { dismissFocusedKeyboard(); sheet.value?.resetScroll(); }
function openEditor(next) {
  if (locked.value || section.value || isManagement || !fields.includes(next) || (personal.value && next === 'name')) return;
  initial.value = familyAppearance(state.value.family);
  for (const key of fields) drafts[key].value = initial.value[key];
  error.value = ''; submitted.value = false; section.value = next;
  resetScroll();
}
function restoreDefault() {
  if (locked.value || !section.value) return;
  drafts[section.value].value = FAMILY_APPEARANCE_DEFAULTS[section.value];
  photo.value?.reset();
  error.value = '';
}
async function confirmDiscard() {
  if (locked.value) return false;
  if (!dirty.value) return true;
  confirming.value = true;
  try {
    return await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '放弃未保存的修改？', content: `返回后将保留原来的${label.value}。`, confirmText: '放弃修改', cancelText: '继续编辑', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
  } finally { confirming.value = false; }
}
function finishEditing() {
  resetScroll();
  if (fields.includes(entry)) emit('close');
  else { section.value = ''; error.value = ''; submitted.value = false; }
}
async function close() {
  if (locked.value || !await confirmDiscard()) return;
  if (creatingFamily.value) { management.value?.back(); resetScroll(); return; }
  if (section.value) finishEditing();
  else emit('close');
}
async function save() {
  if (locked.value || !section.value) return;
  if (state.value.family.id !== spaceId) { error.value = '当前空间已变化，请返回后重新编辑'; return; }
  submitted.value = true; error.value = '';
  if (Object.keys(fieldErrors.value).length) { await nextTick(); field.value?.reveal(); return; }
  // Merge only the edited field into the latest confirmed appearance.
  const current = familyAppearance(state.value.family);
  const appearance = familyAppearance({ ...current, [section.value]: drafts[section.value].value });
  const edited = section.value;
  let draft = drafts[edited].value;
  const userId = cloudStatus.value.userId;
  saving.value = true;
  try {
    if (edited === 'cover' && cropDirty.value) {
      appearance.cover = await photo.value.save();
      draft = appearance.cover;
      const latest = familyAppearance(state.value.family);
      appearance.name = latest.name; appearance.coverTitle = latest.coverTitle;
    }
    if (disposed || state.value.family.id !== spaceId || cloudStatus.value.userId !== userId) throw new Error('当前空间已变化，请返回后重新编辑');
    await presentMutation(customizeFamily({ name: appearance.name, cover: appearance.cover, coverTitle: appearance.coverTitle }), finishEditing);
  } catch (failure) {
    if (state.value.family.id !== spaceId || cloudStatus.value.userId !== userId) return;
    const message = failure.message || '保存失败，请重试';
    if (disposed) { notify(message); return; }
    initial.value = familyAppearance(state.value.family);
    section.value = edited; drafts[edited].value = draft;
    submitted.value = true; error.value = message;
  }
  finally { saving.value = false; }
}
</script>

<template>
  <Sheet ref="sheet" :page="page || Boolean(section) || creatingFamily" :title="title" :variant="isManagement ? 'settings' : section === 'cover' ? 'profile-cover' : section ? 'profile-editor' : 'settings'" :preferred-height="isManagement && !creatingFamily ? 660 : 0" :footer-visible="false" @close="close">
    <view v-if="!cloudMode" class="preview-mode-note" role="status">当前未连接家庭云数据，请在微信小程序中保存修改。</view>
    <FamilyManagement v-if="isManagement" ref="management" @busy="managing = $event" @section-change="resetScroll" @changed="$emit('close')" />
    <view v-else-if="section" class="family-field-editor">
      <InlinePhotoEditor v-if="section === 'cover'" ref="photo" :value="cover" :personal="state.family.kind === 'personal'" :disabled="locked" @dirty="cropDirty = $event" @busy="busy = $event" />
      <view v-else class="family-text-entry"><view class="family-text-input"><FormField ref="field" v-model="textDraft" :error="fieldErrors[section]" :disabled="locked" variant="profile-nickname" field-class="input profile-nickname-native-input" :maxlength="20" :placeholder="FAMILY_APPEARANCE_DEFAULTS[section]" :aria-label="label" /></view><button v-if="textDraft" role="button" class="family-text-clear" :aria-label="`清空${label}`" :disabled="locked" @click.stop="textDraft = ''" hover-class="touch-feedback"><view class="family-clear-icon" aria-hidden="true"><view class="family-clear-line" /><view class="family-clear-line is-cross" /></view></button></view>
      <view class="family-field-controls">
        <text v-if="error" class="error-message" role="alert">{{ error }}</text>
        <view class="family-field-actions"><button role="button" class="secondary-button family-field-cancel" :disabled="locked" @click.stop="close" hover-class="touch-feedback">取消</button><button role="button" class="primary-button family-field-save" :class="{ 'is-busy': saving }" :disabled="locked" :aria-busy="saving || busy" @click.stop="save" hover-class="touch-feedback">{{ saving ? '保存中…' : busy && section === 'cover' ? '准备中…' : '完成' }}</button></view>
        <button v-if="section === 'cover'" role="button" class="text-button family-field-reset" :disabled="locked" @click.stop="restoreDefault" hover-class="touch-feedback">使用默认封面</button>
      </view>
    </view>
    <FamilyAppearanceDetails v-else :family="state.family" @edit="openEditor" />
  </Sheet>
</template>

<style scoped src="./family-field-editor.css"></style>
