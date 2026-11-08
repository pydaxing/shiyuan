<script setup>
import AppIcon from './AppIcon.vue';
import { foodMinutesLabel } from '../domain/presentation.js';
defineProps({ category: String, minutes: Number, origin: String, count: Number });
</script>

<template>
  <view class="recipe-list-meta"><text class="home-menu-item-category">{{ category || '其他' }}</text><text v-if="origin" class="source-badge" :class="origin === '美食' ? 'source-badge-community' : 'source-badge-custom'">{{ origin }}</text><view v-if="count != null" class="recipe-list-duration"><AppIcon name="menu" :size="12" /><text>{{ count }} 道菜</text></view><view v-else-if="foodMinutesLabel(minutes)" class="recipe-list-duration"><AppIcon name="clock" :size="12" /><text>{{ foodMinutesLabel(minutes) }}</text></view></view>
</template>

<style scoped>
.recipe-list-meta { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px; margin-top: 6px; color: var(--muted); font-family: var(--font-body); font-size: var(--type-caption); line-height: 18px; }
.recipe-list-meta .home-menu-item-category, .recipe-list-meta .source-badge { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 2px; border-width: 1px; border-style: solid; border-radius: var(--radius-subtle); font-size: var(--type-caption); line-height: 16px; white-space: nowrap; }
.recipe-list-meta .home-menu-item-category { border-color: #dfdbe7; background: #f6f4f8; color: #7b6c8a; }
.recipe-list-duration { flex-shrink: 0; white-space: nowrap; display: flex; align-items: center; gap: 3px; }
</style>
