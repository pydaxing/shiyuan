<script setup>
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
import { state, activeMember, cloudStatus, preferencePending, notify } from '../store.js';
import { manageFamily, invokeCloud, recoverFamilyState } from '../services/cloud.js';
import FamilyCreationFields from './FamilyCreationFields.vue';
import AppIcon from './AppIcon.vue';
import FamilyCoverImage from './FamilyCoverImage.vue';
import LazyImage from './LazyImage.vue';
import FamilyInviteCard from './FamilyInviteCard.vue';
import { FAMILY_APPEARANCE_DEFAULTS, familyAppearance, familyAppearanceFieldErrors } from '../domain/family.js';
const props = defineProps({ beforeChange: Function, unsavedChanges: Boolean, active: { type: Boolean, default: true } });
const emit = defineEmits(['busy', 'changed', 'section-change']);
useSheetContentResize();
const owner = computed(() => state.value.family.ownerId === cloudStatus.value.userId);
const personal = computed(() => state.value.family.kind === 'personal');
const displayedMembers = computed(() => state.value.family.members.map(member => member.id === activeMember.value?.id
  ? { ...member, name: activeMember.value.name || member.name, avatar: activeMember.value.avatar || '' }
  : member));
const families = ref([]);
const familyChoices = computed(() => {
  const choices = families.value.map(family => ({ ...familyDetails(family.id), current: family.id === cloudStatus.value.familyId }));
  // The current household and members are already confirmed in the snapshot.
  // Show them immediately while the other household choices are loading.
  if (!personal.value && cloudStatus.value.familyId && !choices.some(family => family.current)) choices.unshift({ ...familyDetails(), current: true });
  return choices;
});
const loading = ref(false);
const busy = ref(false);
const uploading = ref(false);
const locked = computed(() => busy.value || uploading.value);
const creating = ref(false);
const editingFamilies = ref(false);
const cover = ref('');
const coverTitle = ref(FAMILY_APPEARANCE_DEFAULTS.coverTitle);
watch(creating, () => emit('section-change'), { flush: 'sync' });
const familyName = ref('');
const canCreate = computed(() => creating.value && !locked.value && !cloudStatus.value.familyRecoveryRequired);
const error = ref('');
const recoveryRequired = computed(() => Boolean(cloudStatus.value.familyRecoveryRequired));
const displayedError = computed(() => error.value || (recoveryRequired.value ? cloudStatus.value.error : ''));
const submitted = ref(false);
const creationFields = ref(null);
const fieldErrors = computed(() => submitted.value ? familyAppearanceFieldErrors({ name: familyName.value, coverTitle: coverTitle.value }) : {});
let createRequest = '';
let alive = true;
let loadGeneration = 0;
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
  const generation = ++loadGeneration;
  const userId = cloudStatus.value.userId;
  const isCurrent = () => alive && generation === loadGeneration && cloudStatus.value.userId === userId;
  loading.value = true; error.value = '';
  try {
    const result = recoveryRequired.value ? await recoverFamilyState() : await invokeCloud('listFamilies');
    if (isCurrent()) families.value = result.families;
  } catch (failure) { if (isCurrent()) error.value = failure.message; }
  finally { if (isCurrent()) loading.value = false; }
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
    // Ignore a background list requested before this mutation.
    loadGeneration++; loading.value = false;
    await manageFamily(action, payload);
    if (changesFamily) {
      if (action === 'leaveFamily' || action === 'deleteFamily') families.value = families.value.filter(family => family.id !== payload.familyId);
      creating.value = false;
      emit('changed');
    }
    else {
      if (action === 'leaveFamily' || action === 'deleteFamily') families.value = families.value.filter(family => family.id !== payload.familyId);
      await load();
    }
  } catch (failure) { error.value = failure.message; }
  finally { busy.value = false; emit('busy', false); }
}
function selectFamily(family) {
  if (editingFamilies.value || family.id === cloudStatus.value.familyId) return;
  return perform('switchFamily', { familyId: family.id });
}
function exitFamily(family) {
  if (!editingFamilies.value) return;
  return leave(family);
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
  if (invalid) { await nextTick(); creationFields.value?.editName(); return; }
  const appearance = familyAppearance({ cover: cover.value, coverTitle: coverTitle.value });
  return perform('createFamily', { familyName: familyName.value.trim(), cover: appearance.cover, coverTitle: appearance.coverTitle, requestId: createRequest });
}
function back() { if (locked.value) return; creating.value = false; error.value = ''; }
onMounted(load);
onUnmounted(() => { alive = false; });
defineExpose({ creating, busy, canCreate, submitCreation, back, load });
</script>

