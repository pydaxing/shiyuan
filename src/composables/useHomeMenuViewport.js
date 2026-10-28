import { computed, getCurrentInstance, onScopeDispose, ref, watch } from 'vue';
import { homeMenuGeometry } from '../domain/home-menu.js';
import { afterNativeRender } from './nativeRender.js';

function readGeometry() {
  const info = uni.getSystemInfoSync();
  return { ...homeMenuGeometry(info, info.uniPlatform === 'mp-weixin' ? uni.getMenuButtonBoundingClientRect?.() : null), windowHeight: Number(info.windowHeight || info.screenHeight) || 780 };
}

export function useHomeMenuViewport(visible, locked) {
  const instance = getCurrentInstance();
  const geometry = ref(readGeometry());
  const pinned = ref(false);
  const docked = computed(() => visible.value && pinned.value);
  let menuLimit = null;
  let panelTop = null;
  let observedTop = 0;
  let pageDragTop = 0;
  let revision = 0;
  let navigationRevision = 0;
  let pendingMeasure = null;
  let disposed = false;
  const listInset = computed(() => geometry.value.listTop);
  const style = computed(() => ({
    '--home-menu-safe-top': `${geometry.value.safeTop}px`,
    '--home-menu-search-top': `${geometry.value.searchTop}px`,
    '--home-menu-tools-height': `${geometry.value.toolsHeight}px`,
    '--home-menu-list-top': `${geometry.value.listTop}px`,
  }));
  const boundary = () => menuLimit ?? 0;

  function onScroll(event) {
    if (!visible.value || locked.value || disposed) return;
    observedTop = Math.max(0, event.scrollTop || 0);
    pinned.value = panelTop !== null && menuLimit !== null && observedTop >= boundary() - 1;
  }

  async function measure(request) {
    geometry.value = readGeometry();
    await afterNativeRender();
    if (disposed || !visible.value || locked.value || request !== revision) return false;
    const query = uni.createSelectorQuery();
    if (instance) query.in(instance.proxy);
    query.select('.home-menu-panel').boundingClientRect();
    query.selectViewport().scrollOffset();
    query.select('.content').boundingClientRect();
    return new Promise(resolve => query.exec(([panel, viewport, content]) => {
      if (!Number.isFinite(content?.bottom)) { resolve(false); return; }
      if (!disposed && visible.value && !locked.value && request === revision && panel) {
        observedTop = Math.max(0, viewport?.scrollTop ?? observedTop);
        panelTop = panel.top + observedTop;
        menuLimit = Math.max(0, content.bottom + observedTop - geometry.value.windowHeight);
        onScroll({ scrollTop: observedTop });
        resolve(true);
        return;
      }
      resolve(false);
    }));
  }

  function refresh() {
    if (pendingMeasure) return pendingMeasure;
    const current = measure(++revision).finally(() => { if (pendingMeasure === current) pendingMeasure = null; });
    pendingMeasure = current;
    return current;
  }

  async function dock() {
    if (!visible.value) return;
    const request = ++navigationRevision;
    if (!await refresh() || request !== navigationRevision || !visible.value || locked.value || disposed) return;
    uni.pageScrollTo({ scrollTop: boundary(), duration: 0 });
  }

  function scrollPage({ distance, start }) {
    if (disposed || !visible.value || locked.value || menuLimit === null || !Number.isFinite(distance)) return;
    if (start) pageDragTop = observedTop;
    pageDragTop = Math.max(0, Math.min(menuLimit, pageDragTop + distance));
    uni.pageScrollTo({ scrollTop: pageDragTop, duration: 0 });
  }

  function reset() {
    revision += 1;
    navigationRevision += 1;
    pendingMeasure = null;
    menuLimit = null;
    panelTop = null;
    observedTop = 0;
    pageDragTop = 0;
    pinned.value = false;
  }

  watch(visible, shown => { reset(); if (shown) refresh(); }, { immediate: true });
  watch(locked, value => { revision += 1; navigationRevision += 1; pendingMeasure = null; if (!value && visible.value) refresh(); }, { flush: 'sync' });
  onScopeDispose(() => { disposed = true; reset(); });
  return { style, listInset, pinned, docked, refresh, reset, onScroll, dock, scrollPage };
}
