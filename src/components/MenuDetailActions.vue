<script setup>
import AppIcon from './AppIcon.vue';
defineProps({ selected: Boolean, busy: Boolean });
defineEmits(['add']);
</script>

<template>
  <view class="menu-detail-actions">
    <button role="button" class="recipe-detail-button menu-detail-order" :class="{ 'is-complete': selected }" :aria-label="selected ? '已选中' : '选择'" :aria-pressed="selected" :disabled="selected || busy" @click="$feedback(); $emit('add')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="detail-choice-surface"><AppIcon :name="selected ? 'check' : 'plus-inverse'" :size="14" /><text>{{ selected ? '已选中' : '选择' }}</text></view></button>
  </view>
</template>

<style scoped>
.menu-detail-actions { display: flex; align-items: center; }
</style>
