<script setup>
import { computed, nextTick, ref } from 'vue';
import { onLoad, onUnload } from '@dcloudio/uni-app';
import { invokeCloud, manageFamily, accountProfile, setInviteMediaToken } from '../../services/cloud.js';
import { cloudMode, connectCloud } from '../../store.js';
import ProfileFields from '../../components/ProfileFields.vue';
import FieldError from '../../components/FieldError.vue';
import PrivacyConsent from '../../components/PrivacyConsent.vue';
import { profileNameError } from '../../domain/family.js';
import AppIcon from '../../components/AppIcon.vue';
import FamilyCoverImage from '../../components/FamilyCoverImage.vue';
import { coverFrameStyle } from '../../domain/image-crop.js';
import { dismissFocusedKeyboard } from '../../services/keyboard.js';
const token = ref('');
const invite = ref(null);
const error = ref('');
const loading = ref(true);
const busy = ref(false);
const uploading = ref(false);
const consent = ref(false);
const name = ref('');
const avatar = ref('');
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => submitted.value && !invite.value?.joined ? { name: profileNameError(name.value), consent: consent.value ? '' : '请先阅读并同意隐私协议' } : {});
let profileBaseline = null;
let readRevision = 0;
let active = true;
async function read() {
  const revision = ++readRevision;
  const current = () => active && revision === readRevision;
  loading.value = true; error.value = ''; invite.value = null; consent.value = false;
  try {
    if (!cloudMode) throw new Error('请在微信小程序中打开家人邀请');
    await connectCloud();
    if (!current()) return;
    name.value = accountProfile.value.name; avatar.value = accountProfile.value.avatar;
    profileBaseline = { name: name.value, avatar: avatar.value };
    const result = await invokeCloud('readInvite', { token: token.value });
    if (!current()) return;
    setInviteMediaToken(token.value);
    invite.value = result;
  } catch (failure) { if (current()) { error.value = failure.message; setInviteMediaToken(); } }
  finally { if (current()) loading.value = false; }
}
onLoad(query => { token.value = query.token || ''; read(); });
onUnload(() => { active = false; readRevision += 1; setInviteMediaToken(); });
async function join() {
  if (!invite.value || loading.value || busy.value || uploading.value) return;
  submitted.value = true;
  const invalid = Object.keys(fieldErrors.value).find(key => fieldErrors.value[key]);
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  busy.value = true; error.value = '';
  const revision = readRevision;
  const current = () => active && revision === readRevision;
  const edited = !invite.value.joined && profileBaseline && (name.value !== profileBaseline.name || avatar.value !== profileBaseline.avatar);
  try {
    await manageFamily('joinFamily', { token: token.value, name: name.value, avatar: avatar.value, ...(edited ? { expectedProfile: { ...profileBaseline } } : {}) });
    if (current()) uni.reLaunch({ url: '/pages/index/index' });
  }
  catch (failure) { if (current()) error.value = failure.message; }
  finally { busy.value = false; }
}
function home() { uni.reLaunch({ url: '/pages/index/index' }); }
</script>

<template>
  <view class="app-shell" @click="dismissFocusedKeyboard"><view class="entry-page invite-page welcome-invite">
    <view class="invitation-paper" :aria-busy="loading || busy">
      <view class="invitation-cover" :style="coverFrameStyle('family')" aria-hidden="true"><FamilyCoverImage :src="invite?.familyCover" variant="detail" /></view>
      <view v-if="loading" class="invitation-body invitation-loading" role="status" aria-live="polite">
        <text class="invitation-title">正在打开邀请</text><text class="invitation-caption">马上就好…</text>
      </view>
      <view v-else-if="invite" class="invitation-body">
        <text class="welcome-eyebrow">家人邀请 · 一起好好吃饭</text>
        <text class="invitation-title">{{ invite.familyName }}</text>
        <text class="invitation-caption">{{ invite.memberCount }} 位家人{{ invite.joined ? '' : '，等你加入' }}</text>
        <view v-if="invite.joined" class="invitation-member-state"><AppIcon name="check" active /><text>你已是这个家的成员</text></view>
        <view v-else class="invitation-profile">
          <text class="invitation-section-title">家人怎么称呼你</text>
          <ProfileFields :ref="field => fieldRefs.name = field" v-model:name="name" v-model:avatar="avatar" :name-error="fieldErrors.name" :disabled="busy" @busy="uploading = $event" />
          <PrivacyConsent v-model="consent" :disabled="busy" :invalid="Boolean(fieldErrors.consent)" />
          <FieldError :ref="field => fieldRefs.consent = field" :error="fieldErrors.consent" />
        </view>
        <view v-if="error" class="invitation-error" role="alert"><text>{{ error }}</text></view>
        <button class="primary-button full invitation-submit" :disabled="busy || uploading" @click="$feedback(); join()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ busy ? (invite.joined ? '正在进入…' : '正在加入…') : invite.joined ? '进入这个家' : '确认加入家庭' }}</button>
      </view>
      <view v-else class="invitation-body invitation-unavailable">
        <text class="invitation-title">暂时无法打开邀请</text><text class="invitation-caption" role="alert">{{ error }}</text>
        <button class="secondary-button full invitation-submit" @click="$feedback(); read()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重新打开邀请</button>
      </view>
    </view>
    <button v-if="invite?.joined" class="text-button invitation-home" @click="$feedback(); home()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">返回首页</button>
  </view></view>
</template>
