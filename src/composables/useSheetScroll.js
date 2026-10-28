import { ref } from 'vue';
import { fieldScrollTop } from '../domain/mobile.js';
import { afterNativeRender } from './nativeRender.js';

export function useSheetScroll() {
  const scrollTop = ref(0);
  let observedTop = 0;
  let revision = 0;
  function onScroll(event) {
    observedTop = Math.max(0, event.detail.scrollTop || 0);
    revision += 1;
  }
  async function reveal(field, viewport) {
    const current = Number.isFinite(viewport?.scrollTop) ? Math.max(0, viewport.scrollTop) : observedTop;
    const target = fieldScrollTop(current, field, viewport);
    if (Math.abs(target - current) < 1) return true;
    const request = ++revision;
    await afterNativeRender();
    if (request !== revision) return false;
    scrollTop.value = scrollTop.value === target ? target + .1 : target;
    return true;
  }
  function cancel() { revision += 1; }
  async function reset() {
    const request = ++revision;
    await afterNativeRender();
    if (request !== revision) return;
    scrollTop.value = scrollTop.value === 0 && observedTop > 0 ? .1 : 0;
    observedTop = 0;
  }
  return { scrollTop, onScroll, reveal, cancel, reset, version: () => revision };
}
