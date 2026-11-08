import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';

export function useCommunityFeedViewport({ navigation, locked, enabled, loading, refresh, indicatorMaxMs = 0, onError = () => {} }) {
  const scrollTop = ref(0);
  const refreshing = ref(false);
  const pullReady = ref(false);
  const refreshThreshold = 80;
  // Keep the native refresher mounted while it restores its pull offset.
  // Disabling it together with triggered=false can strand the content below the header.
  const refresherEnabled = computed(() => enabled.value && !locked.value);
  let lastTop = 0;
  let scrollSequence = 0;
  let refreshSequence = 0;
  let disposed = false;
  let indicatorTimer;
  watch(locked, value => { if (value) scrollTop.value = lastTop; }, { flush: 'sync' });

  function onScroll(event) {
    if (disposed || locked.value || !Number.isFinite(event?.detail?.scrollTop)) return;
    lastTop = Math.max(0, event.detail.scrollTop);
    navigation.onScroll({ scrollTop: lastTop });
  }

  function onPull(event) {
    if (disposed || locked.value) return;
    pullReady.value = Number(event?.detail?.dy) >= refreshThreshold;
    navigation.reveal();
  }

  function stopPull() { pullReady.value = false; }

  async function reset() {
    if (disposed) return;
    const token = ++scrollSequence;
    refreshSequence += 1;
    clearTimeout(indicatorTimer);
    refreshing.value = false;
    pullReady.value = false;
    navigation.reset();
    scrollTop.value = lastTop;
    await nextTick();
    if (disposed || locked.value || token !== scrollSequence) return;
    lastTop = 0;
    scrollTop.value = 0;
  }

  async function onRefresh() {
    if (disposed || refreshing.value) return;
    const token = ++refreshSequence;
    refreshing.value = true;
    pullReady.value = false;
    navigation.reveal();
    try {
      await nextTick();
      if (disposed || token !== refreshSequence || !enabled.value || locked.value || loading.value) return;
      if (indicatorMaxMs > 0) indicatorTimer = setTimeout(() => {
        if (!disposed && token === refreshSequence) refreshing.value = false;
      }, indicatorMaxMs);
      await refresh();
    } catch (error) {
      if (!disposed && token === refreshSequence && enabled.value && !locked.value) onError(error);
    } finally {
      if (!disposed && token === refreshSequence) { clearTimeout(indicatorTimer); refreshing.value = false; }
    }
  }

  onScopeDispose(() => {
    disposed = true;
    scrollSequence += 1;
    refreshSequence += 1;
    clearTimeout(indicatorTimer);
    refreshing.value = false;
    pullReady.value = false;
  });

  return { scrollTop, refreshing, pullReady, refreshThreshold, refresherEnabled, onScroll, onPull, stopPull, reset, onRefresh };
}
