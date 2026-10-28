<script setup>
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { FAMILY_APPEARANCE_DEFAULTS, familyAppearance, familyAppearanceFieldErrors } from '../domain/family.js';
import FormField from './FormField.vue';
import { computed, nextTick, ref } from 'vue';
import { state, cloudMode, customizeFamily } from '../store.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { presentMutation } from '../services/mutation-feedback.js';
import Sheet from './Sheet.vue';
import ImagePicker from './ImagePicker.vue';
import FamilyManagement from './FamilyManagement.vue';
const props = defineProps({ initialTab: { type: String, default: 'appearance' } });
const emit = defineEmits(['close']);
const sheet = ref(null);
const management = ref(null);
function resetScroll() { dismissFocusedKeyboard(); sheet.value?.resetScroll(); }
const initial = familyAppearance(state.value.family);
const name = ref(initial.name);
const cover = ref(initial.cover);
const coverTitle = ref(initial.coverTitle);
const tab = ref(cloudMode && props.initialTab === 'management' ? 'management' : 'appearance');
const creatingFamily = computed(() => tab.value === 'management' && Boolean(management.value?.creating));
const managementVisited = ref(tab.value === 'management');
const busy = ref(false);
const saving = ref(false);
const managing = ref(false);
const confirming = ref(false);
const error = ref('');
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => submitted.value ? familyAppearanceFieldErrors({ name: name.value, coverTitle: coverTitle.value }) : {});
const locked = computed(() => busy.value || saving.value || managing.value || confirming.value);
const dirty = computed(() => name.value !== initial.name || cover.value !== initial.cover || coverTitle.value !== initial.coverTitle);
function restoreDefaults() {
  if (locked.value) return;
  name.value = FAMILY_APPEARANCE_DEFAULTS.name;
  cover.value = FAMILY_APPEARANCE_DEFAULTS.cover;
  coverTitle.value = FAMILY_APPEARANCE_DEFAULTS.coverTitle;
  error.value = '';
}
function selectTab(next) {
  if (locked.value || tab.value === next) return;
  if (next === 'management') managementVisited.value = true;
  tab.value = next;
  void resetScroll();
}
async function confirmDiscard() {
  if (busy.value || saving.value || confirming.value) return false;
  if (!dirty.value) return true;
  confirming.value = true;
  try {
    return await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '放弃未保存的修改？', content: '名称与封面还没有保存，继续将放弃这些修改。', confirmText: '放弃修改', cancelText: '继续编辑', success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
  } finally { confirming.value = false; }
}
async function close() {
  if (locked.value) return;
  if (await confirmDiscard()) emit('close');
}
async function save() {
  if (locked.value) return;
  submitted.value = true; error.value = '';
  const invalid = Object.keys(fieldErrors.value)[0];
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  saving.value = true; error.value = '';
  try {
    const appearance = familyAppearance({ name: name.value, cover: cover.value, coverTitle: coverTitle.value });
    await presentMutation(customizeFamily({ name: appearance.name, cover: appearance.cover, coverTitle: appearance.coverTitle }), () => emit('close'));
  }
  catch (failure) { error.value = failure.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <Sheet ref="sheet" title="家庭设置" :preferred-height="tab === 'management' && !creatingFamily ? 660 : 0" :footer-visible="tab === 'appearance' || creatingFamily" @close="close">
    <view v-if="!cloudMode" class="preview-mode-note" role="status">当前是本地布局预览，未连接家庭云数据。创建、切换、退出和删除家庭，请在微信云端预览包中使用。</view>
    <view v-if="cloudMode" class="family-settings-tabs" role="tablist" aria-label="家庭设置分类">
      <button class="family-settings-tab" :class="{ active: tab === 'appearance' }" role="tab" :aria-selected="tab === 'appearance'" :disabled="locked" @click="$feedback(); selectTab('appearance')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">名称与封面</button>
      <button class="family-settings-tab" :class="{ active: tab === 'management' }" role="tab" :aria-selected="tab === 'management'" :disabled="locked" @click="$feedback(); selectTab('management')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">切换与管理</button>
    </view>
    <view v-if="tab === 'appearance'" class="family-appearance-panel">
    <view class="field-label"><text class="subheading">家庭封面</text></view>
    <ImagePicker v-model="cover" frame="family" :disabled="saving" label="拍照/相册" @busy="busy = $event" />
    <view class="field-label" @click.stop><text class="subheading">家庭名称</text><FormField :ref="field => fieldRefs.name = field" v-model="name" :error="fieldErrors.name" :disabled="saving" field-class="input" maxlength="20" :placeholder="FAMILY_APPEARANCE_DEFAULTS.name" aria-label="家庭名称" /></view>
    <view class="field-label" @click.stop><text class="subheading">菜单主标题</text><FormField :ref="field => fieldRefs.coverTitle = field" v-model="coverTitle" :error="fieldErrors.coverTitle" :disabled="saving" field-class="input" maxlength="30" :placeholder="FAMILY_APPEARANCE_DEFAULTS.coverTitle" aria-label="菜单主标题" /></view>
    </view>
    <FamilyManagement v-if="cloudMode && managementVisited" :active="tab === 'management'" ref="management" :before-change="confirmDiscard" :unsaved-changes="dirty" @busy="managing = $event" @section-change="resetScroll" @changed="$emit('close')" />
    <template v-if="tab === 'appearance' || creatingFamily" #footer>
      <view v-if="tab === 'appearance'" class="family-appearance-footer">
        <text v-if="error" class="error-message" role="alert">{{ error }}</text>
        <button role="button" class="text-button family-cover-reset" :disabled="locked" @click="$feedback(); restoreDefaults()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">恢复默认设置</button>
        <button role="button" class="primary-button full" :disabled="locked" @click="$feedback(); save()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在保存…' : '保存设置' }}</button>
      </view>
      <button v-else role="button" class="primary-button full" :disabled="locked || !management?.canCreate" @click="$feedback(); management?.submitCreation()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ management?.busy ? '正在创建…' : '创建并切换' }}</button>
    </template>
  </Sheet>
</template>
