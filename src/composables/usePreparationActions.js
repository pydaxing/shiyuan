import { computed } from 'vue';
import { state, setDishPrepared } from '../store.js';
import { preparationKey, preparationMeals } from '../domain/meal-preparation.js';
import { usePreparationAutosave } from './usePreparationAutosave.js';

export function usePreparationActions() {
  const autosave = usePreparationAutosave();
  const savingKey = computed(() => {
    const entry = autosave.entries().find(entry => entry.actionBusy === 'prepared');
    return entry ? preparationKey(entry.orderId, entry.recipeId) : '';
  });
  const failure = computed(() => autosave.entries().find(entry => entry.actionError?.kind === 'prepared')?.actionError || null);
  const busy = computed(() => Boolean(savingKey.value));
  async function togglePrepared(order, dish) {
    const prepared = !dish.prepared;
    return autosave.act(order.id, dish.recipe.id, 'prepared', async (barrier, present) => {
      const latest = preparationMeals(state.value).find(entry => entry.id === order.id)?.dishes.find(entry => entry.recipe.id === dish.recipe.id);
      if (!latest) throw new Error('这一餐已结束或菜品已移除，请重新查看');
      if (latest.prepared === prepared) return true;
      await present(setDishPrepared(order.id, dish.recipe.id, prepared, latest.signature));
      return true;
    }, { immediate: true, materialBarrier: prepared });
  }
  return { busy, savingKey, failure, togglePrepared };
}
