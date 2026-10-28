import { onScopeDispose, ref, watch } from 'vue';

export function useCommunityNavigation(locked, editing) {
  const hidden = ref(false);
  let previousTop = 0;
  let direction = 0;
  let distance = 0;
  let restoreTop = null;
  let disposed = false;

  function resetDirection() { direction = 0; distance = 0; }
  function reveal() { hidden.value = false; resetDirection(); }
  function reset() { reveal(); previousTop = 0; restoreTop = null; }

  function onScroll(event) {
    if (disposed || locked.value || !Number.isFinite(event?.scrollTop)) return;
    const top = Math.max(0, event.scrollTop);
    if (restoreTop !== null) {
      if (top === 0 && restoreTop > 0) return;
      restoreTop = null;
      previousTop = top;
      resetDirection();
      return;
    }
    const delta = top - previousTop;
    previousTop = top;
    if (editing.value || top <= 8) { reveal(); return; }
    if (!delta) return;
    const nextDirection = Math.sign(delta);
    if (nextDirection !== direction) { resetDirection(); direction = nextDirection; }
    distance += Math.abs(delta);
    if (direction > 0 && top >= 56 && distance >= 16) hidden.value = true;
    else if (direction < 0 && distance >= 10) hidden.value = false;
  }

  watch(locked, value => {
    resetDirection();
    if (value) restoreTop = previousTop;
  }, { flush: 'sync' });
  watch(editing, value => {
    resetDirection();
    if (value) reveal();
  }, { flush: 'sync' });
  onScopeDispose(() => { disposed = true; });
  return { hidden, onScroll, reveal, reset };
}
