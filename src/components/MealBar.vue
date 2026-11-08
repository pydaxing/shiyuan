<script setup>
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { MEALS, reservationDays, calendarDateLabel } from '../domain/kitchen.js';
const props = defineProps({ date: String, meal: String, today: String, mealError: Boolean });
const emit = defineEmits(['update:date', 'update:meal']);
const expanded = ref('');
const days = computed(() => reservationDays(props.today));
const dateLabel = computed(() => `${days.value.find(day => day.date === props.date)?.label || ''} ${calendarDateLabel(props.date)}`.trim());
const mealIcons = { 早餐: 'meal-breakfast', 午餐: 'meal-lunch', 晚餐: 'meal-dinner', 宵夜: 'meal-snack' };
function mealLabel(value) { return value === '宵夜' ? '加餐' : value; }
function select(field, value) {
  emit(`update:${field}`, value);
  expanded.value = '';
}
</script>

<template>
  <view class="arrangement-selectors">
    <button class="arrangement-setting" :aria-expanded="expanded === 'date'" @click="$feedback(); expanded = expanded === 'date' ? '' : 'date'" hover-class="touch-feedback">
      <text class="arrangement-label">用餐日期</text>
      <text class="arrangement-value">{{ dateLabel }}</text>
      <AppIcon name="chevron" :size="16" class="arrangement-chevron" :class="{ 'is-expanded': expanded === 'date' }" />
    </button>
    <view v-if="expanded === 'date'">
      <button v-for="day in days" :key="day.date" class="arrangement-option" :aria-label="`选择${day.label}，${calendarDateLabel(day.date)}${date === day.date ? '，已选择' : ''}`" @click="$feedback(); select('date', day.date)" hover-class="touch-feedback">
        <view class="arrangement-option-label"><text>{{ day.label }}</text><text class="arrangement-date">{{ calendarDateLabel(day.date) }}</text></view>
        <AppIcon v-if="date === day.date" name="check" :size="18" class="arrangement-check" />
      </button>
    </view>
    <button class="arrangement-setting" :class="{ 'is-invalid': mealError }" :aria-invalid="mealError" :aria-expanded="expanded === 'meal'" @click="$feedback(); expanded = expanded === 'meal' ? '' : 'meal'" hover-class="touch-feedback">
      <text class="arrangement-label">餐次</text>
      <view class="arrangement-value arrangement-option-label"><AppIcon v-if="meal" :name="mealIcons[meal]" :size="18" /><text>{{ meal ? mealLabel(meal) : '请选择餐次' }}</text></view>
      <AppIcon name="chevron" :size="16" class="arrangement-chevron" :class="{ 'is-expanded': expanded === 'meal' }" />
    </button>
    <view v-if="expanded === 'meal'">
      <button v-for="entry in MEALS" :key="entry" class="arrangement-option" :aria-label="`选择${mealLabel(entry)}${meal === entry ? '，已选择' : ''}`" @click="$feedback(); select('meal', entry)" hover-class="touch-feedback">
        <view class="arrangement-option-label"><AppIcon :name="mealIcons[entry]" :size="18" /><text>{{ mealLabel(entry) }}</text></view>
        <AppIcon v-if="meal === entry" name="check" :size="18" class="arrangement-check" />
      </button>
    </view>
  </view>
</template>

<style scoped>
.arrangement-setting, .arrangement-option { display: flex; align-items: center; width: 100%; min-height: 56px; margin: 0; padding: 0; border: 0; border-bottom: 1px solid #f0f3f3; border-radius: 0; background: transparent; color: var(--ink); font-size: var(--type-body); line-height: 24px; text-align: left; }
.arrangement-setting { gap: 16px; }
.arrangement-label { flex: 1; }
.arrangement-value { color: var(--muted); font-size: var(--type-control); }
.arrangement-option { justify-content: space-between; min-height: 52px; padding-left: 40px; box-sizing: border-box; }
.arrangement-option-label { display: flex; align-items: center; gap: 8px; }
.arrangement-date { color: var(--muted); font-size: var(--type-control); }
.arrangement-check { color: var(--green); }
.arrangement-chevron { margin-left: -8px; color: var(--muted); transition: transform .18s ease; }
.arrangement-chevron.is-expanded { transform: rotate(90deg); }
.arrangement-setting.is-invalid .arrangement-value { color: var(--danger); }
</style>
