<script>
import FamilyCoverImage from './FamilyCoverImage.vue';

export default {
  components: { FamilyCoverImage },
  props: { src: String, personal: Boolean, compact: Boolean, enabled: { type: Boolean, default: true }, active: { type: Boolean, default: true }, atTop: { type: Boolean, default: true }, refreshAction: Function },
  data: () => ({ refreshing: false, pullReady: false }),
  methods: {
    setPullReady(ready) { this.pullReady = ready; },
    async requestRefresh() {
      if (this.refreshing || !this.active || !this.refreshAction) return;
      this.refreshing = true;
      try { await this.refreshAction(); }
      catch (error) { uni.showToast({ title: error?.message || '刷新暂时没成功，请再试试', icon: 'none' }); }
      finally { this.refreshing = false; this.pullReady = false; }
    },
  },
  computed: { gestureEnabled() { return !this.enabled || !this.active ? 0 : this.atTop ? 1 : 2; } },
};
</script>

<script module="cover" lang="wxs">
var limit = 80;
var threshold = 44;
function ready(owner, value) {
  var state = owner.getState();
  if (state.ready === value) return;
  state.ready = value;
  owner.callMethod('setPullReady', value);
}
function syncRefresh(value, previous, owner) {
  var state = owner.getState();
  state.refreshable = value > 0;
  state.refreshing = value === 2;
  if (previous === 2 && value !== 2) {
    ready(owner, false);
    paint(owner, 0, true);
  }
}
function paint(owner, height, animated) {
  var state = owner.getState();
  var indicator = owner.selectComponent('.stretch-cover-refresher');
  if (indicator) indicator.setStyle({ opacity: state.refreshable ? Math.min(1, height / 24) : 0 });
  var spacer = owner.selectComponent('.stretch-cover-space');
  if (spacer) spacer.setStyle({ height: height + 'px', transition: animated ? 'height 260ms cubic-bezier(.2,.7,.2,1)' : 'none' });
}
function sync(value, previous, owner) {
  var state = owner.getState();
  state.enabled = value > 0;
  state.atTop = value === 1;
  if (state.enabled) return;
  state.active = false;
  state.blocked = false;
  state.dragging = false;
  if (state.refreshable) ready(owner, false);
  paint(owner, 0, false);
}
function start(event, owner) {
  var state = owner.getState();
  if (state.refreshing || !state.enabled || !state.atTop || !event.touches || event.touches.length !== 1) return;
  state.active = true;
  state.blocked = false;
  state.dragging = false;
  state.distance = 0;
  state.x = event.touches[0].pageX;
  state.y = event.touches[0].pageY;
  var surface = owner.selectComponent('.stretch-cover');
  var size = surface ? surface.getComputedStyle(['height', 'min-height']) : {};
  var height = parseFloat(size.height);
  var minimum = parseFloat(size['min-height']);
  // Unknown measurements must not trap genuinely overflowing content.
  state.scrollable = !(height >= 0 && minimum > 0) || height > minimum + 1;
}
function move(event, owner) {
  var state = owner.getState();
  if (!state.active) { if (state.blocked) return false; return; }
  if (!event.touches || event.touches.length !== 1) return cancel(event, owner);
  var dx = event.touches[0].pageX - state.x;
  var dy = event.touches[0].pageY - state.y;
  if (!state.dragging) {
    if (Math.abs(dx) > 8 && Math.abs(dx) >= Math.abs(dy)) { state.active = false; return; }
    if (dy < -8) {
      state.active = false;
      state.blocked = !state.scrollable;
      if (state.blocked) return false;
      return;
    }
    if (Math.abs(dy) < 8 || Math.abs(dy) <= Math.abs(dx)) return;
    state.dragging = true;
  }
  // Increase resistance as the finger travels; even a long pull stays below 80px.
  var distance = Math.max(0, dy);
  state.distance = limit * distance / (distance + 180);
  if (state.refreshable) ready(owner, state.distance >= threshold);
  paint(owner, state.distance, false);
  return false;
}
function end(event, owner) {
  var state = owner.getState();
  state.active = false;
  state.blocked = false;
  if (!state.dragging) return;
  state.dragging = false;
  if (state.refreshable && state.ready && !state.refreshing && state.enabled) {
    state.refreshing = true;
    paint(owner, threshold, true);
    owner.callMethod('requestRefresh');
  } else {
    if (state.refreshable) ready(owner, false);
    paint(owner, 0, true);
  }
  return false;
}
function cancel(event, owner) {
  var state = owner.getState();
  state.active = false;
  state.blocked = false;
  state.dragging = false;
  if (state.refreshable) ready(owner, false);
  paint(owner, 0, true);
}
module.exports = { syncRefresh: syncRefresh, sync: sync, start: start, move: move, end: end, cancel: cancel };
</script>

<template>
  <view class="stretch-cover" :class="{ 'is-compact': compact }" :prop="gestureEnabled" :change:prop="cover.sync" :refresh="refreshing ? 2 : refreshAction ? 1 : 0" :change:refresh="cover.syncRefresh" @touchstart="cover.start" @touchmove="cover.move" @touchend="cover.end" @touchcancel="cover.cancel">
    <view class="stretch-cover-hero">
      <view v-if="enabled" class="stretch-cover-background" aria-hidden="true"><FamilyCoverImage :src="src" :personal="personal" variant="cover" /><view class="stretch-cover-shade" /></view>
      <slot name="navigation" />
      <view class="stretch-cover-space"><view v-if="!!refreshAction" class="stretch-cover-refresher" role="status"><view class="community-refresh-spinner" :class="{ 'is-refreshing': refreshing }" /><text>{{ refreshing ? '正在刷新' : pullReady ? '松开刷新' : '下拉刷新' }}</text></view></view>
      <slot />
    </view>
    <slot name="content" />
  </view>
</template>

<style scoped>
.stretch-cover { position: relative; min-height: calc(100vh - var(--account-bottom-inset, 0px)); }
.stretch-cover.is-compact { min-height: 0; }
.stretch-cover.is-compact .stretch-cover-hero { padding-bottom: 12px; }
.stretch-cover-hero { position: relative; background: var(--white); }
.stretch-cover-background { position: absolute; inset: 0; overflow: hidden; pointer-events: none; background: var(--green); }
.stretch-cover-shade { position: absolute; inset: 0; background: linear-gradient(180deg, var(--profile-cover-shade-light) 0%, var(--profile-cover-shade-light) 55%, var(--profile-cover-shade) 78%, var(--profile-cover-shade-deep) 100%); }
.stretch-cover-space { position: relative; height: 0; pointer-events: none; }
.stretch-cover-refresher { position: absolute; left: 0; right: 0; top: -18px; height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; opacity: 0; color: rgba(255,255,255,.94); font-size: var(--type-caption); line-height: 20px; text-shadow: 0 1px 3px rgba(0,0,0,.3); }
.stretch-cover-refresher .community-refresh-spinner { border-color: rgba(255,255,255,.35); border-top-color: #fff; }
@media (prefers-reduced-motion: reduce) { .stretch-cover-space { transition: none !important; } }
</style>
