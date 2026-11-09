<script setup>
import { computed, inject, provide, ref, watch } from 'vue';
import { mealTimeline, MEAL_ICONS } from '../domain/meal-social.js';
import { useMealPosts } from '../composables/useMealPosts.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { currentIdentity } from '../services/cloud.js';
import { notify } from '../store.js';
import MealPostCard from './MealPostCard.vue';
import MealListEnd from './MealListEnd.vue';
import { foodCover } from '../domain/presentation.js';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
const props = defineProps({ orders: Array, today: String, active: Boolean });
provide('imageViewActive', computed(() => props.active));
const emit = defineEmits(['open', 'record', 'changed']);
const limit = ref(8);
const { diaryManagementVersion = ref(0), diaryArchiveComplete = ref(false), suppressedOrderIds = ref([]), posts, cursor, loading, loaded, error, busy, load, mutate } = inject('mealDiaryFeed', null) || useMealPosts('mine', computed(() => props.active));
watch(() => props.today, (value, previous) => { if (value !== previous && props.active) void load(false, true); });
const historical = computed(() => (props.orders || []).filter(order => order.items?.length && order.status !== 'cancelled' && (order.date < props.today || order.status === 'completed')));
const entries = computed(() => mealTimeline(loaded.value && diaryManagementVersion.value !== 1 && !diaryArchiveComplete.value ? historical.value.filter(order => !suppressedOrderIds.value.includes(order.id)) : [], posts.value));
const hasMore = computed(() => entries.value.length > limit.value || Boolean(cursor.value));
const days = computed(() => {
  const grouped = [];
  for (const entry of entries.value.slice(0, limit.value)) {
    let day = grouped.at(-1);
    if (!day || day.date !== entry.date) { day = { date: entry.date, entries: [] }; grouped.push(day); }
    day.entries.push(entry);
  }
  return grouped;
});
async function change(action, post, values) { const result = await mutate(action, post, values); if (result) emit('changed', result); return result; }
async function visibility(post, value) {
  if (busy.value[post.id]) return;
  if (value === 'public') {
    const yes = await new Promise(resolve => uni.showModal({ title: '设为公开？', content: '餐食照片或菜品搭配将对所有用户可见，并开放点赞和标签互动。', confirmText: '设为公开', confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, success: result => resolve(result.confirm), fail: () => resolve(false) }));
    if (!yes) return;
  }
  const result = await change('setMealVisibility', post, { visibility: value });
  if (result?.post?.id === post.id && result.post.visibility === value) notify(value === 'family' ? '已设为仅饮食日记' : value === 'private' ? '已设为仅饮食日记' : '已设为公开');
  else if (error.value) notify(`未保存成功：${error.value}`);
}
async function remove(post) {
  const yes = await new Promise(resolve => uni.showModal({ title: '删除这条餐食记录？', content: post.deleteScope === 'personal' ? '仅从你的个人饮食日记中移除，家庭和其他成员的日记会保留。' : post.mealSharingVersion === 2 && post.mealContext === 'family' ? '这条记录会从家庭日记和家人的个人日记中一起移除，原餐单状态保留。' : '这条动态会移除，原餐单状态保留。', confirmText: '删除', cancelText: '保留', confirmColor: NATIVE_UI_COLORS.danger, cancelColor: NATIVE_UI_COLORS.muted, success: result => resolve(result.confirm), fail: () => resolve(false) }));
  if (yes) {
    const result = await change('deleteMealPost', post);
    if (!result && error.value) notify(`删除未成功：${error.value}`);
  }
}
async function more() {
  if (!props.active || loading.value || !hasMore.value) return;
  if (limit.value >= entries.value.length && cursor.value) await load(true);
  limit.value += 8;
}
defineExpose({ refresh: () => load(false, true), loadMore: more, showRecords: () => load(false, true) });
</script>
<template>
  <view class="meal-history">
    <view class="meal-history-compose"><text class="meal-history-today">今天</text><button class="meal-history-camera" aria-label="拍照记下这一餐" @click="$emit('record')" hover-class="touch-feedback"><AppIcon name="camera" :size="27" active /></button></view>
    <view v-if="error" class="form-error meal-history-error" role="alert"><text>{{ error }}</text><button class="text-button" :disabled="loading" @click="load()" hover-class="touch-feedback">重试</button></view>
    <view v-for="(day, dayIndex) in days" :key="day.date" class="meal-history-day" :class="{ 'is-last': dayIndex === days.length - 1 }">
      <view class="meal-history-date" :aria-label="day.date"><text v-if="day.date.slice(0, 4) !== today.slice(0, 4)" class="meal-history-year">{{ day.date.slice(0, 4) }}</text><view class="meal-history-date-line"><text class="meal-history-day-number">{{ day.date.slice(8) }}</text><text class="meal-history-month">{{ Number(day.date.slice(5, 7)) }}月</text></view></view>
      <view class="meal-history-day-content">
        <view v-for="entry in day.entries" :key="entry.id" class="meal-history-entry">
          <MealPostCard v-if="entry.post" timeline :personal-diary="currentIdentity?.family?.kind === 'personal'" :post="entry.post" :busy="Boolean(busy[entry.post.id])" @like="change('setMealLike', entry.post, { selected: $event })" @visibility="visibility(entry.post, $event)" @remove="remove(entry.post)" />
          <view v-else class="meal-history-order">
            <view class="meal-history-meal"><AppIcon :name="MEAL_ICONS[entry.meal] || 'menu'" :size="14" /><text>{{ entry.meal }}</text></view>
            <view class="meal-history-dishes"><button v-for="item in entry.order.items" :key="item.recipe.id" class="meal-history-dish" :aria-label="`查看${item.recipe.title}`" @click="$emit('open', item.recipe)" hover-class="touch-feedback"><LazyImage :src="foodCover(item.recipe.image)" variant="card" mode="aspectFill" thumbnail /></button></view>
          </view>
        </view>
      </view>
    </view>
    <view v-if="!entries.length && !loading && !error" class="meal-history-empty"><text>把好好吃饭的日子，慢慢记下来</text></view>
    <MealListEnd v-if="loading" loading>加载中…</MealListEnd>
    <MealListEnd v-else-if="entries.length && !hasMore && !error">已显示全部记录</MealListEnd>
  </view>
