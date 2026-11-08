<script setup>
import FormField from './FormField.vue';
import FieldError from './FieldError.vue';
import { computed, nextTick, ref, watch } from 'vue';
import Sheet from './Sheet.vue';
import ImagePicker from './ImagePicker.vue';
import SelectField from './SelectField.vue';
import DateField from './DateField.vue';
import { stockReminder } from '../domain/stock-reminders.js';
import { ingredientImage } from '../domain/presentation.js';
import { coverFrameStyle } from '../domain/image-crop.js';
import { ingredientFieldErrors, validDate, SELECTABLE_UNITS, STOCK_LOCATIONS } from '../domain/kitchen.js';
import { state, addStock, recordPurchase } from '../store.js';
import { presentMutation } from '../services/mutation-feedback.js';

const props = defineProps({ initial: { type: Object, default: () => ({}) }, purchase: Boolean });
const emit = defineEmits(['close', 'saved']);
const draft = ref({ name: props.initial.name || '', quantity: props.initial.quantity ?? props.initial.toBuy ?? '', unit: props.initial.unit || 'g', location: STOCK_LOCATIONS.includes(props.initial.location) ? props.initial.location : '冷藏', expiresOn: props.initial.expiresOn || '', image: props.initial.image || '' });
const dateEdited = ref(false);
watch(() => draft.value.location, () => { if (props.initial.estimatedReminder && !dateEdited.value) draft.value.expiresOn = stockReminder(null, draft.value.location).date; });
function setExpiry(value) { dateEdited.value = true; draft.value.expiresOn = value; }
const busy = ref(false);
const saving = ref(false);
const locations = STOCK_LOCATIONS;
const error = ref('');
const submitted = ref(false);
const fieldRefs = {};
const fieldErrors = computed(() => {
  if (!submitted.value) return {};
  const errors = ingredientFieldErrors(draft.value);
  if (!STOCK_LOCATIONS.includes(draft.value.location)) errors.location = '请选择存放位置';
  if (draft.value.expiresOn && !validDate(draft.value.expiresOn)) errors.expiresOn = '请填写正确的到期日期';
  return errors;
});
watch(draft, () => { error.value = ''; }, { deep: true, flush: 'sync' });
async function save() {
  if (busy.value || saving.value) return;
  error.value = '';
  submitted.value = true;
  const invalidField = Object.keys(fieldErrors.value)[0];
  if (invalidField) {
    await nextTick();
    fieldRefs[invalidField]?.reveal();
    return;
  }
  saving.value = true;
  try {
    await presentMutation(props.purchase ? recordPurchase(draft.value) : addStock(draft.value), () => emit('saved'));
  } catch (failure) { error.value = failure?.message || '保存失败，请重试'; }
  finally { saving.value = false; }
}
</script>

<template>
  <Sheet :title="purchase ? (draft.name || '确认采购') : '记录食材'" @close="$emit('close')">
    <view v-if="!purchase" class="stock-ingredient-search">
      <view class="field-label" @click.stop>食材名称<FormField :ref="field => fieldRefs.name = field" v-model="draft.name" :error="fieldErrors.name" error-id="stock-name-error" field-class="input" placeholder="输入食材名称" aria-label="食材名称" maxlength="30" /></view>
    </view>
    <view class="form-grid">
      <view class="field-label" @click.stop>{{ purchase ? '实际买入数量' : '现有数量' }}<FormField :ref="field => fieldRefs.quantity = field" v-model="draft.quantity" :error="fieldErrors.quantity" error-id="stock-quantity-error" field-class="input" type="digit" placeholder="例如：500" aria-label="库存数量" /></view>
      <view><text class="field-label">单位</text><SelectField :ref="field => fieldRefs.unit = field" v-model="draft.unit" :error="fieldErrors.unit" centered variant="units" :options="SELECTABLE_UNITS" :disabled="purchase" label="食材单位" /></view>
    </view>
    <view v-if="!purchase || state.family.features.fridge"><text class="field-label">存放位置</text><view class="chips"><button role="button" v-for="location in locations" :key="location" class="chip" :class="{ active: draft.location === location }" :aria-pressed="draft.location === location" @click="draft.location = location" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ location }}</button></view>
      <FieldError :ref="field => fieldRefs.location = field" :error="fieldErrors.location" />
    </view>
    <text class="field-label">{{ initial.estimatedReminder ? '预计到期提醒 / 可修改' : '到期日期 / 可不填' }}</text><DateField :model-value="draft.expiresOn" @update:model-value="setExpiry" label="选择到期日期" />
    <text v-if="initial.estimatedReminder" class="stock-reminder-note">自定义食材先设置较近的提醒，请按包装和实际状态调整</text>
    <FieldError :ref="field => fieldRefs.expiresOn = field" :error="fieldErrors.expiresOn" />
    <button role="button" v-if="draft.expiresOn" class="text-button" @click="setExpiry('')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">清除到期日期</button>
    <ImagePicker v-if="!purchase || state.family.features.fridge" v-model="draft.image" frame="recipe" label="拍照或上传食材图片" :fallback="ingredientImage(draft.name)" :disabled="saving" @busy="busy = $event" />
    <view v-else class="image-picker stock-cover-fallback" aria-hidden="true">
      <view class="image-upload" :style="coverFrameStyle('recipe')"><image class="upload-preview" :src="$image(ingredientImage(draft.name))" mode="aspectFill" /></view>
    </view>
    <template #footer><text v-if="error" class="error-message stock-save-error" role="alert" aria-live="polite">{{ error }}</text><button role="button" class="primary-button full" :disabled="busy || saving" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在保存…' : purchase && !state.family.features.fridge ? '确认已买' : '确认入库' }}</button></template>
  </Sheet>
</template>

<style scoped>
.stock-reminder-note { display: block; font-size: var(--type-caption); color: var(--muted); margin-top: 8px; }
.stock-save-error { margin: 0 0 10px; line-height: 1.5; }
.stock-ingredient-search { margin-bottom: 18px; }
</style>
