import { computed, onUnmounted, ref, watch } from 'vue';
import { cloudMode, cloudStatus, cloudEnvironment, cloudFunction, invokeCloud, mealStatsVersion } from '../services/cloud.js';

import { createPersistentCache } from '../services/persistent-cache.js';

// Display the last server-confirmed totals immediately after a restart.
// Account and cloud environment isolate the cache; each visit still revalidates.
const cache = createPersistentCache(`shiyuan-user-meal-stats-v1-${cloudEnvironment}-${cloudFunction}`, {
  maxEntries: 12, maxChars: 6000, maxAge: Number.MAX_SAFE_INTEGER,
  validate: value => Number.isSafeInteger(value?.receivedLikes) && value.receivedLikes >= 0
    && (value.mealCount === null || (Number.isSafeInteger(value.mealCount) && value.mealCount >= 0)),
});
export function useReceivedMealLikes(spaceId) {
  const count = ref(null), mealCount = ref(null), error = ref('');
  let request = 0, disposed = false;
  const scope = computed(() => `${cloudStatus.value.userId || ''}:user-summary-v1`);
  async function refresh() {
    const token = ++request, key = scope.value, id = cloudStatus.value.familyId;
    const cached = cache.get(key);
    count.value = cached?.receivedLikes ?? null;
    mealCount.value = cached?.mealCount ?? null;
    error.value = '';
    if (!cloudMode || !cloudStatus.value.userId || cloudStatus.value.phase !== 'ready' || !id) return;
    try {
      const result = await invokeCloud('mealReceivedLikes', { spaceId: id, userSummaryVersion: 1 });
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
