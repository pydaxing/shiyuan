<script setup>
import LazyImage from './LazyImage.vue';
import { DEFAULT_FAMILY_COVER, DEFAULT_PERSONAL_COVER } from '../domain/family.js';

defineProps({ src: String, personal: Boolean, variant: { type: String, default: 'cover' } });
</script>

<template>
  <view class="family-cover-image">
    <LazyImage v-if="src" :src="src" :variant="variant" mode="aspectFill" />
    <view v-else class="family-cover-default" aria-hidden="true">
      <image class="family-cover-photo" :src="personal ? DEFAULT_PERSONAL_COVER : DEFAULT_FAMILY_COVER" mode="aspectFill" />
    </view>
  </view>
</template>

<style scoped>
.family-cover-image, .family-cover-default { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; border-radius: inherit; background: var(--green-light); }
.family-cover-photo { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>
