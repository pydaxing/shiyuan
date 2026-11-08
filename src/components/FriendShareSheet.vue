<script setup>
import Sheet from './Sheet.vue';
import NativeShareButton from './NativeShareButton.vue';
import AppIcon from './AppIcon.vue';
import { cloudMode, notify } from '../store.js';
const props = defineProps({ card: Object, preparing: Boolean });
const emit = defineEmits(['close', 'publish', 'retry']);
function retry() {
  if (!cloudMode) return notify('请在微信小程序中分享给好友');
  if (props.preparing) return notify('正在准备分享链接，请稍候');
  emit('retry');
}
</script>

<template>
  <Sheet title="分享" variant="action-picker" @close="$emit('close')">
    <view class="sheet-action-options friend-share-options">
      <view class="sheet-action-cell">
        <NativeShareButton v-if="card" :card="card" label="分享给微信好友" button-class="sheet-action-option"><view class="sheet-action-icon"><AppIcon name="detail-share" :size="24" active /></view><text class="sheet-action-label">微信好友</text><text class="friend-share-status">仅分享菜品与做法，不含家庭信息</text><AppIcon class="friend-share-chevron" name="chevron" :size="16" /></NativeShareButton>
        <button v-else role="button" class="sheet-action-option" :aria-busy="preparing" aria-label="分享给微信好友" @click.stop="$feedback(); retry()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="detail-share" :size="24" active /></view><text class="sheet-action-label">微信好友</text><text class="friend-share-status">仅分享菜品与做法，不含家庭信息</text><AppIcon class="friend-share-chevron" name="chevron" :size="16" /></button>
      </view>
      <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="发布到美食，所有人可见" @click.stop="$feedback(); $emit('publish')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="community" :size="24" active /></view><text class="sheet-action-label">发布美食</text><text class="friend-share-status">发布到美食后，所有人可见</text><AppIcon class="friend-share-chevron" name="chevron" :size="16" /></button></view>
    </view>
  </Sheet>
</template>

