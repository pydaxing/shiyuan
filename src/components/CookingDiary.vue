<script setup>
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { computed, ref, watch, onMounted, getCurrentInstance } from 'vue';
import { localDate } from '../domain/kitchen.js';
import { cookingDays } from '../domain/cooking-diary.js';
import { useDiaryScroll, DIARY_DAY_WIDTH } from '../composables/useDiaryScroll.js';
import RecipeSheet from './RecipeSheet.vue';

const props = defineProps({ orders: { type: Array, default: () => [] }, today: { type: String, default: localDate } });
const today = computed(() => props.today);
const instance = getCurrentInstance();
const { start, count, scrollLeft, month, onScroll, resize, earlier, later } = useDiaryScroll(today.value);
const selectedDate = ref(today.value);
const expanded = ref(false);
const recipe = ref(null);
const days = computed(() => cookingDays(props.orders, start.value, count.value));
const selected = computed(() => days.value.find((day) => day.date === selectedDate.value));
const monthLabel = computed(() => `${month.value.slice(0, 4)}年${Number(month.value.slice(5))}月`);
const dateLabel = computed(() => selectedDate.value === today.value ? '今日' : `${Number(selectedDate.value.slice(5, 7))}月${selected.value.day}日`);
const weekday = (date) => ['日', '一', '二', '三', '四', '五', '六'][new Date(`${date}T12:00:00`).getDay()];
watch(selectedDate, () => { expanded.value = false; });
onMounted(() => uni.createSelectorQuery().in(instance.proxy).select('.diary-date-scroll').boundingClientRect((rect) => resize(rect?.width)).exec());
</script>

<template>
  <view class="cooking-diary">
    <view class="diary-heading"><text class="subheading">开火日记</text><text class="diary-month-inline">{{ monthLabel }}</text></view>
    <scroll-view scroll-x :show-scrollbar="false" :scroll-left="scrollLeft" :scroll-with-animation="false" :upper-threshold="240" :lower-threshold="240" @scroll="onScroll" @scrolltoupper="earlier" @scrolltolower="later" class="diary-date-scroll"><view class="diary-date-strip" :style="{ width: `${days.length * DIARY_DAY_WIDTH}px` }"><view v-for="day in days" :key="day.date" class="diary-date-cell" :style="{ width: `${DIARY_DAY_WIDTH}px` }"><text class="diary-month-start">{{ day.day === 1 ? `${Number(day.date.slice(5, 7))}月` : '' }}</text><button :id="`diary-${day.date}`" role="button" class="diary-date" :class="{ selected: day.date === selectedDate, today: day.date === today }" :aria-label="`${day.date}，${day.meals.length ? '已开火' : '未开火'}`" :aria-pressed="day.date === selectedDate" @click="$feedback(); selectedDate = day.date" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="diary-date-number">{{ day.day }}</text><view v-if="day.meals.length" class="diary-date-dot" /></button><text class="diary-date-week">{{ day.date === today ? '今天' : `周${weekday(day.date)}` }}</text></view></view></scroll-view>
    <button role="button" class="diary-disclosure" :aria-expanded="expanded" @click="$feedback(); expanded = !expanded" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>{{ dateLabel }} <text :class="{ 'diary-lit': selected.meals.length }">{{ selected.meals.length ? '已开火' : '未开火' }}</text></text><view><text v-if="selected.meals.length">{{ selected.meals.length }} 餐</text><AppIcon :name="expanded ? 'minus' : 'plus'" class="disclosure-mark" /></view></button>
    <view v-if="expanded" class="diary-details"><view v-if="selected.meals.length" class="diary-meals"><view v-for="meal in selected.meals" :key="meal.name" class="diary-meal"><view class="diary-meal-label"><text>{{ meal.name }}</text><text class="diary-meal-separator" aria-hidden="true">·</text><text>{{ meal.recipes.length }} 道菜</text></view><view class="diary-recipes"><button v-for="dish in meal.recipes" :key="dish.id" role="button" class="diary-recipe" :aria-label="`查看日记中的${dish.title}做法`" @click="recipe = dish" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="dish.image" /><text class="food-list-title">{{ dish.title }}</text></button></view></view></view><text v-else class="diary-empty">这天还没有开火记录</text></view>
    <RecipeSheet v-if="recipe" :recipe="recipe" read-only @close="recipe = null" />
  </view>
</template>
