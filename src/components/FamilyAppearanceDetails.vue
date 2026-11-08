<script setup>
import { computed } from 'vue';
import { familyAppearance } from '../domain/family.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import FamilyCoverImage from './FamilyCoverImage.vue';
import AppIcon from './AppIcon.vue';
const props = defineProps({ family: { type: Object, required: true } });
defineEmits(['edit']);
const appearance = computed(() => familyAppearance(props.family));
const personal = computed(() => props.family.kind === 'personal');
</script>

<template>
  <view class="family-appearance-details">
    <button role="button" class="family-full-cover" :aria-label="personal ? '编辑个人封面' : '编辑家庭封面'" @click.stop="$emit('edit', 'cover')" hover-class="touch-feedback">
      <view class="family-full-cover-frame" :style="coverFrameStyle('family')"><FamilyCoverImage :src="appearance.cover" variant="detail" :personal="personal" /></view>
      <view class="family-cover-edit-hint"><AppIcon name="camera-inverse" :size="16" /><text>更换封面</text></view>
    </button>
    <slot />
    <view v-if="!personal" class="family-detail-rows">
      <button role="button" class="family-detail-row" aria-label="编辑家庭名称" @click.stop="$emit('edit', 'name')" hover-class="touch-feedback"><text class="family-detail-label">家庭名称</text><text class="family-detail-value">{{ appearance.name }}</text><AppIcon name="chevron" :size="16" /></button>
    </view>
  </view>
</template>

<style scoped>
.family-appearance-details { margin-bottom: 12px; background: var(--white); }
.family-full-cover { display: block; position: relative; width: 100%; margin: 0; padding: 0; border-radius: 0; background: var(--green-light); }
.family-full-cover-frame { position: relative; width: 100%; overflow: hidden; }
.family-cover-edit-hint { position: absolute; right: 16px; bottom: 16px; display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 12px; border-radius: 999px; background: var(--photo-action-surface); color: var(--white); font-size: var(--type-caption); pointer-events: none; }
.family-detail-rows { padding: 0; }
.family-detail-row { display: flex; align-items: center; gap: 14px; width: 100%; box-sizing: border-box; min-height: 58px; margin: 0; padding: 13px 20px; border-top: 1px solid var(--paper); border-radius: 0; background: var(--white); text-align: left; }
.family-detail-row + .family-detail-row { border-top: 1px solid var(--paper); }
.family-detail-label { flex-shrink: 0; font-size: var(--type-body); line-height: 24px; color: var(--ink); }
.family-detail-value { flex: 1; min-width: 0; font-size: var(--type-meta); line-height: 24px; color: var(--muted); text-align: right; overflow-wrap: anywhere; }
.family-detail-row :deep(.app-icon) { flex-shrink: 0; }
</style>
