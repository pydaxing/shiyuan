<script setup>
import { computed, getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import FormField from './FormField.vue';
import MenuSwipeRow from './MenuSwipeRow.vue';
import HomeWelcome from './HomeWelcome.vue';
import { familyAppearance } from '../domain/family.js';
import { sheetOpen } from '../composables/sheetStack.js';
import { dismissFocusedKeyboard } from '../services/keyboard.js';
import { afterNativeRender } from '../composables/nativeRender.js';
import { HOME_MENU_CATEGORIES, firstHomeMenuCategory, groupHomeMenu, homeMenuCategoryAtScroll } from '../domain/home-menu.js';

const props = defineProps({ entries: Array, selected: Object, category: String, search: String, cover: String, coverTitle: String, dateLabel: String, busy: Boolean, sharing: Boolean, scrollInset: { type: Number, default: 16 }, docked: Boolean, active: { type: Boolean, default: true } });
const emit = defineEmits(['update:category', 'update:search', 'open', 'toggle', 'create', 'edit-entry', 'share-entry', 'remove-entry', 'discover', 'layout', 'dock', 'page-drag']);
const instance = getCurrentInstance();
const openedKey = ref('');
const query = computed(() => (props.search || '').trim());
const groups = computed(() => groupHomeMenu(props.entries, query.value));
const visibleGroups = computed(() => groups.value.filter(group => group.entries.length));
const emptyMenu = computed(() => !props.entries.length);
const menuAppearance = computed(() => familyAppearance(props));
const listInset = computed(() => Math.max(0, props.scrollInset ?? 16));
const railContentHeight = ref(HOME_MENU_CATEGORIES.length * 48);
const listOriginTop = ref(null);
const menuStyle = computed(() => ({ '--home-menu-list-top': `${listInset.value}px`, '--home-menu-rail-content-height': `${railContentHeight.value}px`, ...(listOriginTop.value === null ? {} : { '--home-menu-origin-top': `${listOriginTop.value}px` }) }));
const listScrollTarget = ref(0);
const navigating = ref(false);
const scrollEnabled = computed(() => props.active && !sheetOpen.value && (props.docked || navigating.value));
const resultCount = computed(() => groups.value.reduce((count, group) => count + group.entries.length, 0));
const railTarget = computed(() => `home-menu-tab-${Math.max(0, HOME_MENU_CATEGORIES.indexOf(props.category))}`);
let positions = [];
let lastScrollTop = 0;
let lastPageTop = 0;
let searchFocused = false;
let searchSnapshot = null;
let inactivePosition = null;
let pinnedPosition = null;
let navigationRevision = 0;
let pendingLayout = null;
let disposed = false;

function refreshLayout() {
  if (pendingLayout) return pendingLayout;
  pendingLayout = afterNativeRender().then(() => {
    if (disposed || sheetOpen.value || !props.active) return [];
    return new Promise(resolve => {
      const selector = uni.createSelectorQuery().in(instance.proxy);
      selector.selectAll('.home-menu-group').boundingClientRect();
      selector.select('.home-menu-sections').scrollOffset();
      selector.select('.home-menu-sections').boundingClientRect();
      selector.select('.home-menu-category-items').boundingClientRect();
      selector.selectViewport().scrollOffset();
      selector.exec(result => {
        if (disposed || sheetOpen.value || !props.active) return resolve([]);
        lastScrollTop = result?.[1]?.scrollTop ?? lastScrollTop;
        if (result?.[3]?.height > 0) railContentHeight.value = result[3].height;
        if (Number.isFinite(result?.[2]?.top) && Number.isFinite(result?.[4]?.scrollTop)) listOriginTop.value = Math.max(0, result[2].top + result[4].scrollTop);
        positions = (result?.[0] || []).flatMap(rect => {
          const group = visibleGroups.value.find(item => item.id === rect.id);
          return group && result?.[2] ? [{ category: group.category, top: rect.top - result[2].top + lastScrollTop }] : [];
        });
        emit('layout');
        resolve(positions);
      });
    });
  }).finally(() => { pendingLayout = null; });
  return pendingLayout;
}

async function moveTo(category, scrollTop) {
  const revision = ++navigationRevision;
  navigating.value = true;
  await refreshLayout();
  if (disposed || revision !== navigationRevision) return;
  if (sheetOpen.value || !props.active) { navigating.value = false; return; }
  const position = positions.find(position => position.category === category);
  if (scrollTop === undefined && !position) {
    pinnedPosition = { category, top: lastScrollTop };
    navigating.value = false;
    return;
  }
  const target = Math.max(0, scrollTop ?? position.top);
  if (scrollTop === undefined) emit('dock');
  listScrollTarget.value = lastScrollTop;
  await afterNativeRender();
  if (disposed || sheetOpen.value || !props.active || revision !== navigationRevision) return;
  listScrollTarget.value = target;
  lastScrollTop = target;
  pinnedPosition = { category, top: target };
  await afterNativeRender();
  if (!disposed && revision === navigationRevision) navigating.value = false;
}

function selectCategory(category) {
  if (!HOME_MENU_CATEGORIES.includes(category)) return;
  openedKey.value = '';
  searchSnapshot = null;
  searchFocused = false;
  dismissFocusedKeyboard();
  emit('update:search', '');
  emit('update:category', category);
  moveTo(category);
}

function onScroll(event) {
  if (sheetOpen.value || !props.active) return;
  if (Math.abs((event.scrollTop || 0) - lastPageTop) > 3) openedKey.value = '';
  lastPageTop = Math.max(0, event.scrollTop || 0);
}

function onListScroll(detail) {
  if (sheetOpen.value || !props.active) return;
  if (Math.abs((detail.scrollTop || 0) - lastScrollTop) > 3) openedKey.value = '';
  lastScrollTop = Math.max(0, detail.scrollTop || 0);
  if (navigating.value || query.value || searchFocused) return;
  if (pinnedPosition && Math.abs(lastScrollTop - pinnedPosition.top) < 3) return;
  pinnedPosition = null;
  const category = homeMenuCategoryAtScroll(positions, lastScrollTop, 8);
  if (category && category !== props.category) emit('update:category', category);
}

function scrollPage(payload) {
  if (!sheetOpen.value && props.active) emit('page-drag', payload);
}

function beginSearch() {
  openedKey.value = '';
  if (!query.value) searchSnapshot = { category: props.category, top: lastScrollTop };
  searchFocused = true;
}

function clearSearch() {
  searchFocused = false;
  dismissFocusedKeyboard();
  emit('update:search', '');
}

function closeMenuActions() { openedKey.value = ''; }

function performEntryAction(action, entry) {
  if (action !== 'share-entry') closeMenuActions();
  dismissFocusedKeyboard();
  emit(action, entry);
}

function openCreateOptions() {
  if (props.busy) return;
  openedKey.value = '';
  dismissFocusedKeyboard();
  emit('create', props.category);
}

function reset(category = '') {
  openedKey.value = '';
  searchSnapshot = null;
  searchFocused = false;
  emit('update:search', '');
  const target = HOME_MENU_CATEGORIES.includes(category) ? category : firstHomeMenuCategory(groupHomeMenu(props.entries));
  emit('update:category', target);
  if (category) moveTo(target);
  else refreshLayout();
}

watch(query, (value, previous) => {
  if (value && !previous && !searchSnapshot) searchSnapshot = { category: props.category, top: lastScrollTop };
  if (value && lastScrollTop > 0) moveTo(props.category, 0);
  if (!value && previous && searchSnapshot) {
    const snapshot = searchSnapshot;
    searchSnapshot = null;
    emit('update:category', snapshot.category);
    moveTo(snapshot.category, snapshot.top);
  }
});
watch(visibleGroups, () => { if (!props.sharing || !visibleGroups.value.some(group => group.entries.some(entry => entry.key === openedKey.value))) openedKey.value = ''; refreshLayout(); }, { flush: 'post' });
watch(() => [props.coverTitle, props.dateLabel], () => refreshLayout(), { flush: 'post' });
watch(listInset, () => refreshLayout(), { flush: 'post' });
watch(() => Object.keys(props.selected || {}).length > 0, () => refreshLayout(), { flush: 'post' });
watch(() => props.active, active => {
  navigationRevision += 1;
  navigating.value = false;
  openedKey.value = '';
  if (!active) { inactivePosition = { category: props.category, top: lastScrollTop }; return; }
  const snapshot = inactivePosition;
  inactivePosition = null;
  if (snapshot) moveTo(snapshot.category, snapshot.top);
  else refreshLayout();
}, { flush: 'sync' });
watch(sheetOpen, locked => { navigationRevision += 1; navigating.value = false; if (locked && !props.sharing) openedKey.value = ''; if (!locked) refreshLayout(); }, { flush: 'sync' });
onMounted(() => { if (!query.value) reset(); else refreshLayout(); });
onUnmounted(() => { disposed = true; navigationRevision += 1; });
defineExpose({ onScroll, onListScroll, scrollPage, refreshLayout, reset, selectCategory });
</script>

<script module="railGesture" lang="wxs">
function begin(event, owner, kind) {
  if (!event.touches || event.touches.length !== 1) return;
  var state = owner.getState();
  var viewport = owner.selectComponent(kind === 'rail' ? '.home-menu-rail-scroll' : '.home-menu-sections');
  var content = owner.selectComponent(kind === 'rail' ? '.home-menu-category-items' : '.home-menu-content');
  state.railStartX = event.touches[0].pageX;
  state.railStartY = event.touches[0].pageY;
  state.railLastY = event.touches[0].pageY;
  state.railMoved = false;
  state.pageGesture = false;
  state[kind + 'ScrollTop'] = state[kind + 'ScrollTop'] || 0;
  state[kind + 'Limit'] = Math.max(0, parseFloat(content.getComputedStyle(['height']).height) - parseFloat(viewport.getComputedStyle(['height']).height));
}
function start(event, owner) { begin(event, owner, 'rail'); }
function listStart(event, owner) { begin(event, owner, 'list'); }
function scroll(event, owner) {
  owner.getState().railScrollTop = event.detail.scrollTop;
}
function listScroll(event, owner) {
  owner.getState().listScrollTop = event.detail.scrollTop;
  owner.callMethod('onListScroll', event.detail);
}
function route(event, owner, kind) {
  if (!event.touches || event.touches.length !== 1) return false;
  var state = owner.getState();
  var data = event.currentTarget.dataset;
  if (data.locked) return false;
  var position = event.touches[0].pageY;
  var movement = state.railLastY - position;
  state.railLastY = position;
  var vertical = Math.abs(position - state.railStartY);
  var horizontal = Math.abs(event.touches[0].pageX - state.railStartX);
  if (vertical >= 8 || horizontal >= 8) state.railMoved = true;
  if (!state.railMoved || horizontal > vertical) return;
  if (!data.docked && !state.pageGesture) return;
  if (state.pageGesture || (movement < 0 && state[kind + 'ScrollTop'] <= 1)) {
    owner.callMethod('scrollPage', { distance: movement, start: !state.pageGesture });
    state.pageGesture = true;
    return false;
  }
  if (state[kind + 'Limit'] <= 0 || (movement > 0 && state[kind + 'ScrollTop'] >= state[kind + 'Limit'] - 1)) return false;
}
function contain(event, owner) { return route(event, owner, 'rail'); }
function listMove(event, owner) { return route(event, owner, 'list'); }
function tap(event, owner) {
  var state = owner.getState();
  if (state.railMoved) { state.railMoved = false; return false; }
  owner.callMethod('selectCategory', event.currentTarget.dataset.category);
  return false;
}
module.exports = { start: start, scroll: scroll, contain: contain, tap: tap, listStart: listStart, listMove: listMove, listScroll: listScroll };
</script>

<template>
  <view class="home-menu" :class="{ 'is-empty': emptyMenu, 'is-searching': Boolean(query) }" :style="menuStyle" @click="closeMenuActions">
    <HomeWelcome v-if="emptyMenu && !query" title="把爱吃的，放进我家菜单" primary-label="创建菜品" primary-icon="plus-inverse" secondary-label="看看美食" secondary-icon="community" :busy="busy" @primary="$emit('create', category, 'dish')" @secondary="$emit('discover')" />
    <template v-else>
    <HomeWelcome compact calendar :cover="cover" :title="menuAppearance.coverTitle" :description="dateLabel" />
    <view class="home-menu-tools">
      <view class="home-menu-search search-wrap">
        <view class="search-leading-icon" aria-hidden="true"><AppIcon name="search" :size="16" /></view>
        <view class="search-input-slot"><FormField :model-value="search" field-class="home-menu-search-input" placeholder="搜菜品、套餐" aria-label="搜索菜品或套餐" @update:model-value="$emit('update:search', $event)" @focus="beginSearch" @blur="searchFocused = false" /></view>
        <view class="search-clear-slot"><button v-if="search" role="button" class="search-clear" aria-label="清空搜索" @click="clearSearch" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="close" :size="16" /></button></view>
      </view>
      <button role="button" class="home-menu-add" aria-label="创建菜品、创建套餐或发现美食" :disabled="busy" @click="openCreateOptions" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="22" active /></button>
    </view>
    <view class="home-menu-layout">
      <view class="home-menu-rail" :data-docked="docked" :data-locked="sheetOpen" @touchstart="railGesture.start" @touchmove="railGesture.contain">
        <scroll-view :scroll-y="scrollEnabled" enhanced :bounces="false" :show-scrollbar="false" :scroll-into-view="railTarget" class="home-menu-rail-scroll" aria-label="菜单分类" @scroll="railGesture.scroll">
          <view class="home-menu-category-items">
            <button v-for="(item, index) in HOME_MENU_CATEGORIES" :id="`home-menu-tab-${index}`" :key="item" role="button" class="home-menu-category" :class="{ active: !query && category === item }" :aria-pressed="!query && category === item" :aria-label="`定位${item}`" :data-category="item" @click="railGesture.tap" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ item }}</button>
          </view>
        </scroll-view>
      </view>
      <view class="home-menu-list" :data-docked="docked" :data-locked="sheetOpen" @touchstart="railGesture.listStart" @touchmove="railGesture.listMove">
      <scroll-view class="home-menu-sections" :scroll-y="scrollEnabled" enhanced :bounces="false" :show-scrollbar="false" :scroll-top="listScrollTarget" :scroll-with-animation="false" aria-label="菜品和套餐列表" @scroll="railGesture.listScroll">
      <view class="home-menu-content">
        <view v-for="group in visibleGroups" :id="group.id" :key="group.category" class="home-menu-group" :aria-label="`${group.category}，${group.entries.length}项`">
          <view class="home-menu-group-heading" role="heading" aria-level="2">{{ group.category }}</view>
          <MenuSwipeRow v-for="entry in group.entries" :key="entry.key" :entry="entry" :selected="Boolean(selected[entry.key])" :opened="openedKey === entry.key" :busy="busy" :sharing="sharing" @activate="openedKey = entry.key" @close="openedKey === entry.key && (openedKey = '')" @open="performEntryAction('open', $event)" @toggle="performEntryAction('toggle', $event)" @edit="performEntryAction('edit-entry', $event)" @share="performEntryAction('share-entry', $event)" @remove="performEntryAction('remove-entry', $event)" />
        </view>
      </view>
      </scroll-view>
      </view>
      <view v-if="query && !resultCount" class="home-menu-empty" role="status"><text>没有找到相关菜品或套餐</text><text class="search-empty-hint">换一换试试</text></view>
    </view>
    </template>
  </view>
