<script setup>
import { computed, ref, watch } from 'vue';
import Sheet from './Sheet.vue';
import StockEditor from './StockEditor.vue';
import StockAmountSheet from './StockAmountSheet.vue';
import FormField from './FormField.vue';
import AppIcon from './AppIcon.vue';
import { ingredientSuggestions, INGREDIENT_CATEGORIES, COMMON_INGREDIENTS } from '../domain/ingredient-catalog.js';
import { stockReminder } from '../domain/stock-reminders.js';
import { state } from '../store.js';
const props = defineProps({ initial: { type: Object, default: () => ({}) } });
const emit = defineEmits(['close', 'saved']);
const query = ref('');
const sheet = ref(null);
const resultScroll = ref(0);
const category = ref('常用');
const limit = ref(40);
const editor = ref(null);
const selected = ref(null);
const categories = ['常用', ...INGREDIENT_CATEGORIES];
const searching = computed(() => Boolean(query.value.trim()));
const matches = computed(() => ingredientSuggestions(query.value, state.value, !searching.value && category.value === '常用' ? 40 : COMMON_INGREDIENTS.length, searching.value || category.value === '常用' ? '全部' : category.value));
const suggestions = computed(() => matches.value.slice(0, limit.value).map(entry => {
  const location = targetLocation.value || entry.location;
  const { days } = stockReminder(entry, location);
  return { ...entry, displayLocation: location, reminderLabel: days === 0 ? '建议今天用完' : `预计保存 ${days} 天` };
}));
const targetLocation = computed(() => props.initial.useCatalogLocation ? undefined : props.initial.location);
watch([query, category], async () => { limit.value = 40; resultScroll.value = 1; await Promise.resolve(); resultScroll.value = 0; });
function choose(entry) { selected.value = entry; }
function more() { limit.value += 40; }
function custom() {
  const location = targetLocation.value || '冷藏';
  editor.value = { name: query.value.trim(), location, expiresOn: stockReminder(null, location).date, estimatedReminder: true };
}
</script>

<template>
  <StockEditor v-if="editor" :initial="editor" @close="editor = null" @saved="$emit('saved')" />
  <StockAmountSheet v-else-if="selected" :entry="selected" :location="targetLocation" @close="selected = null" @saved="$emit('saved')" />
  <Sheet v-else ref="sheet" title="放入冰箱" :fit-content="false" :footer-visible="false" @close="$emit('close')">
    <view class="stock-search"><AppIcon name="search" :size="20" /><view class="search-input-slot"><FormField v-model="query" field-class="stock-search-input" placeholder="搜索全部食材" aria-label="搜索全部食材" maxlength="30" /></view><button v-if="query" class="search-clear" aria-label="清空食材搜索" @click="query = ''"><AppIcon name="close" :size="16" /></button><button class="picker-manual" aria-label="手动添加食材" @click="custom" hover-class="touch-feedback"><AppIcon name="plus" :size="20" /></button></view>
    <view class="picker-browser"><scroll-view scroll-y enhanced :bounces="false" :show-scrollbar="false" class="ingredient-categories"><view class="ingredient-category-track"><button v-for="item in categories" :key="item" class="ingredient-category" :class="{ active: !searching && category === item }" :aria-pressed="!searching && category === item" @click="category = item" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ item }}</button></view></scroll-view>
    <scroll-view scroll-y enhanced :bounces="false" :show-scrollbar="false" :scroll-top="resultScroll" class="picker-results"><view class="picker-heading"><text>{{ searching ? '全部食材中的结果' : category === '常用' ? '常用食材' : category }}</text></view>
    <view v-if="suggestions.length" class="picker-grid">
      <button v-for="entry in suggestions" :key="entry.name" class="picker-card" :aria-label="`选择${entry.name}`" @click="choose(entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <image class="ingredient-art" :src="$image(entry.image)" mode="aspectFit" lazy-load aria-hidden="true" />
        <view class="ingredient-copy"><view class="ingredient-name-line"><text class="ingredient-name">{{ entry.name }}</text></view><view class="ingredient-meta"><text class="ingredient-storage">{{ entry.displayLocation }}</text><text class="ingredient-category-label">{{ entry.reminderLabel }}</text></view></view>
      </button>
      <button v-if="suggestions.length < matches.length" class="text-button picker-more" @click="more" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">加载更多 · 已显示 {{ suggestions.length }} 种</button>
    </view>
    <view v-else class="ingredient-miss"><AppIcon name="search" :size="32" /><text class="ingredient-miss-title">暂未找到这个食材</text><button class="secondary-button" @click="custom" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="18" />添加这个食材</button></view>
    </scroll-view></view>

  </Sheet>
</template>
<style scoped>
.stock-search { min-height: 44px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 2px 14px; border-radius: 999px; background: var(--paper); color: var(--muted); }
.stock-search :deep(.form-field) { flex: 1; min-width: 0; }
.stock-search :deep(.stock-search-input) { height: 42px; font-size: var(--type-body); width: 100%; }
.picker-manual { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 36px; height: 36px; padding: 0; margin: 0; border-radius: 50%; background: var(--green); color: var(--white); }
.picker-browser { display: flex; gap: 14px; margin-top: 16px; height: calc(100vh - 270px); min-height: 280px; }
.ingredient-categories { width: 64px; flex-shrink: 0; height: 100%; background: var(--white); }
.ingredient-category-track { display: flex; flex-direction: column; padding: 0; gap: 0; }
.ingredient-category { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; margin: 0; padding: 12px 6px; color: var(--muted); font-size: var(--type-control); border-radius: var(--radius-control); background: transparent; line-height: 24px; white-space: nowrap; }
.ingredient-category.active { color: var(--green); background: var(--green-light); font-weight: 600; }
.ingredient-category.active::before { content: ''; position: absolute; left: 0; top: 14px; width: 3px; height: 20px; border-radius: 2px; background: var(--green); }
.ingredient-category:focus-visible { outline-offset: -3px; }
.picker-results { flex: 1; width: 0; height: 100%; min-width: 0; }
.picker-heading { display: flex; justify-content: space-between; align-items: center; gap: 4px; margin: 2px 0 12px; font-size: var(--type-control); font-weight: 600; }
.picker-hint { flex-shrink: 0; font-size: var(--type-caption); font-weight: 400; color: var(--muted); }
.picker-note { display: block; color: var(--muted); font-size: var(--type-caption); line-height: 1.5; text-align: center; }
.picker-grid { display: flex; flex-direction: column; gap: 2px; padding-bottom: 8px; }
.picker-card { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 70px; box-sizing: border-box; margin: 0; padding: 5px 0; border: 0; border-radius: 0; background: var(--white); color: var(--ink); text-align: left; line-height: 1.5; }
.ingredient-art { display: block; width: 60px; height: 60px; flex-shrink: 0; }
.ingredient-copy { min-width: 0; flex: 1; }
.ingredient-name { display: block; min-width: 0; font-family: var(--font-display); font-size: var(--type-list); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ingredient-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 6px; font-size: var(--type-caption); color: var(--muted); }
.ingredient-storage { color: var(--green); background: var(--green-light); padding: 0 5px; border-radius: var(--radius-subtle); }
.ingredient-miss { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 45px 4px; color: var(--muted); font-size: var(--type-meta); text-align: center; }
.ingredient-miss-title { color: var(--ink); font-size: var(--type-control); overflow-wrap: anywhere; }
.picker-custom, .picker-more { display: flex; align-items: center; justify-content: center; width: 100%; text-align: center; min-height: 44px; }
</style>
