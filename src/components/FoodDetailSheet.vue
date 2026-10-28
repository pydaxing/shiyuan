<script setup>
import { computed, ref } from 'vue';
import Sheet from './Sheet.vue';
import AppIcon from './AppIcon.vue';
import RecipeCover from './RecipeCover.vue';
import NativeShareButton from './NativeShareButton.vue';
import OrderActionMenu from './OrderActionMenu.vue';
import { foodDetailToolbarOpacity } from '../domain/food-detail.js';

const props = defineProps({ title: String, image: String, kind: String, category: String, minutes: Number, dishCount: Number, scrollAnchor: String, shareCard: Object, community: Boolean, publisher: String, familyCount: { type: Number, default: null }, canShare: Boolean, sharing: Boolean, canEdit: Boolean, canRemove: Boolean, busy: Boolean });
defineEmits(['close', 'share', 'edit', 'remove']);
const menuOpen = ref(false);
const toolbarOpacity = ref(0);
const publisherName = computed(() => props.community && typeof props.publisher === 'string' ? props.publisher.trim() : '');
const coverFamilyCount = computed(() => props.community && Number.isInteger(props.familyCount) && props.familyCount >= 0 ? props.familyCount : null);
const actions = computed(() => [props.canEdit && { action: 'edit', label: '编辑' }, props.canRemove && { action: 'remove', label: '删除' }].filter(Boolean));
function onDetailScroll(event) {
  toolbarOpacity.value = foodDetailToolbarOpacity(event.detail?.scrollTop);
  menuOpen.value = false;
}
</script>

<template>
  <Sheet :title="title" :scroll-anchor="scrollAnchor" immersive :fit-content="false" @scroll="onDetailScroll" @close="$emit('close')">
    <template #header>
      <view class="food-detail-toolbar">
        <view class="food-detail-toolbar-backdrop" :style="{ opacity: toolbarOpacity }" aria-hidden="true" />
        <button role="button" class="detail-toolbar-button" aria-label="关闭详情" @click.stop="$feedback(); $emit('close')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="detail-tool-surface"><AppIcon name="detail-collapse" :size="24" active /></view></button>
        <view class="food-detail-tools">
          <NativeShareButton v-if="shareCard" :card="shareCard" :disabled="busy" button-class="detail-toolbar-button" label="分享菜品或套餐"><view class="detail-tool-surface"><AppIcon name="detail-share" :size="25" active /></view></NativeShareButton>
          <button v-else-if="canShare" role="button" class="detail-toolbar-button" :aria-label="sharing ? '正在准备分享' : '分享菜品或套餐'" :aria-busy="sharing" :disabled="sharing || busy" @click.stop="$feedback(); $emit('share')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="detail-tool-surface" :class="{ 'action-pending': sharing }"><AppIcon name="detail-share" :size="25" active /></view></button>
          <OrderActionMenu v-if="actions.length" :label="title" :actions="actions" :opened="menuOpen" :busy="busy || sharing" floating @activate="menuOpen = true" @close="menuOpen = false" @edit="$emit('edit')" @remove="$emit('remove')" />
        </view>
      </view>
    </template>
    <RecipeCover :image="image" :kind="kind" :title="title" :category="category" :minutes="minutes" :dish-count="dishCount" :family-count="coverFamilyCount" immersive />
    <view class="food-detail-body">
      <view class="food-detail-heading"><text class="food-detail-title" role="heading" aria-level="1">{{ title }}</text><view v-if="$slots.action" class="food-detail-primary"><slot name="action" /></view></view>
      <view v-if="publisherName" class="food-detail-attribution">
        <text class="food-detail-publisher" :aria-label="`发布者：${publisherName}`">{{ publisherName }}</text>
      </view>
      <slot />
    </view>
  </Sheet>
</template>
