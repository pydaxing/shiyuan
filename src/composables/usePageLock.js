import { computed, nextTick, ref, watch } from 'vue';

export function usePageLock(open, restore) {
  let lastTop = 0;
  let revision = 0;
  const frozenTop = ref(0);
  const style = computed(() => open.value ? { position: 'fixed', top: `-${frozenTop.value}px`, left: '0', right: '0', width: '100%' } : {});
  function onScroll(event) {
    if (!open.value) lastTop = Math.max(0, event.scrollTop || 0);
  }
  function reset() { lastTop = 0; frozenTop.value = 0; }
  watch(open, async (locked) => {
    const request = ++revision;
    if (locked) frozenTop.value = lastTop;
    else {
      await nextTick();
      if (request === revision && !open.value) restore(frozenTop.value);
    }
  }, { flush: 'sync' });
  return { style, onScroll, reset };
}
