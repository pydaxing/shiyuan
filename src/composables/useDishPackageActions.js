import { computed } from 'vue';
import { state, saveShoppingDraft, removeShoppingDraft } from '../store.js';
import { preparationKey, preparationMeals } from '../domain/meal-preparation.js';
import { normalizeShoppingDraft, shoppingEditSignature, wholeDishShoppingDraft } from '../domain/meal-shopping.js';
import { usePreparationAutosave } from './usePreparationAutosave.js';

export function useDishPackageActions() {
  const autosave = usePreparationAutosave();
  const addingKey = computed(() => {
    const entry = autosave.entries().find(entry => entry.actionBusy === 'package');
    return entry ? preparationKey(entry.orderId, entry.recipeId) : '';
  });
  const failure = computed(() => autosave.entries().find(entry => entry.actionError?.kind === 'package')?.actionError || null);
  const busy = computed(() => Boolean(addingKey.value));

  async function togglePackage(orderId, recipeId) {
    const adding = !state.value.orders.find(entry => entry.id === orderId)?.shoppingDrafts?.some(entry => entry.recipeId === recipeId);
    return autosave.act(orderId, recipeId, 'package', async (barrier, present) => {
      const order = state.value.orders.find(entry => entry.id === orderId);
      const dish = preparationMeals(state.value).find(entry => entry.id === orderId)?.dishes.find(entry => entry.recipe.id === recipeId);
      if (!dish) throw new Error('这一餐已结束或菜品已移除，请重新查看');
      const existing = order.shoppingDrafts?.find(entry => entry.recipeId === recipeId);
      if (!adding) {
        if (existing) await present(removeShoppingDraft(orderId, recipeId, shoppingEditSignature(order, recipeId)));
        return true;
      }
      if (dish.prepared) throw new Error('食材已备齐，需要采购时请先取消已备齐');
      const draft = wholeDishShoppingDraft(dish);
      if (existing?.sourceSignature === dish.signature && JSON.stringify(normalizeShoppingDraft(existing)) === JSON.stringify(draft)) return true;
      await present(saveShoppingDraft(orderId, recipeId, draft, shoppingEditSignature(order, recipeId)));
      return true;
    }, { immediate: true, materialBarrier: adding });
  }

  return { busy, addingKey, failure, togglePackage };
}
