<script setup>
import AppIcon from './AppIcon.vue';
defineProps({ category: String, minutes: Number });
</script>

<template>
  <view class="recipe-list-meta"><text class="home-menu-item-category">{{ category || '其他' }}</text><view v-if="minutes != null" class="recipe-list-duration"><AppIcon name="clock" :size="12" /><text>{{ minutes }} 分钟</text></view></view>
</template>

<style scoped>
.recipe-list-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; color: var(--muted); font-family: var(--font-body); font-size: var(--type-caption); line-height: 18px; }
.recipe-list-duration { display: flex; align-items: center; gap: 3px; }
</style>
