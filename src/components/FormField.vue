<script setup>
import { computed, getCurrentInstance, inject, onUnmounted, ref } from 'vue';
import { focusKeyboardField, blurKeyboardField } from '../services/keyboard.js';
defineOptions({ inheritAttrs: false });
const props = defineProps({ modelValue: [String, Number], multiline: Boolean, fieldClass: String, variant: String, emptyValue: [String, Number], placeholder: String, ariaLabel: String, error: String, errorId: String, externalError: Boolean, type: { type: String, default: 'text' }, maxlength: { type: [String, Number], default: 140 }, disabled: Boolean, focus: Boolean });
const emit = defineEmits(['update:modelValue', 'focus', 'blur', 'compositionstart', 'compositionend']);
const sheet = inject('sheetKeyboard', null);
const instance = getCurrentInstance();
const errorElementId = computed(() => props.errorId || `field-error-${instance.uid}`);
const token = Symbol('field');
const focused = ref(false);
let composing = false;
const measure = (callback) => uni.createSelectorQuery().in(instance.proxy).select('.form-field').boundingClientRect(callback).exec();
function reveal() {
  if (sheet) sheet.reveal(token, measure);
  else {
    const query = uni.createSelectorQuery().in(instance.proxy);
    query.select('.form-field').boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(([rect, viewport]) => { if (rect) uni.pageScrollTo({ scrollTop: Math.max(0, rect.top + (viewport?.scrollTop || 0) - 100), duration: 180 }); });
  }
}
defineExpose({ reveal });
function onFocus(event) {
  focused.value = true;
  focusKeyboardField(token, () => sheet?.dismiss(token));
  sheet?.focus(token, measure);
  if (event.detail?.height > 0) sheet?.keyboard(event.detail, token);
  emit('focus', event);
}
function onCompositionStart(event) { if (!composing) { composing = true; emit('compositionstart', event); } }
function onCompositionEnd(event) { if (composing) { composing = false; emit('compositionend', event); } }
function onInput(event) {
  const flag = event.detail?.isComposing ?? event.isComposing;
  if (flag === true) onCompositionStart(event);
  const empty = props.emptyValue !== undefined && !composing && String(event.detail.value).trim() === '';
  const value = empty ? props.emptyValue : event.detail.value;
  emit('update:modelValue', value);
  if (flag === false) onCompositionEnd(event);
  if (empty) return String(value);
}
function onBlur(event) {
  focused.value = false;
  onCompositionEnd(event);
  if (props.emptyValue !== undefined && String(event.detail?.value ?? props.modelValue ?? '').trim() === '') emit('update:modelValue', props.emptyValue);
  blurKeyboardField(token); sheet?.blur(token); emit('blur', event);
}
function keyboardChange(event) { sheet?.keyboard(event.detail, token); }
onUnmounted(() => { blurKeyboardField(token); sheet?.blur(token); });
</script>

<template>
  <view class="form-field" data-keyboard-field="true" mark:keyboardfield="true" :class="{ 'field-invalid': error, 'form-field-material': variant === 'material', 'is-focused': focused }" :aria-invalid="Boolean(error)" @click.stop>
    <textarea v-if="multiline" data-keyboard-field="true" style="resize: none" :class="fieldClass" :value="modelValue" :placeholder="placeholder" :aria-label="ariaLabel" :aria-invalid="Boolean(error)" :aria-describedby="error ? errorElementId : undefined" :maxlength="maxlength" :disabled="disabled" :focus="focus" :fixed="Boolean(sheet)" :adjust-position="!sheet" :cursor-spacing="24" :disable-default-padding="true" :show-confirm-bar="false" :hold-keyboard="false" @input="onInput" @compositionstart="onCompositionStart" @compositionend="onCompositionEnd" @focus="onFocus" @blur="onBlur" @keyboardheightchange="keyboardChange" />
    <input v-else data-keyboard-field="true" :class="fieldClass" :value="modelValue" :placeholder="placeholder" :aria-label="ariaLabel" :aria-invalid="Boolean(error)" :aria-describedby="error ? errorElementId : undefined" :maxlength="maxlength" :disabled="disabled" :focus="focus" :type="type" :always-embed="true" :adjust-position="!sheet" :cursor-spacing="24" :hold-keyboard="false" @input="onInput" @compositionstart="onCompositionStart" @compositionend="onCompositionEnd" @focus="onFocus" @blur="onBlur" @keyboardheightchange="keyboardChange" />
    <text v-if="error && !externalError" :id="errorElementId" class="field-error" role="alert">{{ error }}</text>
  </view>
</template>
