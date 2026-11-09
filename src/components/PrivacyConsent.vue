<script setup>
defineProps({ modelValue: Boolean, disabled: Boolean, invalid: Boolean });
defineEmits(['update:modelValue']);
function openAgreement() { uni.navigateTo({ url: '/pages/privacy/index' }); }
</script>

<template>
  <view class="privacy-consent" :class="{ 'is-invalid': invalid }">
    <button class="privacy-toggle" role="checkbox" :aria-checked="modelValue" :aria-invalid="invalid" :disabled="disabled" aria-label="我已阅读并同意隐私协议" hover-class="none" @click="$emit('update:modelValue', !modelValue)">
      <view class="privacy-check" :class="{ checked: modelValue }"><view v-if="modelValue" class="privacy-check-mark" /></view>
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
.privacy-check { display: flex; align-items: center; justify-content: center; width: 15px; height: 15px; flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 50%; box-sizing: border-box; }
.privacy-check.checked { background: #e9eee6; border-color: #96aa94; }
.privacy-check-mark { width: 6px; height: 3px; border-left: 1.5px solid #526e50; border-bottom: 1.5px solid #526e50; transform: translateY(-1px) rotate(-45deg); }
.privacy-link { color: var(--green); }
.is-invalid .privacy-check { border-color: var(--danger); }
</style>
