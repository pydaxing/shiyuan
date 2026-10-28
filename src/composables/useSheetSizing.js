import { inject, onMounted, onUnmounted, onUpdated, provide, ref } from 'vue';
import { afterNativeRender } from './nativeRender.js';

export function sheetContentHeight(regions, footerVisible) {
  const [header, content, footer] = regions || [];
  const required = footerVisible ? [header, content, footer] : [header, content];
  if (required.some(region => !Number.isFinite(region?.height) || region.height <= 0)) return 0;
  return Math.ceil(required.reduce((total, region) => total + region.height, 0));
}

export function useSheetSizing({ instance, enabled, canMeasure, hasFooter }) {
  const contentRef = ref(null);
  const contentHeight = ref(0);
  const ready = ref(!enabled());
  let disposed = false;
  let queued = false;
  let revision = 0;
  let observer;
  let fallbackTimer;
  const allowed = () => !disposed && enabled() && canMeasure();
  function finish() {
    ready.value = true;
    clearTimeout(fallbackTimer);
  }
  function request() {
    if (!allowed()) return;
    revision += 1;
    if (queued) return;
    queued = true;
    void afterNativeRender().then(() => {
      queued = false;
      if (!allowed()) return;
      const current = revision;
      const footerVisible = hasFooter();
      try {
        const query = uni.createSelectorQuery().in(instance.proxy);
        for (const selector of ['.sheet-header', '.sheet-content', '.sheet-footer']) query.select(selector).boundingClientRect();
        query.exec(regions => {
          if (!allowed() || current !== revision) return;
          const height = sheetContentHeight(regions, footerVisible);
          if (height) contentHeight.value = height;
          finish();
        });
      } catch { finish(); }
    });
  }
  provide('sheetContentResize', request);
  onMounted(() => {
    if (!enabled()) return;
    fallbackTimer = setTimeout(() => { if (!disposed) finish(); }, 160);
    const element = contentRef.value?.$el || contentRef.value;
    if (typeof ResizeObserver !== 'undefined' && element?.nodeType === 1) {
      observer = new ResizeObserver(request);
      observer.observe(element);
    }
    request();
  });
  onUpdated(request);
  onUnmounted(() => {
    disposed = true;
    revision += 1;
    observer?.disconnect();
    clearTimeout(fallbackTimer);
  });
  return { contentRef, contentHeight, ready, request };
}

export function useSheetContentResize(enabled = () => true) {
  const resize = inject('sheetContentResize', null);
  const notify = () => { if (enabled()) resize?.(); };
  if (resize) {
    onMounted(notify);
    onUpdated(notify);
    onUnmounted(notify);
  }
  return notify;
}
