<script setup>
import LazyImage from './LazyImage.vue';
import { coverFrameStyle } from '../domain/image-crop.js';
import { foodCover } from '../domain/presentation.js';
defineProps({ src: String, kind: { type: String, default: 'dish' } });
</script>

<template>
  <view class="food-thumbnail">
    <view class="food-thumbnail-frame" :style="coverFrameStyle('recipe')">
      <LazyImage class="food-thumbnail-image" :src="foodCover(src, kind)" variant="card" mode="aspectFill" thumbnail />
    </view>
  </view>
</template>

<style scoped>
.food-thumbnail { display: block; flex: 0 0 var(--food-thumbnail-width); width: var(--food-thumbnail-width); min-width: 0; border-radius: var(--food-photo-radius); overflow: hidden; background: var(--paper); }
.food-thumbnail-frame { position: relative; width: 100%; overflow: hidden; border-radius: inherit; }
.food-thumbnail-image { position: absolute; inset: 0; }
</style>
