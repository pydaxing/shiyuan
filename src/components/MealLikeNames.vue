<script setup>
import { getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue';
import { afterNativeRender } from '../composables/nativeRender.js';
const props = defineProps({ text: String, resetKey: String });
const expanded = ref(false);
const overflowing = ref(false);
const instance = getCurrentInstance();
let request = 0;
let disposed = false;
async function measure() {
  const current = ++request;
  await afterNativeRender();
  if (disposed || current !== request) return;
  const query = uni.createSelectorQuery().in(instance.proxy);
  query.select('.like-names-text').boundingClientRect(rect => {
    if (disposed || current !== request || !rect?.width) return;
    overflowing.value = rect.height > 101;
    if (!overflowing.value) expanded.value = false;
  }).exec();
}
watch(() => props.text, measure);
watch(() => props.resetKey, () => { expanded.value = false; overflowing.value = false; measure(); });
onMounted(() => { measure(); uni.onWindowResize?.(measure); });
onUnmounted(() => { disposed = true; request += 1; uni.offWindowResize?.(measure); });
</script>
<template>
  <view class="like-names-content">
    <view class="like-names-clip" :class="{ 'is-collapsed': !expanded }">
      <text class="like-names-text">{{ text }}</text>
    </view>
    <button v-if="overflowing" class="like-names-disclosure" :class="{ 'has-fade': !expanded }" :aria-expanded="expanded" @click.stop="expanded = !expanded" hover-class="none"><text>{{ expanded ? '收起' : '展示全部' }}</text><view class="disclosure-chevron" :class="{ 'is-expanded': expanded }" /></button>
  </view>
</template>
<style scoped>
.like-names-content { flex: 1; min-width: 0; }
.like-names-clip { overflow: hidden; }
.like-names-clip.is-collapsed { max-height: 100px; }
.like-names-text { display: block; line-height: 20px; overflow-wrap: anywhere; word-break: break-word; }
.like-names-disclosure { position: relative; display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; min-height: 32px; margin: 3px 0 0; padding: 0; background: transparent; color: var(--feed-author); font-size: var(--type-caption); line-height: 20px; }
.like-names-disclosure::after { border: 0; }
.like-names-disclosure.has-fade::before { content: ''; position: absolute; left: 0; right: 0; top: -23px; height: 20px; background: linear-gradient(to bottom, transparent, #f7f7f7); pointer-events: none; }
</style>
