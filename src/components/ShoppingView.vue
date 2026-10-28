<script setup>
import { computed, getCurrentInstance, onScopeDispose, ref, watch } from 'vue';
import { state, cloudStatus, removeShoppingDraft, notify } from '../store.js';
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
const dishCount = computed(() => meals.value.reduce((count, meal) => count + meal.dishes.length, 0));
const unselected = ref([]);
const selectedMeals = computed(() => meals.value.map(order => ({ ...order, dishes: order.dishes.filter(dish => isSelected(order, dish)) })).filter(order => order.dishes.length));
const selectedCount = computed(() => selectedMeals.value.reduce((count, order) => count + order.dishes.length, 0));
const expanded = ref([]);
const removing = ref('');
const removeError = ref(null);
const busy = computed(() => Boolean(cloudStatus.value.busy || removing.value));
const focus = useKitchenFocus(meals, computed(() => props.active), sheetOpen, undefined, { anchor: shoppingOrderAnchor, scope: getCurrentInstance()?.proxy, firstAtTop: true });
let revision = 0;
watch(() => props.focusOrder, request => { if (request?.id) focus.focus(request.id); }, { immediate: true });
watch(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`, () => { revision += 1; removing.value = ''; removeError.value = null; expanded.value = []; unselected.value = []; focus.cancel(); });
watch(() => props.active, active => { if (!active) expanded.value = []; });
watch(() => meals.value.flatMap(order => order.dishes.map(dish => preparationKey(order.id, dish.recipe.id))), keys => {
  expanded.value = expanded.value.filter(key => keys.includes(key));
  unselected.value = unselected.value.filter(key => keys.includes(key));
});
onScopeDispose(() => { revision += 1; });
function isSelected(order, dish) { return !unselected.value.includes(preparationKey(order.id, dish.recipe.id)); }
function mealSelection(order) {
  const count = order.dishes.filter(dish => isSelected(order, dish)).length;
  return count === 0 ? false : count === order.dishes.length ? true : 'mixed';
}
function toggleSelected(order, dish) {
  if (busy.value || !meals.value.some(entry => entry.id === order.id && entry.dishes.some(item => item.recipe.id === dish.recipe.id))) return;
  const key = preparationKey(order.id, dish.recipe.id);
  unselected.value = isSelected(order, dish) ? [...unselected.value, key] : unselected.value.filter(entry => entry !== key);
}
function toggleMeal(order) {
  if (busy.value) return;
  const current = meals.value.find(entry => entry.id === order.id);
  if (!current) return;
  const keys = current.dishes.map(dish => preparationKey(current.id, dish.recipe.id));
  unselected.value = mealSelection(current) === true ? [...unselected.value, ...keys] : unselected.value.filter(key => !keys.includes(key));
}
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
function purchase() {
  if (busy.value || !selectedCount.value) return;
  notify('接入中，敬请期待');
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
          <button role="checkbox" class="shopping-meal-select" :aria-checked="mealSelection(order)" :aria-label="`${mealSelection(order) === true ? '取消选择' : '全选'}${mealDateLabel(order.date, today)}${order.meal}的食材`" :disabled="busy" @click="toggleMeal(order)" hover-class="touch-feedback">
            <view class="shopping-select-target"><view class="shopping-select-face" :class="{ selected: mealSelection(order) !== false }"><AppIcon v-if="mealSelection(order) === true" name="check-inverse" :size="14" /><view v-else-if="mealSelection(order) === 'mixed'" class="shopping-select-mixed" /></view></view>
            <view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(order.date, today) }}</text><text class="order-tag order-meal-tag">{{ order.meal }}</text></view>
          </button>
          <text class="shopping-meal-count">{{ order.dishes.length }}道菜</text>
        </view>
        <view v-for="(dish, dishIndex) in order.dishes" :key="dish.recipe.id" class="shopping-package" :class="{ 'is-expanded': expanded.includes(preparationKey(order.id, dish.recipe.id)) }">
          <view class="shopping-package-heading">
            <button role="checkbox" class="shopping-dish-select" :aria-checked="isSelected(order, dish)" :aria-label="`${isSelected(order, dish) ? '取消选择' : '选择'}${mealDateLabel(order.date, today)}${order.meal}的${dish.recipe.title}食材`" :disabled="busy" @click="toggleSelected(order, dish)" hover-class="touch-feedback"><view class="shopping-select-face" :class="{ selected: isSelected(order, dish) }"><AppIcon v-if="isSelected(order, dish)" name="check-inverse" :size="14" /></view></button>
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
      <view v-if="active" class="selection-dock shopping-purchase"><view class="shopping-purchase-copy" role="status" aria-live="polite" :aria-label="`已选${selectedMeals.length}餐，${selectedCount}道菜`"><text class="shopping-purchase-count">{{ selectedCount }}道菜</text><text class="shopping-purchase-meta">{{ selectedMeals.length }}餐 · 按菜配齐食材 / 配料</text></view><button role="button" class="primary-button selection-submit" :disabled="busy || !selectedCount" :aria-label="`下单，已选${selectedCount}道菜`" @click="purchase" hover-class="touch-feedback"><AppIcon name="shopping-inverse" :size="18" /><text>下单</text></button></view>
    </template>
  </view>
</template>

<style scoped>
.shopping-view { --shopping-selection-width: 44px; --shopping-column-gap: 10px; }
.shopping-view.has-packages { min-height: calc(100vh - var(--page-top, 88px) - var(--nav-height) - 66px - env(safe-area-inset-bottom)); margin: -8px calc(-1 * var(--page-gutter)) 0; padding: 2px var(--page-gutter) 88px; background: var(--white); }
.shopping-meal.has-expanded-tail { padding-bottom: var(--material-card-bottom-padding); }
.shopping-meal-heading { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin: 0 0 2px; }
.shopping-meal-select { display: flex; align-items: center; gap: var(--shopping-column-gap); min-width: 0; min-height: 44px; margin: 0; padding: 0; background: transparent; }
.shopping-select-target { display: flex; align-items: center; justify-content: center; flex: 0 0 var(--shopping-selection-width); width: var(--shopping-selection-width); height: 44px; }
.shopping-dish-select { display: flex; align-items: center; align-self: center; justify-content: center; flex: 0 0 var(--shopping-selection-width); width: var(--shopping-selection-width); min-height: 44px; margin: 0; padding: 0; background: transparent; }
.shopping-select-face { display: flex; align-items: center; justify-content: center; box-sizing: border-box; width: 20px; height: 20px; border: 1.5px solid var(--border-strong); border-radius: 50%; background: var(--white); }
.shopping-select-face.selected { border-color: var(--green); background: var(--green); }
.shopping-select-mixed { width: 10px; height: 2px; border-radius: 1px; background: var(--white); }
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
.shopping-package-ingredients { min-width: 0; margin-top: 10px; margin-left: calc(var(--shopping-selection-width) + var(--shopping-column-gap)); padding: 0; }
.shopping-remove { display: flex; align-items: center; align-self: center; justify-content: center; flex: 0 0 44px; width: 44px; min-height: 44px; margin: 0 -6px 0 0; padding: 0; background: transparent; }
.shopping-purchase { height: auto; }
.shopping-purchase-copy { flex: 1; min-width: 0; }
.shopping-purchase-count { display: block; font-size: var(--type-body); font-weight: 600; line-height: 20px; }
.shopping-purchase-meta { display: block; margin-top: 3px; font-size: var(--type-caption); color: var(--muted); line-height: 16px; }
.shopping-empty { min-height: calc(100vh - var(--page-top, 88px) - 230px); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 0 50px; text-align: center; }
.shopping-empty-button { margin: 0; gap: 7px; padding: 0 20px; border-radius: var(--radius-control); }
@media (max-width: 360px) { .shopping-dish-image { --food-thumbnail-width: 72px; } }
</style>
