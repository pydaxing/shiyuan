<script setup>
import AppIcon from './AppIcon.vue';
import FormField from './FormField.vue';
import FieldError from './FieldError.vue';
import { computed, nextTick, ref } from 'vue';
import { state, saveMealSet } from '../store.js';
import { presentMutation } from '../services/mutation-feedback.js';
import { mealSetFieldErrors } from '../domain/kitchen.js';
import { DEFAULT_SET_COVER } from '../domain/presentation.js';
import Sheet from './Sheet.vue';
import ImagePicker from './ImagePicker.vue';
import RecipeListMeta from './RecipeListMeta.vue';
import FoodThumbnail from './FoodThumbnail.vue';
const props = defineProps({ mealSet: Object });
const emit = defineEmits(['close', 'saved']);
const sheet = ref(null);
const title = ref(props.mealSet?.title || '');
const image = ref(props.mealSet?.image || '');
const selected = ref([...(props.mealSet?.recipeIds || [])]);
const busy = ref(false);
const saving = ref(false);
const error = ref('');
const submitted = ref(false);
const fieldRefs = {};
const draft = computed(() => ({ title: title.value, image: image.value, recipeIds: selected.value }));
const fieldErrors = computed(() => submitted.value ? mealSetFieldErrors(draft.value, state.value.recipes) : {});
function toggle(id) { if (!busy.value && !saving.value) selected.value = selected.value.includes(id) ? selected.value.filter((entry) => entry !== id) : [...selected.value, id]; }
async function save() {
  if (busy.value || saving.value) return;
  submitted.value = true; error.value = '';
  const invalid = Object.keys(fieldErrors.value)[0];
  if (invalid) { await nextTick(); fieldRefs[invalid]?.reveal(); return; }
  saving.value = true; error.value = '';
  try { await presentMutation(saveMealSet(draft.value, props.mealSet?.id), () => emit('saved')); }
  catch (failure) { error.value = failure.message; }
  finally { saving.value = false; }
}
</script>

<template>
  <Sheet ref="sheet" :title="mealSet ? '编辑套餐' : '创建套餐'" @close="!saving && $emit('close')">
    <ImagePicker v-model="image" :fallback="DEFAULT_SET_COVER" label="拍照/相册" :disabled="saving" @busy="busy = $event" />
    <view class="field-label" @click.stop><text class="subheading">套餐名称</text><FormField :ref="field => fieldRefs.title = field" v-model="title" :error="fieldErrors.title" :disabled="saving" field-class="input" placeholder="例如：清爽轻食餐" maxlength="30" aria-label="套餐名称" /></view>
    <view class="section-line"><text class="subheading">搭配菜品</text><text class="muted">已选 {{ selected.length }} 道</text></view>
    <FieldError :ref="field => fieldRefs.recipeIds = field" :error="fieldErrors.recipeIds" />
    <view class="set-pick-list"><button v-for="recipe in state.recipes" :key="recipe.id" role="button" class="set-pick-row" :class="{ selected: selected.includes(recipe.id) }" :aria-label="`套餐选择${recipe.title}`" :aria-pressed="selected.includes(recipe.id)" :disabled="saving || busy" @click="$feedback(); toggle(recipe.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><FoodThumbnail :src="recipe.image" /><view class="set-pick-copy"><text class="stock-name food-list-title">{{ recipe.title }}</text><RecipeListMeta :category="recipe.category" :minutes="recipe.minutes" /></view><view class="pick-check"><AppIcon :name="selected.includes(recipe.id) ? 'check-inverse' : 'plus'" /></view></button></view>
    <text v-if="state.recipes.length < 2" class="hint">先添加至少两道菜，就可以搭配套餐。</text>
    <template #footer><text v-if="error" class="error-message" role="alert">{{ error }}</text><button role="button" class="primary-button full" :disabled="busy || saving" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在保存…' : '保存套餐' }}</button></template>
  </Sheet>
</template>