</template>
<style scoped>
.meal-history { min-width: 0; }
.meal-history-compose { display: flex; align-items: center; gap: 10px; margin: 4px 0 26px; }
.meal-history-today { flex: 0 0 48px; font-size: var(--type-heading); font-weight: 600; }
.meal-history-camera { display: flex; align-items: center; justify-content: center; width: 68px; height: 68px; padding: 0; margin: 0; border-radius: var(--radius-small); background: var(--paper); }
.meal-history-day { display: flex; gap: 10px; padding-bottom: 26px; }
.meal-history-day.is-last { padding-bottom: 18px; }
.meal-history-date { flex: 0 0 48px; padding-top: 5px; color: var(--ink); }
.meal-history-date-line { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.meal-history-day-number { font-size: var(--type-display); font-weight: 600; line-height: 1.1; }
.meal-history-month, .meal-history-year { color: var(--muted); font-size: var(--type-caption); line-height: 1.4; white-space: nowrap; }
.meal-history-year { display: block; margin-bottom: 5px; }
.meal-history-day-content { flex: 1; min-width: 0; }
.meal-history-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 4px 8px; }
.meal-history-error .text-button { flex-shrink: 0; min-height: 44px; margin: 0; }
.meal-history-entry + .meal-history-entry { margin-top: 20px; }
.meal-history-meal { display: flex; align-items: center; gap: 8px; min-height: 28px; margin-bottom: 6px; color: var(--ink); font-size: var(--type-meta); }
.meal-history-dishes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.meal-history-dish { display: block; min-width: 0; padding: 0; margin: 0; width: 100%; height: 70px; overflow: hidden; border-radius: var(--food-photo-radius); background: transparent; }
.meal-history-empty { text-align: center; color: var(--muted); font-size: var(--type-meta); padding: 12px; }
</style>
