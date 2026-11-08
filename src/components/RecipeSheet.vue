<script setup>
import AppIcon from './AppIcon.vue';
import FoodDetailSheet from './FoodDetailSheet.vue';
import RecipeContent from './RecipeContent.vue';
import RecipeDetailLoading from './RecipeDetailLoading.vue';
import MenuDetailActions from './MenuDetailActions.vue';
import { computed, provide } from 'vue';
import { recipeDisplaySteps } from '../domain/presentation.js';
// A detail opened over a paused feed still needs to load its own images.
provide('imageViewActive', computed(() => true));
import { useFriendShare } from '../composables/useFriendShare.js';
const props = defineProps({ recipe: Object, selected: Boolean, menuEntry: Boolean, readOnly: Boolean, busy: Boolean, loading: Boolean });
const incomplete = computed(() => !props.recipe.ingredients?.length || !recipeDisplaySteps(props.recipe.steps).length);
const emit = defineEmits(['close', 'add', 'share', 'edit', 'remove', 'supplement']);
// Prepare the cached ticket on entry; the parent opens the picker immediately.
useFriendShare(computed(() => !props.menuEntry || props.readOnly ? null : { itemId: props.recipe.id, kind: 'dish' }), card => emit('share', props.recipe, card));
</script>

<template>
  <FoodDetailSheet :compact="!loading && incomplete" :title="recipe.title" :image="recipe.image" kind="dish" :category="recipe.category" :minutes="recipe.minutes" :can-share="menuEntry && !readOnly" :busy="props.busy" :can-edit="menuEntry && !readOnly" :can-remove="menuEntry && !readOnly" @close="$emit('close')" @share="$emit('share', recipe)" @edit="$emit('edit', recipe)" @remove="$emit('remove', recipe)">
    <template v-if="!readOnly" #action><MenuDetailActions :selected="selected" :busy="props.busy" @add="$emit('add', recipe)" /></template>
    <RecipeDetailLoading v-if="loading" />
    <text v-if="!loading && recipe.sourceLabel" class="recipe-source-note">{{ recipe.sourceLabel }}</text>
    <button v-if="!loading && !readOnly && incomplete" class="recipe-supplement" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90" @click="$emit('supplement', recipe)"><view class="recipe-supplement-copy"><text class="recipe-supplement-title">食材与做法</text><text class="recipe-supplement-hint">{{ !recipe.ingredients?.length && !recipe.steps?.length ? '尚未补充，随时完善这道菜' : '补全细节，让做菜更方便' }}</text></view><view class="recipe-supplement-action"><text>去补充</text><AppIcon name="chevron" :size="14" /></view></button>
    <RecipeContent v-if="!loading" :recipe="recipe" :cover="false" :show-meta="false" :show-empty="readOnly" />
  </FoodDetailSheet>
</template>

<style scoped>
.recipe-source-note { display: block; margin: 6px 0 18px; color: var(--muted); font-size: var(--type-caption); line-height: 1.5; }
.recipe-supplement { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0 8px; border-top: 1px solid var(--line); border-radius: 0; background: transparent; color: var(--ink); font-size: var(--type-body); text-align: left; }
.recipe-supplement-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.recipe-supplement-title { font-size: var(--type-body); font-weight: 500; line-height: 1.5; }
.recipe-supplement-hint { color: var(--muted); font-size: var(--type-caption); font-weight: 400; line-height: 1.5; }
.recipe-supplement-action { display: flex; align-items: center; gap: 4px; flex-shrink: 0; color: var(--green); font-size: var(--type-meta); font-weight: 400; }
</style>
