<script setup>
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import { state, cloudStatus, saveShoppingDraft } from '../store.js';
import { clone, hasTextAmount, localDate, mealDateLabel, shoppingDraftFieldErrors, SELECTABLE_UNITS } from '../domain/kitchen.js';
import { preparationMeals } from '../domain/meal-preparation.js';
import { shoppingEditSignature, shoppingSourceIngredients } from '../domain/meal-shopping.js';
import { NATIVE_UI_COLORS } from '../domain/ui-theme.js';
import Sheet from './Sheet.vue';
import FormField from './FormField.vue';
import SelectField from './SelectField.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import AppIcon from './AppIcon.vue';
import FieldError from './FieldError.vue';

const props = defineProps({ orderId: String, recipeId: String, today: { type: String, default: localDate } });
const emit = defineEmits(['close', 'saved']);
const order = computed(() => state.value.orders.find(entry => entry.id === props.orderId));
const dish = computed(() => preparationMeals(state.value, props.today).find(entry => entry.id === props.orderId)?.dishes.find(entry => entry.recipe.id === props.recipeId));
const existing = computed(() => order.value?.shoppingDrafts?.find(entry => entry.recipeId === props.recipeId));
const rows = ref([]);
const submitted = ref(false);
const error = ref('');
const saving = ref(false);
const confirming = ref(false);
const signature = ref('');
const initial = ref('');
const sheet = ref(null);
const fieldRefs = {};
const presets = ['适量', '少许'];
const unitOptions = [...presets, ...SELECTABLE_UNITS];
const busy = computed(() => saving.value || confirming.value || cloudStatus.value.busy);
const unavailable = computed(() => !dish.value ? '这一餐已结束、已取消或菜品已移除' : dish.value.prepared ? '这道菜已备齐，需要采购时请先取消已备' : '');
const stale = computed(() => Boolean(dish.value && shoppingEditSignature(order.value, props.recipeId) !== signature.value));
const changedRequirements = computed(() => Boolean(existing.value && dish.value && existing.value.sourceSignature !== dish.value.signature));
const selectedRows = computed(() => rows.value.filter(row => row.selected));
const draft = computed(() => ({ ingredients: selectedRows.value.map(({ selected, choice, removed, ...ingredient }) => ingredient) }));
const dirty = computed(() => JSON.stringify(draft.value) !== initial.value);
const fieldErrors = computed(() => {
  if (!submitted.value) return {};
  const errors = shoppingDraftFieldErrors(draft.value);
  selectedRows.value.forEach((row, index) => { if (row.removed) errors[`ingredients.${index}.sourceKey`] = '本餐已移除这项，请取消勾选'; });
  return errors;
});
const rowErrors = computed(() => Object.fromEntries(selectedRows.value.map((row, index) => [row.sourceKey, {
  quantity: fieldErrors.value[`ingredients.${index}.quantity`],
  amount: fieldErrors.value[`ingredients.${index}.amountText`] || fieldErrors.value[`ingredients.${index}.unit`],
  source: fieldErrors.value[`ingredients.${index}.sourceKey`],
}])));
let revision = 0;

