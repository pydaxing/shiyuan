<script setup>
import { NATIVE_UI_COLORS } from '../../domain/ui-theme.js';
import { mainNavigation } from '../../domain/navigation.js';
import FormField from '../../components/FormField.vue';
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';
import { onShow, onPageScroll, onReachBottom, onResize, onShareAppMessage } from '@dcloudio/uni-app';
import { shareMessage } from '../../services/native-share.js';
import FriendShareSheet from '../../components/FriendShareSheet.vue';
import { useFriendShare } from '../../composables/useFriendShare.js';
import { tapFeedback } from '../../services/feedback.js';
import { dismissFocusedKeyboard } from '../../services/keyboard.js';
import { isPendingRecord, presentMutation } from '../../services/mutation-feedback.js';
import { state, familyFeatures, storageError, cloudMode, cloudStatus, connectCloud, submitOrder, addOrderDishes, removeOrderDish, updateOrder, removeOrder, removeFamilyEntry, runAction, notify } from '../../store.js';
import CloudConnection from '../../components/CloudConnection.vue';
import MutationSyncStatus from '../../components/MutationSyncStatus.vue';
import { mutationStatus } from '../../services/cloud.js';
import { CATEGORIES, localDate, reservationDays, mealDateLabel, kitchenOrders } from '../../domain/kitchen.js';
import { preparationMeals } from '../../domain/meal-preparation.js';
import { shoppingCartMeals } from '../../domain/meal-shopping.js';
import MealPreparationSheet from '../../components/MealPreparationSheet.vue';
import Sheet from '../../components/Sheet.vue';
import RecipeSheet from '../../components/RecipeSheet.vue';
import RecipeEditor from '../../components/RecipeEditor.vue';
import SetEditor from '../../components/SetEditor.vue';
import SetSheet from '../../components/SetSheet.vue';
import ShareSheet from '../../components/ShareSheet.vue';
import IngredientsView from '../../components/IngredientsView.vue';
import CommunityView from '../../components/CommunityView.vue';
import FamilyView from '../../components/FamilyView.vue';
import FamilyEditor from '../../components/FamilyEditor.vue';
import AppIcon from '../../components/AppIcon.vue';
import MealBar from '../../components/MealBar.vue';
import PageHeader from '../../components/PageHeader.vue';
import HomeMenu from '../../components/HomeMenu.vue';
import HomeWelcome from '../../components/HomeWelcome.vue';
import { kitchenWelcome, homeDateLabel } from '../../domain/home-welcome.js';
import MealDishList from '../../components/MealDishList.vue';
import OrderActionMenu from '../../components/OrderActionMenu.vue';
import AddDishesSheet from '../../components/AddDishesSheet.vue';
import { sheetOpen } from '../../composables/sheetStack.js';
import { usePageLock } from '../../composables/usePageLock.js';
import { mealDishRows, removeDishSelection } from '../../domain/presentation.js';
import { useMealDraft } from '../../composables/useMealDraft.js';
import { checkoutPresentation } from '../../domain/checkout.js';
import { useKitchenFocus, kitchenOrderAnchor } from '../../composables/useKitchenFocus.js';
import { useHomeMenuViewport } from '../../composables/useHomeMenuViewport.js';

