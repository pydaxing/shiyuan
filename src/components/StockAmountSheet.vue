<script setup>
import { computed, nextTick, ref, watch } from 'vue';
import Sheet from './Sheet.vue';
import FormField from './FormField.vue';
import SelectField from './SelectField.vue';
import DateField from './DateField.vue';
import { ingredientFieldErrors, validDate, SELECTABLE_UNITS, STOCK_LOCATIONS } from '../domain/kitchen.js';
import { stockFromIngredient } from '../domain/ingredient-catalog.js';
import { stockReminder } from '../domain/stock-reminders.js';
import { addStock } from '../store.js';
import { presentMutation } from '../services/mutation-feedback.js';
const props = defineProps({ entry: { type: Object, required: true }, location: String });
const emit = defineEmits(['close', 'saved']);
const draft = ref(stockFromIngredient(props.entry, props.location));
const saving = ref(false);
const accepted = ref(false);
const submitted = ref(false);
const error = ref('');
const quantityField = ref(null);
const dateEdited = ref(false);
const reminder = computed(() => stockReminder(props.entry, draft.value.location));
const errors = computed(() => submitted.value ? ingredientFieldErrors(draft.value) : {});
watch(() => draft.value.location, () => { if (!dateEdited.value) draft.value.expiresOn = reminder.value.date; });
function setDate(value) { if (saving.value || accepted.value) return; dateEdited.value = true; draft.value.expiresOn = value; }
function close() { if (!saving.value && !accepted.value) emit('close'); }
async function save() {
  if (saving.value || accepted.value) return;
  submitted.value = true; error.value = '';
  if (Object.keys(errors.value).length) { await nextTick(); quantityField.value?.reveal(); return; }
  if (!STOCK_LOCATIONS.includes(draft.value.location)) { error.value = '请选择存放位置'; return; }
  if (!validDate(draft.value.expiresOn)) { error.value = '请选择正确的提醒日期'; return; }
  saving.value = true;
  try {
    await presentMutation(addStock({ ...draft.value }), () => { accepted.value = true; emit('saved'); });
  } catch (failure) { error.value = failure?.message || '添加失败，请重试'; }
  finally { saving.value = false; }
}
</script>
<template>
  <Sheet title="放入冰箱" @close="close">
    <view class="amount-food"><image class="amount-image" :src="$image(entry.image)" mode="aspectFit" /><view><text class="amount-name">{{ entry.name }}</text><text class="amount-subtitle">确认数量，安排好存放位置</text></view></view>
    <text class="amount-label">数量</text>
    <view class="amount-fields">
      <FormField ref="quantityField" v-model="draft.quantity" field-class="input" type="digit" aria-label="食材数量" placeholder="输入数量" :error="errors.quantity" :disabled="saving || accepted" />
      <SelectField v-model="draft.unit" :options="SELECTABLE_UNITS" label="食材单位" centered variant="units" :error="errors.unit" :disabled="saving || accepted" />
    </view>
    <text class="amount-label">存放位置</text>
    <view class="amount-locations"><button v-for="place in STOCK_LOCATIONS" :key="place" class="amount-location" :class="{ active: draft.location === place }" :aria-pressed="draft.location === place" :disabled="saving || accepted" @click="draft.location = place" hover-class="touch-feedback">{{ place }}</button></view>
    <view class="amount-date"><text class="amount-date-label">提醒日期</text><view class="amount-date-control"><DateField :model-value="draft.expiresOn" label="修改提醒日期" @update:model-value="setDate" /></view></view>
    <text class="amount-note">保存时间为预估，请以包装与实际状态为准</text>
    <template #footer><text v-if="error" class="error-message" role="alert">{{ error }}</text><button class="primary-button full" :disabled="saving || accepted" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在添加…' : '放入冰箱' }}</button></template>
  </Sheet>
</template>
<style scoped>
.amount-food { display: flex; align-items: center; gap: 14px; margin-bottom: 24px; }
.amount-image { width: 72px; height: 64px; flex-shrink: 0; }
.amount-name { display: block; font-family: var(--font-display); font-size: var(--type-title); font-weight: 600; }
.amount-subtitle { display: block; margin-top: 6px; font-size: var(--type-caption); color: var(--muted); }
.amount-label { display: block; margin: 20px 0 10px; font-size: var(--type-control); font-weight: 600; }
.amount-fields { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 12px; }
.amount-locations { display: flex; gap: 4px; padding: 4px; background: var(--paper); border-radius: var(--radius-card); }
.amount-location { flex: 1; min-height: 44px; margin: 0; padding: 10px 0; background: transparent; color: var(--muted); font-size: var(--type-control); border-radius: var(--radius-control); }
.amount-location.active { background: var(--white); color: var(--green); font-weight: 600; }
.amount-date { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 22px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.amount-date-label { font-size: var(--type-control); font-weight: 600; flex-shrink: 0; }
.amount-date-control { min-width: 0; }
.amount-date-control :deep(.choice-trigger) { border: 0; background: transparent; padding: 8px 0; }
.amount-note { display: block; color: var(--muted); font-size: var(--type-caption); line-height: 1.6; margin-top: 12px; }
</style>
