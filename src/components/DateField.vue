<script setup>
import { computed, ref } from 'vue';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { localDate, dateOffset } from '../domain/kitchen.js';
import AppIcon from './AppIcon.vue';
import Sheet from './Sheet.vue';
const props = defineProps({ modelValue: String, label: { type: String, default: '选择日期' }, compact: Boolean });
const emit = defineEmits(['update:modelValue']);
const open = ref(false);
const cursor = ref(localDate().slice(0, 7));
const dateLabel = computed(() => !props.modelValue ? '选择到期日期' : props.modelValue === localDate() ? '今天' : props.modelValue === dateOffset(1) ? '明天' : `${Number(props.modelValue.slice(5, 7))}月${Number(props.modelValue.slice(8))}日`);
const monthLabel = computed(() => `${cursor.value.slice(0, 4)} 年 ${Number(cursor.value.slice(5))} 月`);
const days = computed(() => {
  const first = new Date(`${cursor.value}-01T12:00:00`);
  const leading = (first.getDay() + 6) % 7;
  const count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return [...Array.from({ length: leading }, (_, index) => ({ key: `empty-${index}` })), ...Array.from({ length: count }, (_, index) => ({ key: `${cursor.value}-${String(index + 1).padStart(2, '0')}`, day: index + 1 }))];
});
function shift(change) {
  const month = new Date(`${cursor.value}-01T12:00:00`);
  month.setMonth(month.getMonth() + change);
  cursor.value = localDate(month).slice(0, 7);
}
function choose(value) { emit('update:modelValue', value); open.value = false; }
function show() { dismissFocusedKeyboard(); cursor.value = (props.modelValue || localDate()).slice(0, 7); open.value = true; }
</script>

<template>
  <view :class="{ 'date-field': !compact }"><button role="button" :class="compact ? 'meal-date' : 'input choice-trigger'" :aria-label="label" :aria-expanded="open" @click="show" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="calendar" /><text>{{ compact ? dateLabel : (modelValue || dateLabel) }}</text></button>
    <Sheet v-if="open" :title="label" :preferred-height="620" @close="open = false"><view class="calendar-quick"><button role="button" class="secondary-button" @click="choose(localDate())" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">今天</button><button role="button" class="secondary-button" @click="choose(dateOffset(1))" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">明天</button></view><view class="calendar-month"><button role="button" class="icon-button" aria-label="上个月" @click="shift(-1)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="chevron" class="icon-previous" /></button><text>{{ monthLabel }}</text><button role="button" class="icon-button" aria-label="下个月" @click="shift(1)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="chevron" /></button></view><view class="calendar-grid"><text v-for="weekday in ['一', '二', '三', '四', '五', '六', '日']" :key="weekday" class="calendar-weekday">{{ weekday }}</text><view v-for="day in days" :key="day.key"><button v-if="day.day" role="button" class="calendar-day" :class="{ selected: modelValue === day.key, today: day.key === localDate() }" :aria-label="`选择${day.key}`" :aria-pressed="modelValue === day.key" @click="choose(day.key)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ day.day }}</button></view></view></Sheet>
  </view>
</template>
