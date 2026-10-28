<script setup>
import NativeShareButton from './NativeShareButton.vue';
import AppIcon from './AppIcon.vue';
defineProps({ card: Object });
</script>

<template>
  <NativeShareButton :card="card" button-class="recipe-detail-button friend-forward-button"><AppIcon name="share" :size="19" active /><text>分享</text></NativeShareButton>
</template>
