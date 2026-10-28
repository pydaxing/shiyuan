<script setup>
import LazyImage from './LazyImage.vue';
import RecipeCover from './RecipeCover.vue';
import { formatAmount } from '../domain/kitchen.js';
import { recipeStepTitle, stepImages } from '../domain/presentation.js';
import { previewImages } from '../services/images.js';
import { useSheetContentResize } from '../composables/useSheetSizing.js';
useSheetContentResize();
function preview(step, image) { void previewImages(stepImages(step), image); }
defineProps({ recipe: Object, cover: { type: Boolean, default: true }, showNutrition: { type: Boolean, default: true }, showMeta: { type: Boolean, default: true } });
</script>

<template>
  <view class="recipe-content">
    <RecipeCover v-if="cover" :image="recipe.image" :title="recipe.title" :category="showMeta ? recipe.category : ''" :minutes="showMeta ? recipe.minutes : null" />
    <view v-if="!cover && showMeta" class="recipe-inline-meta"><text v-if="recipe.category">{{ recipe.category }}</text><text v-if="recipe.minutes !== null && recipe.minutes !== undefined">{{ recipe.minutes }} 分钟</text></view>
    <view class="recipe-ingredients-section">
      <view class="recipe-section-heading"><text class="subheading">食材 · {{ recipe.ingredients.length }} 种</text></view>
      <view class="ingredient-list"><view v-for="(ingredient, index) in recipe.ingredients" :key="index" class="ingredient-row"><text>{{ ingredient.name }}</text><text>{{ formatAmount(ingredient.quantity, ingredient.unit, ingredient.amountText) }}</text></view></view>
    </view>
    <view class="recipe-method">
      <view class="recipe-section-heading"><text class="subheading">做法{{ recipe.steps.length ? ' · ' + recipe.steps.length + ' 步' : '' }}</text></view>
      <text v-if="!recipe.steps.length" class="recipe-method-empty muted">作者还没填写做法</text>
      <view class="recipe-method-body">
        <view v-for="(step, index) in recipe.steps" :key="index" class="recipe-step">
          <view class="recipe-step-lead"><text class="step-number" :aria-label="`第${index + 1}步`">{{ index + 1 }}</text><view class="recipe-step-copy"><text v-if="recipeStepTitle(step)" class="step-title">{{ recipeStepTitle(step) }}</text><text v-if="step.text" class="step-body">{{ step.text }}</text></view></view>
          <view v-if="stepImages(step).length" class="recipe-step-photos"><button role="button" v-for="(image, photoIndex) in stepImages(step)" :key="photoIndex" :aria-label="`查看步骤${index + 1}图片${photoIndex + 1}`" @click="preview(step, image)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><LazyImage :src="image" variant="detail" class="step-image" mode="widthFix" /></button></view>
        </view>
      </view>
    </view>
    <view v-if="showNutrition && recipe.nutrition?.trim()" class="nutrition-panel recipe-nutrition"><text class="subheading">营养疗效</text><text class="nutrition-copy">{{ recipe.nutrition }}</text></view>
  </view>
</template>
