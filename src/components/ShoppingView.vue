<script setup>
import { computed, getCurrentInstance, onScopeDispose, ref, watch } from 'vue';
import { state, cloudStatus, removeShoppingDraft } from '../store.js';
import { formatQuantity, localDate, mealDateLabel } from '../domain/kitchen.js';
import { preparationKey, shoppingOrderAnchor } from '../domain/meal-preparation.js';
import { shoppingCartMeals } from '../domain/meal-shopping.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { useKitchenFocus } from '../composables/useKitchenFocus.js';
import { sheetOpen } from '../composables/sheetStack.js';
import { presentMutation } from '../services/mutation-feedback.js';
import FoodThumbnail from './FoodThumbnail.vue';
import PageHeader from './PageHeader.vue';
import AppIcon from './AppIcon.vue';
import MealIngredientList from './MealIngredientList.vue';

const props = defineProps({ embedded: Boolean, active: { type: Boolean, default: true }, today: { type: String, default: localDate }, focusOrder: { type: Object, default: null } });
defineEmits(['open', 'discover']);
const meals = computed(() => shoppingCartMeals(state.value, props.today));
const expanded = ref([]);
const removing = ref('');
const removeError = ref(null);
const busy = computed(() => Boolean(cloudStatus.value.busy || removing.value));
const focus = useKitchenFocus(meals, computed(() => props.active), sheetOpen, undefined, { anchor: shoppingOrderAnchor, scope: getCurrentInstance()?.proxy, firstAtTop: true });
let revision = 0;
watch(() => props.focusOrder, request => { if (request?.id) focus.focus(request.id); }, { immediate: true });
watch(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`, () => { revision += 1; removing.value = ''; removeError.value = null; expanded.value = []; focus.cancel(); });
watch(() => props.active, active => { if (!active) expanded.value = []; });
watch(() => meals.value.flatMap(order => order.dishes.map(dish => preparationKey(order.id, dish.recipe.id))), keys => {
  expanded.value = expanded.value.filter(key => keys.includes(key));
});
onScopeDispose(() => { revision += 1; });
function toggleIngredients(order, dish) {
  const key = preparationKey(order.id, dish.recipe.id);
  expanded.value = expanded.value.includes(key) ? expanded.value.filter(entry => entry !== key) : [...expanded.value, key];
}
function hasExpandedTail(order) {
  const lastDish = order.dishes[order.dishes.length - 1];
  return Boolean(lastDish && expanded.value.includes(preparationKey(order.id, lastDish.recipe.id)));
}
async function remove(order, dish) {
  if (busy.value) return;
  const request = ++revision;
  const key = preparationKey(order.id, dish.recipe.id);
  removing.value = key;
  removeError.value = null;
  try {
    const confirmed = await new Promise(resolve => uni.showModal({ title: '移除待买食材包？', content: `只移除「${dish.recipe.title}」这次要买的食材，不删除餐单，也不会标记已备齐。`, confirmText: '移除', cancelText: '保留', confirmColor: NATIVE_UI_COLORS.danger, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
    if (!confirmed || request !== revision) return;
    await presentMutation(removeShoppingDraft(order.id, dish.recipe.id, dish.shoppingSignature), () => {
      if (request === revision) removing.value = '';
    });
  } catch (error) { if (request === revision) removeError.value = { key, message: error?.message || '移除失败，请重试' }; }
  finally { if (request === revision) removing.value = ''; }
}
</script>

<template>
  <view class="shopping-view" :class="{ 'has-packages': meals.length }">
    <PageHeader v-if="!embedded" title="采购" />
    <view v-if="!meals.length" class="shopping-empty" aria-label="没有待买食材">
      <view class="shopping-empty-art supplies-empty-art"><AppIcon name="shopping" :size="50" /></view>
      <button role="button" class="secondary-button shopping-empty-button" @click="$emit('discover')" hover-class="touch-feedback"><AppIcon name="community" :size="18" /><text>看看美食</text></button>
    </view>
    <template v-else>
      <view v-for="(order, orderIndex) in meals" :id="shoppingOrderAnchor(orderIndex)" :key="order.id" class="order-card shopping-meal" :class="{ 'has-expanded-tail': hasExpandedTail(order) }">
        <view class="shopping-meal-heading">
          <view class="shopping-meal-info"><view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(order.date, today) }}</text><text class="order-tag order-meal-tag">{{ order.meal }}</text></view></view>
          <text class="shopping-meal-count">{{ order.dishes.length }}道菜</text>
        </view>
        <view v-for="(dish, dishIndex) in order.dishes" :key="dish.recipe.id" class="shopping-package" :class="{ 'is-expanded': expanded.includes(preparationKey(order.id, dish.recipe.id)) }">
          <view class="shopping-package-heading">
            <button role="button" class="shopping-dish-image" :aria-label="`查看${dish.recipe.title}的做法`" @click="$emit('open', dish.recipe)" hover-class="touch-feedback"><FoodThumbnail :src="dish.recipe.image" /></button>
            <view class="shopping-dish-copy">
              <button role="button" class="shopping-dish-open" :aria-label="`查看${dish.recipe.title}的做法`" @click="$emit('open', dish.recipe)" hover-class="touch-feedback"><text class="meal-ingredient-title food-list-title">{{ dish.recipe.title }}</text></button>
              <button role="button" class="shopping-package-disclosure" :class="{ expanded: expanded.includes(preparationKey(order.id, dish.recipe.id)) }" :aria-label="`${dish.recipe.title}，${expanded.includes(preparationKey(order.id, dish.recipe.id)) ? '收起' : '查看'}食材配料`" :aria-expanded="expanded.includes(preparationKey(order.id, dish.recipe.id))" :aria-controls="`shopping-ingredients-${orderIndex}-${dishIndex}`" @click="toggleIngredients(order, dish)" hover-class="touch-feedback"><text class="shopping-package-meta">{{ formatQuantity(dish.quantity) }}份 · {{ dish.purchaseIngredients.length }}项食材 / 配料</text><view class="shopping-package-chevron"><AppIcon name="detail-collapse" :size="14" /></view></button>
            </view>
            <button role="button" class="shopping-remove" :aria-label="`移除${dish.recipe.title}的待买食材包`" :disabled="busy" :aria-busy="removing === preparationKey(order.id, dish.recipe.id)" @click="remove(order, dish)" hover-class="touch-feedback"><AppIcon name="trash" :size="17" /></button>
          </view>
          <view v-if="expanded.includes(preparationKey(order.id, dish.recipe.id))" :id="`shopping-ingredients-${orderIndex}-${dishIndex}`" class="shopping-package-ingredients"><MealIngredientList :ingredients="dish.purchaseIngredients" /></view>
          <text v-if="removeError?.key === preparationKey(order.id, dish.recipe.id)" class="field-error" role="alert">{{ removeError.message }}</text>
        </view>
      </view>
    </template>
  </view>
</template>

<style scoped>
.shopping-view { --shopping-column-gap: 10px; }
.shopping-view.has-packages { min-height: calc(100vh - var(--page-top, 88px) - var(--nav-height) - 24px - env(safe-area-inset-bottom)); margin: -8px calc(-1 * var(--page-gutter)) 0; padding: 2px var(--page-gutter) 24px; background: var(--white); }
.shopping-meal.has-expanded-tail { padding-bottom: var(--material-card-bottom-padding); }
.shopping-meal-heading { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: 0 0 2px; }
.shopping-meal-info { display: flex; align-items: center; min-width: 0; min-height: 44px; }
.shopping-meal-count { color: var(--muted); font-size: var(--type-caption); white-space: nowrap; }
.shopping-package { padding: 8px 0; margin: 0; border: 0; border-radius: 0; background: var(--white); }
.shopping-package.is-expanded:last-child { padding-bottom: 0; }
.shopping-package-heading { display: flex; gap: var(--shopping-column-gap); align-items: flex-start; }
.shopping-dish-image { display: flex; align-items: center; flex-shrink: 0; min-height: 44px; margin: 0; padding: 0; background: transparent; --food-thumbnail-width: 80px; }
.shopping-dish-open { display: flex; align-items: flex-start; width: 100%; min-width: 0; min-height: 24px; margin: 0; padding: 0; background: transparent; text-align: left; }
.shopping-dish-open .meal-ingredient-title { line-height: 20px; }
.shopping-dish-copy { display: flex; flex-direction: column; flex: 1; gap: 2px; min-width: 0; }
.shopping-package-meta { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: var(--type-caption); line-height: 1.5; }
.shopping-package-disclosure { display: flex; align-items: center; gap: 4px; width: 100%; min-width: 0; min-height: 24px; margin: 0; padding: 0; background: transparent; text-align: left; }
.shopping-package-chevron { display: flex; flex-shrink: 0; }
.shopping-package-disclosure.expanded .shopping-package-chevron { transform: rotate(180deg); }
.shopping-package-ingredients { min-width: 0; margin-top: 10px; margin-left: 0; padding: 0; }
.shopping-remove { display: flex; align-items: center; align-self: center; justify-content: center; flex: 0 0 44px; width: 44px; min-height: 44px; margin: 0 -6px 0 0; padding: 0; background: transparent; }
.shopping-empty { min-height: calc(100vh - var(--page-top, 88px) - 230px); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 0 50px; text-align: center; }
.shopping-empty-button { margin: 0; gap: 7px; padding: 0 20px; border-radius: var(--radius-control); }
@media (max-width: 360px) { .shopping-dish-image { --food-thumbnail-width: 72px; } }
</style>
