<script setup>
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
</script>
<template><view class="plans-view"><PageHeader title="计划" /><view class="plans-empty"><view class="plans-icon"><AppIcon name="calendar" active :size="36" /></view><text class="plans-title">好好吃饭，慢慢来</text><text class="muted">新的饮食计划正在准备中</text></view></view></template>
<style scoped>
.plans-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 55vh; gap: 14px; text-align: center; }
.plans-icon { width: 76px; height: 76px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 50%; background: var(--white); }
.plans-title { font-family: var(--font-display); font-size: var(--type-section); color: var(--ink); margin-top: 8px; }
</style>
