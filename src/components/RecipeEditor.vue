<script setup>
import AppIcon from './AppIcon.vue';
import FormField from './FormField.vue';
import FieldError from './FieldError.vue';
import { computed, nextTick, ref } from 'vue';
import Sheet from './Sheet.vue';
import ImagePicker from './ImagePicker.vue';
import StepImagePicker from './StepImagePicker.vue';
import SelectField from './SelectField.vue';
import { CATEGORIES, SELECTABLE_UNITS, MAX_RECIPE_STEPS, clone, recipeFieldErrors, hasTextAmount } from '../domain/kitchen.js';
import { cleanSteps, stepImages, DEFAULT_DISH_COVER } from '../domain/presentation.js';
import { saveRecipe } from '../store.js';
import { presentMutation } from '../services/mutation-feedback.js';

const emit = defineEmits(['close', 'saved']);
const props = defineProps({ recipe: Object, initialCategory: String, expandDetails: Boolean });
const sheet = ref(null);
const detailsOpen = ref(Boolean(props.expandDetails));
const title = ref(props.recipe?.title || '');
const category = ref(props.recipe?.category || (CATEGORIES.includes(props.initialCategory) ? props.initialCategory : '荤菜'));
const minutes = ref(String(props.recipe?.minutes ?? 20));
const image = ref(props.recipe?.image || '');
const nutrition = ref(props.recipe?.nutrition || '');
const newIngredient = () => ({ name: '', quantity: null, unit: '', amountText: '适量' });
const ingredients = ref(props.recipe ? clone(props.recipe.ingredients || []) : []);
const ingredientAmountPresets = ['适量', '少许'];
const ingredientUnitOptions = [...ingredientAmountPresets, ...SELECTABLE_UNITS.filter(unit => unit !== '汤匙').map(unit => unit === '茶匙' ? '匙' : unit)];
const ingredientInputs = ref(new Map());
let ingredientId = 0;
function registerIngredient(ingredient) {
  const spoonAmount = ingredient.amountText?.trim().match(/^(\d+(?:\.\d+)?)\s*匙$/);
  if (hasTextAmount(ingredient) && spoonAmount) { ingredient.quantity = Number(spoonAmount[1]); ingredient.unit = '匙'; delete ingredient.amountText; }
  const amountText = hasTextAmount(ingredient) ? ingredient.amountText.trim() : '';
  const unit = hasTextAmount(ingredient) ? (ingredientAmountPresets.includes(amountText) ? amountText : '原用量') : ingredient.unit;
  ingredientInputs.value.set(ingredient, { id: ++ingredientId, unit });
}
ingredients.value.forEach(registerIngredient);
const ingredientInput = ingredient => ingredientInputs.value.get(ingredient);
let stepId = 0;
const newStep = () => ({ id: ++stepId, title: '', text: '', images: [] });
const steps = ref(props.recipe ? (props.recipe.steps || []).map((step) => ({ ...clone(step), images: [...stepImages(step)], id: ++stepId })) : []);
const busyImages = ref(0);
const error = ref('');
const saving = ref(false);
const submitted = ref(false);
const fieldRefs = {};
const draft = computed(() => ({ title: title.value, category: category.value, servings: props.recipe?.servings || 2, minutes: String(minutes.value).trim() === '' ? 20 : minutes.value, image: image.value, ...(props.recipe?.guideImage ? { guideImage: props.recipe.guideImage } : {}), ...(props.recipe?.provenance ? { provenance: props.recipe.provenance } : {}), nutrition: nutrition.value, ingredients: ingredients.value, steps: cleanSteps(steps.value) }));
const fieldErrors = computed(() => submitted.value ? recipeFieldErrors({ ...draft.value, steps: steps.value }, { requireStepTitles: true, requireCover: true }) : {});
function changeIngredientUnit(ingredient, unit) {
  const input = ingredientInput(ingredient);
  if (!input || input.unit === unit || !ingredientUnitOptions.includes(unit)) return;
  if (ingredientAmountPresets.includes(unit)) {
    ingredient.amountText = unit;
    ingredient.quantity = null;
    ingredient.unit = '';
  } else {
    if (hasTextAmount(ingredient)) ingredient.quantity = '';
    delete ingredient.amountText;
    ingredient.unit = unit;
  }
  input.unit = unit;
}
function addIngredient() {
  if (ingredients.value.length >= 30) return;
  ingredients.value.push(newIngredient());
  registerIngredient(ingredients.value[ingredients.value.length - 1]);
}
function removeIngredient(index) {
  ingredientInputs.value.delete(ingredients.value[index]);
  ingredients.value.splice(index, 1);
}
function moveStep(index, change) {
  const target = index + change;
  if (busyImages.value > 0 || index < 0 || index >= steps.value.length || target < 0 || target >= steps.value.length) return;
  const reordered = [...steps.value];
  const [step] = reordered.splice(index, 1);
  reordered.splice(target, 0, step);
  steps.value = reordered;
}
async function save() {
  if (saving.value || busyImages.value > 0) return;
  error.value = '';
  submitted.value = true;
  const invalidField = Object.keys(fieldErrors.value)[0];
  if (invalidField) {
    if (/^(ingredients|steps)/.test(invalidField)) detailsOpen.value = true;
    nextTick(() => fieldRefs[invalidField]?.reveal());
    return;
  }
  saving.value = true;
  try {
    await presentMutation(saveRecipe(draft.value, props.recipe?.id), () => emit('saved', { category: category.value }));
  } catch (failure) { error.value = failure.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <Sheet ref="sheet" page variant="menu-editor" :title="recipe ? '编辑菜品' : '创建菜品'" @close="!saving && busyImages === 0 && $emit('close')">
    <view class="menu-editor-body">
    <view class="editor-list-section editor-cover-section">
    <ImagePicker v-model="image" :fallback="DEFAULT_DISH_COVER" label="拍照/相册" :caption-error="Boolean(fieldErrors.image)" :caption="fieldErrors.image ? '请添加封面' : '拍照/相册'" inline-crop :disabled="saving" @busy="busyImages += $event ? 1 : -1" />
    <view class="editor-validation-accessible"><FieldError :ref="field => fieldRefs.image = field" :error="fieldErrors.image" /></view>
    <view class="field-label editor-title-field" @click.stop>
      <text class="subheading">菜名<text class="editor-required-mark" aria-hidden="true">*</text></text>
      <FormField :ref="field => fieldRefs.title = field" v-model="title" :error="fieldErrors.title" field-class="input" :placeholder-style="fieldErrors.title ? 'color: var(--danger)' : ''" :placeholder="fieldErrors.title ? '请输入菜名' : '给拿手菜起个名字'" maxlength="30" aria-label="菜名" />
    </view>
    </view>
    <view class="editor-list-section editor-meta-section">
    <view class="form-grid recipe-meta-fields">
      <view class="field-label category-list-field">
        <SelectField :ref="field => fieldRefs.category = field" v-model="category" :error="fieldErrors.category" inline inline-list inline-pills variant="categories" :options="CATEGORIES" label="选择菜品分类">
          <template #leading><text class="subheading">分类<text class="editor-required-mark" aria-hidden="true">*</text></text></template>
        </SelectField>
      </view>
      <view class="field-label" @click.stop>
        <view class="recipe-field-heading"><text class="subheading">耗时 / 分钟</text></view>
        <FormField :ref="field => fieldRefs.minutes = field" v-model="minutes" :error="fieldErrors.minutes" field-class="input" type="number" placeholder="20" aria-label="耗时分钟（选填）" />
      </view>
    </view>
    </view>
    <view class="editor-list-section editor-details-heading">
      <button class="editor-details-toggle" role="button" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90" :aria-expanded="detailsOpen" @click="detailsOpen = !detailsOpen">
        <view class="editor-details-copy"><text class="subheading">食材与做法</text><text class="editor-details-hint">选填.发布到美食时需补全</text></view>
        <AppIcon name="chevron" :class="{ 'editor-details-expanded': detailsOpen }" :size="16" />
      </button>
    </view>
    <view v-show="detailsOpen">
    <view class="editor-list-section editor-ingredients-section">
    <view class="section-line"><text class="subheading">食材/配料</text><text class="editor-section-count">{{ ingredients.length }} 种</text></view>
    <view class="editor-ingredient-table">
    <FieldError :ref="field => fieldRefs.ingredients = field" :error="fieldErrors.ingredients" />
    <view v-for="(ingredient, index) in ingredients" :key="ingredientInput(ingredient).id" class="ingredient-editor" :class="{ 'text-amount-editor': hasTextAmount(ingredient) }">
      <SelectField class="ingredient-unit-field" :row-layout="hasTextAmount(ingredient) ? 'text' : 'numeric'" :ref="field => { fieldRefs[`ingredients.${index}.unit`] = field; fieldRefs[`ingredients.${index}.amountText`] = field; }" :error="fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`]" :model-value="ingredientInput(ingredient).unit" centered inline inline-list inline-pills variant="units" :options="ingredientUnitOptions" :label="`食材${index + 1}用量`" @update:model-value="changeIngredientUnit(ingredient, $event)" >
        <template #leading>
      <FormField class="ingredient-name-field" :ref="field => fieldRefs[`ingredients.${index}.name`] = field" v-model="ingredient.name" :error="fieldErrors[`ingredients.${index}.name`]" variant="inline-validation" field-class="input" :placeholder-style="fieldErrors[`ingredients.${index}.name`] ? 'color: var(--danger)' : ''" :placeholder="fieldErrors[`ingredients.${index}.name`] ? '请输入食材名称' : '名称'" :aria-label="`食材${index + 1}名称`" maxlength="30" />
        </template>
        <template #quantity>
      <FormField class="ingredient-quantity-field" v-if="!hasTextAmount(ingredient)" :ref="field => fieldRefs[`ingredients.${index}.quantity`] = field" v-model="ingredient.quantity" :error="fieldErrors[`ingredients.${index}.quantity`]" field-class="input" type="digit" placeholder="数量" :aria-label="`食材${index + 1}数量`" />
        </template>
        <template #trailing>
      <button role="button" class="icon-button" :aria-label="`删除食材${index + 1}`" @click="removeIngredient(index)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="20" /></button>
        </template>
      </SelectField>
      <text v-if="ingredientInput(ingredient).unit === '原用量'" class="ingredient-original-amount">原用量：{{ ingredient.amountText }}</text>
    </view>
    <button role="button" class="text-button" :disabled="ingredients.length >= 30" @click="addIngredient" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="editor-add-circle"><AppIcon name="plus" :size="22" /></view><text>添加食材 / 配料</text></button>
    </view>
    </view>
    <view class="editor-list-section editor-steps-section">
    <view class="section-line"><view class="recipe-field-heading"><text class="subheading">做法</text></view><text class="editor-section-count">{{ steps.length }} 步</text></view>
    <FieldError :ref="field => fieldRefs.steps = field" :error="fieldErrors.steps" />
    <view v-for="(step, index) in steps" :key="step.id" class="step-editor" role="group" :aria-label="`做法步骤${index + 1}`">
      <view class="step-entry-fields">
      <view class="step-editor-header">
        <view class="editor-step-heading"><text class="step-editor-label">步骤 {{ index + 1 }}<text class="editor-required-mark" aria-hidden="true">*</text></text></view>
        <!-- Refresh native control bindings when a stable step changes position. -->
        <view v-for="position in [index]" :key="position" class="step-tools">
          <button role="button" :aria-label="`上移步骤${index + 1}`" :disabled="index === 0 || busyImages > 0" @click="moveStep(steps.findIndex(item => item.id === step.id), -1)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="arrow-up-circle" :size="24" /></button>
          <button role="button" :aria-label="`下移步骤${index + 1}`" :disabled="index === steps.length - 1 || busyImages > 0" @click="moveStep(steps.findIndex(item => item.id === step.id), 1)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="arrow-down-circle" :size="24" /></button>
          <button role="button" class="step-remove" :aria-label="`删除步骤${index + 1}`" :disabled="busyImages > 0" @click="steps.splice(index, 1)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="20" /></button>
        </view>
      </view>
        <FormField class="step-heading-input" :ref="field => fieldRefs[`steps.${index}.title`] = field" v-model="step.title" :error="fieldErrors[`steps.${index}.title`]" variant="inline-validation" field-class="input step-title-input" :placeholder-style="fieldErrors[`steps.${index}.title`] ? 'color: var(--danger)' : ''" :placeholder="fieldErrors[`steps.${index}.title`] ? '请输入步骤标题' : '标题：小火慢炖'" :aria-label="`步骤${index + 1}标题（必填）`" maxlength="40" />
        <FormField multiline :ref="field => fieldRefs[`steps.${index}.text`] = field" v-model="step.text" :error="fieldErrors[`steps.${index}.text`]" field-class="textarea" placeholder="具体做法、火候和时间" :aria-label="`步骤${index + 1}介绍（选填）`" maxlength="1000" />
      </view>
      <StepImagePicker icon-only :disabled="saving" v-model="step.images" :label="`步骤${index + 1}图片`" @busy="busyImages += $event ? 1 : -1" />
    </view>
    <button role="button" class="secondary-button full step-add-button editor-add-row" :disabled="steps.length >= MAX_RECIPE_STEPS || busyImages > 0" @click="steps.push(newStep())" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="editor-add-circle"><AppIcon name="plus" :size="22" /></view><text>添加步骤</text></button>
    </view>
    </view>
    <view class="menu-editor-actions"><text v-if="error" role="alert" class="error-message">{{ error }}</text><button role="button" class="primary-button full" :disabled="busyImages > 0 || saving" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在保存…' : '保存菜品' }}</button></view>
    </view>
  </Sheet>
</template>

<style scoped>
.editor-details-toggle { width: 100%; padding: 16px 0; display: flex; align-items: center; justify-content: space-between; text-align: left; background: transparent; }
.editor-details-copy { display: flex; flex-direction: column; gap: 5px; }
.editor-details-hint { font-size: var(--type-caption); color: var(--muted); line-height: 1.5; }
.editor-details-expanded { transform: rotate(90deg); }
</style>
