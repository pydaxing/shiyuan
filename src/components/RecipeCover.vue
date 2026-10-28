<script setup>
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import LazyImage from './LazyImage.vue';
import CommunityFamilyCount from './CommunityFamilyCount.vue';
import { previewImages } from '../services/images.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import { foodCover } from '../domain/presentation.js';

const props = defineProps({ image: String, kind: { type: String, default: 'dish' }, title: String, category: String, minutes: Number, dishCount: Number, familyCount: { type: Number, default: null }, immersive: Boolean });
const coverImage = computed(() => foodCover(props.image, props.kind));
</script>

<template>
  <button role="button" class="detail-cover recipe-cover" :class="{ 'is-immersive': immersive }" :style="coverFrameStyle('recipe')" :aria-label="`查看${title}原图`" @click="previewImages([coverImage], coverImage)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
    <view class="recipe-cover-image"><LazyImage :src="coverImage" variant="detail" mode="aspectFill" /></view>
    <view v-if="immersive" class="recipe-cover-fade" aria-hidden="true" />
    <view class="recipe-cover-meta">
      <view v-if="category || minutes != null || dishCount != null" class="recipe-cover-tags">
        <text v-if="category" class="recipe-cover-tag">{{ category }}</text>
        <view v-if="minutes != null" class="recipe-cover-tag"><AppIcon name="clock-inverse" :size="12" /><text>{{ minutes }} 分钟</text></view>
        <text v-if="dishCount != null" class="recipe-cover-tag">{{ dishCount }} 道菜</text>
      </view>
      <CommunityFamilyCount :count="familyCount" />
    </view>
  </button>
</template>

<style scoped>
.recipe-cover { --cover-meta-inset: 12px; position: relative; }
.recipe-cover-image { position: absolute; inset: 0; }
</style>
