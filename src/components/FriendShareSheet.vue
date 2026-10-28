<script setup>
import Sheet from './Sheet.vue';
import NativeShareButton from './NativeShareButton.vue';
import AppIcon from './AppIcon.vue';
import { cloudMode, notify } from '../store.js';
defineProps({ card: Object, preparing: Boolean });
defineEmits(['close', 'publish', 'retry']);
</script>

<template>
  <Sheet title="分享" variant="action-picker" @close="$emit('close')">
    <view class="sheet-action-options friend-share-options">
      <view class="sheet-action-cell">
        <NativeShareButton v-if="card" :card="card" label="分享给微信好友" button-class="sheet-action-option"><view class="sheet-action-icon"><AppIcon name="detail-share" :size="26" active /></view><text class="sheet-action-label">微信好友</text><text class="friend-share-status" aria-hidden="true" /></NativeShareButton>
        <button v-else role="button" class="sheet-action-option" :disabled="preparing" :aria-busy="preparing" :aria-label="preparing ? '正在准备微信分享' : '分享给微信好友'" @click.stop="$feedback(); cloudMode ? $emit('retry') : notify('请在微信小程序中分享给好友')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="detail-share" :size="26" active /></view><text class="sheet-action-label">微信好友</text><text class="friend-share-status" role="status">{{ cloudMode ? (preparing ? '准备中…' : '点此重试') : '' }}</text></button>
      </view>
      <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="发布到美食，所有人可见" @click.stop="$feedback(); $emit('publish')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="community" :size="26" active /></view><text class="sheet-action-label">发布美食</text></button></view>
    </view>
    <view class="share-privacy-note"><text>仅分享菜品与做法，不含家庭信息</text><text>发布到美食后，所有人可见</text></view>
  </Sheet>
</template>

