<script setup>
import { computed, ref, watch } from 'vue';
import { state, activeMember, cloudMode, cloudStatus, notify } from '../store.js';
import ProfileEditor from './ProfileEditor.vue';
import LazyImage from './LazyImage.vue';
import FamilyManagement from './FamilyManagement.vue';
import StretchCover from './StretchCover.vue';
import AppIcon from './AppIcon.vue';
import PageHeader from './PageHeader.vue';
import Sheet from './Sheet.vue';
import { familyModePreview, personalModePreview, manageFamily } from '../services/cloud.js';
import { familyAppearance } from '../domain/family.js';
import { localDate } from '../domain/kitchen.js';
import { useNavigationAppearance } from '../composables/useNavigationAppearance.js';
import { sheetOpen } from '../composables/sheetStack.js';
defineProps({ today: { type: String, default: localDate }, refreshAction: Function });
const emit = defineEmits(['customize', 'manage', 'diary']);
const personal = computed(() => state.value.family.kind === 'personal');
const modeBusy = ref(false);
const requestedFamilyMode = ref(null);
const pageTitle = computed(() => '');
const displayedFamilyMode = computed(() => requestedFamilyMode.value ?? !personal.value);
const modeError = ref('');
async function toggleMode() {
  if (modeBusy.value || cloudStatus.value.busy) return;
  if (!cloudMode) { modeError.value = '请连接微信云端后切换使用方式'; return; }
  const enableFamilyMode = personal.value;
  requestedFamilyMode.value = enableFamilyMode;
  modeBusy.value = true; modeError.value = '';
  notify(enableFamilyMode ? '开启家庭模式' : '关闭家庭模式');
  try {
    await manageFamily('switchWorkspace', { mode: enableFamilyMode ? 'family' : 'personal', expectedSpaceId: state.value.family.id });
  }
  catch (error) { if (error.code === 'FAMILY_REQUIRED') { notify('请先创建或加入家庭'); emit('manage'); } else { modeError.value = error.message || '切换失败，请重试'; notify(modeError.value); } }
  finally { modeBusy.value = false; requestedFamilyMode.value = null; if (personal.value) familyOpen.value = false; }
}
// A remembered cover is presentation only. Membership and all writes continue
// to use the confirmed workspace until switchWorkspace acknowledges the change.
const displayedFamily = computed(() => !personal.value ? state.value.family
  : familyModePreview.value?.userId === cloudStatus.value.userId ? familyModePreview.value : null);
const displayedPersonal = computed(() => personal.value ? state.value.family
  : personalModePreview.value?.userId === cloudStatus.value.userId ? personalModePreview.value : null);
const familyDisplay = computed(() => familyAppearance((displayedFamilyMode.value ? displayedFamily.value : displayedPersonal.value) || {}));
const displayedMemberCount = computed(() => displayedFamily.value?.members?.length ?? displayedFamily.value?.memberCount);
const headerOpacity = ref(0);
const headerSolid = computed(() => headerOpacity.value >= 0.4);
const atTop = ref(true);
function onScroll(event) {
  const top = Math.max(0, Number(event?.scrollTop) || 0);
  headerOpacity.value = Math.round(Math.min(top / 64, 1) * 100) / 100;
  atTop.value = top <= 1;
}
defineExpose({ onScroll });
useNavigationAppearance(computed(() => !headerSolid.value ? 'dark' : 'light'));
const about = ref(false);
const familyOpen = ref(false);
const familySheet = ref(null);
const familyManagement = ref(null);
const familyManaging = ref(false);
const familyCreating = computed(() => Boolean(familyManagement.value?.creating));
const editingProfile = ref(false);
watch(() => state.value.family.id, () => {
  if (personal.value || (!familyManaging.value && requestedFamilyMode.value !== true)) familyOpen.value = false;
  editingProfile.value = false;
  headerOpacity.value = 0; atTop.value = true;
});
watch(() => cloudStatus.value.userId, () => { familyOpen.value = false; editingProfile.value = false; });
function editProfile() {
  if (modeBusy.value || cloudStatus.value.busy) return;
  if (!cloudMode) { notify('请在微信小程序中编辑头像与昵称'); return; }
  editingProfile.value = true;
}
function closeFamily() {
  if (familyManaging.value) return;
  if (familyCreating.value) { familyManagement.value?.back(); familySheet.value?.resetScroll(); return; }
  familyOpen.value = false;
}
function familyChanged() {
  if (personal.value) { familyOpen.value = false; return; }
  familyManagement.value?.load();
  familySheet.value?.resetScroll();
}
</script>

