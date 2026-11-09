<template>
  <view class="moments-preview">
    <image class="moments-cover" :src="$image('/static/entry-window.jpg')" mode="aspectFill" aria-hidden="true" />
    <view class="moments-shade" />
    <view class="moments-content">
      <image class="moments-logo" :src="$image('/static/entry-window-logo.png')" mode="aspectFit" aria-hidden="true" />
      <image class="moments-name" :src="$image('/static/entry-window-wordmark.png')" mode="aspectFit" aria-label="食愿小灶" />
      <text class="moments-title">把每一餐过成喜欢的日常</text>
      <text class="moments-description">收藏喜欢的菜，安排每天的饭。
一个人好好吃，也和家人一起分享。</text>
      <view class="moments-features"><text>日常菜单</text><text>餐食安排</text><text>饮食日记</text></view>
      <text class="moments-hint">打开小程序，进入你的小灶</text>
    </view>
  </view>
</template>
<style scoped>
.moments-preview { position: relative; min-height: 100vh; overflow: hidden; background: #f7f3e6; }
.moments-cover, .moments-shade { position: absolute; inset: 0; width: 100%; height: 100%; }
.moments-shade { background: linear-gradient(180deg, rgba(247,243,230,.12), rgba(247,243,230,.85) 55%, #f7f3e6 90%); }
.moments-content { position: relative; display: flex; flex-direction: column; align-items: center; padding: 20vh 24px 40px; text-align: center; color: #405b46; }
.moments-logo { width: 62px; height: 66px; }
.moments-name { width: 154px; height: 42px; margin-top: 18px; }
.moments-title { margin-top: 40px; font-size: var(--type-title); font-weight: 500; line-height: 1.6; }
.moments-description { margin-top: 16px; font-size: var(--type-body); line-height: 1.9; white-space: pre-line; }
.moments-features { display: flex; gap: 22px; margin-top: 32px; font-size: var(--type-meta); }
.moments-hint { margin-top: 48px; font-size: var(--type-caption); color: #657262; }
</style>
