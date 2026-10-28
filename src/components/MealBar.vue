<script setup>
import { MEALS, reservationDays, calendarDateLabel } from '../domain/kitchen.js';
defineProps({ date: String, meal: String, today: String });
defineEmits(['update:date', 'update:meal']);
</script>

<template>
  <view class="meal-bar">
    <view class="reservation-days">
      <button role="button" v-for="day in reservationDays(today)" :key="day.date" :aria-label="`选择${day.label}，${calendarDateLabel(day.date)}`" :aria-pressed="date === day.date" :class="{ active: date === day.date }" @click="$feedback(); $emit('update:date', day.date)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <text class="reservation-day-label">{{ day.label }}</text>
        <text class="reservation-day-date">{{ calendarDateLabel(day.date) }}</text>
      </button>
    </view>
    <view class="meal-tabs"><button role="button" v-for="entry in MEALS" :key="entry" :aria-label="`选择${entry}`" :aria-pressed="meal === entry" :class="{ active: meal === entry }" @click="$feedback(); $emit('update:meal', entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ entry }}</button></view>
  </view>
</template>
