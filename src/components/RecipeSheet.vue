<script setup>
import FoodDetailSheet from './FoodDetailSheet.vue';
import RecipeContent from './RecipeContent.vue';
import MenuDetailActions from './MenuDetailActions.vue';
import { computed } from 'vue';
import { useFriendShare } from '../composables/useFriendShare.js';
const props = defineProps({ recipe: Object, selected: Boolean, readOnly: Boolean, busy: Boolean });
const emit = defineEmits(['close', 'add', 'share', 'edit', 'remove']);
const { busy, share } = useFriendShare(computed(() => props.readOnly ? null : { itemId: props.recipe.id, kind: 'dish' }), card => emit('share', props.recipe, card));
</script>

<template>
  <FoodDetailSheet :title="recipe.title" :image="recipe.image" kind="dish" :category="recipe.category" :minutes="recipe.minutes" :can-share="!readOnly" :sharing="busy" :busy="props.busy" :can-edit="!readOnly" :can-remove="!readOnly" @close="$emit('close')" @share="share" @edit="$emit('edit', recipe)" @remove="$emit('remove', recipe)">
    <template v-if="!readOnly" #action><MenuDetailActions :selected="selected" :busy="props.busy" @add="$emit('add', recipe)" /></template>
    <RecipeContent :recipe="recipe" :cover="false" :show-meta="false" />
  </FoodDetailSheet>
</template>
