<script setup>
import AppIcon from './AppIcon.vue';
defineProps({ modelValue: Boolean, disabled: Boolean, invalid: Boolean });
defineEmits(['update:modelValue']);
function openAgreement() { uni.navigateTo({ url: '/pages/privacy/index' }); }
</script>

<template>
  <view class="privacy-consent" :class="{ 'is-invalid': invalid }">
    <button class="privacy-toggle" role="checkbox" :aria-checked="modelValue" :aria-invalid="invalid" :disabled="disabled" aria-label="我已阅读并同意隐私协议" hover-class="none" @click="$emit('update:modelValue', !modelValue)">
      <view class="privacy-check" :class="{ checked: modelValue }"><AppIcon v-if="modelValue" name="check" :size="13" /></view>
      <text>我已阅读并同意</text>
    </button>
    <button class="privacy-link" hover-class="none" @click="openAgreement">《隐私协议》</button>
  </view>
</template>

<style scoped>
.privacy-consent { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; margin: 24px 0 8px; color: var(--muted); font-size: var(--type-meta); }
.privacy-toggle, .privacy-link { display: flex; align-items: center; min-height: 44px; margin: 0; padding: 0; font-size: inherit; line-height: 22px; background: transparent; color: inherit; }
.privacy-toggle { gap: 8px; }
.privacy-toggle, .privacy-link { border: 0; box-shadow: none; border-radius: 0; }
.privacy-toggle::after, .privacy-link::after { border: 0; }
.privacy-check { display: flex; align-items: center; justify-content: center; width: 17px; height: 17px; border: 1px solid var(--border-strong); border-radius: 50%; box-sizing: border-box; }
.privacy-check.checked { background: var(--green-light); border-color: var(--green); }
.privacy-link { color: var(--green); }
.is-invalid .privacy-check { border-color: var(--danger); }
</style>
