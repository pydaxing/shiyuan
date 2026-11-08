<script setup>
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { localDate } from '../domain/kitchen.js';
const props = defineProps({ modelValue: String, disabled: Boolean });
const emit = defineEmits(['update:modelValue']);
const expanded = ref(false);
const maximum = ref(localDate());
const parts = computed(() => (props.modelValue || maximum.value).split('-').map(Number));
const years = computed(() => Array.from({ length: Number(maximum.value.slice(0, 4)) - 1999 }, (_, i) => 2000 + i));
const months = computed(() => Array.from({ length: parts.value[0] === Number(maximum.value.slice(0, 4)) ? Number(maximum.value.slice(5, 7)) : 12 }, (_, i) => i + 1));
const days = computed(() => {
  const [year, month] = parts.value;
  const count = new Date(year, month, 0).getDate();
  const limit = props.modelValue?.slice(0, 7) === maximum.value.slice(0, 7) ? Number(maximum.value.slice(8)) : count;
  return Array.from({ length: Math.min(count, limit) }, (_, i) => i + 1);
});
const indices = computed(() => [parts.value[0] - 2000, parts.value[1] - 1, parts.value[2] - 1]);
const label = computed(() => `${parts.value[0]}年${parts.value[1]}月${parts.value[2]}日`);
function toggle() {
  if (props.disabled) return;
  maximum.value = localDate();
  expanded.value = !expanded.value;
  if (expanded.value) uni.hideKeyboard();
}
function change(event) {
  if (props.disabled) return;
  const [yi, mi, di] = event.detail.value;
  const year = years.value[yi] || parts.value[0];
  const maxParts = maximum.value.split('-').map(Number);
  const month = Math.min(Math.max(mi + 1, 1), year === maxParts[0] ? maxParts[1] : 12);
  const day = Math.min(Math.max(di + 1, 1), new Date(year, month, 0).getDate(), year === maxParts[0] && month === maxParts[1] ? maxParts[2] : 31);
  emit('update:modelValue', `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
}
</script>
<template>
  <button class="meal-date-row" :disabled="disabled" :aria-expanded="expanded" @click="toggle" hover-class="touch-feedback">
    <text class="meal-date-label">用餐日期</text>
    <text class="meal-date-value">{{ label }}</text>
    <AppIcon name="chevron" :size="16" class="meal-date-arrow" :class="{ 'is-expanded': expanded }" />
  </button>
  <view v-if="expanded" class="meal-date-panel" :class="{ 'is-disabled': disabled }">
    <picker-view class="meal-date-wheel" :value="indices" indicator-style="height: 44px; border-top: 1px solid #f0f3f3; border-bottom: 1px solid #f0f3f3;" @change="change">
      <picker-view-column><view v-for="year in years" :key="year" class="meal-date-option" :class="{ 'is-selected': year === parts[0] }">{{ year }}年</view></picker-view-column>
      <picker-view-column><view v-for="month in months" :key="month" class="meal-date-option" :class="{ 'is-selected': month === parts[1] }">{{ month }}月</view></picker-view-column>
      <picker-view-column><view v-for="day in days" :key="day" class="meal-date-option" :class="{ 'is-selected': day === parts[2] }">{{ day }}日</view></picker-view-column>
    </picker-view>
  </view>
</template>
<style scoped>
.meal-date-row { display: flex; align-items: center; gap: 16px; width: 100%; min-height: 56px; margin: 0; padding: 0; border: 0; border-bottom: 1px solid #f0f3f3; border-radius: 0; background: transparent; text-align: left; }
.meal-date-label { flex: 1; font-size: var(--type-body); line-height: 24px; }
.meal-date-value { color: var(--muted); font-size: var(--type-control); line-height: 24px; }
.meal-date-arrow { flex-shrink: 0; margin-left: -8px; transition: transform 160ms ease; }
.meal-date-arrow.is-expanded { transform: rotate(90deg); }
.meal-date-panel { padding: 8px 0 8px 40px; border-bottom: 1px solid #f0f3f3; }
.meal-date-panel.is-disabled { pointer-events: none; opacity: .6; }
.meal-date-wheel { width: 100%; height: 220px; }
.meal-date-option { display: flex; align-items: center; justify-content: center; height: 44px; color: var(--muted); font-size: var(--type-body); }
.meal-date-option.is-selected { color: var(--green); font-weight: 500; }
</style>
