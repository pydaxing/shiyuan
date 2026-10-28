<script setup>
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';

const props = defineProps({ count: { type: Number, default: null }, inline: Boolean, labelled: Boolean });
const familyCount = computed(() => Number.isInteger(props.count) && props.count >= 0 ? props.count : null);
</script>

<template>
  <view v-if="familyCount !== null" class="community-cover-count" :class="{ 'is-inline': inline }" :aria-label="`${familyCount} 个家庭在做`">
    <AppIcon :name="inline ? 'menu' : 'menu-photo'" :size="14" class="community-cover-count-icon" /><text class="community-cover-count-value">{{ familyCount }}{{ labelled ? ' 家庭' : '' }}</text>
  </view>
</template>
