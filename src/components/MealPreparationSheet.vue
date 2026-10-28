<script setup>
import { computed, ref, watch } from 'vue';
import { state } from '../store.js';
import { formatQuantity, localDate, mealDateLabel } from '../domain/kitchen.js';
import { preparationMeals } from '../domain/meal-preparation.js';
import { shoppingCartMeals } from '../domain/meal-shopping.js';
import { usePreparationAutosave } from '../composables/usePreparationAutosave.js';
import { usePreparationActions } from '../composables/usePreparationActions.js';
import { useDishPackageActions } from '../composables/useDishPackageActions.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import Sheet from './Sheet.vue';
import AppIcon from './AppIcon.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import DishReadyButton from './DishReadyButton.vue';
import DishPreparationEditor from './DishPreparationEditor.vue';

const props = defineProps({ orderId: String, today: { type: String, default: localDate } });
const emit = defineEmits(['close', 'open', 'shopping']);
const meal = computed(() => preparationMeals(state.value, props.today).find(order => order.id === props.orderId));
const cartMeal = computed(() => shoppingCartMeals(state.value, props.today).find(order => order.id === props.orderId));
const cartCount = computed(() => cartMeal.value?.dishes.length || 0);
const expanded = ref([]);
const opened = ref([]);
const editorStates = ref({});
const autosave = usePreparationAutosave();
const { togglePrepared } = usePreparationActions();
const { togglePackage } = useDishPackageActions();
const pending = dish => autosave.peek(props.orderId, dish.recipe.id)?.actionBusy || '';
const actionError = dish => autosave.peek(props.orderId, dish.recipe.id)?.actionError?.message || '';
const inCart = dish => Boolean(state.value.orders.find(order => order.id === props.orderId)?.shoppingDrafts?.some(entry => entry.recipeId === dish.recipe.id));
function toggleIngredients(dish) {
  dismissFocusedKeyboard();
  if (!opened.value.includes(dish.recipe.id)) opened.value.push(dish.recipe.id);
  expanded.value = expanded.value.includes(dish.recipe.id) ? expanded.value.filter(id => id !== dish.recipe.id) : [...expanded.value, dish.recipe.id];
  void autosave.dispatch(props.orderId, dish.recipe.id);
}
function updateEditor(recipeId, status) { editorStates.value[recipeId] = status; }
function close() {
  for (const dish of meal.value?.dishes || []) void autosave.dispatch(props.orderId, dish.recipe.id);
  emit('close');
}
async function markPrepared(dish) {
  if (!meal.value) return;
  dismissFocusedKeyboard();
  await togglePrepared(meal.value, dish);
}
async function purchaseDish(dish) {
  if (!meal.value) return;
  dismissFocusedKeyboard();
  await togglePackage(meal.value.id, dish.recipe.id);
}
function openShopping() { emit('shopping', props.orderId); }
watch(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`, () => { editorStates.value = {}; emit('close'); });
watch(() => props.orderId, () => { editorStates.value = {}; opened.value = []; expanded.value = []; });
watch(() => meal.value?.dishes.map(dish => dish.recipe.id).join(':'), () => {
  const ids = meal.value?.dishes.map(dish => dish.recipe.id) || [];
  editorStates.value = Object.fromEntries(Object.entries(editorStates.value).filter(([id]) => ids.includes(id)));
  opened.value = opened.value.filter(id => ids.includes(id));
  expanded.value = expanded.value.filter(id => ids.includes(id));
});
</script>

<template>
  <Sheet title="本餐备菜" variant="preparation" :preferred-height="820" @close="close">
    <template v-if="meal">
      <view class="prep-overview">
        <view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(meal.date, today) }}</text><text class="order-tag order-meal-tag">{{ meal.meal }}</text></view>
        <text class="prep-count" role="status">{{ meal.preparedCount }}/{{ meal.dishes.length }} 道已备齐</text>
      </view>
      <view v-for="(dish, index) in meal.dishes" :key="dish.recipe.id" class="prep-card" :class="{ 'is-prepared': dish.prepared, 'is-expanded': expanded.includes(dish.recipe.id) }">
        <view class="prep-card-heading">
          <button role="button" class="prep-dish-open" :aria-label="`查看${dish.recipe.title}的做法`" @click="$emit('open', dish.recipe)" hover-class="touch-feedback">
            <FoodThumbnail :src="dish.recipe.image" />
            <view class="prep-dish-copy"><text class="meal-ingredient-title food-list-title">{{ dish.recipe.title }}</text><text class="prep-servings">{{ formatQuantity(dish.quantity) }}份 · 食材 / 配料 {{ autosave.peek(orderId, dish.recipe.id)?.ingredients.length ?? dish.ingredients.length }}项</text></view>
          </button>
        </view>
        <view class="prep-card-toolbar">
          <button role="button" class="prep-disclosure" :class="{ expanded: expanded.includes(dish.recipe.id) }" :aria-label="`按需调整${dish.recipe.title}的本餐食材与配料，仅修改本餐`" :aria-expanded="expanded.includes(dish.recipe.id)" :aria-controls="`prep-ingredients-${index}`" @click="toggleIngredients(dish)" hover-class="touch-feedback"><text class="prep-adjust-label">按需调整</text><view class="prep-disclosure-chevron"><AppIcon name="detail-collapse" :size="14" /></view></button>
          <view class="prep-card-actions">
            <view class="prep-ready-action"><DishReadyButton :prepared="dish.prepared" :busy="pending(dish) === 'prepared'" :disabled="Boolean(pending(dish))" :label="`${dish.recipe.title}，${dish.prepared ? '食材已备齐，点击取消备齐' : '标记食材已备齐'}`" @toggle="markPrepared(dish)" /></view>
            <button role="button" class="prep-cart-button primary-button" :class="{ 'is-added': inCart(dish), 'is-disabled': Boolean(pending(dish)) || dish.prepared }" :disabled="Boolean(pending(dish)) || dish.prepared" :aria-busy="pending(dish) === 'package'" :aria-pressed="inCart(dish)" :aria-label="`${dish.recipe.title}，${inCart(dish) ? '已加购，点击取消加购' : dish.prepared ? '已备齐，取消备齐后可加购' : '加购整份食材包，继续备菜'}`" @click="purchaseDish(dish)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon :name="inCart(dish) ? 'shopping' : 'shopping-inverse'" :active="inCart(dish)" :size="16" /><text>{{ inCart(dish) ? '已加购' : '加购' }}</text></button>
          </view>
        </view>
        <text v-if="actionError(dish)" class="field-error" role="alert">{{ actionError(dish) }}</text>
        <view v-if="opened.includes(dish.recipe.id)" v-show="expanded.includes(dish.recipe.id)" :id="`prep-ingredients-${index}`" class="prep-ingredients">
          <DishPreparationEditor :order-id="orderId" :recipe-id="dish.recipe.id" :today="today" @state-change="updateEditor(dish.recipe.id, $event)" />
        </view>
      </view>
    </template>
    <view v-else class="empty-state"><text class="subheading">这一餐已结束或已移除</text></view>
    <template #footer>
      <button role="button" class="prep-footer-button primary-button" :aria-label="`去采购，本餐已加购${cartCount}份食材`" @click="openShopping" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <view class="prep-cart-icon"><AppIcon name="shopping-inverse" :size="18" /><text v-if="cartCount > 0" class="prep-cart-count nav-count" :class="{ 'is-overflow': cartCount > 99 }" role="status" :aria-label="`本餐已加购${cartCount}份食材`">{{ cartCount > 99 ? '99+' : cartCount }}</text></view>
        <text>去采购</text>
      </button>
    </template>
  </Sheet>
</template>

<style scoped>
.prep-overview { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 4px 14px; }
.prep-count { color: var(--muted); font-size: var(--type-meta); white-space: nowrap; }
.prep-card { padding: var(--panel-padding); margin-bottom: 12px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--white); box-shadow: none; }
.prep-card.is-expanded { padding-bottom: var(--material-card-bottom-padding); }
.prep-card-heading { display: flex; align-items: center; gap: 8px; }
.prep-dish-open { display: flex; align-items: flex-start; gap: 10px; flex: 1; min-width: 0; padding: 0; margin: 0; text-align: left; background: transparent; --food-thumbnail-width: 76px; }
.prep-dish-copy { flex: 1; min-width: 0; }
.prep-servings { display: block; margin-top: 4px; color: var(--muted); font-size: var(--type-caption); line-height: 18px; }
.prep-card-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.prep-disclosure { display: flex; flex: 1; gap: 6px; align-items: center; min-width: 72px; min-height: 44px; margin: 0; padding: 0; text-align: left; background: transparent; color: var(--muted); font-size: var(--type-meta); white-space: nowrap; }
.prep-adjust-label { color: var(--green); }
.prep-disclosure-chevron { display: flex; flex-shrink: 0; transition: transform 160ms ease; }
.prep-disclosure.expanded .prep-disclosure-chevron { transform: rotate(180deg); }
.prep-card-actions { display: flex; flex: 0 0 auto; align-items: stretch; justify-content: flex-end; gap: 8px; margin-left: auto; }
.prep-ingredients { margin-top: 12px; }
.prep-ready-action { flex: 0 0 96px; min-width: 0; }
.prep-cart-button { flex: 0 0 96px; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; margin: 0; padding: 0 10px; border: 0; border-radius: var(--radius-control); font-size: var(--type-control); line-height: 22px; }
.prep-cart-button.is-disabled { background: var(--green); color: var(--white); }
.prep-cart-button.is-added, .prep-cart-button.is-added.is-disabled { background: var(--green-light); color: var(--green); }
.prep-footer-button { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-height: 44px; margin: 0; padding: 0 16px; border: 0; border-radius: var(--radius-control); font-size: var(--type-control); }
.prep-cart-icon { position: relative; display: flex; align-items: center; justify-content: center; flex: 0 0 24px; width: 24px; height: 24px; }
.prep-cart-count { top: -8px; right: -10px; border: 2px solid var(--green); font-weight: 500; }
@media (max-width: 360px) { .prep-dish-open { --food-thumbnail-width: 68px; gap: 10px; } .prep-card { padding: 12px 10px; } .prep-card-actions { gap: 8px; } .prep-disclosure { gap: 5px; } }
@media (prefers-reduced-motion: reduce) { .prep-disclosure-chevron { transition: none; } }
</style>
