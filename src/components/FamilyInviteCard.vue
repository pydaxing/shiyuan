<script setup>
import { computed } from 'vue';
import { state, cloudStatus, cloudMode, notify } from '../store.js';
import { familyInvitation } from '../services/family-invitation.js';
import { invitationCard } from '../services/native-share.js';
import NativeShareButton from './NativeShareButton.vue';
import AppIcon from './AppIcon.vue';
const props = defineProps({ compact: Boolean, disabled: Boolean });
const { prepared, error, busy } = familyInvitation;
const owner = computed(() => state.value.family.ownerId === cloudStatus.value.userId);
const buttonClass = computed(() => props.compact ? 'group-invite-button' : 'member-card member-invite');
const card = computed(() => prepared.value ? invitationCard({ ...prepared.value, familyName: state.value.family.name }) : null);
familyInvitation.resume().catch(() => {});
function fallback() {
  if (!cloudMode || !owner.value) { notify(cloudMode ? '请让家庭管理员邀请家人' : '请在微信云端版本中邀请家人'); return; }
  if (busy.value) { notify('邀请正在连接，马上就好'); return; }
  notify(error.value || '邀请正在连接，马上就好');
  familyInvitation.ensure().catch(failure => notify(failure.message));
}
</script>

<template>
  <NativeShareButton v-if="card" :card="card" :disabled="disabled" :button-class="buttonClass"><view class="invite-portrait"><AppIcon name="plus" /></view><text class="member-name">邀请</text></NativeShareButton>
  <button v-else :class="buttonClass" :disabled="disabled" :aria-busy="busy" @click.stop="$feedback(); fallback()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="invite-portrait"><AppIcon name="plus" /></view><text class="member-name">邀请</text></button>
</template>
