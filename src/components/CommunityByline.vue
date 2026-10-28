<script setup>
import { computed } from 'vue';
import { communityPublisherName } from '../domain/community-policy.js';

const props = defineProps({ post: { type: Object, required: true }, expanded: Boolean });
const publisher = computed(() => communityPublisherName(props.post).trim());
</script>

<template>
  <view v-if="publisher" class="community-byline" :class="{ 'is-expanded': expanded }">
    <text class="community-byline-author" :aria-label="`发布者：${publisher}`">{{ publisher }}</text>
  </view>
</template>
