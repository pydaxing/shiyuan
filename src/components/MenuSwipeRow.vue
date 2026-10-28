<script>
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { foodMinutesLabel } from '../domain/presentation.js';

export default {
  components: { AppIcon, FoodThumbnail },
  props: { entry: Object, selected: Boolean, opened: Boolean, busy: Boolean, sharing: Boolean },
  emits: ['activate', 'close', 'open', 'toggle', 'edit', 'share', 'remove'],
  computed: {
    swipeState() { return this.busy ? this.sharing && this.opened ? 3 : 2 : this.opened ? 1 : 0; },
    categoryLabel() { return this.entry.kind === 'set' ? '套餐' : this.entry.label || this.entry.category || '其他'; },
    secondaryMeta() {
      if (this.entry.kind === 'set') return `${this.entry.recipes?.length ?? this.entry.recipeIds?.length ?? 0} 道菜`;
      return foodMinutesLabel(this.entry.minutes);
    },
  },
  methods: {
    activate() { if (!this.busy) this.$emit('activate'); },
    settled(result) { this.$emit(result.open && !this.busy ? 'activate' : 'close'); },
    dispatchAction({ action }) {
      if (this.busy || !['open', 'toggle', 'edit', 'share', 'remove'].includes(action)) return;
      if (action !== 'share') this.$emit('close');
      this.$emit(action, action === 'toggle' ? this.entry.key : this.entry);
    },
    handleKey(event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.activate(); }
      if (event.key === 'Escape' || event.key === 'ArrowRight') { event.preventDefault(); this.$emit('close'); }
    },
  },
};
</script>

<script module="swipe" lang="wxs">
var actionWidth = 180;

function paint(owner, offset, animated) {
  var surface = owner.selectComponent('.menu-swipe-surface');
  if (surface) surface.setStyle({
    transform: 'translate3d(' + offset + 'px, 0, 0)',
    transition: animated ? 'transform 180ms ease-out' : 'none'
  });
}

function sync(value, previous, owner) {
  var state = owner.getState();
  state.disabled = value === 2 || value === 3;
  if (state.dragging && value === 1) return;
  state.dragging = false;
  state.active = false;
  state.open = value === 1 || value === 3;
  state.offset = state.open ? -actionWidth : 0;
  paint(owner, state.offset, true);
}

function point(event) {
  if (event.touches && event.touches.length) return event.touches[0];
  if (event.changedTouches && event.changedTouches.length) return event.changedTouches[0];
  return event;
}

function start(event, owner) {
  var state = owner.getState();
  if (state.disabled || (event.touches && event.touches.length !== 1)) return;
  if (event.type === 'mousedown' && event.button && event.button !== 0) return;
  var touch = point(event);
  state.active = true;
  state.dragging = false;
  state.axis = '';
  state.suppressTap = false;
  state.initialOpen = !!state.open;
  state.initialOffset = state.initialOpen ? -actionWidth : 0;
  state.startX = touch.pageX;
  state.startY = touch.pageY;
  state.deltaX = 0;
  state.startedAt = event.timeStamp;
}

function move(event, owner) {
  var state = owner.getState();
  if (!state.active) return;
  if (event.touches && event.touches.length !== 1) return cancel(event, owner);
  var touch = point(event);
  var deltaX = touch.pageX - state.startX;
  var deltaY = touch.pageY - state.startY;
  var horizontal = Math.abs(deltaX);
  var vertical = Math.abs(deltaY);
  if (!state.axis) {
    if (vertical >= 8 && vertical >= horizontal) state.axis = 'vertical';
    else if (horizontal >= 8 && horizontal > vertical * 1.25) {
      state.axis = 'horizontal';
      state.dragging = true;
      owner.callMethod('activate');
    } else return;
  }
  state.suppressTap = true;
  if (state.axis !== 'horizontal') return;
  state.deltaX = deltaX;
  state.offset = Math.max(-actionWidth, Math.min(0, state.initialOffset + deltaX));
  paint(owner, state.offset, false);
  return false;
}