<template>
  <view class="family-view">
    <StretchCover class="account-hero has-family-cover" :src="familyDisplay.cover" :personal="!displayedFamilyMode" :enabled="true" :active="!sheetOpen" :at-top="atTop" :refresh-action="refreshAction">
      <template #navigation><PageHeader :title="pageTitle" :cover="!headerSolid" :fade="headerOpacity" /></template>
      <button role="button" class="account-profile" :class="{ 'is-pending': modeBusy }" :disabled="modeBusy" aria-label="编辑我的资料与封面" @click.stop="editProfile" hover-class="touch-feedback">
        <view class="account-avatar"><LazyImage :src="activeMember.avatar" variant="avatar" avatar round /></view>
        <view class="account-copy">
          <text class="account-name">{{ activeMember.name || '我' }}</text>
          <view class="account-identity" :aria-busy="modeBusy">
            <view class="account-identity-badge"><view class="account-identity-symbol" :class="{ 'is-family': displayedFamilyMode }" aria-hidden="true"><AppIcon :name="displayedFamilyMode ? 'identity-home-inverse' : 'identity-person-inverse'" :size="14" /></view><text class="account-identity-label">{{ displayedFamilyMode ? '家庭' : '个人' }}</text></view>
            <text v-if="displayedFamilyMode && displayedFamily" class="account-family-name">{{ familyDisplay.name }}</text>
          </view>
        </view>
        <view class="account-profile-chevron"><AppIcon name="chevron" :size="18" /></view>
      </button>
      <template #content>
        <view class="account-sections">
          <view class="account-group">
            <button role="button" class="account-row diary-entry" aria-label="打开饮食日记" @click.stop="$emit('diary')" hover-class="touch-feedback"><AppIcon name="calendar" :size="22" /><text class="account-row-title">饮食日记</text><AppIcon name="chevron" :size="16" /></button>
          </view>
          <view class="account-group account-workspace-group">
            <view class="account-row account-mode-row" :aria-busy="modeBusy"><AppIcon name="family" :size="22" /><text class="account-row-title">家庭模式</text><button role="switch" class="feature-switch" :class="{ on: displayedFamilyMode, pending: modeBusy }" :aria-checked="displayedFamilyMode" :aria-busy="modeBusy" :disabled="modeBusy || cloudStatus.busy" aria-label="家庭模式" @click.stop="toggleMode" hover-class="none"><view /></button></view>
            <text v-if="modeError" class="form-error account-error" role="alert">{{ modeError }}</text>
            <button v-if="displayedFamilyMode" role="button" class="account-row family-members-entry" aria-label="查看我的家庭" @click.stop="familyOpen = true" hover-class="touch-feedback"><AppIcon name="family" :size="22" /><text class="account-row-title">我的家庭</text><text v-if="displayedMemberCount" class="account-row-value">{{ displayedMemberCount }} 人</text><AppIcon name="chevron" :size="16" /></button>
          </view>
          <view class="account-group">
            <button role="button" class="account-row family-help-entry" aria-label="打开使用说明" @click.stop="about = true" hover-class="touch-feedback"><AppIcon name="menu" :size="22" /><text class="account-row-title">使用说明</text><AppIcon name="chevron" :size="16" /></button>
          </view>
        </view>
      </template>
    </StretchCover>
    <Sheet v-if="familyOpen" ref="familySheet" page :title="familyCreating ? '新建家庭' : '我的家庭'" variant="settings" :footer-visible="false" @close="closeFamily">
      <FamilyManagement ref="familyManagement" :active="!modeBusy" @busy="familyManaging = $event" @section-change="familySheet?.resetScroll()" @changed="familyChanged" />
    </Sheet>
    <Sheet v-if="about" page title="使用说明" variant="help" :footer-visible="false" @close="about = false">
      <view class="help-section"><text class="help-heading">从菜单安排一餐</text><text class="help-paragraph">在「小灶 → 菜单」选好菜，再选择日期和餐次。已有安排时去「安排」加菜或查看备菜清单。菜谱原本的用量会保留。</text></view>
      <view class="help-section"><text class="help-heading">留下吃饭的记录</text><text class="help-paragraph">在「安排」可以添上实拍与标签。未手动记录的当天餐食跨日后自动存入饮食日记，并默认公开到「发现」；家庭餐同步到家人的个人日记。已手动设置的可见范围保持不变。</text></view>
      <view class="help-section"><text class="help-heading">看看大家吃什么</text><text class="help-paragraph">在「发现」浏览公开餐食的照片与标签，下拉可以刷新。自己的记录可以在饮食日记中改为仅饮食日记，也可以删除。</text></view>
      <view class="help-section"><text class="help-heading">个人与家庭</text><text class="help-paragraph">在「我的」关闭家庭模式只是切换为个人使用，不会退出或删除家庭。开启后可回到原家庭，没有家庭时可创建或加入。退出和删除仍在家庭管理中单独处理。</text></view>
    </Sheet>
    <ProfileEditor v-if="editingProfile" page @close="editingProfile = false" />
  </view>