<template>
  <view v-if="props.active" class="family-management-panel" :aria-busy="locked || recoveryRequired">
    <view v-if="creating" class="family-creation-panel">
      <FamilyCreationFields ref="creationFields" v-model:name="familyName" v-model:cover="cover" :request-id="createRequest" :disabled="busy" :name-error="fieldErrors.name" @busy="imageBusy" />
      <view class="family-creation-controls"><button class="primary-button family-create-submit" :disabled="!canCreate" :aria-busy="busy" @click="$feedback(); submitCreation()" hover-class="touch-feedback">{{ busy ? '正在创建…' : '创建并切换' }}</button></view>
    </view>
    <view v-else>
      <view class="family-selection-section">
      <view class="section-line family-section-heading"><text class="subheading">家庭</text><text v-if="loading && recoveryRequired" class="family-loading-label" role="status">同步中</text><button class="family-manage-toggle" :disabled="locked" :aria-pressed="editingFamilies" @click="editingFamilies = !editingFamilies" hover-class="touch-feedback">{{ editingFamilies ? '完成' : '管理' }}</button></view>
      <view class="family-choice-list">
      <view v-for="family in familyChoices" :key="family.id" class="family-choice-card" :class="{ active: family.current }">
        <button class="family-choice-select" :class="{ 'is-disabled': locked || preferencePending || recoveryRequired || editingFamilies }" :disabled="locked || preferencePending || recoveryRequired || editingFamilies" :aria-pressed="family.current" :aria-label="`${family.name}，${editingFamilies ? '可退出' : family.current ? '正在使用' : '点击切换'}`" @click="$feedback(); selectFamily(family)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
          <view class="family-choice-cover"><view class="family-choice-cover-frame" ><FamilyCoverImage :src="family.cover" :variant="family.current ? 'cover' : 'card'" /></view></view>
          <view class="family-choice-copy"><text class="family-choice-name">{{ family.name }}</text><view class="family-choice-meta"><text>{{ family.memberCount }} 人</text></view></view>
        </button>
        <view v-if="family.current && !editingFamilies" class="family-choice-check" aria-label="正在使用"><view class="family-current-tick" /></view>
        <view v-if="editingFamilies" class="family-choice-actions">
          <button class="family-choice-action danger" :disabled="locked || preferencePending || recoveryRequired" :aria-label="`退出「${family.name}」`" @click.stop="$feedback(); exitFamily(family)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="family-choice-action-label">退出</text></button>
        </view>
      </view>
      <button v-if="!editingFamilies" class="family-add-row" :disabled="locked || recoveryRequired || families.length >= 10" @click="$feedback(); create()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="family-add-icon"><AppIcon name="plus" /></view><text>添加家庭</text></button>
      </view>
      <text v-if="!loading && !familyChoices.length && !displayedError" class="hint">还没有家庭，可以创建一个家。</text>
      </view>
      <view v-if="!personal" class="family-members-section">
        <view class="section-line family-members-heading"><text class="subheading">家庭成员</text><text class="family-section-count">{{ state.family.members.length }} 人</text></view>
        <view class="member-grid family-member-grid">
          <view v-for="member in displayedMembers" :key="member.id" class="member-card">
            <view class="member-portrait"><view class="member-photo"><LazyImage class="member-avatar-image" :src="member.avatar" variant="avatar" avatar round /></view><view v-if="state.family.headMemberId === member.id" class="head-crown" aria-label="一家之主"><AppIcon name="crown" active /></view></view>
            <text class="member-name">{{ member.name || '家人' }}</text><text class="member-status">{{ activeMember.id === member.id ? '我' : '家人' }}</text><text v-if="state.family.headMemberId === member.id" class="member-status member-head-label">一家之主</text>
          </view>
          <FamilyInviteCard :disabled="locked || recoveryRequired" />
        </view>
      </view>
    </view>
    <text v-if="displayedError" class="error-message" role="alert">{{ displayedError }}</text><button v-if="!creating && displayedError" class="text-button" :disabled="loading || busy" @click="$feedback(); load()">{{ recoveryRequired ? '重新同步家庭状态' : '重新加载' }}</button>
  </view>
