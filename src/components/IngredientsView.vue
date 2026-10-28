<script setup>
import { computed, ref, watch } from 'vue';
import { familyFeatures } from '../store.js';
import PageHeader from './PageHeader.vue';
import InventoryView from './InventoryView.vue';
import ShoppingView from './ShoppingView.vue';
import AppIcon from './AppIcon.vue';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { tapFeedback } from '../services/feedback.js';
import { localDate } from '../domain/kitchen.js';

const props = defineProps({ modelValue: { type: String, default: 'shopping' }, today: { type: String, default: localDate }, focusOrder: { type: Object, default: null } });
const emit = defineEmits(['update:modelValue', 'open', 'discover']);
const fridgeEnabled = computed(() => Boolean(familyFeatures.value.fridge));
const currentSection = computed(() => fridgeEnabled.value && props.modelValue === 'inventory' ? 'inventory' : 'shopping');
const visited = ref({ inventory: props.modelValue === 'inventory', shopping: props.modelValue === 'shopping' });
watch(fridgeEnabled, enabled => { if (!enabled && props.modelValue !== 'shopping') emit('update:modelValue', 'shopping'); }, { immediate: true });
watch(currentSection, section => { visited.value[section] = true; });

function selectSection(section) {
  if (currentSection.value === section || (section === 'inventory' && !fridgeEnabled.value)) return;
  dismissFocusedKeyboard();
  tapFeedback();
  visited.value[section] = true;
  emit('update:modelValue', section);
  uni.pageScrollTo({ scrollTop: 0, duration: 0 });
}
</script>

<template>
  <view class="ingredients-view">
    <PageHeader :title="fridgeEnabled ? '食材' : '采购'" />
    <view v-if="fridgeEnabled" class="menu-segments ingredients-segments" role="tablist" aria-label="采购与冰箱">
      <button role="tab" :class="{ selected: currentSection === 'shopping' }" :aria-selected="currentSection === 'shopping'" aria-label="采购" @click="selectSection('shopping')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="shopping" :active="currentSection === 'shopping'" :size="20" /><text class="segment-label">采购</text></button>
      <button role="tab" :class="{ selected: currentSection === 'inventory' }" :aria-selected="currentSection === 'inventory'" aria-label="冰箱" @click="selectSection('inventory')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="inventory" :active="currentSection === 'inventory'" :size="20" /><text class="segment-label">冰箱</text></button>
    </view>
    <InventoryView v-if="fridgeEnabled && (visited.inventory || currentSection === 'inventory')" v-show="currentSection === 'inventory'" embedded :today="today" />
    <ShoppingView v-if="visited.shopping || currentSection === 'shopping'" v-show="currentSection === 'shopping'" embedded :active="currentSection === 'shopping'" :today="today" :focus-order="focusOrder" @open="$emit('open', $event)" @discover="$emit('discover')" />
  </view>
</template>

<style scoped>
.ingredients-segments { margin-bottom: 18px; }
</style>
