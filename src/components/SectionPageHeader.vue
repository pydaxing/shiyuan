<script setup>
import PageHeader from './PageHeader.vue';
import { SECTION_TABS_HEIGHT } from '../domain/navigation.js';

defineProps({ title: String, modelValue: String, sections: { type: Array, required: true } });
defineEmits(['update:modelValue']);
</script>

<template>
  <PageHeader :title="title" :style="{ '--page-header-extension-height': `${SECTION_TABS_HEIGHT}px` }">
    <template #extension>
      <view class="section-tabs-frame">
        <view class="section-tabs community-single-toolbar" :aria-label="`${title}页面切换`">
          <button v-for="section in sections" :key="section.id" role="button" class="community-order-button" :class="{ active: modelValue === section.id }" :aria-pressed="modelValue === section.id" @click="$emit('update:modelValue', section.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ section.label }}</button>
          <view class="section-header-actions"><slot name="actions" /></view>
        </view>
      </view>
    </template>
  </PageHeader>
</template>

<style scoped>
.section-tabs-frame { background: var(--white); }
.section-tabs { display: flex; align-items: center; max-width: var(--content-width); margin: 0 auto; padding: 0 var(--page-gutter); }
.section-header-actions { display: flex; align-items: center; flex: 0 0 auto; margin-left: auto; }
</style>