const tab = ref('menu');
const homeMenu = ref(null);
const ingredientSection = ref('shopping');
const preparingOrderId = ref('');
const shoppingFocusRequest = ref(null);
const homeViewport = useHomeMenuViewport(computed(() => tab.value === 'menu' && (!cloudMode || cloudStatus.value.phase === 'ready')), sheetOpen);
const { listInset: menuListInset, docked: menuDocked } = homeViewport;
const pageLock = usePageLock(sheetOpen, (scrollTop) => uni.pageScrollTo({ scrollTop, duration: 0 }));
onPageScroll(event => { pageLock.onScroll(event); homeMenu.value?.onScroll(event); homeViewport.onScroll(event); if (tab.value === 'community') communityView.value?.onScroll(event); });
onResize(() => { homeViewport.refresh(); homeMenu.value?.refreshLayout(); });
const communityView = ref(null);
const communityVisited = ref(false);
watch(tab, value => { if (value === 'community') communityVisited.value = true; }, { immediate: true });
onReachBottom(() => { if (tab.value === 'community') communityView.value?.loadMore(); });
const pageStyle = computed(() => ({ ...pageLock.style.value, ...homeViewport.style.value }));
watch(tab, () => { pageLock.reset(); tapFeedback(); uni.pageScrollTo({ scrollTop: 0, duration: 0 }); });
const isWeixin = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
const date = ref(localDate());
const today = ref(localDate());
const meal = ref('晚餐');
let clock;
const category = ref('');
const search = ref('');
const createMenuOpen = ref(false);
const removingMenuEntry = ref(false);
let menuRemovalRevision = 0;
const creationCategory = ref('荤菜');
const cartOpen = ref(false);
const detail = ref(null);
const orderRecipe = ref(null);
const setDetail = ref(null);
const editingRecipe = ref(false);
const recipeDraft = ref(null);
const editingSet = ref(false);
const setDraft = ref(null);
const sharing = ref(null);
const friendSharing = ref(null);
const swipeSharing = ref(null);
const { share: prepareMenuShare } = useFriendShare(computed(() => swipeSharing.value ? { itemId: swipeSharing.value.id, kind: swipeSharing.value.kind } : null), card => {
  if (swipeSharing.value && friendSharing.value?.itemId === swipeSharing.value.id) share(swipeSharing.value, swipeSharing.value.kind, card);
});
onShareAppMessage(event => shareMessage(event));
const editingFamily = ref(false);
const familyEditorTab = ref('appearance');
const submitting = ref(false);
let submitRevision = 0;
const submitError = ref('');
const addingOrderId = ref('');
const addingOrder = computed(() => state.value.orders.find((order) => order.id === addingOrderId.value));
const additionSaving = ref(false);
const additionError = ref('');
let additionRevision = 0;
const orderSavingId = ref('');
const orderFailure = ref(null);
const openedOrderId = ref('');
const orderActionBusy = computed(() => Boolean(orderSavingId.value || cloudStatus.value.busy));
onPageScroll(() => { openedOrderId.value = ''; });
watch([tab, sheetOpen, orderActionBusy], () => { openedOrderId.value = ''; });
let orderActionRevision = 0;
const selection = computed(() => ({ date: date.value, meal: meal.value }));
const features = familyFeatures;
const navigation = computed(() => mainNavigation(features.value));
watch(navigation, (items) => { if (!items.some((item) => item.id === tab.value)) tab.value = 'family'; });
const menuEntries = computed(() => [
  ...state.value.mealSets.map((mealSet) => {
    const recipes = mealSet.recipeIds.map((id) => state.value.recipes.find((recipe) => recipe.id === id)).filter(Boolean);
    return { ...mealSet, key: `set:${mealSet.id}`, kind: 'set', recipes, label: '套餐' };
  }),
  ...state.value.recipes.map((recipe) => ({ ...recipe, key: recipe.id, kind: 'dish', recipes: [recipe], label: recipe.category })),
]);
const orders = computed(() => kitchenOrders(state.value.orders, today.value));
watch(orders, (items) => { if (!items.some(order => order.id === openedOrderId.value)) openedOrderId.value = ''; });
const kitchenIntro = computed(() => kitchenWelcome(orders.value, today.value));
const todayLabel = computed(() => homeDateLabel(today.value));
const kitchenFocus = useKitchenFocus(orders, computed(() => tab.value === 'kitchen'), sheetOpen);
const checkoutOrders = computed(() => state.value.orders.filter((order) => order.date === date.value && order.meal === meal.value));
const currentOrder = computed(() => checkoutOrders.value.find((order) => ['pending', 'accepted'].includes(order.status)));
const pendingOrderCount = computed(() => orders.value.filter((order) => ['pending', 'accepted'].includes(order.status)).length);
const currentSelection = computed(() => currentOrder.value?.selections?.find((entry) => entry.memberId === state.value.activeMemberId));
const mealDraft = useMealDraft(computed(() => state.value.activeMemberId), currentSelection, menuEntries);
const { cart, note, dirty: cartDirty } = mealDraft;
const cartItems = computed(() => Object.keys(cart.value).map((key) => menuEntries.value.find((entry) => entry.key === key)).filter(Boolean));
const cartRows = computed(() => mealDishRows(cartItems.value.flatMap((entry) => entry.recipes.map((recipe) => ({ recipe }))), cartItems.value.map((entry) => ({ ...entry, recipeIds: entry.recipes.map((recipe) => recipe.id) }))));
const dishCount = computed(() => cartRows.value.length);
const mealClosed = computed(() => !currentOrder.value && checkoutOrders.value.some((order) => order.status === 'completed'));
const checkout = computed(() => checkoutPresentation({ closed: mealClosed.value, status: currentOrder.value?.status, hasSelection: Boolean(currentSelection.value), hasOrder: Boolean(currentOrder.value), dirty: cartDirty.value, dishCount: dishCount.value }));
watch([cart, note, date, meal], () => { submitError.value = ''; });
const missingCount = computed(() => shoppingCartMeals(state.value, today.value).reduce((count, order) => count + order.dishes.length, 0));
const preparationByOrder = computed(() => Object.fromEntries(preparationMeals(state.value, today.value).map(order => [order.id, order])));
const statusNames = { pending: '已预订', accepted: '已预订', completed: '已开饭', cancelled: '已取消' };
const pickedBy = (item, order) => item.chosenBy || [{ id: order.memberId, name: order.memberName }];
const orderRows = (order) => mealDishRows(order.items.map((item) => ({ ...item, chosenBy: pickedBy(item, order) })), order.entries);
function removeCartDish(recipeId) { cart.value = removeDishSelection(cart.value, state.value.mealSets, recipeId); }
function clearSelection() { tapFeedback(); mealDraft.empty(); }
function selectNavigation(nextTab) {
  if (nextTab !== 'ingredients') { tab.value = nextTab; return; }
  if (tab.value === 'ingredients') {
    dismissFocusedKeyboard(); tapFeedback();
    uni.pageScrollTo({ scrollTop: 0, duration: 0 });
  }
  openIngredients('shopping');
}
function openIngredients(section, orderId = '') {
  preparingOrderId.value = '';
  ingredientSection.value = section;
  shoppingFocusRequest.value = orderId ? { id: orderId } : null;
  tab.value = 'ingredients';
}
function openPreparation(order) {
  if (isPendingRecord(order.id)) { notify('这餐正在同步，请稍等'); return; }
  if (orderActionBusy.value || !['pending', 'accepted'].includes(order.status)) return;
  dismissFocusedKeyboard();
  preparingOrderId.value = order.id;
}
function revealOrder(orderId) {
  if (!orderId) return;
  dismissFocusedKeyboard(); cartOpen.value = false; tab.value = 'kitchen';
  kitchenFocus.focus(orderId);
}
function closeAdditions() { additionRevision += 1; addingOrderId.value = ''; additionError.value = ''; additionSaving.value = false; }
function openAdditions(order) {
  if (isPendingRecord(order.id)) { notify('这餐正在同步，请稍等'); return; }
  refreshDay();
  if (!['pending', 'accepted'].includes(order.status) || orderActionBusy.value) return;
  dismissFocusedKeyboard(); additionError.value = ''; addingOrderId.value = order.id;
}
async function saveAdditions(cartToAdd) {
  if (additionSaving.value || !addingOrderId.value) return;
  const orderId = addingOrderId.value;
  const request = ++additionRevision;
  additionSaving.value = true; additionError.value = '';
  try {
    await presentMutation(addOrderDishes(orderId, cartToAdd), () => {
      if (request !== additionRevision) return;
      closeAdditions(); revealOrder(orderId);
    });
  } catch (error) { if (request === additionRevision) additionError.value = error.message || '没有保存成功，请重试'; }
  finally { if (request === additionRevision) additionSaving.value = false; }
}
function resetOrderAction() { orderActionRevision += 1; orderSavingId.value = ''; orderFailure.value = null; openedOrderId.value = ''; shoppingFocusRequest.value = null; preparingOrderId.value = ''; }
watch(() => state.value.activeMemberId, () => { closeAdditions(); kitchenFocus.cancel(); resetOrderAction(); });
onUnmounted(resetOrderAction);
function editFamily(initialTab = 'appearance') { dismissFocusedKeyboard(); tapFeedback(); familyEditorTab.value = initialTab; editingFamily.value = true; }
function toggleSelection(key) {
  if (isPendingRecord(key)) { notify('这道菜正在同步，请稍等'); return; }
  tapFeedback();
  const next = { ...cart.value };
  if (next[key]) delete next[key]; else next[key] = 1;
  cart.value = next;
}
function openEntry(entry) { tapFeedback(); if (entry.kind === 'set') setDetail.value = entry; else detail.value = entry; }
function editEntry(entry) { if (entry.kind === 'set') createSet(entry); else createDish(entry); }
function createDish(recipe = null) { tapFeedback(); if (isPendingRecord(recipe?.id)) { notify('这道菜正在同步，请稍等'); return; } createMenuOpen.value = false; recipeDraft.value = recipe; detail.value = null; editingRecipe.value = true; }
function createSet(mealSet = null) { tapFeedback(); if (isPendingRecord(mealSet?.id)) { notify('这个套餐正在同步，请稍等'); return; } createMenuOpen.value = false; setDraft.value = mealSet; setDetail.value = null; editingSet.value = true; }
function openCreate(categoryName, kind = '') {
  creationCategory.value = CATEGORIES.includes(categoryName) ? categoryName : '荤菜';
  if (kind === 'dish') createDish();
  else if (kind === 'set') createSet();
  else { dismissFocusedKeyboard(); createMenuOpen.value = true; }
}
function discoverFood() { createMenuOpen.value = false; tab.value = 'community'; }
function share(item, kind, card) { if (isPendingRecord(item.id)) { notify('正在同步，完成后就能分享'); return; } friendSharing.value = { itemId: item.id, kind, card }; }
async function shareEntry(entry) {
  if (isPendingRecord(entry.id)) { notify('正在同步，完成后就能分享'); return; }
  if (swipeSharing.value || removingMenuEntry.value) return;
  swipeSharing.value = entry;
  const selection = swipeSharing.value;
  friendSharing.value = { itemId: entry.id, kind: entry.kind, card: null, preparing: cloudMode };
  await nextTick();
  if (swipeSharing.value !== selection || friendSharing.value?.itemId !== entry.id) return;
  try { await prepareMenuShare(); }
  finally {
    if (swipeSharing.value === selection) {
      swipeSharing.value = null;
      if (friendSharing.value?.itemId === entry.id) friendSharing.value.preparing = false;
    }
  }
}
function closeFriendShare() { friendSharing.value = null; swipeSharing.value = null; }
function publishFriendShare() { sharing.value = friendSharing.value; closeFriendShare(); }
function retryFriendShare() {
  const selection = friendSharing.value;
  if (!selection || selection.preparing) return;
  const entry = (selection.kind === 'set' ? state.value.mealSets : state.value.recipes).find(item => item.id === selection.itemId);
  if (entry) shareEntry({ ...entry, kind: selection.kind });
  else { closeFriendShare(); notify('菜品或家庭已变更，请重新打开'); }
}
watch(() => cloudStatus.value.familyId, (next, previous) => {
  if (next === previous) return;
  menuRemovalRevision += 1; removingMenuEntry.value = false;
  homeViewport.reset(); homeViewport.refresh();
  resetDraft(); closeAdditions(); kitchenFocus.cancel(); resetOrderAction(); detail.value = null; setDetail.value = null; orderRecipe.value = null;
  editingRecipe.value = false; editingSet.value = false; editingFamily.value = false; sharing.value = null; friendSharing.value = null; swipeSharing.value = null;
  createMenuOpen.value = false; search.value = ''; category.value = ''; ingredientSection.value = 'shopping'; homeMenu.value?.reset();
});
async function saved(recipe) {
  const target = editingSet.value ? '套餐' : recipe?.category || recipeDraft.value?.category || creationCategory.value;
  editingRecipe.value = false; editingSet.value = false; tab.value = 'menu'; search.value = '';
  await nextTick();
  homeMenu.value?.reset(target);
}
function addDetail(item, kind) { const key = kind === 'set' ? `set:${item.id}` : item.id; if (!cart.value[key]) toggleSelection(key); detail.value = null; setDetail.value = null; }
function updateMealSlot(field, value) {
  mealDraft.retain();
  if (field === 'date') date.value = value;
  else meal.value = value;
}
function refreshDay() {
  today.value = localDate();
  if (!reservationDays(today.value).some((day) => day.date === date.value)) updateMealSlot('date', today.value);
}
function openCart() { refreshDay(); submitError.value = ''; cartOpen.value = true; tapFeedback(); }
onShow(refreshDay);
onMounted(() => { clock = setInterval(refreshDay, 60000); });
onUnmounted(() => clearInterval(clock));
async function submit() {
  if (submitting.value) return;
  refreshDay();
  const action = checkout.value.action;
  if (action === 'blocked') return;
  if (action === 'view' || action === 'choose') {
    dismissFocusedKeyboard();
    tapFeedback();
    cartOpen.value = false;
    if (action === 'view') revealOrder(currentOrder.value?.id);
    else tab.value = 'menu';
    return;
  }
  submitting.value = true;
  const request = ++submitRevision;
  const scope = `${state.value.family.id}:${state.value.activeMemberId}`;
  submitError.value = '';
  try {
    await presentMutation(submitOrder(cart.value, selection.value, note.value), () => {
      if (request !== submitRevision || scope !== `${state.value.family.id}:${state.value.activeMemberId}`) return;
      dismissFocusedKeyboard(); tapFeedback();
      mealDraft.clear(); cartOpen.value = false; tab.value = 'kitchen'; submitting.value = false;
      if (action !== 'withdraw') kitchenFocus.focus(currentOrder.value?.id);
    });
  } catch (error) {
    if (request === submitRevision && scope === `${state.value.family.id}:${state.value.activeMemberId}`) submitError.value = error.message || '没有保存成功，请再试一次。';
  } finally {
    if (request === submitRevision) submitting.value = false;
  }
}
async function remove(entry) {
  if (isPendingRecord(entry.id)) { notify('正在同步，请稍后再删除'); return; }
  if (removingMenuEntry.value) return;
  const revision = ++menuRemovalRevision;
  const scope = `${state.value.family?.id}:${state.value.activeMemberId}`;
  removingMenuEntry.value = true;
  const related = entry.kind === 'dish' ? state.value.mealSets.filter((mealSet) => mealSet.recipeIds.includes(entry.id)) : [];
  try {
    const confirmed = await new Promise(resolve => uni.showModal({ cancelColor: NATIVE_UI_COLORS.muted, title: `删除${entry.title}？`, content: related.length ? '会同时从套餐中移除此菜，不足两道菜的套餐也会移除。已提交的厨房订单和美食分享保留。' : '从家庭菜单移除，已提交的厨房订单和美食分享保留。', confirmText: '确认删除', confirmColor: NATIVE_UI_COLORS.danger, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
    if (!confirmed || revision !== menuRemovalRevision || scope !== `${state.value.family?.id}:${state.value.activeMemberId}`) return;
    await runAction(async () => {
      await presentMutation(removeFamilyEntry(entry.id, entry.kind), () => {
        if (revision !== menuRemovalRevision || scope !== `${state.value.family?.id}:${state.value.activeMemberId}`) return;
        detail.value = null; setDetail.value = null; removingMenuEntry.value = false;
        nextTick(() => homeMenu.value?.reset());
      });
    });
  } finally { if (revision === menuRemovalRevision) removingMenuEntry.value = false; }
}
async function removeMealDish(order, recipeId) {
  if (isPendingRecord(order.id) || orderActionBusy.value || !['pending', 'accepted'].includes(order.status)) return;
  if (!order.items.some(entry => entry.recipe.id === recipeId)) return;
  const revision = ++orderActionRevision;
  const scope = `${state.value.family.id}:${state.value.activeMemberId}`;
  openedOrderId.value = '';
  orderSavingId.value = order.id;
  orderFailure.value = null;
  try {
    await presentMutation(removeOrderDish(order.id, recipeId), () => {
      if (revision === orderActionRevision && scope === `${state.value.family.id}:${state.value.activeMemberId}`) orderSavingId.value = '';
    });
  } catch (error) {
    if (revision === orderActionRevision && scope === `${state.value.family.id}:${state.value.activeMemberId}`) orderFailure.value = { id: order.id, message: error?.message || '没有移除成功，请重试' };
  } finally {
    if (revision === orderActionRevision && scope === `${state.value.family.id}:${state.value.activeMemberId}`) orderSavingId.value = '';
  }
}
async function orderAction(order, action) {
  if (action === 'completed') {
    refreshDay();
    if (order.date !== today.value) { notify('只能当天开饭'); return; }
  }
  if (isPendingRecord(order.id)) { notify('这餐正在同步，请稍等'); return; }
  if (orderActionBusy.value) return;
  const revision = ++orderActionRevision;
  openedOrderId.value = '';
  orderSavingId.value = order.id;
  orderFailure.value = null;
  try {
    if (action === 'cancelled') {
      const result = await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '取消这一餐？', content: '将取消所有家人这一餐的选菜，并移除仅属于这餐的待买食材包。', success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!result.confirm) return;
    } else if (action === 'deleted') {
      const result = await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.danger, cancelColor: NATIVE_UI_COLORS.muted, title: `删除${mealDateLabel(order.date, today.value)}${order.meal}？`, content: '将删除所有家人这餐的选菜、备菜及开火记录。菜谱和冰箱不受影响，删除后可重新预定。', confirmText: '删除', cancelText: '保留', success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!result.confirm) return;
    }
    if (revision !== orderActionRevision) return;
    await presentMutation(action === 'deleted' ? removeOrder(order.id) : updateOrder(order.id, action), () => {
      if (revision === orderActionRevision) orderSavingId.value = '';
    });
  } catch (error) {
    if (revision === orderActionRevision) orderFailure.value = { id: order.id, message: error?.message || '没有保存成功，请重试' };
  } finally {
    if (revision === orderActionRevision) orderSavingId.value = '';
  }
}
function resetDraft() { mealDraft.reset(); cartOpen.value = false; }
</script>

<template>
  <page-meta :page-style="sheetOpen ? 'overflow: hidden;' : 'overflow: visible;'" />
  <view class="app-shell" :class="{ 'weixin-shell': isWeixin, 'menu-page': tab === 'menu', 'community-page': tab === 'community', 'family-page': tab === 'family', 'has-selection': dishCount > 0 && tab === 'menu' }" :style="pageStyle" @click="dismissFocusedKeyboard">
    <CloudConnection v-if="cloudMode && cloudStatus.phase !== 'ready'" />
    <template v-else>
    <view class="sidebar"><view class="desktop-brand"><AppIcon name="family" /><text>{{ state.family.name }}</text></view><view class="nav-list"><button role="button" v-for="item in navigation" :key="item.id" class="nav-item" :class="{ active: tab === item.id }" :aria-label="item.label" :aria-pressed="tab === item.id" @click="selectNavigation(item.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="nav-icon-wrap"><AppIcon :name="item.icon" :active="tab === item.id" /><text v-if="item.id === 'ingredients' && missingCount" class="nav-count" :class="{ 'is-overflow': missingCount > 99 }" :aria-label="`待采购${missingCount}道菜`">{{ missingCount > 99 ? '99+' : missingCount }}</text><text v-if="item.id === 'kitchen' && pendingOrderCount" class="nav-count" :class="{ 'is-overflow': pendingOrderCount > 99 }" :aria-label="`待准备${pendingOrderCount}餐`">{{ pendingOrderCount > 99 ? '99+' : pendingOrderCount }}</text></view><text>{{ item.label }}</text></button></view></view>
    <view class="workspace"><view v-if="storageError" class="storage-error">{{ storageError }}</view><view class="content">
      <view v-show="tab === 'menu'" class="menu-view">
        <PageHeader title="我家菜单" />
        <view class="home-menu-panel">
        <HomeMenu ref="homeMenu" :key="cloudStatus.familyId || state.family.id" :active="tab === 'menu'" :docked="menuDocked" :entries="menuEntries" :selected="cart" :cover="state.family.cover" :cover-title="state.family.coverTitle" :date-label="todayLabel" :busy="removingMenuEntry || Boolean(swipeSharing)" :sharing="Boolean(swipeSharing || friendSharing || sharing)" :scroll-inset="menuListInset" v-model:category="category" v-model:search="search" @layout="homeViewport.refresh" @dock="homeViewport.dock" @page-drag="homeViewport.scrollPage" @open="openEntry" @toggle="toggleSelection" @create="openCreate" @edit-entry="editEntry" @share-entry="shareEntry" @remove-entry="remove" @discover="discoverFood" />
        </view>
      </view>
      <view v-if="tab === 'kitchen'" class="kitchen-view">
        <PageHeader title="我家厨房" />
        <view class="orders-view">
          <view class="kitchen-intro" :class="{ 'is-empty': kitchenIntro.mode === 'empty' }">
            <HomeWelcome calendar :compact="kitchenIntro.mode !== 'empty'" :kitchen="kitchenIntro.mode !== 'empty'" :cover="state.family.cover" :title="kitchenIntro.title" :description="kitchenIntro.mode === 'active' ? todayLabel : ''" :primary-label="kitchenIntro.mode === 'active' ? '' : '看看菜单'" :primary-icon="kitchenIntro.mode === 'empty' ? 'menu-inverse' : 'menu'" @primary="tab = 'menu'" />
          </view>
          <text v-if="kitchenIntro.recordTitle" class="kitchen-record-title" role="heading" aria-level="2">{{ kitchenIntro.recordTitle }}</text>
          <view v-for="(order, orderIndex) in orders" :key="order.id + ':' + order.status" :id="kitchenOrderAnchor(orderIndex)" class="kitchen-order">
          <view :key="order.id + ':' + order.status" class="order-card" :class="{ 'is-finished': ['completed', 'cancelled'].includes(order.status) }">
            <view class="section-line compact order-card-heading">
              <view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(order.date, today) }}</text><text class="order-tag order-meal-tag">{{ order.meal }}</text><text class="order-tag order-status" :class="order.status">{{ statusNames[order.status] }}</text></view>
              <OrderActionMenu :label="`${mealDateLabel(order.date, today)}${order.meal}`" :status="order.status" :opened="openedOrderId === order.id" :busy="orderActionBusy" :has-dishes="order.items.length > 0" @activate="openedOrderId = order.id" @close="openedOrderId === order.id && (openedOrderId = '')" @cancel="orderAction(order, 'cancelled')" @restore="orderAction(order, 'accepted')" @remove="orderAction(order, 'deleted')" />
            </view>
            <MealDishList :rows="orderRows(order)" :members="state.family.members" :editable="['pending', 'accepted'].includes(order.status)" :busy="orderActionBusy" @open="orderRecipe = $event" @remove="removeMealDish(order, $event)" />
            <text v-if="!order.items.length" class="muted">本餐暂无菜品</text>
            <text v-if="order.note" class="order-note">{{ order.note }}</text>
            <view v-if="['pending', 'accepted'].includes(order.status)" class="order-actions">
              <button role="button" class="text-button order-add-button" :disabled="orderActionBusy" :aria-label="`给${mealDateLabel(order.date, today)}${order.meal}加菜`" @click="openAdditions(order)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="16" /><text>加菜</text></button>
              <view class="order-progress-actions">
                <button role="button" class="secondary-button" :disabled="orderActionBusy" :aria-label="`查看${mealDateLabel(order.date, today)}${order.meal}的本餐备菜`" @click="openPreparation(order)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="chef" active :size="16" /><text>备菜 {{ preparationByOrder[order.id]?.preparedCount || 0 }}/{{ order.items.length }}</text></button>
                <button role="button" class="primary-button" :disabled="orderActionBusy" :aria-busy="orderSavingId === order.id" @click="orderAction(order, 'completed')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="menu-inverse" :size="16" /><text>开饭</text></button>
              </view>
            </view>
            <text v-if="orderFailure?.id === order.id" class="form-error" role="alert">{{ orderFailure.message }}</text>
          </view>
          </view>
        </view>
      </view>
      <IngredientsView v-else-if="tab === 'ingredients'" :key="cloudStatus.familyId || state.family.id" v-model="ingredientSection" :today="today" :focus-order="shoppingFocusRequest" @open="orderRecipe = $event" @discover="discoverFood" />
      <FamilyView v-else-if="tab === 'family'" :today="today" @customize="editFamily()" />
      <view v-if="communityVisited" v-show="tab === 'community'" class="community-tab"><CommunityView ref="communityView" :key="`${cloudStatus.userId}:${cloudStatus.familyId}`" :active="tab === 'community'" @edit-entry="editEntry" /></view>
    </view>
    <view v-if="dishCount > 0 && tab === 'menu'" class="selection-dock">
      <view class="selection-overview">
        <button role="button" class="selection-summary" :aria-label="`查看已选${dishCount}道菜`" @click="openCart" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>已选 {{ dishCount }} 道菜</text></button>
        <button role="button" class="selection-clear" aria-label="清空已选菜品" @click="clearSelection" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="16" /><text>清空</text></button>
      </view>
      <button role="button" class="primary-button selection-submit" @click="openCart" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="menu-inverse" :size="18" /><text>点餐</text></button>
    </view>
    </view>
    <RecipeSheet v-if="detail" :recipe="detail" :selected="Boolean(cart[detail.id])" :busy="removingMenuEntry" @close="detail = null" @add="addDetail($event, 'dish')" @share="(item, card) => share(item, 'dish', card)" @edit="createDish" @remove="remove({ ...$event, kind: 'dish' })" />
    <SetSheet v-if="setDetail" :meal-set="setDetail" :selected="Boolean(cart[`set:${setDetail.id}`])" :busy="removingMenuEntry" @close="setDetail = null" @add="addDetail($event, 'set')" @share="(item, card) => share(item, 'set', card)" @edit="createSet" @remove="remove({ ...$event, kind: 'set' })" />
    <Sheet v-if="createMenuOpen" title="添加到菜单" variant="action-picker" @close="createMenuOpen = false">
      <view class="sheet-action-options menu-create-options">
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="创建菜品" @click.stop="createDish()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="menu" :size="26" active /></view><text class="sheet-action-label">创建菜品</text></button></view>
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="创建套餐" @click.stop="createSet()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="meal-set" :size="26" active /></view><text class="sheet-action-label">创建套餐</text></button></view>
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="发现美食" @click.stop="discoverFood" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="community" :size="26" active /></view><text class="sheet-action-label">发现美食</text></button></view>
      </view>
    </Sheet>
    <RecipeEditor v-if="editingRecipe" :recipe="recipeDraft" :initial-category="creationCategory" @close="editingRecipe = false" @saved="saved" />
    <SetEditor v-if="editingSet" :meal-set="setDraft" @close="editingSet = false" @saved="saved" />
    <ShareSheet v-if="sharing" :item-id="sharing.itemId" :kind="sharing.kind" @close="sharing = null" @published="sharing = null; detail = null; setDetail = null; tab = 'community'" />
    <FriendShareSheet v-if="friendSharing" :card="friendSharing.card" :preparing="friendSharing.preparing" @close="closeFriendShare" @retry="retryFriendShare" @publish="publishFriendShare" />
    <FamilyEditor v-if="editingFamily" :initial-tab="familyEditorTab" @close="editingFamily = false" />
    <AddDishesSheet v-if="addingOrderId" :order="addingOrder" :entries="menuEntries" :member-id="state.activeMemberId" :today="today" :saving="additionSaving" :error="additionError" @close="closeAdditions" @save="saveAdditions" />
    <Sheet v-if="cartOpen" title="这一餐，就吃这些" @close="cartOpen = false">
      <view class="checkout-cards">
        <view class="checkout-card checkout-schedule"><text class="subheading">哪一餐吃？</text><MealBar :date="date" :meal="meal" :today="today" @update:date="updateMealSlot('date', $event)" @update:meal="updateMealSlot('meal', $event)" /><view v-if="checkout.tip" class="checkout-tip" :class="{ warning: checkout.warning }" role="status"><text>{{ checkout.tip }}</text><button v-if="['pending', 'accepted'].includes(currentOrder?.status) && checkout.action !== 'view'" role="button" class="text-button checkout-add-link" @click="revealOrder(currentOrder.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">去加菜<AppIcon name="chevron" :size="14" /></button></view></view>
        <view class="checkout-card checkout-dishes"><view class="checkout-card-heading"><text class="subheading">已选 {{ dishCount }} 道菜</text><button role="button" class="text-button" @click="$feedback(); cartOpen = false" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">继续选菜</button></view><MealDishList v-if="dishCount" :rows="cartRows" removable @open="orderRecipe = $event" @remove="removeCartDish" /><text v-else class="checkout-empty">还没有选菜</text></view>
        <view class="checkout-card checkout-note"><text class="subheading">给大厨的备注</text><FormField multiline v-model="note" field-class="textarea short" placeholder="口味、忌口、几点吃…（选填）" maxlength="200" aria-label="点餐备注" /></view>
      </view>
      <template #footer><view v-if="submitError" class="checkout-tip warning checkout-submit-error" role="alert"><text>{{ submitError }}</text></view><button role="button" class="primary-button full checkout-submit" :disabled="checkout.action === 'blocked' || submitting" @click="submit" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ submitting ? '正在提交…' : checkout.label }}</button></template>
    </Sheet>
    <MealPreparationSheet v-if="preparingOrderId" :order-id="preparingOrderId" :today="today" @close="preparingOrderId = ''" @open="orderRecipe = $event" @shopping="openIngredients('shopping', $event)" />
    <RecipeSheet v-if="orderRecipe" :recipe="orderRecipe" read-only @close="orderRecipe = null" />
    <MutationSyncStatus v-if="cloudMode" />
    <view v-if="cloudMode && cloudStatus.error && !mutationStatus.failures.length && !mutationStatus.pending.length" class="cloud-sync-warning" role="alert"><text>暂未同步：{{ cloudStatus.error }}</text><button role="button" class="text-button" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重试</button></view>
    </template>
  </view>
</template>