</template>

<style scoped>
.home-menu { --food-row-padding: 2px; --food-row-height: calc(var(--food-row-content-height) + var(--food-row-padding) + var(--food-row-padding)); --home-menu-rail-height: max(48px, min(var(--home-menu-rail-content-height), calc(100vh - var(--home-menu-list-top) - var(--home-menu-bottom-inset)))); --home-menu-viewport-height: max(var(--home-menu-rail-height), calc(100vh - var(--home-menu-origin-top, 100vh) - var(--home-menu-bottom-inset))); min-width: 0; }
.home-menu-tools { position: relative; z-index: 11; height: var(--home-menu-tools-height); margin-left: calc(0px - var(--page-gutter)); margin-right: calc(0px - var(--page-gutter)); padding-left: var(--page-gutter); padding-right: var(--page-gutter); background: var(--white); }
.home-menu-layout { --home-menu-rail-width: 64px; position: relative; display: flex; align-items: flex-start; gap: 14px; height: var(--home-menu-viewport-height); }
.home-menu-rail { flex: 0 0 var(--home-menu-rail-width); min-width: 0; height: var(--home-menu-rail-height); background: var(--white); }
.home-menu-rail-scroll, .home-menu-sections { height: 100%; overscroll-behavior-y: contain; }
.home-menu-rail-scroll :deep(.uni-scroll-view), .home-menu-sections :deep(.uni-scroll-view) { overscroll-behavior-y: contain; }
.home-menu-category { position: relative; display: flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; padding: 12px 6px; color: var(--muted); font-size: var(--type-control); border-radius: var(--radius-control); line-height: 24px; white-space: nowrap; }
.home-menu-category.active { color: var(--green); background: var(--green-light); font-weight: 600; }
.home-menu-category.active::before { content: ''; position: absolute; left: 0; top: 14px; width: 3px; height: 20px; border-radius: 2px; background: var(--green); }
.home-menu-category:focus-visible { outline-offset: -3px; }
.home-menu-list { flex: 1; min-width: 0; height: 100%; }
.home-menu-content { min-height: var(--home-menu-viewport-height); }
.home-menu.is-empty .home-menu-content { display: flex; flex-direction: column; }
.home-menu:not(.is-searching) .home-menu-group:last-child { min-height: var(--home-menu-viewport-height); }
.home-menu-group + .home-menu-group { margin-top: 4px; }
.home-menu-group-heading { padding: 2px 0 8px; color: var(--ink); font-size: var(--type-control); font-weight: 600; line-height: 20px; }
.home-menu-empty { position: absolute; top: 0; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; gap: 8px; padding: 36px 8px 24px; color: var(--ink); font-size: var(--type-control); text-align: center; pointer-events: none; }
@media (min-width: 761px) {
  .home-menu-layout { --home-menu-rail-width: 88px; gap: 24px; }
}
@media (max-width: 374px) {
  .home-menu-layout { --home-menu-rail-width: 56px; gap: 12px; }
}
@media (hover: hover) and (pointer: fine) { .home-menu-category:not(.active):hover { color: var(--ink); background: var(--control-hover); } }
</style>