function register(ingredient, selected, removed = false) {
  const amount = hasTextAmount(ingredient) ? ingredient.amountText.trim() : '';
  return { ...clone(ingredient), selected, removed, choice: hasTextAmount(ingredient) ? presets.includes(amount) ? amount : '原用量' : ingredient.unit };
}
function loadCurrent() {
  if (!dish.value) return;
  const sources = shoppingSourceIngredients(dish.value.ingredients);
  const previous = existing.value?.ingredients || [];
  rows.value = sources.map(source => {
    const saved = previous.find(entry => entry.sourceKey === source.sourceKey);
    return register(saved || source, Boolean(saved));
  });
  rows.value.push(...previous.filter(entry => !sources.some(source => source.sourceKey === entry.sourceKey)).map(entry => register(entry, true, true)));
  signature.value = shoppingEditSignature(order.value, props.recipeId);
  initial.value = JSON.stringify(draft.value);
  submitted.value = false;
  error.value = '';
}
loadCurrent();
function toggle(row) { if (!busy.value) row.selected = !row.selected; }
function toggleAll() {
  if (busy.value) return;
  const selected = !rows.value.filter(row => !row.removed).every(row => row.selected);
  rows.value.forEach(row => { row.selected = selected && !row.removed; });
}
function changeUnit(row, choice) {
  if (busy.value || !unitOptions.includes(choice)) return;
  if (presets.includes(choice)) { row.quantity = null; row.unit = ''; row.amountText = choice; }
  else { if (hasTextAmount(row)) row.quantity = ''; row.unit = choice; delete row.amountText; }
  row.choice = choice;
}
function useCurrentAmounts() {
  if (busy.value || !dish.value) return;
  const sources = shoppingSourceIngredients(dish.value.ingredients);
  rows.value = sources.map(source => register(source, rows.value.some(row => row.sourceKey === source.sourceKey && row.selected)));
}
async function confirmDiscard() {
  if (!dirty.value) return true;
  confirming.value = true;
  try { return await new Promise(resolve => uni.showModal({ title: '放弃未保存的采购调整？', content: '当前选择和购买用量尚未保存。', confirmText: '放弃修改', cancelText: '继续编辑', confirmColor: NATIVE_UI_COLORS.primary, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) })); }
  finally { confirming.value = false; }
}
async function close() {
  if (busy.value) return;
  const request = revision;
  if (await confirmDiscard() && request === revision) emit('close');
}
async function reloadLatest() {
  if (busy.value || unavailable.value) return;
  const request = revision;
  if (await confirmDiscard() && request === revision) loadCurrent();
}
async function save() {
  if (busy.value || unavailable.value || stale.value) return;
  submitted.value = true;
  error.value = '';
  const invalid = Object.keys(fieldErrors.value)[0];
  if (invalid) {
    await nextTick();
    const index = Number(invalid.split('.')[1]);
    const field = invalid.endsWith('.quantity') ? 'quantity' : invalid.endsWith('.sourceKey') ? 'source' : 'amount';
    if (Number.isInteger(index)) fieldRefs[`${selectedRows.value[index]?.sourceKey}.${field}`]?.reveal();
    else fieldRefs.ingredients?.reveal();
    return;
  }
  const request = ++revision;
  saving.value = true;
  try {
    await saveShoppingDraft(props.orderId, props.recipeId, draft.value, signature.value);
    if (request === revision) emit('saved');
  } catch (failure) { if (request === revision) error.value = failure?.message || '保存失败，请重试'; }
  finally { if (request === revision) saving.value = false; }
}
watch(() => `${state.value.family.id || ''}:${state.value.activeMemberId}`, () => { revision += 1; emit('close'); });
onScopeDispose(() => { revision += 1; });
</script>

