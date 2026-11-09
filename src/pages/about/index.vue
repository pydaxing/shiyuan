<script setup>
import { APP_VERSION } from '../../domain/app-info.js';
import { sheetPageHeaderStyle } from '../../domain/mobile.js';
import AppIcon from '../../components/AppIcon.vue';
const info = uni.getSystemInfoSync();
const headerStyle = sheetPageHeaderStyle(info, info.uniPlatform === 'mp-weixin' ? uni.getMenuButtonBoundingClientRect?.() || {} : null);
const goBack = () => uni.navigateBack();
</script>

<template>
  <view class="about-screen">
    <view :style="{ height: headerStyle.height }"><view class="about-nav" :style="headerStyle">
      <text class="about-nav-title">关于食愿小灶</text>
      <button class="about-back" aria-label="返回上一页" hover-class="none" @click="goBack"><AppIcon name="arrow-left" :size="22" /></button>
    </view></view>
    <view class="about-brand">
      <image class="about-logo" :src="$image('/static/brand-shiyuan.png')" mode="aspectFit" aria-label="食愿小灶 Logo" />
      <text class="about-name">食愿小灶</text>
    </view>
    <text class="about-version">版本 {{ APP_VERSION }}</text>
  </view>
</template>

<style scoped>
.about-screen { display: flex; flex-direction: column; box-sizing: border-box; min-height: 100vh; background: var(--white); color: var(--ink); }
.about-nav { box-sizing: border-box; position: fixed; top: 0; left: 0; right: 0; z-index: 12; background: var(--white); display: flex; align-items: center; padding-left: 16px; }
.about-nav-title { position: absolute; left: var(--sheet-page-title-inset); right: var(--sheet-page-title-inset); text-align: center; font-size: var(--type-heading); font-weight: 600; white-space: nowrap; }
.about-back { margin: 0; display: flex; align-items: center; justify-content: center; width: 40px; height: 44px; padding: 0; background: transparent; border: 0; }
.about-back::after { border: 0; }
.about-brand { display: flex; flex-direction: column; align-items: center; padding: 58px 24px 64px; }
.about-logo { display: block; width: 84px; height: 84px; border-radius: var(--radius-sheet); overflow: hidden; }
.about-name { margin-top: 30px; font-size: var(--type-display); line-height: 32px; font-weight: 600; }
.about-version { display: block; margin-top: auto; padding: 24px 24px calc(28px + env(safe-area-inset-bottom)); text-align: center; color: var(--muted); font-size: var(--type-control); line-height: 22px; }
</style>
