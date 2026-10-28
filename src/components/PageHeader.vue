<script setup>
import { onScopeDispose, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { pageHeaderHeight, pageHeaderStyle } from '../domain/mobile.js';
defineProps({ title: String, editable: Boolean });
defineEmits(['edit']);

function readLayout() {
  const info = uni.getSystemInfoSync();
  const capsule = info.uniPlatform === 'mp-weixin' ? uni.getMenuButtonBoundingClientRect?.() || {} : null;
  return { safeStyle: pageHeaderStyle(info, capsule), height: pageHeaderHeight(info, capsule) };
}

const layout = ref(readLayout());
const refreshLayout = () => { layout.value = readLayout(); };
uni.onWindowResize?.(refreshLayout);
onScopeDispose(() => uni.offWindowResize?.(refreshLayout));
</script>

<template>
  <view class="page-header-space" :style="{ '--page-header-height': `${layout.height}px` }">
    <view class="page-header-fixed">
      <view class="page-header-frame">
        <view class="page-header" :style="layout.safeStyle" :class="{ 'has-action': $slots.default }"><button v-if="editable" role="button" class="page-heading-edit" aria-label="编辑家庭名称与封面" @click.stop="$emit('edit')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="page-heading">{{ title }}</text><AppIcon name="edit" /></button><text v-else class="page-heading">{{ title }}</text><view class="page-header-action"><slot /></view></view>
      </view>
      <slot name="extension" />
    </view>
  </view>
</template>