</template>

<style scoped>
.family-management-panel { background: var(--paper); }
.family-selection-section, .family-members-section { padding: 18px 20px; background: var(--white); }
.family-selection-section { padding-top: 2px; }
.family-members-section { margin-top: 12px; }
.family-section-heading, .section-line.family-members-heading { justify-content: flex-start; gap: 8px; margin: 0 0 12px; }
.family-section-count, .family-loading-label { color: var(--muted); font-size: var(--type-caption); }
.family-loading-label { margin-left: auto; }
.family-choice-card:last-child { margin-bottom: 0; }
.family-creation-controls { margin: 24px 20px; }
.family-create-submit { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 46px; border-radius: var(--radius-control); font-size: var(--type-body); font-weight: 500; }
.family-management-panel > .error-message, .family-management-panel > .text-button { display: block; margin: 12px 20px; }
.family-manage-toggle { display: flex; align-items: center; justify-content: center; line-height: 1.4; margin: 0 0 0 auto; padding: 0 0 0 16px; min-height: 44px; background: transparent; color: var(--green); font-size: var(--type-body); }
.family-choice-list { overflow: hidden; border-radius: var(--radius-sheet); background: var(--control-surface); }
.family-choice-card { display: flex; align-items: center; gap: 8px; margin: 0 16px; border-bottom: .5px solid var(--line); background: transparent; }
.family-choice-card:last-child { border-bottom: 0; }
.family-choice-select { display: flex; flex: 1; align-self: stretch; align-items: center; gap: 12px; min-width: 0; margin: 0; padding: 16px 0; border: 0; background: transparent; color: var(--ink); text-align: left; }
.family-choice-select.is-disabled { background: transparent; color: var(--ink); opacity: 1; }
.family-choice-cover { flex: 0 0 48px; width: 48px; height: 48px; overflow: hidden; border-radius: 50%; }
.family-choice-cover-frame { position: relative; width: 100%; height: 100%; }
.family-choice-copy { flex: 1; min-width: 0; }
.family-choice-name { display: block; font-size: var(--type-body); font-weight: 500; overflow-wrap: anywhere; }
.family-choice-meta { margin-top: 5px; color: var(--muted); font-size: var(--type-caption); }
.family-choice-check { display: flex; flex: 0 0 24px; align-items: center; justify-content: center; width: 24px; height: 28px; border: 0; border-radius: 0; background: transparent; color: var(--green); }
.family-current-tick { width: 10px; height: 19px; margin-top: -5px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(40deg); }
.family-add-row { display: flex; align-items: center; gap: 12px; margin: 0 16px; padding: 16px 0; border: 0; border-radius: 0; background: transparent; color: var(--ink); font-size: var(--type-body); text-align: left; }
.family-add-icon { display: flex; flex: 0 0 48px; align-items: center; justify-content: center; width: 48px; height: 48px; box-sizing: border-box; border: .5px solid var(--line); border-radius: 50%; }
.family-add-icon .app-icon { width: 22px; height: 22px; }
.family-choice-actions { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
.family-choice-action { display: flex; align-items: center; justify-content: center; min-width: 44px; height: 44px; margin: 0; padding: 0 6px; border: 0; background: transparent; color: var(--muted); font-size: var(--type-caption); }
.family-choice-action-label { padding: 5px 9px; border: .5px solid var(--line); border-radius: 999px; line-height: 1.3; }
.family-choice-action.danger { color: var(--danger); }
.family-choice-action.danger .family-choice-action-label { border-color: var(--danger); }
</style>
