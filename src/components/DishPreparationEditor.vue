<script setup>
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { state } from '../store.js';
import { hasTextAmount, localDate, SELECTABLE_UNITS } from '../domain/kitchen.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import { usePreparationAutosave } from '../composables/usePreparationAutosave.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import FormField from './FormField.vue';
import AppIcon from './AppIcon.vue';
import FieldError from './FieldError.vue';

const props = defineProps({ orderId: String, recipeId: String, today: { type: String, default: localDate } });
const emit = defineEmits(['close', 'state-change']);
const autosave = usePreparationAutosave();
const session = autosave.edit(props.orderId, props.recipeId);
const scope = computed(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`);
const title = computed(() => session.title || '调整备菜');
const ingredients = computed(() => session.ingredients);
const rows = computed(() => session.rowOrder.map(index => ({ ingredient: ingredients.value[index], index })));
const confirming = ref(false);
const editingUnit = ref(null);
const presets = ['适量', '少许'];
const unitOptions = [...presets, ...SELECTABLE_UNITS];
const ingredientError = ref(null);
const ingredientFields = ref([]);
const ingredientErrors = ref([]);
let viewRevision = 0;
const dirty = computed(() => session.dirty);
const saving = computed(() => session.saving || session.externalSaving);
const fieldErrors = computed(() => session.touched ? session.validation : {});
const unavailable = computed(() => session.unavailable);
const stale = computed(() => session.conflict);
const feedback = computed(() => unavailable.value || (session.uncertain ? session.error || '同步结果尚未确认，请重试核对，草稿已保留' : stale.value ? '家人已更新这道菜，草稿已保留，请载入最新内容后再调整' : '') || session.error);
const validationStatus = computed(() => session.touched && !session.composing && Object.keys(session.validation).length ? '待补全，草稿已保留' : '');

function changeUnit(ingredient, unit) {
  if (ingredient.enabled === false || unavailable.value || !unitOptions.includes(unit)) return;
  if (ingredient.choice === unit) { editingUnit.value = null; return; }
  if (presets.includes(unit)) {
    ingredient.amountText = unit;
    ingredient.quantity = null;
    ingredient.unit = '';
  } else {
    if (hasTextAmount(ingredient)) ingredient.quantity = 0;
    delete ingredient.amountText;
    ingredient.unit = unit;
  }
  ingredient.choice = unit;
  editingUnit.value = null;
  void autosave.dispatch(props.orderId, props.recipeId);
}
function toggleUnit(ingredient) {
  if (ingredient.enabled === false || unavailable.value) return;
  dismissFocusedKeyboard();
  editingUnit.value = editingUnit.value === ingredient.key ? null : ingredient.key;
}
function addIngredient() {
  autosave.add(props.orderId, props.recipeId);
}
async function removeIngredient(ingredient) {
  if (unavailable.value) return;
  dismissFocusedKeyboard();
  if (editingUnit.value === ingredient.key) editingUnit.value = null;
  if (!autosave.remove(props.orderId, props.recipeId, ingredient.key)) return;
  await autosave.dispatch(props.orderId, props.recipeId);
}
async function close() {
  await autosave.dispatch(props.orderId, props.recipeId);
  emit('close');
  return true;
}
async function reloadLatest() {
  if (confirming.value || saving.value || unavailable.value) return;
  const revision = viewRevision;
  confirming.value = true;
  try {
    const confirmed = await new Promise(resolve => uni.showModal({ title: '载入最新内容？', content: '家人的最新内容会替换这道菜保留的草稿。', confirmText: '载入最新', cancelText: '保留草稿', confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
    if (confirmed && revision === viewRevision) { await autosave.reload(props.orderId, props.recipeId); editingUnit.value = null; }
  } catch (error) {
    session.error = error?.message || '载入失败，草稿已保留';
  } finally { confirming.value = false; }
}
function revealInvalid(field) {
  if (field === 'ingredients') { ingredientError.value?.reveal(); return; }
  const [, index, property] = field.split('.');
  const type = property === 'amountText' ? 'unit' : property;
  const errorId = fieldId(index, type);
  const target = ingredientErrors.value.find(component => component?.$props?.errorId === errorId) || ingredientFields.value.find(component => component?.$props?.errorId === errorId);
  target?.reveal();
}
function fieldId(index, type) { return `preparation-${props.recipeId}-${type}-error-${index}`; }
async function retry() {
  session.touched = true;
  try {
    await autosave.retry(props.orderId, props.recipeId);
  } catch {
    await nextTick();
    const invalid = Object.keys(fieldErrors.value)[0];
    if (invalid) revealInvalid(invalid);
  }
}
async function restoreDefaults() {
  dismissFocusedKeyboard();
  await nextTick();
  autosave.defaults(props.orderId, props.recipeId);
  editingUnit.value = null;
}
function startComposition() { session.composing = true; }
async function endComposition() { await nextTick(); session.composing = false; }
async function blurField() { session.touched = true; await autosave.dispatch(props.orderId, props.recipeId); }
watch(scope, () => { viewRevision += 1; emit('close'); });
watch(() => [dirty.value, saving.value, ingredients.value.length, feedback.value, validationStatus.value], () => emit('state-change', { dirty: dirty.value, busy: saving.value, count: ingredients.value.length, status: feedback.value || validationStatus.value }), { immediate: true });
onScopeDispose(() => { viewRevision += 1; });
defineExpose({ requestClose: close, recipeId: props.recipeId });
</script>

<template>
  <view class="preparation-inline-editor" :aria-label="`调整${title}的本餐食材`">
    <FieldError ref="ingredientError" :error="fieldErrors.ingredients" />
    <text v-if="!ingredients.length" class="preparation-edit-hint">还没有食材，可以按实际需要添加</text>
    <view class="meal-material-list">
      <view v-if="ingredients.length" class="meal-material-header preparation-material-header"><text>食材 / 配料</text><text class="preparation-header-amount">用量</text><text class="preparation-header-action">操作</text></view>
      <view class="meal-material-items" role="list" aria-label="本餐食材和配料">
        <view v-for="{ ingredient, index } in rows" :key="ingredient.key" class="meal-material-item preparation-edit-item" :class="{ 'is-disabled': ingredient.enabled === false }" role="listitem">
          <view class="preparation-edit-fields" :class="{ 'text-amount-editor': hasTextAmount(ingredient) }">
            <FormField class="preparation-name-field" ref="ingredientFields" v-model="ingredient.name" variant="material" :error="fieldErrors[`ingredients.${index}.name`]" :error-id="fieldId(index, 'name')" external-error :disabled="Boolean(unavailable) || ingredient.enabled === false" field-class="input preparation-material-input" placeholder="食材名称" :aria-label="`食材${index + 1}名称`" maxlength="30" @blur="blurField" @compositionstart="startComposition" @compositionend="endComposition" />
            <FormField class="preparation-quantity-field" v-if="!hasTextAmount(ingredient)" ref="ingredientFields" v-model="ingredient.quantity" variant="material" :empty-value="0" :error="fieldErrors[`ingredients.${index}.quantity`]" :error-id="fieldId(index, 'quantity')" external-error :disabled="Boolean(unavailable) || ingredient.enabled === false" :field-class="`input preparation-material-input preparation-material-quantity${Number(ingredient.quantity) === 0 ? ' quantity-zero' : ''}`" type="digit" placeholder="0" :aria-label="`${ingredient.name || '食材'}数量${Number(ingredient.quantity) === 0 ? '，当前为零，可继续调整' : ''}`" @blur="blurField" @compositionstart="startComposition" @compositionend="endComposition" />
            <view class="preparation-unit-field">
              <button role="button" class="preparation-unit-trigger" :class="{ 'field-invalid': fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`], 'is-expanded': editingUnit === ingredient.key, 'is-disabled': Boolean(unavailable) || ingredient.enabled === false }" :disabled="Boolean(unavailable) || ingredient.enabled === false" :aria-label="`食材${index + 1}用量，当前${ingredient.choice === '原用量' ? ingredient.amountText : ingredient.choice}`" :aria-expanded="editingUnit === ingredient.key" :aria-controls="`preparation-${recipeId}-units-${ingredient.key}`" :aria-invalid="Boolean(fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`])" :aria-describedby="fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`] ? fieldId(index, 'unit') : undefined" @click="toggleUnit(ingredient)" hover-class="touch-feedback"><text class="preparation-unit-label">{{ ingredient.choice === '原用量' ? ingredient.amountText : ingredient.choice }}</text><view class="preparation-unit-chevron"><AppIcon name="detail-collapse" :size="12" /></view></button>
            </view>
            <button role="button" class="icon-button preparation-remove" :aria-label="`删除本餐食材${ingredient.name ? `：${ingredient.name}` : `第${index + 1}项`}`" :disabled="Boolean(unavailable)" @click="removeIngredient(ingredient)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="16" /></button>
          </view>
          <view v-if="fieldErrors[`ingredients.${index}.name`] || fieldErrors[`ingredients.${index}.quantity`] || fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`]" class="preparation-edit-errors">
            <FieldError ref="ingredientErrors" :error="fieldErrors[`ingredients.${index}.name`]" :error-id="fieldId(index, 'name')" />
            <FieldError ref="ingredientErrors" :error="fieldErrors[`ingredients.${index}.quantity`]" :error-id="fieldId(index, 'quantity')" />
            <FieldError ref="ingredientErrors" :error="fieldErrors[`ingredients.${index}.unit`] || fieldErrors[`ingredients.${index}.amountText`]" :error-id="fieldId(index, 'unit')" />
          </view>
          <view v-if="editingUnit === ingredient.key && ingredient.enabled !== false" :id="`preparation-${recipeId}-units-${ingredient.key}`" class="preparation-unit-options" role="listbox" :aria-label="`食材${index + 1}用量`"><button v-for="unit in unitOptions" :key="unit" class="preparation-unit-option" role="option" :aria-selected="ingredient.choice === unit" :class="{ selected: ingredient.choice === unit }" :disabled="Boolean(unavailable)" @click="changeUnit(ingredient, unit)" hover-class="touch-feedback">{{ unit }}</button></view>
        </view>
      </view>
    </view>
    <view class="preparation-edit-footer">
      <view class="preparation-edit-actions">
        <button role="button" class="text-button preparation-add" aria-label="添加食材或配料" :disabled="Boolean(unavailable) || ingredients.length >= 30" @click="addIngredient" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" active :size="16" /><text>添加食材/配料</text></button>
        <button role="button" class="text-button preparation-reset" aria-label="恢复本餐默认食材和用量" :class="{ 'is-disabled': Boolean(unavailable) || stale || Boolean(session.error) }" :disabled="Boolean(unavailable) || stale || Boolean(session.error)" @click="restoreDefaults" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="restore" active :size="16" /><text>恢复默认</text></button>
      </view>
    </view>
    <view v-if="feedback || session.notice || validationStatus" class="preparation-edit-feedback">
      <text v-if="feedback" class="error-message preparation-save-error" role="alert" aria-live="polite">{{ feedback }}</text>
      <text v-else-if="session.notice || validationStatus" class="preparation-save-status" role="status" aria-live="polite">{{ session.notice || validationStatus }}</text>
      <button v-if="stale && !session.uncertain && !unavailable" role="button" class="text-button" :disabled="saving || confirming" @click="reloadLatest" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">载入最新内容</button>
      <button v-else-if="session.error && !unavailable" role="button" class="text-button" :disabled="saving" @click="retry" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重试同步</button>
    </view>
  </view>
