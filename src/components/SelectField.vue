<script setup>
import AppIcon from './AppIcon.vue';
import FieldError from './FieldError.vue';
import { computed, getCurrentInstance, nextTick, onUnmounted, ref, watch } from 'vue';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { afterNativeRender } from '../composables/nativeRender.js';
import { selectDropdownGeometry } from '../domain/select-dropdown.js';
import Sheet from './Sheet.vue';
const props = defineProps({ modelValue: String, options: Array, label: String, error: String, disabled: Boolean, centered: Boolean, variant: String, active: Boolean, tabindex: { type: Number, default: 0 } });
const emit = defineEmits(['update:modelValue', 'open-change']);
const open = ref(false);
const instance = getCurrentInstance();
const triggerRef = ref(null);
const dropdownRef = ref(null);
const dropdownLayout = ref(null);
const highlighted = ref(0);
const dropdownId = `select-dropdown-${instance?.uid ?? 0}`;
const fieldError = ref(null);
const errorId = `select-error-${instance?.uid ?? 0}`;
defineExpose({ reveal() { fieldError.value?.reveal(); } });
const dropdownStyle = computed(() => dropdownLayout.value ? Object.fromEntries(Object.entries(dropdownLayout.value).map(([key, value]) => [key, `${value}px`])) : {});
let layoutRequest = 0;
let disposed = false;

function focusElement(element) {
  const target = element?.$el || element;
  target?.focus?.({ preventScroll: true });
}
async function focusOption() {
  await nextTick();
  if (!open.value || disposed) return;
  const target = dropdownRef.value?.$el || dropdownRef.value;
  focusElement(target?.querySelectorAll?.('[role="option"]')[highlighted.value]);
}
function close(restoreFocus = true) {
  open.value = false;
  if (props.variant === 'feed' && restoreFocus) focusElement(triggerRef.value);
}
async function positionDropdown() {
  const request = ++layoutRequest;
  await afterNativeRender();
  if (disposed || !open.value || props.variant !== 'feed') return;
  const anchor = await new Promise(resolve => {
    const query = uni.createSelectorQuery();
    if (instance) query.in(instance.proxy);
    query.select('.choice-trigger').boundingClientRect(resolve).exec();
  });
  if (disposed || !open.value || request !== layoutRequest) return;
  dropdownLayout.value = selectDropdownGeometry(anchor, uni.getWindowInfo?.() || uni.getSystemInfoSync(), props.options.length);
  if (!dropdownLayout.value) close(false);
}
watch(open, value => {
  if (props.variant !== 'feed') return;
  emit('open-change', value);
  if (value) uni.onWindowResize?.(positionDropdown);
  else { layoutRequest += 1; dropdownLayout.value = null; uni.offWindowResize?.(positionDropdown); }
}, { flush: 'sync' });
watch(() => props.disabled, value => { if (value) close(false); });
function choose(value) { emit('update:modelValue', value); close(); }
async function show(event) {
  if (props.disabled) return;
  if (props.variant === 'feed' && open.value) { close(); return; }
  dismissFocusedKeyboard();
  highlighted.value = props.active ? Math.max(0, props.options.indexOf(props.modelValue)) : 0;
  open.value = true;
  if (props.variant === 'feed') {
    await positionDropdown();
    if (event?.detail === 0) focusOption();
  }
}
async function onDropdownKey(event) {
  if (props.variant !== 'feed') return;
  if (event.key === 'Tab') { if (open.value) close(); return; }
  if (event.key === 'Escape') { event.preventDefault(); close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (!open.value) { await show(); if (event.key === 'ArrowUp' || event.key === 'End') highlighted.value = props.options.length - 1; }
  else if (event.key === 'Home') highlighted.value = 0;
  else if (event.key === 'End') highlighted.value = props.options.length - 1;
  else {
    const step = { ArrowDown: 2, ArrowUp: -2, ArrowLeft: -1, ArrowRight: 1 }[event.key];
    highlighted.value = Math.max(0, Math.min(props.options.length - 1, highlighted.value + step));
  }
  focusOption();
}
onUnmounted(() => {
  disposed = true;
  layoutRequest += 1;
  if (props.variant === 'feed') {
    uni.offWindowResize?.(positionDropdown);
    if (open.value) emit('open-change', false);
  }
});
</script>

<template>
  <view :class="{ 'community-category-select': variant === 'feed', 'field-invalid': error }"><button ref="triggerRef" role="button" class="choice-trigger" :class="variant === 'feed' ? { 'community-filter-trigger': true, active } : { input: true, centered }" :aria-label="label" :aria-invalid="Boolean(error)" :aria-describedby="error ? errorId : undefined" :aria-expanded="open" :aria-haspopup="variant === 'feed' ? 'listbox' : 'dialog'" :aria-controls="variant === 'feed' && open ? dropdownId : undefined" :aria-pressed="variant === 'feed' ? active : undefined" :tabindex="tabindex" :disabled="disabled" @click="show" @keydown="onDropdownKey" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="choice-label">{{ props.modelValue }}</text><view v-if="variant === 'feed'" class="feed-filter-chevron" :class="{ 'is-open': open }" aria-hidden="true" /><AppIcon v-else-if="!centered" name="chevron" class="choice-chevron" /></button>
    <FieldError ref="fieldError" :error="error" :error-id="errorId" />
    <Sheet v-if="open && variant !== 'feed'" :title="label" :preferred-height="['units', 'categories'].includes(variant) ? 0 : 156 + Math.ceil(options.length / 2) * 70" @close="close"><view class="choice-options" :class="{ 'choice-options-units': variant === 'units', 'choice-options-categories': variant === 'categories' }"><button role="button" v-for="option in options" :key="option" :aria-pressed="modelValue === option" :class="{ selected: modelValue === option }" @click="$feedback(); choose(option)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>{{ option }}</text><AppIcon v-if="modelValue === option" name="check" active /></button></view></Sheet>
    <!-- #ifdef H5 -->
    <Teleport to="body">
    <!-- #endif -->
    <!-- #ifdef MP-WEIXIN -->
    <root-portal>
    <!-- #endif -->
    <view v-if="variant === 'feed' && open && dropdownLayout" class="app-shell select-dropdown-root">
      <view class="select-dropdown-backdrop" aria-hidden="true" @click.stop="close()" @touchmove.stop.prevent />
      <view ref="dropdownRef" class="select-dropdown-popover" :style="dropdownStyle" @click.stop @keydown="onDropdownKey">
        <scroll-view :id="dropdownId" class="select-dropdown-scroll" scroll-y enhanced :bounces="false" role="listbox" :aria-label="label">
          <view class="select-dropdown-options">
            <button v-for="(option, index) in options" :key="option" role="option" class="select-dropdown-option" :class="{ selected: active && modelValue === option }" :aria-selected="active && modelValue === option" :tabindex="highlighted === index ? 0 : -1" @focus="highlighted = index" @click="$feedback(); choose(option)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>{{ option }}</text><AppIcon v-if="active && modelValue === option" name="check" :size="11" active /></button>
          </view>
        </scroll-view>
      </view>
    </view>
    <!-- #ifdef MP-WEIXIN -->
    </root-portal>
    <!-- #endif -->
    <!-- #ifdef H5 -->
    </Teleport>
    <!-- #endif -->
  </view>
</template>
