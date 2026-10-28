<script setup>
import { computed, watch } from 'vue';
import { state } from '../store.js';
import FoodDetailSheet from './FoodDetailSheet.vue';
import RecipeContent from './RecipeContent.vue';
import MenuDetailActions from './MenuDetailActions.vue';
import AppIcon from './AppIcon.vue';
import RecipeListMeta from './RecipeListMeta.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { useFriendShare } from '../composables/useFriendShare.js';
import { useRecipeAccordion } from '../composables/useRecipeAccordion.js';
const props = defineProps({ mealSet: Object, selected: Boolean, busy: Boolean });
const emit = defineEmits(['close', 'add', 'share', 'edit', 'remove']);
const { busy, share } = useFriendShare(computed(() => ({ itemId: props.mealSet.id, kind: 'set' })), card => emit('share', props.mealSet, card));
const { expanded, scrollAnchor, recipeAnchor, toggleRecipe, resetRecipes, cancelRecipeScroll } = useRecipeAccordion();
watch(() => props.mealSet.id, resetRecipes);
const recipes = computed(() => props.mealSet.recipeIds.map((id) => state.value.recipes.find((recipe) => recipe.id === id)).filter(Boolean));
</script>

<template>
  <FoodDetailSheet :title="mealSet.title" :image="mealSet.image" kind="set" category="套餐" :dish-count="recipes.length" :scroll-anchor="scrollAnchor" can-share :sharing="busy" :busy="props.busy" can-edit can-remove @close="$emit('close')" @share="share" @edit="$emit('edit', mealSet)" @remove="$emit('remove', mealSet)">
    <template #action><MenuDetailActions :selected="selected" :busy="props.busy" @add="$emit('add', mealSet)" /></template>
    <view class="section-line"><text class="subheading">套餐搭配</text></view>
    <view v-for="(recipe, index) in recipes" :id="recipeAnchor(index)" :key="recipe.id" class="community-recipe" @touchmove="cancelRecipeScroll"><button role="button" class="recipe-expand" :aria-label="`${expanded === recipe.id ? '收起' : '查看'}${recipe.title}食材与做法`" :aria-expanded="expanded === recipe.id" @click="$feedback(); toggleRecipe(recipe.id, index)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="recipe.image" /><view class="recipe-list-copy"><text class="stock-name" :class="{ 'food-list-title': expanded !== recipe.id }">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><AppIcon :name="expanded === recipe.id ? 'minus' : 'plus'" class="expand-mark" /></button><RecipeContent v-if="expanded === recipe.id" :recipe="recipe" :cover="false" :show-meta="false" /></view>
  </FoodDetailSheet>
</template>
