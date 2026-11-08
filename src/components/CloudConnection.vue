<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import { cloudStatus, connectCloud, runAction } from '../store.js';
import { manageFamily, accountProfile } from '../services/cloud.js';
import ProfileFields from './ProfileFields.vue';
import PrivacyConsent from './PrivacyConsent.vue';
import FieldError from './FieldError.vue';
import { profileNameError } from '../domain/family.js';
const entering = computed(() => cloudStatus.value.phase === 'connecting' && !cloudStatus.value.error && !cloudStatus.value.familyRecoveryRequired);
const name = ref(accountProfile.value.name || '');
const avatar = ref(accountProfile.value.avatar || '');
watch(accountProfile, (next, previous) => {
  // Bootstrap can finish after this component mounts. Populate its defaults
  // without replacing text or a photo the person has already edited.
  if (name.value === (previous?.name || '')) name.value = next.name || '';
  if (avatar.value === (previous?.avatar || '')) avatar.value = next.avatar || '';
});
const uploading = ref(false);
const consent = ref(false);
const busy = ref(false);
const error = ref('');
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => submitted.value ? {
  name: profileNameError(name.value),
  consent: consent.value ? '' : '请先阅读并同意隐私协议',
} : {});
async function enter() {
  if (busy.value || uploading.value) return;
  submitted.value = true; error.value = '';
  const invalid = Object.keys(fieldErrors.value).find(key => fieldErrors.value[key]);
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  busy.value = true;
  try {
    await manageFamily('updateProfile', { name: name.value, avatar: avatar.value });
    await manageFamily('switchWorkspace', { mode: 'personal', expectedSpaceId: '' });
  }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <view v-if="entering" class="entry-cover" role="status" aria-label="正在进入你的小灶">
    <image class="entry-backdrop" :src="$image('/static/entry-window.jpg')" mode="aspectFill" aria-hidden="true" />
    <view class="entry-shade" aria-hidden="true" />
    <view class="entry-brand"><image class="entry-logo" :src="$image('/static/entry-window-logo.png')" mode="aspectFit" aria-hidden="true" /><image class="entry-brand-name" :src="$image('/static/entry-window-wordmark.png')" mode="aspectFit" aria-label="食愿小灶" /></view>
    <text class="entry-message">正在进入你的小灶</text>
  </view>
  <view v-else class="cloud-welcome welcome-page">
    <image class="welcome-cover" :src="$image('/static/personal-home-default.jpg')" mode="aspectFill" aria-hidden="true" />
    <view class="welcome-content">
    <text class="welcome-eyebrow">食愿小灶</text><text class="welcome-title">一个人的饭，也好好吃</text><text class="welcome-caption">收下喜欢的菜，记住每一餐。</text>
    <view v-if="cloudStatus.familyRecoveryRequired" class="cloud-card"><text role="alert" class="error-message">{{ cloudStatus.error }}</text><button role="button" class="primary-button full" :disabled="cloudStatus.busy" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ cloudStatus.busy ? '正在同步…' : cloudStatus.pendingDeletions?.length ? '继续清理' : '重新同步家庭状态' }}</button></view>
    <view v-else-if="cloudStatus.phase === 'onboarding'" class="welcome-form">
      <ProfileFields :ref="field => fieldRefs.name = field" v-model:name="name" v-model:avatar="avatar" :name-error="fieldErrors.name" :disabled="busy" @busy="uploading = $event" />
      <PrivacyConsent v-model="consent" :disabled="busy" :invalid="Boolean(fieldErrors.consent)" />
      <FieldError :ref="field => fieldRefs.consent = field" :error="fieldErrors.consent" error-id="cloud-consent-error" />
      <text v-if="error" class="error-message" role="alert">{{ error }}</text>
      <button role="button" class="primary-button full" :disabled="busy || uploading" @click="enter" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '正在进入…' : '进入我的小灶' }}</button>
    </view>
    <view v-else-if="cloudStatus.error" class="cloud-card"><text role="alert" class="error-message">{{ cloudStatus.error }}</text><button role="button" class="primary-button full" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重新连接</button></view>
    </view>
  </view>
</template>

<style scoped>
 .entry-cover { position: fixed; inset: 0; z-index: 20; overflow: hidden; background: #d1d2b9; }
.entry-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; }
.entry-shade { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 76%, rgba(247,243,230,.78) 100%); }
.entry-brand { position: absolute; top: 47%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 18px; }
.entry-logo { display: block; width: 62px; height: 66px; }
.entry-brand-name { display: block; width: 154px; height: 42px; }
.entry-message { position: absolute; bottom: calc(36px + env(safe-area-inset-bottom)); left: 24px; right: 24px; color: #435b46; font-size: var(--type-control); letter-spacing: 2px; line-height: 1.6; text-align: center; }

</style>
