<script setup>
import { computed, ref, watch } from 'vue';
import { formatAmount } from '../domain/kitchen.js';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
const props = defineProps({ ingredients: { type: Array, default: () => [] }, resetKey: String, preparation: Boolean, collapsedCount: { type: Number, default: 5 } });
const expanded = ref(false);
const canExpand = computed(() => props.ingredients.length > props.collapsedCount);
const visibleIngredients = computed(() => expanded.value ? props.ingredients : props.ingredients.slice(0, props.collapsedCount + 2));
watch(() => props.resetKey, () => { expanded.value = false; });
useSheetContentResize();
</script>
<template>
  <view class="ingredient-table" :class="{ 'is-preparation-table': preparation }">
    <view class="ingredient-list" :class="{ 'ingredient-list-folded': canExpand && !expanded }">
      <view v-for="(ingredient, index) in visibleIngredients" :key="index" class="ingredient-row" :class="{ 'ingredient-row-peek': !expanded && index >= collapsedCount, 'ingredient-row-peek-start': !expanded && index === collapsedCount }" :aria-hidden="!expanded && index >= collapsedCount">
        <text class="ingredient-name">{{ ingredient.name }}</text>
        <text class="ingredient-amount">{{ formatAmount(ingredient.quantity, ingredient.unit, ingredient.amountText) }}</text>
      </view>
    </view>
    <button v-if="canExpand" class="recipe-disclosure" :class="{ 'recipe-disclosure-fade': !expanded }" :aria-expanded="expanded" @click="expanded = !expanded" hover-class="touch-feedback"><text>{{ expanded ? '收起食材' : '展开全部' }}</text><view class="disclosure-chevron" :class="{ 'is-expanded': expanded }" /></button>
  </view>
</template>
<style scoped>
.ingredient-table .ingredient-list { border: 1px solid var(--line); }
.ingredient-table .ingredient-row { align-items: flex-start; gap: 16px; }
.ingredient-table .ingredient-row .ingredient-name { flex: 1; min-width: 0; }
.ingredient-table .ingredient-row .ingredient-amount { max-width: 52%; text-align: right; overflow-wrap: anywhere; }
.is-preparation-table .ingredient-list { padding: 0; background: var(--white); border: 0; border-radius: 0; }
.is-preparation-table .ingredient-row { border-bottom-width: 0.5px; border-color: #f0f3f3; }
.is-preparation-table .ingredient-row .ingredient-amount { color: var(--green); font-weight: 500; font-variant-numeric: tabular-nums; }
.is-preparation-table .ingredient-row-peek { height: 30px; }
.is-preparation-table .ingredient-row-peek-start:last-child { height: 60px; }
.is-preparation-table .recipe-disclosure-fade { margin-top: -60px; min-height: 60px; padding-top: 14px; }
</style>
