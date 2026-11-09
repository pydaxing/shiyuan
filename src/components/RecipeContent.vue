<script setup>
import { computed } from 'vue';
import LazyImage from './LazyImage.vue';
import RecipeCover from './RecipeCover.vue';
import IngredientTable from './IngredientTable.vue';
import { recipeStepTitle, stepImages, recipeDisplaySteps } from '../domain/presentation.js';
import { previewImages } from '../services/images.js';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
useSheetContentResize();
function preview(step, image) { void previewImages(stepImages(step), image); }
const props = defineProps({ recipe: Object, showEmpty: { type: Boolean, default: true }, cover: { type: Boolean, default: true }, showNutrition: { type: Boolean, default: true }, showMeta: { type: Boolean, default: true } });
const displaySteps = computed(() => recipeDisplaySteps(props.recipe.steps));
</script>

<template>
  <view class="recipe-content">
    <RecipeCover v-if="cover" :image="recipe.image" :title="recipe.title" :category="showMeta ? recipe.category : ''" :minutes="showMeta ? recipe.minutes : null" />
    <view v-if="!cover && showMeta" class="recipe-inline-meta"><text v-if="recipe.category">{{ recipe.category }}</text><text v-if="recipe.minutes !== null && recipe.minutes !== undefined">{{ recipe.minutes }} 分钟</text></view>
    <view v-if="recipe.ingredients?.length" class="recipe-ingredients-section">
      <view class="recipe-section-heading"><text class="subheading">食材 · {{ recipe.ingredients.length }} 种</text></view>
      <IngredientTable :ingredients="recipe.ingredients" :reset-key="recipe.id" />
    </view>
    <view v-if="displaySteps.length" class="recipe-method">
      <view class="recipe-section-heading"><text class="subheading">做法{{ displaySteps.length ? ' · ' + displaySteps.length + ' 步' : '' }}</text></view>
      <text v-if="!displaySteps.length" class="recipe-method-empty muted">作者还没填写做法</text>
      <view class="recipe-method-body">
        <view v-for="(step, index) in displaySteps" :key="index" class="recipe-step">
          <view class="recipe-step-lead"><text class="step-number" :aria-label="`第${index + 1}步`">{{ index + 1 }}</text><view class="recipe-step-copy"><text v-if="recipeStepTitle(step)" class="step-title">{{ recipeStepTitle(step) }}</text></view></view><text v-if="step.text" class="step-body">{{ step.text }}</text>
          <view v-if="stepImages(step).length" class="recipe-step-photos"><button role="button" v-for="(image, photoIndex) in stepImages(step)" :key="photoIndex" :aria-label="`查看步骤${index + 1}图片${photoIndex + 1}`" @click="preview(step, image)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><LazyImage :src="image" variant="card" class="step-image" mode="widthFix" /></button></view>
        </view>
      </view>
    </view>
    <text v-if="showEmpty && !recipe.ingredients?.length && !displaySteps.length" class="recipe-method-empty muted">暂未填写食材与做法</text>
    <view v-if="showNutrition && recipe.nutrition?.trim()" class="nutrition-panel recipe-nutrition"><text class="subheading">营养疗效</text><text class="nutrition-copy">{{ recipe.nutrition }}</text></view>
  </view>
</template>
