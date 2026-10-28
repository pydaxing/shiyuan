<script setup>
import { getCurrentInstance, inject, onUnmounted } from 'vue';
defineProps({ error: String, errorId: String });
const instance = getCurrentInstance();
const sheet = inject('sheetKeyboard', null);
const token = Symbol('field-error');
function reveal() {
  const measure = callback => uni.createSelectorQuery().in(instance.proxy).select('.field-error-anchor').boundingClientRect(callback).exec();
  if (sheet) sheet.reveal(token, measure);
  else {
    const query = uni.createSelectorQuery().in(instance.proxy);
    query.select('.field-error-anchor').boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(([rect, viewport]) => { if (rect) uni.pageScrollTo({ scrollTop: Math.max(0, rect.top + (viewport?.scrollTop || 0) - 100), duration: 180 }); });
  }
}
defineExpose({ reveal });
onUnmounted(() => sheet?.blur(token));
</script>

<template><view v-if="error" class="field-error-anchor"><text :id="errorId" class="field-error" role="alert">{{ error }}</text></view></template>
