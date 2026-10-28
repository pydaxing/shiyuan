<script setup>
import { computed, ref, watch } from 'vue';
import Sheet from './Sheet.vue';
import AppIcon from './AppIcon.vue';
import FormField from './FormField.vue';
import FoodThumbnail from './FoodThumbnail.vue';
import { mealDateLabel, reservationDays } from '../domain/kitchen.js';
import { mealAdditionOptions, mealAdditionCart, mealAdditionCount } from '../domain/meal-additions.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
const props = defineProps({ order: Object, entries: Array, memberId: String, today: String, saving: Boolean, error: String });
const emit = defineEmits(['close', 'save']);
const sheet = ref(null);
const search = ref('');
const selected = ref({});
const options = computed(() => mealAdditionOptions(props.entries || [], props.order, props.memberId));
const cart = computed(() => mealAdditionCart(selected.value, options.value));
const count = computed(() => mealAdditionCount(cart.value, options.value));
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  return options.value.filter((entry) => [entry.title, entry.label].join(' ').toLocaleLowerCase().includes(query));
});
const locked = computed(() => !['pending', 'accepted'].includes(props.order?.status) || !reservationDays(props.today).some((day) => day.date === props.order?.date));
const notice = computed(() => locked.value
  ? '这餐已结束、取消或不在可点餐日期内，请返回厨房查看。'
  : '');
watch([() => props.order?.id, () => props.memberId], () => { selected.value = {}; search.value = ''; });
watch(search, () => sheet.value?.resetScroll({ preserveFocus: true }), { flush: 'post' });
function clearSearch() { search.value = ''; dismissFocusedKeyboard(); }
function toggle(entry) {
  if (locked.value || props.saving || entry.alreadySelected) return;
  const next = { ...cart.value };
  if (next[entry.key]) delete next[entry.key]; else next[entry.key] = 1;
  selected.value = next;
}
function save() { if (!locked.value && !props.saving && count.value) emit('save', { ...cart.value }); }
</script>

<template>
  <Sheet ref="sheet" title="给这餐加菜" :preferred-height="640" :fit-content="false" @close="!saving && $emit('close')">
    <view class="meal-addition-summary"><text v-if="order" class="subheading">{{ mealDateLabel(order.date, today) }} · {{ order.meal }} · {{ order.items.length }} 道菜</text><text v-if="notice" class="meal-addition-notice" role="status">{{ notice }}</text></view>
    <view class="meal-addition-tools">
      <view class="meal-addition-search search-wrap" @click.stop>
        <view class="search-leading-icon" aria-hidden="true"><AppIcon name="search" :size="16" /></view>
        <view class="search-input-slot"><FormField v-model="search" field-class="search-input" placeholder="搜菜品、套餐" aria-label="搜索可加的菜品或套餐" /></view>
        <view class="search-clear-slot"><button v-if="search" role="button" class="search-clear" aria-label="清空加菜搜索" @click="clearSearch" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" :size="16" /></button></view>
      </view>
    </view>
    <view class="meal-addition-list">
      <button v-for="entry in filtered" :key="entry.key" role="button" class="meal-addition-row" :class="{ selected: cart[entry.key], 'already-selected': entry.alreadySelected, 'is-disabled': locked || saving || entry.alreadySelected }" :disabled="locked || saving || entry.alreadySelected" :aria-label="`${entry.title}，${entry.alreadySelected ? '你已点过' : cart[entry.key] ? '取消加菜' : '加到这餐'}`" :aria-pressed="Boolean(cart[entry.key])" @click="toggle(entry)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">
        <FoodThumbnail :src="entry.image" :kind="entry.kind" />
        <view class="meal-addition-copy"><text class="stock-name food-list-title">{{ entry.title }}</text><view class="meal-addition-meta"><text class="home-menu-item-category">{{ entry.label }}</text><text v-if="entry.kind === 'set'">{{ entry.recipes.length }} 道菜</text><text v-else-if="entry.inMeal && !entry.alreadySelected">家人已点</text></view></view>
        <text v-if="entry.alreadySelected" class="meal-addition-owned">已点</text><view v-else class="pick-check"><AppIcon :name="cart[entry.key] ? 'check-inverse' : 'plus'" :size="18" /></view>
      </button>
      <view v-if="!filtered.length" class="meal-addition-empty" role="status"><text>{{ options.length ? '没有找到相关菜品或套餐' : '家里还没有菜品' }}</text><text class="search-empty-hint">{{ options.length ? '换一换试试' : '先把喜欢的菜加入我家菜单吧' }}</text></view>
    </view>
    <template #footer><text v-if="error" class="error-message" role="alert">{{ error }}</text><button role="button" class="primary-button full" :disabled="locked || saving || !count" @click="save" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ saving ? '正在加菜…' : count ? `确认加菜 · ${count} 道` : '选择想加的菜' }}</button></template>
  </Sheet>
</template>

<style scoped>
.meal-addition-summary { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.meal-addition-notice { color: var(--warning); font-size: var(--type-meta); line-height: 1.6; }
.meal-addition-tools { display: flex; align-items: center; padding-bottom: 6px; }
.meal-addition-list { display: flex; flex-direction: column; }
.meal-addition-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 64px; padding: var(--food-row-padding) 0; text-align: left; background: transparent; border-radius: 0; border: 0; }
.meal-addition-row.is-disabled { color: var(--ink); background: transparent; }
.meal-addition-copy { flex: 1; min-width: 0; }
.meal-addition-copy .stock-name { line-height: 1.45; overflow-wrap: anywhere; }
.meal-addition-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; color: var(--muted); font-size: var(--type-caption); }
.meal-addition-owned { color: var(--muted); font-size: var(--type-meta); flex-shrink: 0; min-width: 32px; text-align: center; }
.meal-addition-row .pick-check { display: flex; align-items: center; justify-content: center; flex: 0 0 28px; height: 28px; margin: 0 2px; border: 1px solid var(--border-strong); border-radius: 50%; }
.meal-addition-row.selected .pick-check { background: var(--green); border-color: var(--green); }
.meal-addition-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px 8px 24px; text-align: center; color: var(--ink); font-size: var(--type-control); line-height: 20px; }
</style>
