<script setup>
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { state, cloudStatus, preferencePending, notify } from '../store.js';
import { manageFamily, invokeCloud, recoverFamilyState } from '../services/cloud.js';
import FormField from './FormField.vue';
import AppIcon from './AppIcon.vue';
import FamilyCoverImage from './FamilyCoverImage.vue';
import ImagePicker from './ImagePicker.vue';
import { coverFrameStyle } from '../domain/image-crop.js';
import { FAMILY_APPEARANCE_DEFAULTS, familyAppearance, familyAppearanceFieldErrors } from '../domain/family.js';
const props = defineProps({ beforeChange: Function, unsavedChanges: Boolean, active: { type: Boolean, default: true } });
const emit = defineEmits(['busy', 'changed', 'section-change']);
useSheetContentResize();
const owner = computed(() => state.value.family.ownerId === cloudStatus.value.userId);
const families = ref([]);
const familyChoices = computed(() => families.value.map(family => ({ ...familyDetails(family.id), current: family.id === cloudStatus.value.familyId })));
const loading = ref(false);
const busy = ref(false);
const uploading = ref(false);
const locked = computed(() => busy.value || uploading.value);
const creating = ref(false);
const cover = ref('');
const coverTitle = ref(FAMILY_APPEARANCE_DEFAULTS.coverTitle);
const subheading = computed(() => creating.value ? '新建一个家' : '');
watch(subheading, () => emit('section-change'), { flush: 'sync' });
const familyName = ref('');
const canCreate = computed(() => creating.value && !locked.value && !cloudStatus.value.familyRecoveryRequired);
const error = ref('');
const recoveryRequired = computed(() => Boolean(cloudStatus.value.familyRecoveryRequired));
const displayedError = computed(() => error.value || (recoveryRequired.value ? cloudStatus.value.error : ''));
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => submitted.value ? familyAppearanceFieldErrors({ name: familyName.value, coverTitle: coverTitle.value }) : {});
let createRequest = '';
let alive = true;
function familyDetails(familyId = cloudStatus.value.familyId) {
  if (familyId !== cloudStatus.value.familyId) return families.value.find(family => family.id === familyId);
  const family = state.value.family;
  return { id: familyId, name: family.name, cover: family.cover || '', memberCount: family.members.length, owner: owner.value };
}
function requireFamily(familyId, expectedCurrentFamilyId) {
  const family = familyDetails(familyId);
  if (!alive || props.active === false || !familyId || !family || cloudStatus.value.familyId !== expectedCurrentFamilyId) throw new Error('家庭状态已变化，请重新打开管理页面。');
  return family;
}
async function load() {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    const result = recoveryRequired.value ? await recoverFamilyState() : await invokeCloud('listFamilies');
    if (alive) families.value = result.families;
  } catch (failure) { if (alive) error.value = failure.message; }
  finally { if (alive) loading.value = false; }
}
async function perform(action, payload = {}, changesFamily = true, confirmAction) {
  if (!alive || props.active === false) return;
  if (recoveryRequired.value) { error.value = '请先重新同步家庭状态，再进行家庭操作。'; return; }
  if (locked.value || preferencePending.value) { notify('请等当前设置保存后再操作'); return; }
  const userId = cloudStatus.value.userId;
  busy.value = true; emit('busy', true); error.value = '';
  try {
    if (confirmAction) { payload = await confirmAction(); if (!payload) return; }
    if (changesFamily && action !== 'leaveFamily' && props.beforeChange && !await props.beforeChange()) return;
    if (!alive || props.active === false || cloudStatus.value.userId !== userId) throw new Error('家庭状态已变化，请重新打开管理页面。');
    if (action === 'leaveFamily' || action === 'deleteFamily') {
      const family = requireFamily(payload.familyId, payload.expectedCurrentFamilyId);
      if (action === 'deleteFamily' && !family.owner) throw new Error('管理员信息已变化，请重新打开管理页面。');
      if (action === 'deleteFamily' && family.name !== payload.confirmName) throw new Error('家庭名称不一致，未删除。请重新输入完整名称。');
    }
    await manageFamily(action, payload);
    if (changesFamily) emit('changed');
    else {
      if (action === 'leaveFamily' || action === 'deleteFamily') families.value = families.value.filter(family => family.id !== payload.familyId);
      await load();
    }
  } catch (failure) { error.value = failure.message; }
  finally { busy.value = false; emit('busy', false); }
}
function selectFamily(family) {
  if (family.id === cloudStatus.value.familyId) return;
  return perform('switchFamily', { familyId: family.id });
}
function deleteFamily(family = familyDetails()) {
  const target = familyDetails(family.id);
  if (!target?.owner) return;
  const familyName = target.name;
  const familyId = target.id;
  const expectedCurrentFamilyId = cloudStatus.value.familyId;
  const modal = options => new Promise((resolve, reject) => uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, ...options, success: resolve, fail: () => reject(new Error('无法打开确认窗口，请重试')) }));
  return perform('deleteFamily', {}, familyId === expectedCurrentFamilyId, async () => {
    const warning = await modal({ title: '删除家庭？', content: `将删除「${familyName}」，所有成员都会离开，家庭私有的菜品、菜单、订单、库存和日记将被清理。已分享的美食及发布时的家庭名称、头像和封面会保留；其他家庭收藏的副本不受影响。此操作不能撤销。`, confirmText: '继续', cancelText: '取消', confirmColor: NATIVE_UI_COLORS.danger });
    if (!warning.confirm) return;
    requireFamily(familyId, expectedCurrentFamilyId);
    const confirmation = await modal({ title: '输入家庭名称确认', editable: true, placeholderText: familyName, confirmText: '删除', cancelText: '取消', confirmColor: NATIVE_UI_COLORS.danger });
    if (!confirmation.confirm) return;
    if (confirmation.content !== familyName) throw new Error('家庭名称不一致，未删除。请重新输入完整名称。');
    return { familyId, expectedCurrentFamilyId, confirmName: confirmation.content };
  });
}
function leave(family = familyDetails()) {
  const target = familyDetails(family.id);
  if (!target) return;
  const familyId = target.id;
  const expectedCurrentFamilyId = cloudStatus.value.familyId;
  const changesFamily = familyId === expectedCurrentFamilyId;
  const lastMember = target.memberCount === 1;
  const consequence = lastMember ? '你是最后一位成员，退出后将自动删除这个家庭，清理家庭私有的菜品、菜单、订单、库存和日记。已分享的美食及发布时的家庭名称、头像和封面会保留。此操作不能撤销。' : `${target.owner ? '管理员将自动交接给最早加入且仍在家的成员。' : ''}家庭记录会保留给其他成员；若退出时已无其他成员，家庭将自动删除并清理私有数据，保留已分享的美食及发布时的家庭名称、头像和封面。家庭删除后无法恢复。`;
  return perform('leaveFamily', {}, changesFamily, async () => {
    const confirmation = await new Promise((resolve, reject) => uni.showModal({ cancelColor: NATIVE_UI_COLORS.muted, title: `退出「${target.name}」？`, content: `${consequence}其他家庭不受影响。${changesFamily && props.unsavedChanges ? '名称与封面未保存的修改也将放弃。' : ''}`, confirmText: '确认退出', cancelText: '取消', confirmColor: NATIVE_UI_COLORS.danger, success: resolve, fail: () => reject(new Error('无法打开确认窗口，请重试')) }));
    if (!confirmation.confirm) return;
    return { familyId, expectedCurrentFamilyId };
  });
}
function create() {
  if (locked.value || recoveryRequired.value) return;
  createRequest = `create-family-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  familyName.value = ''; cover.value = ''; coverTitle.value = FAMILY_APPEARANCE_DEFAULTS.coverTitle; creating.value = true; error.value = ''; submitted.value = false;
}
function imageBusy(value) { uploading.value = value; emit('busy', locked.value); }
async function submitCreation() {
  if (!canCreate.value) return;
  submitted.value = true; error.value = '';
  const invalid = Object.keys(fieldErrors.value)[0];
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  const appearance = familyAppearance({ cover: cover.value, coverTitle: coverTitle.value });
  return perform('createFamily', { familyName: familyName.value.trim(), cover: appearance.cover, coverTitle: appearance.coverTitle, requestId: createRequest });
}
function back() { if (locked.value) return; creating.value = false; error.value = ''; }
onMounted(load);
onUnmounted(() => { alive = false; });
defineExpose({ creating, busy, canCreate, submitCreation });
</script>

<template>
  <view v-if="props.active" class="family-management-panel" :aria-busy="locked || loading">
    <view v-if="subheading" class="family-management-heading"><text class="subheading">{{ subheading }}</text><button class="text-button" :disabled="locked" @click="$feedback(); back()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">返回列表</button></view>
    <view v-if="creating" class="family-appearance-panel">
      <view class="field-label"><text class="subheading">家庭封面</text></view>
      <ImagePicker v-model="cover" frame="family" :family-draft-request="createRequest" :disabled="busy" label="拍照/相册" @busy="imageBusy" />
      <view class="field-label" @click.stop><text class="subheading">家庭名称</text><FormField :ref="field => fieldRefs.name = field" v-model="familyName" :error="fieldErrors.name" aria-label="新家庭名称" :disabled="locked" field-class="input" maxlength="20" placeholder="例如：爸妈的小家" /></view>
      <view class="field-label" @click.stop><text class="subheading">菜单主标题</text><FormField :ref="field => fieldRefs.coverTitle = field" v-model="coverTitle" :error="fieldErrors.coverTitle" aria-label="新家庭菜单主标题" :disabled="locked" field-class="input" maxlength="30" :placeholder="FAMILY_APPEARANCE_DEFAULTS.coverTitle" /></view>
    </view>
    <view v-else>
      <text v-if="loading" class="hint">正在读取家庭…</text>
      <view v-for="family in familyChoices" :key="family.id" class="family-choice-card" :class="{ active: family.current }">
        <button class="family-choice-select" :disabled="busy || loading || preferencePending || recoveryRequired" :aria-pressed="family.current" :aria-label="`${family.name}，${family.current ? '正在使用' : '点击切换'}`" @click="$feedback(); selectFamily(family)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <view class="family-choice-cover"><view class="family-choice-cover-frame" :style="coverFrameStyle('family')"><FamilyCoverImage :src="family.cover" variant="card" /></view></view>
          <view class="family-choice-copy"><text class="family-choice-name">{{ family.name }}</text><view class="family-choice-meta"><text>{{ family.memberCount }} 人</text><text v-if="family.current" class="family-current-label">使用中</text></view></view>
        </button>
        <view class="family-choice-actions">
          <button class="family-choice-action" :disabled="busy || loading || preferencePending || recoveryRequired" :aria-label="`退出「${family.name}」`" @click.stop="$feedback(); leave(family)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="action-icon-circle family-choice-action-surface"><AppIcon name="exit" :size="18" /></view></button>
          <button v-if="family.owner" class="family-choice-action danger" :disabled="busy || loading || preferencePending || recoveryRequired" :aria-label="`删除「${family.name}」`" @click.stop="$feedback(); deleteFamily(family)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="action-icon-circle family-choice-action-surface"><AppIcon name="trash-danger" :size="18" /></view></button>
        </view>
      </view>
      <button class="secondary-button full family-create-button" :disabled="busy || loading || recoveryRequired || families.length >= 10" @click="$feedback(); create()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" /><text>新建家庭</text></button>
    </view>
    <text v-if="displayedError" class="error-message" role="alert">{{ displayedError }}</text><button v-if="!subheading && displayedError" class="text-button" :disabled="loading || busy" @click="$feedback(); load()">{{ recoveryRequired ? '重新同步家庭状态' : '重新加载' }}</button>
  </view>
</template>

<style scoped>
.family-choice-card { display: flex; align-items: center; gap: 4px; overflow: hidden; margin-bottom: 10px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--white); }
.family-choice-card.active { border-color: var(--border-strong); background: var(--control-accent); }
.family-choice-select { display: flex; flex: 1; align-self: stretch; align-items: center; gap: 12px; min-width: 0; margin: 0; padding: 12px 0 12px 12px; border: 0; background: transparent; color: var(--ink); text-align: left; }
.family-choice-cover { flex: 0 0 92px; width: 92px; overflow: hidden; border-radius: var(--radius-small); }
.family-choice-cover-frame { position: relative; width: 100%; }
.family-choice-name { font-size: var(--type-section); font-weight: 600; overflow-wrap: anywhere; }
.family-choice-card.active .family-choice-name { color: var(--green); }
.family-choice-actions { display: flex; flex-shrink: 0; align-items: center; padding-right: 6px; }
.family-choice-action { display: flex; flex: 0 0 44px; align-items: center; justify-content: center; width: 44px; height: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: 50%; background: transparent; line-height: 1; }
.family-choice-action-surface { flex: 0 0 32px; width: 32px; height: 32px; background: var(--control-surface); }
.family-choice-action.danger .family-choice-action-surface { background: var(--danger-light); }
@media (max-width: 360px) {
  .family-choice-card { gap: 0; }
  .family-choice-select { gap: 8px; padding-left: 10px; }
  .family-choice-cover { flex-basis: 80px; width: 80px; }
  .family-choice-actions { padding-right: 2px; }
}
</style>
