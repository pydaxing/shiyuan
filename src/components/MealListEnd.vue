<script setup>
defineProps({ loading: Boolean });
</script>
<template>
  <view class="meal-list-end" :role="loading ? 'status' : undefined"><text><slot /></text></view>
</template>
<style scoped>
.meal-list-end { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 100%; min-height: 60px; margin: 0; padding: 20px 12px; border: 0; color: var(--feed-time); font-size: var(--type-caption); font-weight: 400; line-height: 20px; text-align: center; }
</style>
