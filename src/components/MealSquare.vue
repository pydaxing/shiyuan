<script setup>
import { computed, inject, onUnmounted, provide, ref, watch } from 'vue';
import MealPostCard from './MealPostCard.vue';
import MealListEnd from './MealListEnd.vue';
import AppIcon from './AppIcon.vue';
import PageHeader from './PageHeader.vue';
import { useNavigationAppearance } from '../composables/useNavigationAppearance.js';
import { useMealPosts } from '../composables/useMealPosts.js';
import { useCommunityFeedViewport } from '../composables/useCommunityFeedViewport.js';
import { sheetOpen } from '../composables/sheetStack.js';
import { cloudMode, cloudStatus, notify } from '../store.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
const props = defineProps({ active: Boolean });
const emit = defineEmits(['record', 'changed']);
const publicationNow = ref(Date.now());
const openLikeMenu = ref('');
provide('mealLikeMenu', openLikeMenu);
watch(() => props.active, () => { openLikeMenu.value = ''; });
function onFeedScroll(event) { openLikeMenu.value = ''; feedViewport.onScroll(event); }
let publicationTimer;
watch(() => props.active, active => {
  clearInterval(publicationTimer);
  publicationNow.value = Date.now();
  if (active) publicationTimer = setInterval(() => { publicationNow.value = Date.now(); }, 30000);
}, { immediate: true });
onUnmounted(() => clearInterval(publicationTimer));
useNavigationAppearance(computed(() => props.active ? 'light' : null));
provide('imageViewActive', computed(() => props.active));
const { posts, cursor, loading, loaded, error, busy, load, retry, mutate } = inject('mealPublicFeed', null) || useMealPosts('public', computed(() => props.active));
const feedLocked = computed(() => !props.active || sheetOpen.value);
async function refreshFeed() {
  await load(false, true);
  if (error.value) throw new Error(error.value);
}
const feedViewport = useCommunityFeedViewport({
  navigation: { onScroll() {}, reveal() {}, reset() {} },
  locked: feedLocked,
  enabled: computed(() => props.active && cloudMode && cloudStatus.value.phase === 'ready'),
  loading,
  refresh: refreshFeed,
  // The meal feed versions requests, so a fresh read can supersede an old page.
  waitForLoading: false,
  onError: failure => notify(failure.message || '刷新暂时没成功，请再试试'),
});
const { scrollTop: feedScrollTop, refreshing, pullReady, refreshThreshold, refresherEnabled } = feedViewport;
// Native WeChat scroll-view does not remount for a plain Vue :key.
// Unmount it while inactive so its private refresher offset cannot survive.
// The locked viewport retains scrollTop and the injected feed retains its cards.
watch(() => props.active, active => {
  if (!active) void feedViewport.reset();
}, { flush: 'sync' });
let pendingScopeReset = false, scopeResetSequence = 0;
async function resetScopeViewport() {
  const token = ++scopeResetSequence;
  await feedViewport.reset();
  if (token === scopeResetSequence && !feedLocked.value) pendingScopeReset = false;
}
watch(() => `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`, () => {
  pendingScopeReset = true;
  void resetScopeViewport();
}, { flush: 'sync' });
watch(feedLocked, locked => { if (!locked && pendingScopeReset) void resetScopeViewport(); }, { flush: 'sync' });
function loadMore() { if (!feedLocked.value && cursor.value && !error.value) return load(true); }
async function change(action, post, changes) {
  const result = await mutate(action, post, changes);
  if (result) emit('changed', result);
  else if (error.value) notify(error.value);
}
defineExpose({ refresh: () => load(false, true), loadMore });
</script>
<template>
  <view class="meal-square">
    <PageHeader title="发现" action-side="left"><button class="square-record" aria-label="记下这一餐" @click="$emit('record')" hover-class="touch-feedback"><view class="square-record-icon"><AppIcon name="plus" :size="14" /></view></button></PageHeader>
    <scroll-view v-if="active" class="square-feed-scroll" :scroll-y="!feedLocked" enhanced :show-scrollbar="false" :enable-back-to-top="true" :scroll-top="feedScrollTop" :scroll-with-animation="false" :lower-threshold="360" :refresher-enabled="refresherEnabled" :refresher-triggered="refreshing" :refresher-threshold="refreshThreshold" refresher-default-style="none" :refresher-background="NATIVE_UI_COLORS.paper" aria-label="大家的餐食，下拉可刷新" @scroll="onFeedScroll" @scrolltolower="loadMore" @refresherpulling="feedViewport.onPull" @refresherrefresh="feedViewport.onRefresh" @refresherrestore="feedViewport.stopPull" @refresherabort="feedViewport.stopPull">
    <view slot="refresher" class="community-refresher square-refresher" :style="{ height: `${refreshThreshold}px` }" role="status"><view class="community-refresh-spinner" :class="{ 'is-refreshing': refreshing }" aria-hidden="true" /><text>{{ refreshing ? '正在刷新' : pullReady ? '松开刷新' : '下拉刷新' }}</text></view>
    <view class="square-feed">
    <view v-if="error" class="meal-state-error" role="alert"><text class="meal-error-copy">{{ error }}</text><button class="text-button" :disabled="loading" @click="retry" hover-class="touch-feedback">重试</button></view>
    <view v-if="loaded && !posts.length && !cursor && !error" class="meal-square-empty">
      <view class="meal-empty-art" aria-hidden="true"><view class="meal-empty-plate"><AppIcon name="meal-set" :size="42" /></view><view class="meal-empty-heart">♡</view></view>
      <text class="meal-empty-title">餐桌还空着，等你来添一道</text>
      <text class="meal-empty-description">一顿家常饭，也值得被记住</text>
      <button class="primary-button meal-empty-record" @click="$emit('record')" hover-class="touch-feedback"><AppIcon name="camera-inverse" :size="18" /><text>记下这一餐</text></button>
    </view>
    <MealPostCard v-for="(post, index) in posts" :key="post.id" :post="post" :now="publicationNow" feed :last="index === posts.length - 1" :manageable="false" :busy="Boolean(busy[post.id])" @like="change('setMealLike', post, { selected: $event })" @react="change('setMealReaction', post, $event)" />
    <MealListEnd v-if="loading && !refreshing" loading>加载中…</MealListEnd>
    <MealListEnd v-else-if="posts.length && !loading && !cursor">已经看完啦</MealListEnd>
    </view>
    </scroll-view>
  </view>