<template>
  <Sheet ref="sheet" :title="existing ? '调整采购清单' : '加入采购'" :preferred-height="740" @close="close">
    <view v-if="dish" class="shopping-edit-heading"><FoodThumbnail :src="dish.recipe.image" /><view class="shopping-edit-copy"><text class="meal-ingredient-title food-list-title">{{ dish.recipe.title }}</text><text class="small-muted">{{ mealDateLabel(order.date, today) }} · {{ order.meal }}</text></view></view>
    <view v-if="unavailable || stale || changedRequirements" class="shopping-edit-warning" role="alert"><text>{{ unavailable || (stale ? '家人已更新备菜或采购清单，请载入最新内容' : '本餐用量已调整，采购数量仍保留原值，请核对后保存') }}</text><button v-if="stale && !unavailable" class="text-button" :disabled="busy" @click="reloadLatest">载入最新内容</button><button v-else-if="changedRequirements && !unavailable" class="text-button" :disabled="busy" @click="useCurrentAmounts">按本餐用量更新</button></view>
    <view class="section-line"><text class="subheading">勾选这次要买的</text><button role="checkbox" class="text-button" :disabled="busy" :aria-checked="rows.length > 0 && rows.filter(row => !row.removed).every(row => row.selected)" @click="toggleAll">{{ rows.length && rows.filter(row => !row.removed).every(row => row.selected) ? '取消全选' : '全选' }}</button></view>
    <FieldError :ref="field => fieldRefs.ingredients = field" :error="fieldErrors.ingredients" />
    <view v-for="row in rows" :key="row.sourceKey" class="shopping-edit-row" :class="{ 'has-text-amount': hasTextAmount(row), 'is-removed': row.removed }">
      <button role="checkbox" class="shopping-ingredient-select" :aria-checked="row.selected" :aria-label="`${row.selected ? '不买' : '购买'}${row.name}`" :disabled="busy" @click="toggle(row)"><view class="shopping-select-box" :class="{ selected: row.selected }"><AppIcon v-if="row.selected" name="check-inverse" :size="15" /></view><text class="shopping-ingredient-name">{{ row.name }}</text></button>
      <FormField v-if="!hasTextAmount(row)" :ref="field => fieldRefs[`${row.sourceKey}.quantity`] = field" v-model="row.quantity" :disabled="busy || !row.selected || row.removed" :error="rowErrors[row.sourceKey]?.quantity" field-class="input" type="digit" placeholder="数量" :aria-label="`${row.name}购买数量`" />
      <SelectField :ref="field => fieldRefs[`${row.sourceKey}.amount`] = field" :error="rowErrors[row.sourceKey]?.amount" :model-value="row.choice" :disabled="busy || !row.selected || row.removed" :options="unitOptions" centered variant="units" :label="`${row.name}购买单位`" @update:model-value="changeUnit(row, $event)" />
      <text v-if="row.choice === '原用量'" class="shopping-row-note">{{ row.amountText }}</text>
      <FieldError class="shopping-row-error" :ref="field => fieldRefs[`${row.sourceKey}.source`] = field" :error="rowErrors[row.sourceKey]?.source" />
    </view>
    <template #footer><text v-if="error" class="error-message" role="alert">{{ error }}</text><button role="button" class="primary-button full" :disabled="busy || Boolean(unavailable) || stale" :aria-busy="saving" @click="save"><AppIcon name="shopping-inverse" :size="18" /><text>{{ saving ? '正在保存…' : `${existing ? '保存采购清单' : '加入采购'} · ${selectedRows.length}项` }}</text></button></template>
  </Sheet>
</template>

<style scoped>
.shopping-edit-heading { display: flex; align-items: center; gap: 12px; --food-thumbnail-width: 78px; }
.shopping-edit-copy { flex: 1; min-width: 0; }
.shopping-edit-copy .small-muted { display: block; margin-top: 6px; }
.shopping-edit-warning { margin-top: 16px; padding: 12px; border-radius: var(--radius-control); background: var(--warning-light); color: var(--warning); font-size: var(--type-meta); line-height: 1.6; }
.shopping-edit-warning .text-button { padding: 6px 0 0; }
.shopping-edit-row { display: grid; grid-template-columns: minmax(0, 1fr) 74px 72px; align-items: start; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.shopping-edit-row.has-text-amount { grid-template-columns: minmax(0, 1fr) 110px; }
.shopping-edit-row .input { margin: 0; padding: 0 8px; }
.shopping-ingredient-select { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 44px; padding: 0; background: transparent; text-align: left; font-size: var(--type-body); line-height: 1.5; }
.shopping-ingredient-name { min-width: 0; overflow-wrap: anywhere; }
.shopping-select-box { display: flex; align-items: center; justify-content: center; flex: 0 0 20px; width: 20px; height: 20px; border: 1.5px solid var(--border-strong); border-radius: var(--radius-small); }
.shopping-select-box.selected { background: var(--green); border-color: var(--green); }
.shopping-row-note, .shopping-row-error { grid-column: 1 / -1; margin: 0; }
.shopping-row-note { color: var(--muted); font-size: var(--type-caption); }
.is-removed { opacity: .65; }
@media (max-width: 360px) { .shopping-edit-row { grid-template-columns: minmax(0, 1fr) 64px 64px; gap: 6px; } .shopping-ingredient-select { gap: 6px; } }
</style>
