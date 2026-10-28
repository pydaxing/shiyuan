<script setup>
import FamilyCoverImage from './FamilyCoverImage.vue';
import AppIcon from './AppIcon.vue';
import { coverFrameStyle } from '../domain/image-crop.js';
import { DEFAULT_SET_COVER } from '../domain/presentation.js';

defineProps({ title: String, description: String, calendar: Boolean, illustration: { type: String, default: DEFAULT_SET_COVER }, cover: String, compact: Boolean, kitchen: Boolean, primaryLabel: String, secondaryLabel: String, primaryIcon: String, secondaryIcon: String, busy: Boolean });
defineEmits(['primary', 'secondary']);
</script>

<template>
  <view class="home-welcome" :class="{ 'is-compact': compact || kitchen, 'is-kitchen': kitchen }">
    <view v-if="!compact && !kitchen" class="home-welcome-art" aria-hidden="true">
      <view class="home-welcome-frame" :style="coverFrameStyle('family')"><image class="home-welcome-illustration" :src="illustration" mode="aspectFill" /></view>
    </view>
    <view class="home-welcome-row">
      <view class="home-welcome-copy">
        <text class="home-welcome-title" role="heading" aria-level="2">{{ title }}</text>
        <view v-if="description && calendar" class="home-welcome-description home-welcome-date" role="text" :aria-label="description"><text v-for="(part, index) in description.split(' · ')" :key="index" class="home-welcome-date-part">{{ index ? '· ' : '' }}{{ part }}</text></view>
        <text v-else-if="description" class="home-welcome-description">{{ description }}</text>
        <view v-if="primaryLabel || secondaryLabel" class="home-welcome-actions">
          <button v-if="primaryLabel" role="button" class="primary-button home-welcome-button" :disabled="busy" @click.stop="$emit('primary')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon v-if="primaryIcon" :name="primaryIcon" :size="kitchen ? 16 : 18" :active="kitchen" /><text>{{ primaryLabel }}</text></button>
          <button v-if="secondaryLabel" role="button" class="secondary-button home-welcome-button" @click.stop="$emit('secondary')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon v-if="secondaryIcon" :name="secondaryIcon" :size="18" active /><text>{{ secondaryLabel }}</text></button>
        </view>
      </view>
      <view v-if="compact" class="home-welcome-cover" aria-hidden="true"><view class="home-welcome-frame" :style="coverFrameStyle('family')"><FamilyCoverImage :src="cover" variant="card" /></view></view>
    </view>
  </view>
</template>

<style scoped>
.home-welcome { display: flex; flex-direction: column; align-items: center; min-width: 0; padding: 44px 8px 32px; text-align: center; }
.home-welcome-art { width: 260px; max-width: 100%; margin-bottom: 24px; }
.home-welcome-frame { position: relative; width: 100%; overflow: hidden; border-radius: var(--radius-card); background: var(--paper); }
.home-welcome-illustration { position: absolute; inset: 0; width: 100%; height: 100%; }
.home-welcome-row { width: 100%; min-width: 0; }
.home-welcome-copy { min-width: 0; }
.home-welcome-title { display: block; color: var(--ink); font-family: var(--font-display); font-size: var(--type-title); font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.home-welcome-description { display: block; margin-top: 10px; color: var(--muted); font-size: var(--type-control); line-height: 22px; overflow-wrap: anywhere; }
.home-welcome-date { display: flex; flex-wrap: wrap; column-gap: 4px; }
.home-welcome-date-part { flex: 0 0 auto; white-space: nowrap; }
.home-welcome-actions { display: flex; flex-direction: column; gap: 12px; width: 264px; max-width: 100%; margin: 32px auto 0; }
.home-welcome .home-welcome-button { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; min-height: 46px; padding: 10px 16px; font-family: var(--font-body); font-size: var(--type-control); line-height: 24px; border-radius: var(--radius-control); }
.home-welcome.is-compact { align-items: flex-start; min-height: 88px; padding: var(--panel-padding); background: var(--paper); border-radius: var(--radius-card); text-align: left; }
.is-compact .home-welcome-row { display: flex; align-items: center; gap: 14px; }
.is-compact .home-welcome-copy { flex: 1; }
.is-compact .home-welcome-title { font-size: var(--type-heading); line-height: 1.5; }
.is-compact .home-welcome-description { margin-top: 6px; font-size: var(--type-meta); line-height: 20px; }
.home-welcome-cover { flex: 0 0 94px; width: 94px; }
.home-welcome-cover .home-welcome-frame { border-radius: var(--radius-small); }
.is-compact .home-welcome-actions { width: 161px; margin: 18px 0 0; }
.is-compact .home-welcome-button { min-height: 44px; padding-top: 10px; padding-bottom: 10px; font-size: var(--type-control); }
.home-welcome.is-kitchen { flex-direction: row; align-items: center; gap: 14px; }
.is-kitchen .home-welcome-row { flex: 1; }
.is-kitchen .home-welcome-actions { align-items: flex-start; width: auto; margin-top: 4px; }
.is-kitchen .home-welcome-button { width: auto; padding-right: 4px; padding-left: 0; background: transparent; border: 0; box-shadow: none; color: var(--green); font-weight: 400; white-space: nowrap; }
@media (max-width: 374px) {
  .home-welcome { padding-top: 32px; }
  .is-compact .home-welcome-row { gap: 10px; }
  .home-welcome-cover { flex-basis: 80px; width: 80px; }
}
</style>