</template>
<style scoped>
.meal-square { --square-bottom-inset: 0px; display: flex; flex-direction: column; margin: 0 calc(-1 * var(--page-gutter)); height: calc(100vh - var(--square-bottom-inset)); background: var(--white); }
.square-feed-scroll { flex: 1; width: 100%; height: 0; min-height: 0; overscroll-behavior-y: contain; }
.square-refresher { transform: none; }
@media (max-width: 760px) { .meal-square { --square-bottom-inset: calc(var(--nav-height) + env(safe-area-inset-bottom)); } }
.square-record { display: flex; align-items: center; justify-content: flex-start; width: 44px; height: 44px; padding: 0; margin: 0 0 0 calc(16px - var(--page-gutter)); background: transparent; color: var(--muted); }
.square-feed { box-sizing: border-box; min-height: 100%; padding: 0 0 20px; }
.meal-state-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--danger); font-size: var(--type-meta); padding: 12px; background: var(--danger-light); border-radius: var(--radius-card); }
.meal-error-copy { flex: 1; }
.meal-square-empty { display: flex; flex-direction: column; align-items: center; padding: 40px 18px; border-radius: var(--radius-card); background: var(--white); }
.meal-empty-art { position: relative; display: flex; align-items: center; justify-content: center; width: 120px; height: 110px; margin-bottom: 16px; }
.meal-empty-plate { display: flex; align-items: center; justify-content: center; width: 92px; height: 92px; border-radius: 50%; background: var(--paper); border: 8px solid var(--green-light); }
.meal-empty-heart { position: absolute; right: 0; bottom: 4px; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 4px solid var(--white); border-radius: 50%; color: var(--mood-rose-ink); background: var(--mood-rose-surface); font-size: var(--type-display); }
.meal-empty-title { color: var(--ink); font-size: var(--type-body); font-weight: 600; text-align: center; }
.meal-empty-description { color: var(--muted); font-size: var(--type-meta); margin-top: 8px; text-align: center; }
.meal-empty-record { gap: 8px; margin: 24px 0 0; min-width: 168px; }
</style>

<style scoped>
.square-record-icon { display: flex; align-items: center; justify-content: center; width: 21px; height: 21px; box-sizing: border-box; border: 1px solid currentColor; border-radius: 50%; }
</style>
