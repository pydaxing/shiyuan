<script setup>
import { computed, getCurrentInstance, nextTick, onUnmounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { afterNativeRender } from '../composables/nativeRender.js';
import { orderMenuActions, orderMenuGeometry, orderMenuIcon } from '../domain/order-action-menu.js';

const props = defineProps({ label: String, status: String, opened: Boolean, busy: Boolean, actions: Array, floating: Boolean, hasDishes: { type: Boolean, default: true } });
const emit = defineEmits(['activate', 'close', 'cancel', 'restore', 'remove', 'edit']);
const instance = getCurrentInstance();
const triggerRef = ref(null);
const menuRef = ref(null);
const layout = ref(null);
const highlighted = ref(0);
const options = computed(() => props.actions || orderMenuActions(props.status, props.hasDishes));
const menuId = `order-action-menu-${instance?.uid ?? 0}`;
const menuStyle = computed(() => layout.value ? Object.fromEntries(['top', 'left', 'width', 'height'].map(key => [key, `${layout.value[key]}px`])) : {});
let layoutRequest = 0;
let disposed = false;

function focusElement(element) {
  const target = element?.$el || element;
  target?.focus?.({ preventScroll: true });
}
async function focusOption() {
  await nextTick();
  if (disposed || !props.opened || !layout.value) return;
  const target = menuRef.value?.$el || menuRef.value;
  focusElement(target?.querySelectorAll?.('[role="menuitem"]')[highlighted.value]);
}
function close(restoreFocus = true) {
  layoutRequest += 1;
  layout.value = null;
  emit('close');
  if (restoreFocus) focusElement(triggerRef.value);
}
async function positionMenu() {
  const request = ++layoutRequest;
  await afterNativeRender();
  if (disposed || !props.opened || props.busy || request !== layoutRequest) return;
  try {
    const anchor = await new Promise(resolve => {
      const query = uni.createSelectorQuery();
      if (instance) query.in(instance.proxy);
      query.select('.order-more-button').boundingClientRect(resolve).exec();
    });
    if (disposed || !props.opened || props.busy || request !== layoutRequest) return;
    layout.value = orderMenuGeometry(anchor, uni.getWindowInfo?.() || uni.getSystemInfoSync(), options.value.length);
    if (!layout.value) close(false);
    else focusOption();
  } catch {
    if (!disposed && props.opened && request === layoutRequest) close(false);
  }
}
function show(index = 0) {
  if (props.busy) return;
  highlighted.value = index;
  emit('activate');
}
function toggle() {
  if (props.busy) return;
  if (props.opened) close();
  else show();
}
function choose(action) {
  if (props.busy || !props.opened || !layout.value || !options.value.some(option => option.action === action)) return;
  close();
  emit(action);
}
function onTriggerKey(event) {
  if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Escape') { if (props.opened) close(); return; }
  const index = event.key === 'ArrowUp' ? options.value.length - 1 : 0;
  if (!props.opened) show(index);
  else { highlighted.value = index; focusOption(); }
}
function onMenuKey(event) {
  if (event.key === 'Tab') { close(); return; }
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') highlighted.value = 0;
  else if (event.key === 'End') highlighted.value = options.value.length - 1;
  else highlighted.value = (highlighted.value + (event.key === 'ArrowDown' ? 1 : -1) + options.value.length) % options.value.length;
  focusOption();
}
watch(() => props.opened, opened => {
  if (opened && !props.busy) {
    uni.onWindowResize?.(positionMenu);
    positionMenu();
  } else {
    layoutRequest += 1;
    layout.value = null;
    uni.offWindowResize?.(positionMenu);
  }
}, { flush: 'sync' });
watch(() => props.busy, busy => { if (busy && props.opened) close(false); });
watch(() => props.status, () => { if (props.opened) close(false); });
watch(() => props.hasDishes, () => { if (props.opened) close(false); });
watch(() => props.label, () => { if (props.opened) close(false); });
onUnmounted(() => {
  disposed = true;
  layoutRequest += 1;
  uni.offWindowResize?.(positionMenu);
  if (props.opened) emit('close');
});
</script>

<template>
  <view class="order-action-menu" :class="{ 'is-floating': floating }">
    <button ref="triggerRef" role="button" class="order-more-button" :aria-label="`${label}的更多操作`" aria-haspopup="menu" :aria-expanded="opened" :aria-controls="opened ? menuId : undefined" :disabled="busy" @click.stop="toggle" @keydown="onTriggerKey" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="order-more-dots" aria-hidden="true"><view class="order-more-dot" /><view class="order-more-dot" /><view class="order-more-dot" /></view></button>
    <!-- #ifdef H5 -->
    <Teleport to="body">
    <!-- #endif -->
    <!-- #ifdef MP-WEIXIN -->
    <root-portal>
    <!-- #endif -->
    <view v-if="opened && layout" class="app-shell order-menu-root" :class="{ 'is-floating-menu': floating }">
      <view class="order-menu-backdrop" aria-hidden="true" @click.stop="close()" @touchmove.stop="close(false)" />
      <view ref="menuRef" class="order-menu-popover" :class="{ 'is-above': layout.placement === 'above' }" :style="menuStyle" @click.stop @keydown.stop="onMenuKey">
        <view class="order-menu-pointer" :style="{ left: `${layout.pointer}px` }" aria-hidden="true" />
        <scroll-view :id="menuId" class="order-menu-list" scroll-y enhanced :bounces="false" role="menu" :aria-label="`${label}的操作`">
          <button v-for="(option, index) in options" :key="option.action" role="menuitem" class="order-menu-item" :class="{ 'is-danger': option.action === 'remove' }" :aria-label="`${option.label}${label}`" :tabindex="highlighted === index ? 0 : -1" :disabled="busy || !opened" @focus="highlighted = index" @click.stop="choose(option.action)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon v-if="orderMenuIcon(option.action)" class="order-menu-icon" :name="orderMenuIcon(option.action)" :size="18" /><text>{{ option.label }}</text></button>
        </scroll-view>
      </view>
    </view>
    <!-- #ifdef MP-WEIXIN -->
    </root-portal>
    <!-- #endif -->
    <!-- #ifdef H5 -->
    </Teleport>
    <!-- #endif -->
  </view>
</template>

<style scoped>
.order-action-menu { flex: 0 0 44px; width: 44px; height: 44px; margin: -6px -8px -6px 0; }
.order-more-button { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; min-width: 44px; min-height: 44px; padding: 0; border-radius: var(--radius-small); background: transparent; color: var(--muted); }
.order-more-dots { display: flex; align-items: center; gap: 3px; }
.order-more-dot { width: 3px; height: 3px; border-radius: 50%; background: currentColor; }
.order-action-menu.is-floating { margin: 0; }
.is-floating .order-more-button { position: relative; border-radius: 50%; color: var(--ink); }
.is-floating .order-more-button::before { content: ''; position: absolute; inset: calc((44px - var(--detail-tool-size)) / 2); border-radius: 50%; background: rgba(255, 255, 255, .9); }
.is-floating .order-more-dots { position: relative; }
.app-shell.order-menu-root { position: fixed; inset: 0; z-index: 90; width: auto; min-height: 0; margin: 0; padding: 0; background: transparent; }
.app-shell.order-menu-root.is-floating-menu { z-index: 110; pointer-events: auto; }
.order-menu-backdrop { position: absolute; inset: 0; background: transparent; }
.order-menu-popover { position: absolute; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--white); box-shadow: 0 6px 22px rgba(36, 54, 63, .12); animation: order-menu-enter 140ms ease-out; transform-origin: top right; }
.order-menu-popover.is-above { transform-origin: bottom right; }
.order-menu-pointer { position: absolute; top: -5px; width: 8px; height: 8px; border-top: 1px solid var(--line); border-left: 1px solid var(--line); background: var(--white); transform: translateX(-50%) rotate(45deg); }
.order-menu-popover.is-above .order-menu-pointer { top: auto; bottom: -5px; transform: translateX(-50%) rotate(225deg); }
.order-menu-list { position: relative; height: 100%; padding: 4px 0; border-radius: inherit; }
.order-menu-item { display: flex; align-items: center; justify-content: flex-start; gap: 10px; width: 100%; min-height: 44px; padding: 0 16px; border-radius: 0; color: var(--ink); font-size: var(--type-control); font-weight: 400; line-height: 22px; text-align: left; }
.order-menu-icon { flex: 0 0 18px; width: 18px; height: 18px; pointer-events: none; }
.order-menu-item + .order-menu-item { border-top: 1px solid var(--line); }
.order-menu-item.is-danger { color: var(--danger); }
.order-menu-item:focus-visible { outline-offset: -3px; }
@keyframes order-menu-enter { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .order-menu-popover { animation: none; } }
</style>