function settle(owner, opened) {
  var state = owner.getState();
  state.active = false;
  state.dragging = false;
  state.open = opened;
  state.offset = opened ? -actionWidth : 0;
  paint(owner, state.offset, true);
  owner.callMethod('settled', { open: opened });
}

function end(event, owner) {
  var state = owner.getState();
  if (!state.active) return;
  state.active = false;
  if (state.axis !== 'horizontal') return;
  var duration = Math.max(1, event.timeStamp - state.startedAt);
  var quick = duration < 220 && Math.abs(state.deltaX) >= 24 && Math.abs(state.deltaX) / duration > 0.45;
  var opened = quick ? state.deltaX < 0 : state.offset < -actionWidth / 2;
  settle(owner, opened);
  return false;
}

function cancel(event, owner) {
  var state = owner.getState();
  if (!state.active) return;
  state.suppressTap = true;
  settle(owner, !!state.initialOpen);
}

function reveal(event, owner) {
  var state = owner.getState();
  if (state.disabled || state.axis === 'vertical' || state.dragging) return;
  state.suppressTap = true;
  settle(owner, true);
}

function tap(event, owner) {
  if (event.stopPropagation) event.stopPropagation();
  var state = owner.getState();
  if (state.disabled) return false;
  if (state.suppressTap) { state.suppressTap = false; return false; }
  if (state.open) { settle(owner, false); return false; }
  owner.callMethod('dispatchAction', { action: event.currentTarget.dataset.action });
  return false;
}

module.exports = { sync: sync, start: start, move: move, end: end, cancel: cancel, reveal: reveal, tap: tap };
</script>

<template>
  <view class="menu-swipe" role="group" :aria-label="entry.title" :tabindex="busy ? -1 : 0" :class="{ 'is-open': opened }" :prop="swipeState" :change:prop="swipe.sync" @keydown="handleKey" @mousedown="swipe.start" @mousemove="swipe.move" @mouseup="swipe.end" @mouseleave="swipe.cancel">
    <view class="home-menu-row menu-swipe-surface" :class="{ 'is-picked': selected, 'is-set': entry.kind === 'set' }" @touchstart="swipe.start" @touchmove="swipe.move" @touchend="swipe.end" @touchcancel="swipe.cancel" @longpress="swipe.reveal">
      <view class="home-menu-photo-slot" data-action="open" @click="swipe.tap"><button role="button" class="home-menu-photo" :aria-label="`查看${entry.title}做法，左滑可编辑、分享或删除`" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="entry.image" :kind="entry.kind" /></button></view>
      <view class="home-menu-row-body">
        <view class="home-menu-info-slot" data-action="open" @click="swipe.tap"><button role="button" class="home-menu-info" :aria-label="`查看${entry.title}详情，左滑可编辑、分享或删除`" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="home-menu-title food-list-title">{{ entry.title }}</text><view class="home-menu-meta"><text class="home-menu-item-category">{{ categoryLabel }}</text><view v-if="secondaryMeta" class="home-menu-secondary-meta"><AppIcon :name="entry.kind === 'set' ? 'menu' : 'clock'" :size="12" /><text>{{ secondaryMeta }}</text></view></view></button></view>
        <view class="home-menu-pick-slot" data-action="toggle" @click="swipe.tap"><button role="button" class="home-menu-pick" :class="{ selected }" :aria-pressed="selected" :aria-label="`${selected ? '取消选择' : '选择'}${entry.title}`" :disabled="busy" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="home-menu-pick-mark"><AppIcon :name="selected ? 'check-inverse' : 'plus'" :size="selected ? 16 : 18" /></view></button></view>
      </view>
    </view>
    <view class="menu-swipe-actions" :aria-hidden="!opened">
      <button role="button" class="menu-swipe-edit" :aria-label="`编辑${entry.title}`" :disabled="busy || !opened" :tabindex="opened ? 0 : -1" @click.stop="dispatchAction({ action: 'edit' })" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>编辑</text></button>
      <button role="button" class="menu-swipe-share" :aria-label="`分享${entry.title}`" :disabled="busy || !opened" :tabindex="opened ? 0 : -1" @click.stop="dispatchAction({ action: 'share' })" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>分享</text></button>
      <button role="button" class="menu-swipe-delete" :aria-label="`删除${entry.title}`" :disabled="busy || !opened" :tabindex="opened ? 0 : -1" @click.stop="dispatchAction({ action: 'remove' })" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>删除</text></button>
    </view>
  </view>
