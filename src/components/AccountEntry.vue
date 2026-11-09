<script setup>
import { onMounted, ref } from 'vue';
import { accountEntry, accountEntryStatus as entry } from '../services/account-entry.js';
import PrivacyConsent from './PrivacyConsent.vue';
const consent = ref(false);
onMounted(() => accountEntry.check());
function phone(event) { return accountEntry.bind(event.detail, consent.value); }
</script>
<template>
  <view class="account-entry" aria-label="食愿小灶登录">
    <image class="account-entry-backdrop" :src="$image('/static/entry-window.jpg')" mode="aspectFill" aria-hidden="true" />
    <view class="account-entry-shade" aria-hidden="true" />
    <view class="account-entry-brand">
      <image class="account-entry-logo" :src="$image('/static/entry-window-logo.png')" mode="aspectFit" aria-hidden="true" />
      <image class="account-entry-name" :src="$image('/static/entry-window-wordmark.png')" mode="aspectFit" aria-label="食愿小灶" />
    </view>
    <view class="account-entry-actions">
      <text v-if="entry.phase === 'checking'" class="account-entry-caption" role="status">正在进入你的小灶</text>
      <template v-else-if="entry.phase === 'phone'">
        <button v-if="consent" class="primary-button full account-entry-button" open-type="getPhoneNumber" :disabled="entry.busy" @getphonenumber="phone" hover-class="none">{{ entry.busy ? '正在登录…' : '手机号快捷登录' }}</button>
        <button v-else class="primary-button full account-entry-button" @click="accountEntry.bind(null, false)" hover-class="none">手机号快捷登录</button>
        <PrivacyConsent v-model="consent" :disabled="entry.busy" :invalid="Boolean(entry.error) && !consent" />
      </template>
      <template v-else-if="entry.phase === 'error'">
        <text class="account-entry-title">暂时未能连接</text>
        <button class="primary-button full account-entry-button" @click="accountEntry.check" hover-class="none">重新连接</button>
      </template>
      <text v-if="entry.error" class="account-entry-error" role="alert">{{ entry.error }}</text>
    </view>
  </view>
</template>
<style scoped>
.account-entry { position: fixed; inset: 0; z-index: 100; background: #d1d2b9; overflow-y: auto; }
.account-entry-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; }
.account-entry-shade { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 40%, rgba(247,243,230,.86) 74%, #f7f3e6 100%); }
.account-entry-brand { position: absolute; top: 35%; left: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 18px; }
.account-entry-logo { display: block; width: 62px; height: 66px; }
.account-entry-name { display: block; width: 154px; height: 42px; }
.account-entry-actions { position: absolute; left: 28px; right: 28px; bottom: calc(24px + env(safe-area-inset-bottom)); max-width: 420px; margin: auto; text-align: center; }
.account-entry-title { display: block; color: var(--ink); font-size: var(--type-title); font-family: var(--font-display); line-height: 1.6; }
.account-entry-caption { display: block; margin-top: 8px; color: #435b46; font-size: var(--type-control); line-height: 1.8; }
.account-entry-button { margin-top: 24px; min-height: 48px; background: #405b46; color: #fff; border: 0; box-shadow: none; }
.account-entry-button::after { border: 0; }
.account-entry-button[disabled] { background: #405b46; color: #fff; opacity: .65; }
.account-entry-error { display: block; margin-top: 8px; color: var(--danger); font-size: var(--type-meta); line-height: 1.6; }
@media (max-height: 600px) { .account-entry-brand { top: 24%; } .account-entry-actions { bottom: calc(12px + env(safe-area-inset-bottom)); } .account-entry-button { margin-top: 12px; } }
</style>