</template>

<style scoped>
.feature-switch.pending { opacity: 1; }
.account-workspace-group .account-row.is-pending { opacity: 1; }
.family-view { min-height: calc(100vh - var(--account-bottom-inset, 0px)); margin: 0 calc(-1 * var(--page-gutter)); background: var(--paper); }
.account-profile { display: flex; align-items: center; gap: 18px; width: 100%; box-sizing: border-box; height: var(--home-cover-content-height); padding: calc(var(--home-cover-content-height) - 104px) 24px 40px; background: var(--white); color: var(--ink); text-align: left; }
.account-profile.is-pending { opacity: 1; }
.has-family-cover .account-profile { position: relative; background: transparent; color: var(--white); border-radius: 0; }
.has-family-cover .account-avatar { box-shadow: 0 0 0 1px var(--profile-cover-border); }
.has-family-cover .account-family-name { color: var(--white); }
.has-family-cover .account-name, .has-family-cover .account-family-name { text-shadow: 0 1px 3px rgba(22, 28, 32, .45); }
.has-family-cover .account-identity-badge { background: var(--photo-label-surface); color: var(--white); }
.account-profile-chevron { display: flex; align-items: center; flex-shrink: 0; }
.has-family-cover .account-profile-chevron { filter: brightness(0) invert(1); }
.account-avatar { width: 64px; height: 64px; flex: 0 0 64px; overflow: hidden; border-radius: 50%; }
.account-avatar .lazy-photo { width: 100%; height: 100%; }
.account-copy { flex: 1; min-width: 0; }
.account-name { display: block; font-size: var(--type-title); font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.account-identity { display: flex; align-items: center; gap: 8px; min-height: 22px; margin-top: 7px; }
.account-identity-badge { display: inline-flex; align-items: center; justify-content: center; gap: 4px; flex-shrink: 0; box-sizing: border-box; height: 22px; padding: 0 9px; border-radius: 999px; background: var(--control-accent); color: var(--green); }
.account-identity-symbol { display: flex; align-items: center; justify-content: center; flex: 0 0 14px; width: 14px; height: 14px; }
.account-identity-label { display: block; font-size: var(--type-caption); font-weight: 500; line-height: 1; text-align: center; white-space: nowrap; }
.account-family-name { display: block; min-width: 0; overflow: hidden; color: var(--muted); font-size: var(--type-meta); line-height: 22px; text-overflow: ellipsis; white-space: nowrap; }
.account-sections { position: relative; margin-top: calc(-1 * var(--radius-sheet)); padding: 0 0 24px; }
.account-group:first-child { overflow: hidden; border-radius: var(--radius-sheet) var(--radius-sheet) 0 0; }
.account-group { margin-bottom: 12px; background: var(--white); }
.account-row { display: flex; align-items: center; gap: 14px; width: 100%; box-sizing: border-box; min-height: 58px; padding: 13px 20px; text-align: left; color: var(--ink); background: var(--white); }
.account-row + .account-row { border-top: 1px solid var(--paper); }
.account-row-title { flex: 1; min-width: 0; font-size: var(--type-body); line-height: 24px; }
.account-row-value { color: var(--muted); font-size: var(--type-meta); }
.account-mode-row { padding-top: 5px; padding-bottom: 5px; }
.account-mode-row .feature-switch { flex-shrink: 0; }
.account-error { display: block; margin: 0 20px 16px; }
</style>
