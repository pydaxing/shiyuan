<script setup>
import { computed, nextTick, ref } from 'vue';
import { cloudStatus, connectCloud, runAction } from '../store.js';
import { manageFamily, accountProfile } from '../services/cloud.js';
import ProfileFields from './ProfileFields.vue';
import FormField from './FormField.vue';
import FieldError from './FieldError.vue';
import { familyAppearanceFieldErrors, profileNameError } from '../domain/family.js';
const name = ref(accountProfile.value.name || '');
const avatar = ref(accountProfile.value.avatar || '');
const uploading = ref(false);
const familyName = ref('我们的小家');
const consent = ref(false);
const busy = ref(false);
const error = ref('');
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => submitted.value ? {
  name: profileNameError(name.value),
  familyName: familyAppearanceFieldErrors({ name: familyName.value }).name,
  consent: consent.value ? '' : '请先确认云端保存说明',
} : {});
const requestId = `create-family-${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function enter() {
  if (busy.value || uploading.value) return;
  submitted.value = true; error.value = '';
  const invalid = Object.keys(fieldErrors.value).find(key => fieldErrors.value[key]);
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  busy.value = true;
  try { await manageFamily('createFamily', { name: name.value, avatar: avatar.value, familyName: familyName.value, requestId }); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <view class="cloud-welcome">
    <text class="cloud-eyebrow">一家人，好好吃饭</text><text class="cloud-title">{{ cloudStatus.phase === 'connecting' ? '正在连接你的小家' : '从我们的小家开始' }}</text>
    <view v-if="cloudStatus.familyRecoveryRequired" class="cloud-card"><text role="alert" class="error-message">{{ cloudStatus.error }}</text><button role="button" class="primary-button full" :disabled="cloudStatus.busy" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ cloudStatus.busy ? '正在同步…' : cloudStatus.pendingDeletions?.length ? '继续清理' : '重新同步家庭状态' }}</button></view>
    <view v-else-if="cloudStatus.phase === 'onboarding'" class="cloud-card">
      <ProfileFields :ref="field => fieldRefs.name = field" v-model:name="name" v-model:avatar="avatar" :name-error="fieldErrors.name" :disabled="busy" @busy="uploading = $event" />
      <view class="field-label" @click.stop><text class="subheading">家庭名称</text><FormField :ref="field => fieldRefs.familyName = field" v-model="familyName" :error="fieldErrors.familyName" :disabled="busy" field-class="input" maxlength="20" aria-label="新家庭名称" /></view>
      <button role="checkbox" class="cloud-consent" :aria-checked="consent" :aria-invalid="Boolean(fieldErrors.consent)" :aria-describedby="fieldErrors.consent ? 'cloud-consent-error' : undefined" :disabled="busy" @click="consent = !consent" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>{{ consent ? '✓' : '○' }}</text><text>同意将资料与家庭记录保存在微信云端，供家人共同使用。主动分享的菜品可由接收好友查看。</text></button>
      <FieldError :ref="field => fieldRefs.consent = field" :error="fieldErrors.consent" error-id="cloud-consent-error" />
      <text v-if="error" class="error-message" role="alert">{{ error }}</text>
      <button role="button" class="primary-button full" :disabled="busy || uploading" @click="enter" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? '正在连接…' : '创建小家' }}</button>
    </view>
    <view v-else-if="cloudStatus.error" class="cloud-card"><text role="alert" class="error-message">{{ cloudStatus.error }}</text><button role="button" class="primary-button full" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重新连接</button></view>
  </view>
</template>
