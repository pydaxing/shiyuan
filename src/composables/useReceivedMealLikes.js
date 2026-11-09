import { computed, onUnmounted, ref, watch } from 'vue';
import { cloudMode, cloudStatus, invokeCloud, mealStatsVersion } from '../services/cloud.js';

// Memory only, isolated by account + confirmed space. Never show another
// space's cached number while an optimistic workspace switch is pending.
const cache = new Map();
export function useReceivedMealLikes(spaceId) {
  const count = ref(null), mealCount = ref(null), error = ref('');
  let request = 0, disposed = false;
  const scope = computed(() => `${cloudStatus.value.userId || ''}:${spaceId.value || ''}`);
  async function refresh() {
    const token = ++request, key = scope.value, id = spaceId.value;
    const cached = cache.get(key);
    count.value = cached?.receivedLikes ?? null;
    mealCount.value = cached?.mealCount ?? null;
    error.value = '';
    if (!cloudMode || cloudStatus.value.phase !== 'ready' || !id || id !== cloudStatus.value.familyId) return;
    try {
      const result = await invokeCloud('mealReceivedLikes', { spaceId: id });
      if (disposed || token !== request || key !== scope.value) return;
      if (result.spaceId !== id || !Number.isSafeInteger(result.receivedLikes) || result.receivedLikes < 0) throw new Error('获赞数暂不可用');
      const meals = Number.isSafeInteger(result.mealCount) && result.mealCount >= 0 ? result.mealCount : null;
      cache.set(key, { receivedLikes: result.receivedLikes, mealCount: meals });
      mealCount.value = meals;
      count.value = result.receivedLikes;
    } catch (failure) {
      if (!disposed && token === request && key === scope.value) error.value = failure.message || '获赞数暂不可用';
    }
  }
  watch([scope, () => cloudStatus.value.phase, () => cloudStatus.value.familyId, mealStatsVersion], refresh, { immediate: true });
  onUnmounted(() => { disposed = true; request += 1; });
  return { count, mealCount, error, refresh };
}