</template>

<style scoped>
.preparation-inline-editor { padding: 0; --preparation-quantity-width: 52px; --preparation-unit-width: 58px; --preparation-column-gap: 4px; }
.preparation-edit-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0 16px; min-height: 44px; }
.preparation-reset { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; gap: 4px; min-height: 44px; margin: 0 0 0 auto; padding: 0; background: transparent; font-size: var(--type-meta); font-weight: 400; line-height: 20px; text-decoration: none; }
.preparation-reset.is-disabled { background: transparent; color: var(--muted); }
.preparation-save-status { display: block; min-height: 20px; color: var(--muted); font-size: var(--type-caption); line-height: 20px; }
.preparation-edit-hint { display: block; color: var(--muted); font-size: var(--type-meta); line-height: 22px; }
.preparation-edit-item { display: block; min-width: 0; padding: 0; }
.preparation-material-header, .preparation-edit-fields { display: grid; grid-template-columns: minmax(0, 1fr) var(--preparation-quantity-width) var(--preparation-unit-width) 44px; gap: var(--preparation-column-gap); }
.preparation-edit-fields { margin: 0; align-items: start; }
.preparation-header-amount, .preparation-edit-fields.text-amount-editor .preparation-unit-field { grid-column: 2 / 4; }
.preparation-header-amount { text-align: right; }
.preparation-header-action { text-align: center; }
.preparation-name-field, .preparation-quantity-field, .preparation-unit-field { min-width: 0; }
.preparation-unit-trigger { display: flex; align-items: center; justify-content: flex-end; gap: 3px; width: 100%; min-width: 0; min-height: 44px; margin: 0; padding: 0; background: transparent; color: var(--muted); font-size: var(--type-meta); }
.preparation-unit-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.preparation-unit-trigger.is-disabled { background: transparent; color: var(--muted); opacity: 1; }
.preparation-unit-chevron { display: flex; flex-shrink: 0; transition: transform 160ms ease; }
.preparation-unit-trigger.is-expanded .preparation-unit-chevron { transform: rotate(180deg); }
.preparation-unit-trigger.is-expanded { color: var(--green); }
.preparation-edit-errors { padding-bottom: 8px; }
.preparation-edit-item.is-disabled .preparation-name-field, .preparation-edit-item.is-disabled .preparation-quantity-field, .preparation-edit-item.is-disabled .preparation-unit-field { opacity: .45; }
.preparation-remove { display: flex; align-items: center; justify-content: center; width: 44px; min-height: 44px; margin: 0; padding: 0; border-radius: 0; background: transparent; }
.preparation-unit-options { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; margin: 4px 0 8px; padding: 0; border-radius: var(--radius-control); background: var(--white); }
.preparation-unit-option { display: flex; align-items: center; justify-content: center; width: 100%; min-width: 0; min-height: 44px; margin: 0; padding: 4px 2px; border-radius: var(--radius-control); background: transparent; color: var(--muted); font-size: var(--type-control); line-height: 20px; text-align: center; }
.preparation-unit-option.selected { background: var(--green-light); color: var(--green); font-weight: 600; }
.preparation-add { display: inline-flex; align-items: center; justify-content: flex-start; gap: 4px; min-height: 44px; margin: 0; padding: 0; font-size: var(--type-meta); font-weight: 400; line-height: 20px; }
.preparation-edit-footer { display: flex; flex-direction: column; gap: 0; margin: 0; padding: 0; }
.preparation-edit-feedback { margin-top: 8px; }
.preparation-save-error { margin: 0 0 10px; }
@media (max-width: 360px) { .preparation-inline-editor { --preparation-quantity-width: 46px; --preparation-unit-width: 48px; --preparation-column-gap: 3px; } }
@media (prefers-reduced-motion: reduce) { .preparation-unit-chevron { transition: none; } }
</style>
