import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';

export function useCommunityFeedViewport({ navigation, locked, enabled, loading, refresh, waitForLoading = true, onError = () => {} }) {
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
  let pendingWait;
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
    pendingWait?.();
    pendingWait = null;
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
      if (disposed || token !== refreshSequence || !enabled.value || locked.value) return;
      // A background load must not swallow a deliberate pull. Wait for it, then refresh.
      if (waitForLoading && loading.value) await new Promise(resolve => {
        const stop = watch([loading, enabled, locked], ([busy, active, blocked]) => {
          if (!busy || !active || blocked) { stop(); resolve(); }
        }, { flush: 'sync' });
        pendingWait = () => { stop(); resolve(); };
      });
      if (disposed || token !== refreshSequence) return;
      pendingWait = null;
      if (!enabled.value || locked.value) return;
      await refresh();
    } catch (error) {
      if (!disposed && token === refreshSequence && enabled.value && !locked.value) onError(error);
    } finally {
      if (!disposed && token === refreshSequence) { refreshing.value = false; }
    }
  }

  onScopeDispose(() => {
    disposed = true;
    scrollSequence += 1;
    refreshSequence += 1;
    pendingWait?.();
    pendingWait = null;
    refreshing.value = false;
    pullReady.value = false;
  });

  return { scrollTop, refreshing, pullReady, refreshThreshold, refresherEnabled, onScroll, onPull, stopPull, reset, onRefresh };
}
