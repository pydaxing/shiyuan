<script setup>
import { computed, nextTick, ref } from 'vue';
import { familyAppearanceFieldErrors } from '../domain/family.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import FamilyAppearanceDetails from './FamilyAppearanceDetails.vue';
import InlinePhotoEditor from './InlinePhotoEditor.vue';
import FormField from './FormField.vue';
import Sheet from './Sheet.vue';
const props = defineProps({ name: String, cover: String, requestId: String, nameError: String, disabled: Boolean });
const emit = defineEmits(['update:name', 'update:cover', 'busy']);
const section = ref('');
const draft = ref('');
const photo = ref(null);
const field = ref(null);
const preparing = ref(false);
const saving = ref(false);
const error = ref('');
const locked = computed(() => props.disabled || preparing.value || saving.value);
const appearance = computed(() => ({ name: props.name || '设置家庭名称', cover: props.cover || '' }));
function edit(key) {
  if (locked.value || section.value) return;
  dismissFocusedKeyboard();
  draft.value = key === 'name' ? props.name || '' : props.cover || '';
  error.value = key === 'name' ? props.nameError || '' : '';
  section.value = key;
}
function editName() { edit('name'); }
function imageBusy(value) { preparing.value = value; emit('busy', value || saving.value); }
function close() {
  if (locked.value) return;
  dismissFocusedKeyboard(); section.value = ''; error.value = '';
}
function restoreDefault() {
  if (locked.value) return;
  draft.value = ''; photo.value?.reset(); error.value = '';
}
async function save() {
  if (locked.value || !section.value) return;
  error.value = '';
  if (section.value === 'name') {
    error.value = familyAppearanceFieldErrors({ name: draft.value }).name || '';
    if (error.value) { await nextTick(); field.value?.reveal(); return; }
    emit('update:name', draft.value.trim()); close(); return;
  }
  saving.value = true; emit('busy', true);
  try {
    const value = await photo.value.save();
    emit('update:cover', value);
    dismissFocusedKeyboard(); section.value = '';
  } catch (failure) { error.value = failure.message || '封面保存失败，请重试'; }
  finally { saving.value = false; emit('busy', preparing.value); }
}
defineExpose({ editName });
</script>

<template>
  <view class="family-creation-fields">
    <FamilyAppearanceDetails :family="appearance" @edit="edit" />
    <Sheet v-if="section" page :title="section === 'cover' ? '家庭封面' : '家庭名称'" :variant="section === 'cover' ? 'profile-cover' : 'profile-editor'" :footer-visible="false" @close="close">
      <view class="family-field-editor">
        <InlinePhotoEditor v-if="section === 'cover'" ref="photo" :value="draft" :family-draft-request="requestId" :disabled="disabled || saving" @busy="imageBusy" />
        <view v-else class="family-text-entry"><view class="family-text-input"><FormField ref="field" v-model="draft" :error="error" :disabled="locked" variant="profile-nickname" field-class="input profile-nickname-native-input" :maxlength="20" placeholder="例如：茱丽叶的厨房" aria-label="新家庭名称" /></view><button v-if="draft" class="family-text-clear" aria-label="清空家庭名称" :disabled="locked" @click.stop="draft = ''" hover-class="touch-feedback"><view class="family-clear-icon" aria-hidden="true"><view class="family-clear-line" /><view class="family-clear-line is-cross" /></view></button></view>
        <view class="family-field-controls">
          <text v-if="error && section === 'cover'" class="error-message" role="alert">{{ error }}</text>
          <view class="family-field-actions"><button class="secondary-button family-field-cancel" :disabled="locked" @click.stop="close" hover-class="touch-feedback">取消</button><button class="primary-button family-field-save" :class="{ 'is-busy': saving }" :disabled="locked" :aria-busy="saving || preparing" @click.stop="save" hover-class="touch-feedback">{{ saving ? '保存中…' : preparing ? '准备中…' : '完成' }}</button></view>
          <button v-if="section === 'cover'" class="text-button family-field-reset" :disabled="locked" @click.stop="restoreDefault" hover-class="touch-feedback">使用默认封面</button>
        </view>
      </view>
    </Sheet>
  </view>
</template>

<style scoped src="./family-field-editor.css"></style>
