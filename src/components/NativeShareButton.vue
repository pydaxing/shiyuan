<script setup>
import { ref, watch, onUnmounted } from 'vue';
import { registerShare, removeShare } from '../services/native-share.js';
import { tapFeedback } from '../services/feedback.js';
import { notify } from '../store.js';
const props = defineProps({ card: Object, disabled: Boolean, label: String, buttonClass: { type: String, default: 'secondary-button' } });
const key = ref('');
const native = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
watch(() => props.card, card => { removeShare(key.value); key.value = card ? registerShare(card) : ''; }, { immediate: true });
onUnmounted(() => removeShare(key.value));
function feedback() { tapFeedback(); if (!native) notify('请在微信小程序中转发给好友'); }
</script>

<template>
  <button role="button" :class="buttonClass" :aria-label="label" :open-type="native && card ? 'share' : undefined" :data-share-key="key" :disabled="disabled || !card" @click.stop="feedback" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><slot>发给微信好友</slot></button>
</template>
