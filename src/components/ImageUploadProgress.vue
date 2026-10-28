<script setup>
defineProps({ value: { type: String, default: '0%' }, compact: Boolean });
</script>

<template>
  <view class="image-upload-progress" :class="{ 'is-compact': compact }" role="progressbar" aria-label="图片上传进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Number.parseInt(value, 10)" aria-live="polite">
    <text class="image-upload-percent">{{ value }}</text>
  </view>
</template>

<style scoped>
.image-upload-progress { position: absolute; inset: 0; z-index: 2; display: flex; align-items: flex-end; justify-content: flex-end; padding: 10px; pointer-events: none; }
.image-upload-percent { min-width: 44px; padding: 3px 8px; border-radius: 999px; background: var(--photo-action-surface); color: var(--white); font-family: var(--font-body); font-size: var(--type-meta); font-weight: 500; line-height: 22px; font-variant-numeric: tabular-nums; text-align: center; white-space: nowrap; }
.image-upload-progress.is-compact { align-items: center; justify-content: center; padding: 4px; }
.is-compact .image-upload-percent { min-width: 36px; padding: 2px 6px; font-size: var(--type-caption); line-height: 20px; }
</style>