</template>

<style scoped>
.menu-swipe { position: relative; width: 100%; overflow: hidden; }
.menu-swipe:focus-visible { outline: 2px solid var(--green); outline-offset: -2px; }
.menu-swipe-surface { position: relative; z-index: 1; border-radius: 0; background: var(--white); touch-action: pan-y; user-select: none; }
.home-menu-row { display: flex; align-items: flex-start; gap: 10px; min-height: var(--food-row-height); padding: var(--food-row-padding) 0; }
.home-menu-photo-slot { flex: 0 0 var(--food-photo-width); }
.home-menu-info-slot { display: flex; flex: 1; min-width: 0; }
.home-menu-pick-slot { flex: 0 0 44px; }
.home-menu-photo { --food-thumbnail-width: var(--food-photo-width); display: block; width: var(--food-photo-width); min-height: 44px; padding: 0; overflow: hidden; border-radius: var(--food-photo-radius); background: var(--paper); }
.home-menu-row-body { display: flex; align-items: center; flex: 1; min-width: 0; }
.home-menu-info { display: flex; flex-direction: column; align-items: flex-start; justify-content: flex-start; align-self: stretch; flex: 1; min-width: 0; min-height: var(--food-row-content-height); padding: 0; text-align: left; }
.home-menu-title { width: 100%; font-family: var(--font-display); font-size: var(--type-list); font-weight: 600; line-height: 1.5; }
.home-menu-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; margin-top: 6px; color: var(--muted); font-family: var(--font-body); font-size: var(--type-caption); line-height: 18px; }
.home-menu-item-category { border-radius: 0; }
.home-menu-secondary-meta { display: flex; align-items: center; flex-shrink: 0; gap: 3px; white-space: nowrap; }
.home-menu-pick { display: flex; align-items: center; justify-content: center; flex: 0 0 44px; width: 44px; height: 44px; margin-left: 2px; border-radius: 50%; }
.home-menu-pick-mark { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border-strong); border-radius: 50%; }
.home-menu-pick.selected .home-menu-pick-mark { border-color: var(--green); background: var(--green); }
.menu-swipe-actions { position: absolute; top: var(--food-row-padding); right: 0; bottom: var(--food-row-padding); display: flex; align-items: stretch; width: 180px; padding: 0; overflow: hidden; border-radius: 0; pointer-events: none; }
.menu-swipe.is-open .menu-swipe-actions { pointer-events: auto; }
.menu-swipe-edit, .menu-swipe-share, .menu-swipe-delete { display: flex; flex: 0 0 60px; align-items: center; justify-content: center; width: 60px; height: 100%; min-width: 44px; min-height: 44px; padding: 0; border-radius: 0; color: var(--white); font-size: var(--type-control); }
.menu-swipe-edit { background: var(--green); }
.menu-swipe-share { background: var(--success); }
.menu-swipe-delete { background: var(--danger); }
@media (min-width: 761px) { .home-menu-row { gap: 18px; } }
@media (max-width: 374px) { .home-menu-row { gap: 8px; } }
@media (prefers-reduced-motion: reduce) { .menu-swipe-surface { transition: none !important; } }
</style>
