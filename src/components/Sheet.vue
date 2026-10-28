<script setup>
import { computed, getCurrentInstance, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { keyboardLayout, nativeKeyboardInset, sheetTopInset, visualKeyboardFrame } from '../domain/mobile.js';
import { afterNativeRender } from '../composables/nativeRender.js';
import { useSheetScroll } from '../composables/useSheetScroll.js';
import { useSheetSizing } from '../composables/useSheetSizing.js';
import { registerSheet } from '../composables/sheetStack.js';
import { createFieldReveal } from '../composables/fieldReveal.js';
import { blurKeyboardField, createKeyboardDismissGesture, dismissFocusedKeyboard } from '../services/keyboard.js';
const props = defineProps({ title: String, eyebrow: { type: String, default: '' }, preferredHeight: { type: Number, default: 0 }, footerVisible: { type: Boolean, default: true }, fitContent: { type: Boolean, default: true }, scrollAnchor: { type: String, default: '' }, immersive: Boolean, variant: String });
const emit = defineEmits(['close', 'scroll']);
const instance = getCurrentInstance();
const info = uni.getWindowInfo?.() || uni.getSystemInfoSync();
let capsule = null;
// #ifdef MP-WEIXIN
capsule = uni.getMenuButtonBoundingClientRect?.() || {};
// #endif
const topInset = sheetTopInset(info, capsule);
const keyboard = ref(0);
const availableHeight = ref(info.windowHeight);
const restHeight = ref(info.windowHeight);
const webFrame = ref(null);
const { scrollTop, onScroll, reveal, cancel, reset, version } = useSheetScroll();
function handleScroll(event) {
  onScroll(event);
  if (props.immersive) emit('scroll', event);
}
const layer = registerSheet();
let viewportCleanup;
let syncViewport;
let focusedToken;
let keyboardCloseTimer;
let blurCloseTimer;
let frameRevision = 0;
let pendingHeight = null;
const surfaceGesture = createKeyboardDismissGesture({ enabled: () => Boolean(syncViewport), onDrag: () => fields.interrupt() });
const fields = createFieldReveal({
  isActive: layer.isTop,
  measureViewport: (callback) => {
    const query = uni.createSelectorQuery().in(instance.proxy);
    query.select('.sheet-scroll').fields({ rect: true, size: true, scrollOffset: true });
    query.exec(([viewport]) => callback(viewport));
  },
  reveal,
  cancelScroll: cancel,
  scrollVersion: version,
});
function restoreKeyboardFrame() {
  frameRevision += 1;
  pendingHeight = null;
  cancelKeyboardClose();
  fields.cancel();
  keyboard.value = 0;
  availableHeight.value = (uni.getWindowInfo?.() || uni.getSystemInfoSync()).windowHeight;
  resizeContent();
}
function releaseField(token) {
  if (token && token !== focusedToken) return;
  blurKeyboardField(focusedToken);
  focusedToken = null;
  clearTimeout(blurCloseTimer);
  fields.clear();
  restoreKeyboardFrame();
}
function dismissKeyboard() {
  if (!dismissFocusedKeyboard()) { releaseField(); uni.hideKeyboard(); }
}
const layout = computed(() => webFrame.value || keyboardLayout(availableHeight.value, nativeKeyboardInset(restHeight.value, availableHeight.value, keyboard.value), topInset));
const maxHeight = computed(() => Math.min(layout.value.maxHeight, Math.floor(restHeight.value * (info.windowWidth <= 760 ? .93 : .9))));
const { contentRef, contentHeight, ready: sizeReady, request: resizeContent } = useSheetSizing({
  instance,
  enabled: () => props.fitContent,
  canMeasure: () => !keyboard.value && !focusedToken && layer.isTop(),
  hasFooter: () => props.footerVisible && Boolean(instance.slots.footer),
});
provide('sheetReady', sizeReady);
const sheetStyle = computed(() => ({
  height: `${keyboard.value ? maxHeight.value : Math.min(props.preferredHeight || maxHeight.value, maxHeight.value, props.fitContent && contentHeight.value ? contentHeight.value : Infinity)}px`,
  maxHeight: `${maxHeight.value}px`,
  visibility: props.fitContent && !sizeReady.value ? 'hidden' : 'visible',
}));
watch([maxHeight, keyboard, layer.isTop, () => props.preferredHeight, () => props.footerVisible, () => props.fitContent], resizeContent, { flush: 'post' });
const backdropStyle = computed(() => ({ paddingBottom: `${layout.value.bottom + (info.windowWidth > 760 ? 24 : 0)}px` }));
function cancelReveal() { fields.interrupt(); }
function startSurfaceGesture(event) {
  surfaceGesture.begin(event);
}
defineExpose({ resetScroll({ preserveFocus = false } = {}) { if (preserveFocus) fields.interrupt(); else fields.clear(); void reset(); } });
function blurField(token) {
  fields.blur(token);
  if (focusedToken !== token) return;
  focusedToken = null;
  clearTimeout(blurCloseTimer);
  blurCloseTimer = setTimeout(() => { if (!focusedToken && layer.isTop()) restoreKeyboardFrame(); }, 80);
}
function cancelKeyboardClose() { clearTimeout(keyboardCloseTimer); keyboardCloseTimer = undefined; }
async function updateNativeFrame(height, windowHeight) {
  const request = ++frameRevision;
  pendingHeight = height;
  fields.cancel();
  availableHeight.value = windowHeight;
  keyboard.value = height;
  await afterNativeRender();
  if (request !== frameRevision || !layer.isTop()) return;
  pendingHeight = null;
  fields.request(0);
}
function onKeyboard(event, token) {
  if (syncViewport || !layer.isTop() || (token && !fields.owns(token))) return;
  const height = Math.max(0, Number(event.height) || 0);
  if (!height) {
    if (keyboardCloseTimer === undefined && keyboard.value) keyboardCloseTimer = setTimeout(() => { if (layer.isTop()) restoreKeyboardFrame(); }, 80);
    return;
  }
  if (!focusedToken) return;
  const closing = keyboardCloseTimer !== undefined;
  cancelKeyboardClose();
  if (height === (pendingHeight ?? keyboard.value)) { if (closing && pendingHeight === null) fields.request(0); return; }
  updateNativeFrame(height, (uni.getWindowInfo?.() || uni.getSystemInfoSync()).windowHeight);
}
function onWindowResize(event) {
  if (syncViewport) return;
  const height = event.size?.windowHeight;
  if (!height || availableHeight.value === height) return;
  if (!keyboard.value && pendingHeight === null) {
    availableHeight.value = height;
    if (!focusedToken || height >= restHeight.value - 80) restHeight.value = height;
  } else updateNativeFrame(pendingHeight ?? keyboard.value, height);
}
provide('sheetKeyboard', {
  keyboard: onKeyboard,
  blur: blurField,
  dismiss: releaseField,
  reveal: fields.focus,
  focus(token, measure) {
    clearTimeout(blurCloseTimer);
    focusedToken = token;
    fields.focus(token, measure, null);
    if (pendingHeight === null && keyboard.value && keyboardCloseTimer === undefined) fields.request(0);
  },
});
watch(layer.isTop, (active) => {
  if (!active) releaseField();
  syncViewport?.();
});
onMounted(() => {
  if (typeof window !== 'undefined' && window.visualViewport) {
    const viewport = window.visualViewport;
    let frameRequest;
    const resize = () => {
      frameRequest = undefined;
      const frame = visualKeyboardFrame(window.innerHeight, viewport, topInset);
      const lostHeight = Math.max(0, restHeight.value - viewport.height);
      availableHeight.value = window.innerHeight;
      const wasOpen = keyboard.value > 0;
      keyboard.value = layer.isTop() && (focusedToken || keyboard.value) && lostHeight > 80 ? lostHeight : 0;
      if (wasOpen && !keyboard.value) fields.clear();
      if (!keyboard.value && !focusedToken) restHeight.value = window.innerHeight;
      if (webFrame.value?.bottom === frame.bottom && webFrame.value?.maxHeight === frame.maxHeight) return;
      webFrame.value = frame;
      if (keyboard.value) fields.request(100);
    };
    syncViewport = () => { if (frameRequest === undefined) frameRequest = window.requestAnimationFrame(resize); };
    viewport.addEventListener('resize', syncViewport);
    viewport.addEventListener('scroll', syncViewport);
    window.addEventListener('resize', syncViewport);
    resize();
    viewportCleanup = () => {
      window.cancelAnimationFrame(frameRequest);
      viewport.removeEventListener('resize', syncViewport);
      viewport.removeEventListener('scroll', syncViewport);
      window.removeEventListener('resize', syncViewport);
    };
  } else {
    uni.onKeyboardHeightChange?.(onKeyboard);
    uni.onWindowResize?.(onWindowResize);
  }
});
onUnmounted(() => {
  const shouldDismiss = layer.isTop() && (focusedToken || keyboard.value);
  releaseField();
  uni.offKeyboardHeightChange?.(onKeyboard);
  uni.offWindowResize?.(onWindowResize);
  viewportCleanup?.();
  if (shouldDismiss) uni.hideKeyboard();
  layer.close();
});
</script>

<template>
  <!-- #ifdef MP-WEIXIN -->
  <root-portal>
  <view class="app-shell sheet-root">
  <!-- #endif -->
  <view class="sheet-backdrop" :style="backdropStyle" @click.stop>
    <view class="sheet-mask" aria-hidden="true" @touchmove.stop.prevent @click.stop="keyboard ? dismissKeyboard() : $emit('close')" />
    <view class="sheet" :class="{ 'is-food-detail': immersive, 'is-preparation': variant === 'preparation', 'is-action-picker': variant === 'action-picker' }" :style="sheetStyle" role="dialog" aria-modal="true" :aria-label="title" @touchstart="startSurfaceGesture" @touchmove="surfaceGesture.move" @touchend="surfaceGesture.end" @touchcancel="surfaceGesture.cancel" @mousedown="startSurfaceGesture" @click.stop="surfaceGesture.end">
      <view class="sheet-header" @touchmove.stop.prevent>
        <slot name="header">
        <view class="sheet-header-leading"><button role="button" class="keyboard-done" :class="{ 'keyboard-done-hidden': !keyboard }" :disabled="!keyboard" :aria-hidden="!keyboard" aria-label="收起键盘" @click.stop="dismissKeyboard" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">完成</button></view>
        <view class="sheet-heading"><text v-if="eyebrow" class="eyebrow">{{ eyebrow }}</text><text class="sheet-title">{{ title }}</text></view>
        <view class="sheet-header-actions"><button role="button" class="icon-button sheet-close" aria-label="关闭弹窗" @click.stop="$emit('close')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><image class="sheet-close-icon" src="/static/icon-close.png" mode="aspectFit" aria-hidden="true" /></button></view>
        </slot>
      </view>
      <scroll-view scroll-y class="sheet-scroll" :scroll-top="scrollTop" :scroll-into-view="scrollAnchor" :scroll-with-animation="false" :scroll-anchoring="false" @scroll="handleScroll"><view ref="contentRef" class="sheet-content"><slot /><view v-if="!footerVisible || !$slots.footer" class="sheet-safe-space" /></view></scroll-view>
      <view v-if="footerVisible && $slots.footer" class="sheet-footer" :style="keyboard ? { paddingBottom: '14px' } : {}" @touchmove.stop.prevent><slot name="footer" /></view>
    </view>
  </view>
  <!-- #ifdef MP-WEIXIN -->
  </view>
  </root-portal>
  <!-- #endif -->
</template>
