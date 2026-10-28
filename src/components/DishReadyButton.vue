<script setup>
import AppIcon from './AppIcon.vue';
defineProps({ prepared: Boolean, busy: Boolean, disabled: Boolean, label: String });
defineEmits(['toggle']);
</script>

<template>
  <button role="button" class="dish-ready-button secondary-button" :class="{ 'is-prepared': prepared, 'is-disabled': disabled || busy }" :aria-pressed="prepared" :aria-busy="busy" :aria-label="label" :disabled="disabled || busy" @click.stop="$emit('toggle')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
    <AppIcon name="check" active :size="16" /><text>{{ prepared ? '已备齐' : '备齐' }}</text>
  </button>
</template>

<style scoped>
.dish-ready-button { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 44px; margin: 0; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius-control); font-size: var(--type-control); line-height: 22px; }
.dish-ready-button.is-disabled { background: var(--white); color: var(--green); }
.dish-ready-button.is-prepared, .dish-ready-button.is-prepared.is-disabled { border-color: var(--success-light); background: var(--success-light); color: var(--success); }
</style>
