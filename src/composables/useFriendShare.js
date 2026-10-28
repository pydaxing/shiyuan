import { computed, ref, watch, onUnmounted } from 'vue';
import { state, cloudMode, cloudStatus, notify } from '../store.js';
import { invokeCloud, resolveImage } from '../services/cloud.js';
import { createPreparedShares, familyShareContext } from '../services/prepared-shares.js';
import { dishShareCard } from '../services/native-share.js';

const preparedShares = createPreparedShares({ request: payload => invokeCloud('createDishShare', payload) });
watch(() => `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`, () => preparedShares.clear());

export function useFriendShare(selection, open) {
  const busy = ref(false);
  const context = computed(() => cloudMode ? familyShareContext(state.value, cloudStatus.value, selection.value) : null);
  const identity = computed(() => context.value ? JSON.stringify([context.value.scope, context.value.kind, context.value.itemId, context.value.fingerprint]) : '');
  let sequence = 0;
  watch(identity, () => {
    sequence += 1;
    busy.value = false;
    if (context.value) preparedShares.prepare(context.value).catch(() => {});
  }, { immediate: true });
  onUnmounted(() => { sequence += 1; });
  function deliver(result) { open(dishShareCard({ ...result, imageUrl: resolveImage(result.image, 'card') })); }
  async function share() {
    if (busy.value) return;
    if (!cloudMode) { open(null); return; }
    if (!context.value) { notify('菜品或家庭已变更，请重新打开'); return; }
    const cached = preparedShares.peek(context.value);
    if (cached) { deliver(cached); return; }
    const current = ++sequence;
    const expected = identity.value;
    busy.value = true;
    try {
      const result = await preparedShares.prepare(context.value);
      if (sequence === current && identity.value === expected) deliver(result);
    } catch (error) { if (sequence === current) notify(error.message || '暂时无法分享，请重试'); }
    finally { if (sequence === current) busy.value = false; }
  }
  return { busy, share };
}
