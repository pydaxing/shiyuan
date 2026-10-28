<script setup>
import { computed } from 'vue';
import { formatQuantity, hasTextAmount } from '../domain/kitchen.js';
import { ingredientListGroups } from '../domain/meal-preparation.js';

const props = defineProps({ ingredients: { type: Array, default: () => [] } });
const entries = computed(() => ingredientListGroups(props.ingredients).flatMap(group => group.items));
const amount = ingredient => hasTextAmount(ingredient) ? ingredient.amountText : `${formatQuantity(ingredient.quantity)} ${ingredient.unit}`;
</script>

<template>
  <view class="meal-material-list">
    <view v-if="entries.length" class="meal-material-header"><text>食材 / 配料</text><text>用量</text></view>
    <view class="meal-material-items" role="list" aria-label="食材和配料">
      <view v-for="entry in entries" :key="entry.ingredient.key || entry.index" class="meal-material-item" :class="{ 'is-disabled': entry.ingredient.enabled === false }" role="listitem">
        <text class="meal-material-name">{{ entry.ingredient.name }}</text>
        <text class="meal-material-amount" :class="{ 'quantity-zero': !hasTextAmount(entry.ingredient) && Number(entry.ingredient.quantity) === 0 }">{{ amount(entry.ingredient) }}</text>
      </view>
    </view>
  </view>
</template>

