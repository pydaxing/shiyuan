<script setup>
import { computed, watch } from 'vue';
import { state } from '../store.js';
import { formatQuantity, localDate, mealDateLabel } from '../domain/kitchen.js';
import { preparationMeals, ingredientListGroups } from '../domain/meal-preparation.js';
import Sheet from './Sheet.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import IngredientTable from './IngredientTable.vue';
const props = defineProps({ orderId: String, today: { type: String, default: localDate } });
const emit = defineEmits(['close', 'open']);
const meal = computed(() => preparationMeals(state.value, props.today).find(order => order.id === props.orderId));
const ingredients = dish => ingredientListGroups(dish.ingredients.filter(ingredient => ingredient.enabled !== false)).flatMap(group => group.items.map(item => item.ingredient));
watch(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`, () => emit('close'));
</script>
<template>
  <Sheet page title="备菜清单" variant="preparation" @close="$emit('close')">
    <template v-if="meal">
      <view class="prep-overview"><view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(meal.date, today) }}</text><text class="order-tag order-meal-tag">{{ meal.meal }}</text></view><text class="prep-dish-count">{{ meal.dishes.length }}道菜</text></view>
      <view v-for="dish in meal.dishes" :key="dish.recipe.id" class="prep-card">
        <button class="prep-dish-open" :aria-label="`查看${dish.recipe.title}的做法`" @click="$emit('open', dish.recipe)" hover-class="touch-feedback">
          <FoodThumbnail :src="dish.recipe.image" />
          <view class="prep-dish-copy"><text class="meal-ingredient-title food-list-title">{{ dish.recipe.title }}</text></view>
          <text class="prep-servings">{{ formatQuantity(dish.quantity) }}份</text>
        </button>
        <IngredientTable v-if="ingredients(dish).length" preparation :collapsed-count="ingredients(dish).length" :ingredients="ingredients(dish)" :reset-key="`${orderId}:${dish.recipe.id}`" />
        <text v-else class="muted prep-missing">这道菜还没有食材信息</text>
      </view>
    </template>
    <view v-else class="empty-state"><text class="subheading">这一餐已结束或已移除</text></view>
  </Sheet>
</template>
<style scoped>
.prep-overview { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px 12px; }
.prep-dish-count { flex-shrink: 0; color: var(--muted); font-size: var(--type-meta); line-height: 20px; }
.prep-card { padding: 12px 14px 4px; margin-bottom: 10px; border: 0; border-radius: var(--radius-card); background: var(--white); box-shadow: none; }
.prep-card:last-child { margin-bottom: 0; }
.prep-dish-open { display: flex; align-items: center; gap: 10px; width: 100%; padding: 0 0 12px; margin: 0 0 2px; min-width: 0; min-height: 44px; border-bottom: 1px solid #f0f3f3; border-radius: 0; text-align: left; background: transparent; --food-thumbnail-width: 56px; }
.prep-dish-copy { flex: 1; min-width: 0; }
.prep-servings { flex-shrink: 0; padding: 3px 7px; border-radius: var(--radius-subtle); background: var(--green-light); color: var(--green); font-size: var(--type-caption); line-height: 18px; }
.prep-missing { display: block; padding: 8px 0; }
</style>
