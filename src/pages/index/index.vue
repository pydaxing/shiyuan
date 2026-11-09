<script setup>
import AccountEntry from '../../components/AccountEntry.vue';
import { accountEntryStatus } from '../../services/account-entry.js';
import { isUnchangedCommunityRecipe } from '../../domain/recipe-identity.js';
import { NATIVE_UI_COLORS } from '../../domain/ui-theme.js';
import { mainNavigation, mainNavigationTab } from '../../domain/navigation.js';
import FormField from '../../components/FormField.vue';
import { computed, nextTick, ref, watch, onMounted, onUnmounted, provide } from 'vue';
import { onShow, onPageScroll, onReachBottom, onResize, onShareAppMessage } from '@dcloudio/uni-app';
import { shareMessage } from '../../services/native-share.js';
import FriendShareSheet from '../../components/FriendShareSheet.vue';
import { useFriendShare } from '../../composables/useFriendShare.js';
import { tapFeedback } from '../../services/feedback.js';
import { dismissFocusedKeyboard } from '../../services/keyboard.js';
import { isPendingRecord, presentMutation } from '../../services/mutation-feedback.js';
import { state, workspaceName, familyFeatures, storageError, cloudMode, cloudStatus, connectCloud, submitOrder, addOrderDishes, removeOrderDish, updateOrder, removeOrder, removeFamilyEntry, runAction, notify } from '../../store.js';
import CloudConnection from '../../components/CloudConnection.vue';
import MutationSyncStatus from '../../components/MutationSyncStatus.vue';
import { mutationStatus, refreshCloud } from '../../services/cloud.js';
import { CATEGORIES, localDate, reservationDays, mealDateLabel, kitchenOrders } from '../../domain/kitchen.js';
import MealPreparationSheet from '../../components/MealPreparationSheet.vue';
import Sheet from '../../components/Sheet.vue';
import RecipeSheet from '../../components/RecipeSheet.vue';
import RecipeEditor from '../../components/RecipeEditor.vue';
import SetEditor from '../../components/SetEditor.vue';
import SetSheet from '../../components/SetSheet.vue';
import ShareSheet from '../../components/ShareSheet.vue';
import MealSquare from '../../components/MealSquare.vue';
import MealTimeline from '../../components/MealTimeline.vue';
import { useMealPosts } from '../../composables/useMealPosts.js';
import MealPublishSheet from '../../components/MealPublishSheet.vue';
import CommunityView from '../../components/CommunityView.vue';
import FamilyView from '../../components/FamilyView.vue';
import FamilyEditor from '../../components/FamilyEditor.vue';
import AppIcon from '../../components/AppIcon.vue';
import MealBar from '../../components/MealBar.vue';
import PageHeader from '../../components/PageHeader.vue';
import StretchCover from '../../components/StretchCover.vue';
import { useNavigationAppearance } from '../../composables/useNavigationAppearance.js';
import HomeMenu from '../../components/HomeMenu.vue';
import HomeWelcome from '../../components/HomeWelcome.vue';
import { kitchenWelcome } from '../../domain/home-welcome.js';
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
const familyView = ref(null);
const menuActive = computed(() => tab.value === 'menu');
const activeNavigation = computed(() => mainNavigationTab(tab.value));
const mealsAtTop = ref(true);
async function refreshKitchen() {
  await refreshCloud();
  refreshDay();
  await nextTick();
  homeViewport.refresh();
  homeMenu.value?.refreshLayout();
}
useNavigationAppearance(computed(() => activeNavigation.value === 'menu' ? 'dark' : null));
const mealSquare = ref(null);
const mealTimeline = ref(null);
const mealHistoryOpen = ref(false);
const diaryFeed = useMealPosts('mine', computed(() => tab.value === 'family' || mealHistoryOpen.value));
provide('mealDiaryFeed', diaryFeed);
const publicFeed = useMealPosts('public', computed(() => cloudStatus.value.phase === 'ready'));
provide('mealPublicFeed', publicFeed);
function diaryChanged(result) { if (result.deletedId && result.deleteScope !== 'personal') publicFeed.removePost(result.deletedId); else if (result.post) publicFeed.acceptPost(result.post); }
function squareChanged(result) { if (result.post?.id) diaryFeed.syncReactions(result.post); }
function openMealHistory() { dismissFocusedKeyboard(); mealHistoryOpen.value = true; }
const mealPublishing = ref(false);
const mealShareOrder = ref(null);
const completedMealIds = ref([]);
function recordMeal(order = null) {
  today.value = localDate();
  if (order && (isPendingRecord(order.id) || orderActionBusy.value)) { notify('餐单正在保存，请稍后记录'); return; }
  if (order && order.date !== today.value) { notify('只能在餐单当天记录'); return; }
  dismissFocusedKeyboard(); mealShareOrder.value = order; mealPublishing.value = true;
}
function mealSaved(post) {
  diaryFeed.acceptPost(post);
  publicFeed.acceptPost(post);
  if (post.mealStarted && (post.orderId || mealShareOrder.value?.id)) completedMealIds.value = [...completedMealIds.value, post.orderId || mealShareOrder.value.id];
  mealPublishing.value = false; mealShareOrder.value = null;
  if (post.mealStarted) void refreshCloud().catch(() => notify('已记下这餐，餐单稍后刷新'));
  tab.value = 'family';
  openMealHistory();
  void nextTick(() => { void publicFeed.load(false, true); void diaryFeed.load(false, true); });
}
const preparingOrderId = ref('');
const homeViewport = useHomeMenuViewport(computed(() => menuActive.value && (!cloudMode || cloudStatus.value.phase === 'ready')), sheetOpen);
const { listInset: menuListInset, docked: menuDocked } = homeViewport;
const pageLock = usePageLock(sheetOpen, (scrollTop) => uni.pageScrollTo({ scrollTop, duration: 0 }));
onPageScroll(event => { if (activeNavigation.value === 'menu' && !sheetOpen.value) mealsAtTop.value = (event.scrollTop || 0) <= 0; pageLock.onScroll(event); if (menuActive.value) homeMenu.value?.onScroll(event); homeViewport.onScroll(event); if (tab.value === 'community') communityView.value?.onScroll(event); if (tab.value === 'family' && !sheetOpen.value) familyView.value?.onScroll(event); });
onResize(() => { homeViewport.refresh(); homeMenu.value?.refreshLayout(); });
const communityView = ref(null);
provide('editCommunityEntry', editEntry);
const communityVisited = ref(false);
const squareVisited = ref(false);
watch(tab, value => { if (value === 'square') { squareVisited.value = true; void publicFeed.refreshIfStale(); } });
watch(tab, value => { if (value === 'community') communityVisited.value = true; }, { immediate: true });
onReachBottom(() => { if (sheetOpen.value) return; if (tab.value === 'community') communityView.value?.loadMore(); if (tab.value === 'square') mealSquare.value?.loadMore(); });
const pageStyle = computed(() => ({ ...pageLock.style.value, ...homeViewport.style.value }));
watch(tab, () => { mealsAtTop.value = true; pageLock.reset(); tapFeedback(); uni.pageScrollTo({ scrollTop: 0, duration: 0 }); });
const isWeixin = uni.getSystemInfoSync().uniPlatform === 'mp-weixin';
const date = ref(localDate());
const today = ref(localDate());
const homeDateLabel = computed(() => {
  const [year, month, day] = today.value.split('-').map(Number);
  const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][new Date(year, month - 1, day).getDay()];
  return `${month}月${day}日 · ${weekday}`;
});
const meal = ref('');
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
// Only a current menu ID grants editing; historical snapshots remain read-only.
const orderMenuRecipe = computed(() => orderRecipe.value && state.value.recipes.find(recipe => recipe.id === orderRecipe.value.id));
const setDetail = ref(null);
const editingRecipe = ref(false);
const expandRecipeDetails = ref(false);
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
const mealRequired = ref(false);
watch(meal, () => { mealRequired.value = false; });
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
watch(navigation, (items) => { if (!items.some((item) => item.id === activeNavigation.value)) tab.value = 'family'; });
const menuEntries = computed(() => [
  ...state.value.mealSets.map((mealSet) => {
    const recipes = mealSet.recipeIds.map((id) => state.value.recipes.find((recipe) => recipe.id === id)).filter(Boolean);
    return { ...mealSet, key: `set:${mealSet.id}`, kind: 'set', recipes, label: '套餐' };
  }),
  ...state.value.recipes.map((recipe) => ({ ...recipe, key: recipe.id, kind: 'dish', recipes: [recipe], label: recipe.category, originLabel: isUnchangedCommunityRecipe(recipe, state.value.posts) ? '美食' : '自建' })),
]);
const orders = computed(() => kitchenOrders(state.value.orders, today.value).filter(order => order.status !== 'completed' && !completedMealIds.value.includes(order.id)));
const kitchenIntro = computed(() => kitchenWelcome(orders.value, today.value));
watch(orders, (items) => { if (!items.some(order => order.id === openedOrderId.value)) openedOrderId.value = ''; });
const kitchenFocus = useKitchenFocus(orders, computed(() => tab.value === 'activity'), sheetOpen);
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
const checkout = computed(() => checkoutPresentation({ hasMeal: Boolean(meal.value), closed: mealClosed.value, status: currentOrder.value?.status, hasSelection: Boolean(currentSelection.value), hasOrder: Boolean(currentOrder.value), dirty: cartDirty.value, dishCount: dishCount.value }));
watch([cart, note, date, meal], () => { submitError.value = ''; });
const statusNames = { pending: '已安排', accepted: '已安排', completed: '已开饭', cancelled: '已取消' };
const pickedBy = (item, order) => item.chosenBy || [{ id: order.memberId, name: order.memberName }];
const orderRows = (order) => mealDishRows(order.items.map((item) => ({ ...item, chosenBy: pickedBy(item, order) })), order.entries);
function removeCartDish(recipeId) { cart.value = removeDishSelection(cart.value, state.value.mealSets, recipeId); }
function clearSelection() { tapFeedback(); mealDraft.empty(); meal.value = ''; mealRequired.value = false; submitError.value = ''; }
function showMenu() { tab.value = 'menu'; }
function selectNavigation(nextTab) { tab.value = nextTab; }
function openPreparation(order) {
  if (isPendingRecord(order.id)) { notify('这餐正在同步，请稍等'); return; }
  if (orderActionBusy.value || !['pending', 'accepted'].includes(order.status)) return;
  dismissFocusedKeyboard();
  preparingOrderId.value = order.id;
}
function revealOrder(orderId) {
  if (!orderId) return;
  dismissFocusedKeyboard(); cartOpen.value = false; tab.value = 'activity';
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
function resetOrderAction() { completedMealIds.value = []; mealPublishing.value = false; mealShareOrder.value = null; orderActionRevision += 1; orderSavingId.value = ''; orderFailure.value = null; openedOrderId.value = ''; preparingOrderId.value = ''; }
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
function createDish(recipe = null, expandDetails = false) { tapFeedback(); expandRecipeDetails.value = expandDetails; if (isPendingRecord(recipe?.id)) { notify('这道菜正在同步，请稍等'); return; } createMenuOpen.value = false; recipeDraft.value = recipe; detail.value = null; orderRecipe.value = null; editingRecipe.value = true; }
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
  createMenuOpen.value = false; search.value = ''; category.value = ''; homeMenu.value?.reset();
  mealHistoryOpen.value = false; mealPublishing.value = false; mealShareOrder.value = null; completedMealIds.value = [];
});
async function saved(recipe) {
  const target = editingSet.value ? '套餐' : recipe?.category || recipeDraft.value?.category || creationCategory.value;
  editingRecipe.value = false; editingSet.value = false; showMenu(); search.value = '';
  await nextTick();
  homeMenu.value?.reset(target);
}
function addDetail(item, kind) { const key = kind === 'set' ? `set:${item.id}` : item.id; if (!cart.value[key]) toggleSelection(key); detail.value = null; setDetail.value = null; orderRecipe.value = null; }
function updateMealSlot(field, value) {
  mealDraft.retain();
  if (field === 'date') date.value = value;
  else meal.value = value;
}
function refreshDay() {
  today.value = localDate();
  if (!reservationDays(today.value).some((day) => day.date === date.value)) updateMealSlot('date', today.value);
}
function openCart() { mealRequired.value = false; refreshDay(); submitError.value = ''; cartOpen.value = true; tapFeedback(); }
onShow(refreshDay);
onShow(() => { if (tab.value === 'square') void publicFeed.refreshIfStale(); });
onMounted(() => { clock = setInterval(refreshDay, 60000); });
onUnmounted(() => clearInterval(clock));
async function submit() {
  if (submitting.value) return;
  refreshDay();
  if (!meal.value) { mealRequired.value = true; return; }
  const action = checkout.value.action;
  if (action === 'blocked' || action === 'occupied') return;
  if (action === 'choose') {
    dismissFocusedKeyboard();
    tapFeedback();
    cartOpen.value = false;
    showMenu();
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
      mealDraft.clear(); cartOpen.value = false; tab.value = 'activity'; submitting.value = false;
      kitchenFocus.focus(currentOrder.value?.id);
      meal.value = '';
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
    const confirmed = await new Promise(resolve => uni.showModal({ cancelColor: NATIVE_UI_COLORS.muted, title: `删除${entry.title}？`, content: related.length ? '会同时从套餐中移除此菜，不足两道菜的套餐也会移除。已安排的餐单和美食分享保留。' : '从家庭菜单移除，已安排的餐单和美食分享保留。', confirmText: '确认删除', confirmColor: NATIVE_UI_COLORS.danger, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
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
  if (isPendingRecord(order.id)) { notify('这餐正在同步，请稍等'); return; }
  if (orderActionBusy.value) return;
  const revision = ++orderActionRevision;
  openedOrderId.value = '';
  orderSavingId.value = order.id;
  orderFailure.value = null;
  try {
    if (action === 'cancelled') {
      const result = await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.primary, cancelColor: NATIVE_UI_COLORS.muted, title: '取消这一餐？', content: '将取消当前空间这一餐的安排，菜谱和已发布的分享保留。', success: resolve, fail: () => resolve({ confirm: false }) }));
      if (!result.confirm) return;
    } else if (action === 'deleted') {
      const result = await new Promise(resolve => uni.showModal({ confirmColor: NATIVE_UI_COLORS.danger, cancelColor: NATIVE_UI_COLORS.muted, title: `删除${mealDateLabel(order.date, today.value)}${order.meal}？`, content: '将删除当前空间这餐的安排与备菜清单，菜谱和已发布的分享保留，删除后可重新安排。', confirmText: '删除', cancelText: '保留', success: resolve, fail: () => resolve({ confirm: false }) }));
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
function resetDraft() { mealDraft.reset(); meal.value = ''; mealRequired.value = false; submitError.value = ''; cartOpen.value = false; }
</script>

<template>
  <page-meta :page-style="sheetOpen ? 'overflow: hidden;' : 'overflow: visible;'" />
  <AccountEntry v-if="cloudMode && accountEntryStatus.phase !== 'ready'" />
  <view v-else class="app-shell" :class="{ 'weixin-shell': isWeixin, 'menu-page': tab === 'menu', 'community-page': tab === 'community', 'square-page': tab === 'square', 'family-page': tab === 'family', 'has-selection': dishCount > 0 && menuActive }" :style="pageStyle" @click="dismissFocusedKeyboard">
    <CloudConnection v-if="cloudMode && cloudStatus.phase !== 'ready'" />
    <template v-else>
    <view class="sidebar"><view class="desktop-brand"><AppIcon name="family" /><text>{{ workspaceName }}</text></view><view class="nav-list"><button role="button" v-for="item in navigation" :key="item.id" class="nav-item" :class="{ active: activeNavigation === item.id }" :aria-label="item.label" :aria-pressed="activeNavigation === item.id" @click="selectNavigation(item.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="nav-icon-wrap"><AppIcon :name="item.icon" :active="activeNavigation === item.id" /><text v-if="item.id === 'menu' && pendingOrderCount" class="nav-count" :class="{ 'is-overflow': pendingOrderCount > 99 }" :aria-label="`已安排${pendingOrderCount}餐`">{{ pendingOrderCount > 99 ? '99+' : pendingOrderCount }}</text></view><text>{{ item.label }}</text></button></view></view>
    <view class="workspace"><view v-if="storageError" class="storage-error">{{ storageError }}</view><view class="content">
      <view v-show="activeNavigation === 'menu'" class="meals-home">
        <view class="meals-cover">
          <StretchCover class="meals-stretch" compact :src="state.family.cover" :personal="state.family.kind === 'personal'" :active="activeNavigation === 'menu' && !sheetOpen" :at-top="mealsAtTop" :refresh-action="refreshKitchen">
          <template #navigation><PageHeader title="" cover /></template>
          <view class="meals-cover-content">
            <text class="meals-cover-date">{{ homeDateLabel }}</text>
            <text class="meals-cover-title">今天吃什么？</text>
            <view class="meals-cover-bottom">
              <view class="meal-section-switch" role="tablist" aria-label="菜单与安排">
                <button role="tab" class="meal-section-button" :class="{ selected: tab === 'menu' }" :aria-selected="tab === 'menu'" aria-label="菜单" @click="selectNavigation('menu')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="meal-section-label">菜单</text></button>
                <button role="tab" class="meal-section-button" :class="{ selected: tab === 'activity' }" :aria-selected="tab === 'activity'" aria-label="安排" @click="selectNavigation('activity')" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="meal-section-label"><text>安排</text><view v-if="pendingOrderCount" class="meal-section-count" :aria-label="`已安排${pendingOrderCount}餐`" /></view></button>
              </view>
              <text v-if="pendingOrderCount" class="meals-cover-summary">已安排 {{ pendingOrderCount }} 餐</text>
            </view>
          </view>
          </StretchCover>
        </view>
      <view v-show="tab === 'menu'" class="menu-home">
        <view class="menu-view home-menu-panel">
        <HomeMenu ref="homeMenu" :key="cloudStatus.familyId || state.family.id" :active="menuActive" :docked="menuDocked" :entries="menuEntries" :selected="cart" :busy="removingMenuEntry || Boolean(swipeSharing)" :sharing="Boolean(swipeSharing || friendSharing || sharing)" :scroll-inset="menuListInset" v-model:category="category" v-model:search="search" @layout="homeViewport.refresh" @dock="homeViewport.dock" @page-drag="homeViewport.scrollPage" @open="openEntry" @toggle="toggleSelection" @create="openCreate" @edit-entry="editEntry" @share-entry="shareEntry" @remove-entry="remove" @discover="discoverFood" />
        </view>
      </view>
      <view v-if="tab === 'activity'" class="activity-view">
        <view class="orders-view">
          <view v-if="kitchenIntro.mode === 'empty'" class="kitchen-intro is-empty">
            <HomeWelcome :title="kitchenIntro.title" primary-label="看看菜单" primary-icon="menu-inverse" @primary="showMenu" />
          </view>
          <view v-else-if="kitchenIntro.mode === 'idle'" class="kitchen-continue"><text class="kitchen-idle-title">没有安排</text></view>
          <text v-if="kitchenIntro.recordTitle" class="kitchen-record-title" role="heading" aria-level="2">{{ kitchenIntro.recordTitle }}</text>
          <view v-for="(order, orderIndex) in orders" :key="order.id + ':' + order.status" :id="kitchenOrderAnchor(orderIndex)" class="kitchen-order">
          <view :key="order.id + ':' + order.status" class="order-card" :class="{ 'is-finished': ['completed', 'cancelled'].includes(order.status), 'is-cancelled-summary': order.status === 'cancelled' }">
            <view class="section-line compact order-card-heading">
              <view class="order-schedule"><text class="order-tag order-date-tag">{{ mealDateLabel(order.date, today) }}</text><text class="order-tag order-meal-tag">{{ order.meal }}</text><text class="order-tag order-status" :class="order.status">{{ statusNames[order.status] }}</text></view>
              <OrderActionMenu :label="`${mealDateLabel(order.date, today)}${order.meal}`" :status="order.status" :opened="openedOrderId === order.id" :busy="orderActionBusy" :has-dishes="order.items.length > 0" @activate="openedOrderId = order.id" @close="openedOrderId === order.id && (openedOrderId = '')" @cancel="orderAction(order, 'cancelled')" @restore="orderAction(order, 'accepted')" @remove="orderAction(order, 'deleted')" />
            </view>
            <MealDishList :rows="orderRows(order)" :members="state.family.members" :posts="state.posts" :editable="['pending', 'accepted'].includes(order.status)" :busy="orderActionBusy" @open="orderRecipe = $event" @remove="removeMealDish(order, $event)" />
            <text v-if="!order.items.length" class="muted">本餐暂无菜品</text>
            <text v-if="order.note" class="order-note">{{ order.note }}</text>
            <view v-if="['pending', 'accepted'].includes(order.status)" class="order-actions">
              <button role="button" class="text-button order-add-button" :disabled="orderActionBusy" :aria-label="`给${mealDateLabel(order.date, today)}${order.meal}加菜`" @click="openAdditions(order)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="16" /><text>加菜</text></button>
              <view class="order-progress-actions">
                <button role="button" class="secondary-button" :disabled="orderActionBusy" :aria-label="`查看${mealDateLabel(order.date, today)}${order.meal}的备菜清单`" @click="openPreparation(order)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>备菜清单</text></button>
                <button role="button" class="primary-button meal-record-button" :class="{ 'is-unavailable': !order.items.length || order.date !== today }" :aria-busy="orderActionBusy || isPendingRecord(order.id)" :disabled="orderActionBusy || isPendingRecord(order.id) || !order.items.length || order.date !== today" :aria-label="order.date === today ? '记下这餐' : '餐单当天可记录'" @click="recordMeal(order)" hover-class="touch-feedback"><text class="meal-record-label">记下这餐</text></button>
              </view>
            </view>
            <text v-if="orderFailure?.id === order.id" class="form-error" role="alert">{{ orderFailure.message }}</text>
          </view>
          </view>

        </view>
      </view>
      </view>
      <FamilyView v-if="tab === 'family'" ref="familyView" :key="cloudStatus.userId || state.activeMemberId" :today="today" :refresh-action="refreshKitchen" @customize="editFamily($event)" @manage="editFamily('management')" @diary="openMealHistory" />
      <view v-if="squareVisited || tab === 'square'" v-show="tab === 'square'" class="square-view">
        <MealSquare ref="mealSquare" :active="tab === 'square' && !sheetOpen" @record="recordMeal()" @changed="squareChanged" />
      </view>
      <view v-if="communityVisited" v-show="tab === 'community'" class="community-tab"><CommunityView ref="communityView" :key="`${cloudStatus.userId}:${cloudStatus.familyId}`" :active="tab === 'community'" @edit-entry="editEntry" /></view>
    </view>
    <view v-if="dishCount > 0 && menuActive" class="selection-dock">
      <view class="selection-overview">
        <button role="button" class="selection-summary" :aria-label="`查看已选${dishCount}道菜`" @click="openCart" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text>已选 {{ dishCount }} 道菜</text></button>
        <button role="button" class="selection-clear" aria-label="清空已选菜品" @click="clearSelection" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="trash-danger" :size="16" /><text>清空</text></button>
      </view>
      <button role="button" class="primary-button selection-submit" @click="openCart" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="menu-inverse" :size="18" /><text>安排</text></button>
    </view>
    </view>
    <RecipeSheet v-if="detail" menu-entry :recipe="detail" :selected="Boolean(cart[detail.id])" :busy="removingMenuEntry" @close="detail = null" @add="addDetail($event, 'dish')" @share="item => shareEntry({ ...item, kind: 'dish' })" @edit="createDish" @supplement="createDish($event, true)" @remove="remove({ ...$event, kind: 'dish' })" />
    <SetSheet v-if="setDetail" :meal-set="setDetail" :selected="Boolean(cart[`set:${setDetail.id}`])" :busy="removingMenuEntry" @close="setDetail = null" @add="addDetail($event, 'set')" @share="item => shareEntry({ ...item, kind: 'set' })" @edit="createSet" @remove="remove({ ...$event, kind: 'set' })" />
    <Sheet v-if="createMenuOpen" title="添加到菜单" variant="action-picker" @close="createMenuOpen = false">
      <view class="sheet-action-options menu-create-options">
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="创建菜品" @click.stop="createDish()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="menu" :size="26" active /></view><text class="sheet-action-label">创建菜品</text><text class="menu-create-description">记录一道拿手菜</text><view class="menu-create-chevron"><AppIcon name="chevron" :size="16" /></view></button></view>
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="创建套餐" @click.stop="createSet()" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="meal-set" :size="26" active /></view><text class="sheet-action-label">创建套餐</text><text class="menu-create-description">把几道菜搭配成一餐</text><view class="menu-create-chevron"><AppIcon name="chevron" :size="16" /></view></button></view>
        <view class="sheet-action-cell"><button role="button" class="sheet-action-option" aria-label="发现美食" @click.stop="discoverFood" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><view class="sheet-action-icon"><AppIcon name="community" :size="26" active /></view><text class="sheet-action-label">发现美食</text><text class="menu-create-description">挑选喜欢的菜加入菜单</text><view class="menu-create-chevron"><AppIcon name="chevron" :size="16" /></view></button></view>
      </view>
    </Sheet>
    <RecipeEditor v-if="editingRecipe" :recipe="recipeDraft" :initial-category="creationCategory" :expand-details="expandRecipeDetails" @close="editingRecipe = false" @saved="saved" />
    <SetEditor v-if="editingSet" :meal-set="setDraft" @close="editingSet = false" @saved="saved" />
    <ShareSheet v-if="sharing" :item-id="sharing.itemId" :kind="sharing.kind" @supplement="sharing = null; createDish($event, true)" @close="sharing = null" @published="sharing = null; detail = null; setDetail = null; tab = 'community'" />
    <FriendShareSheet v-if="friendSharing" :card="friendSharing.card" :preparing="friendSharing.preparing" @close="closeFriendShare" @retry="retryFriendShare" @publish="publishFriendShare" />
    <FamilyEditor v-if="editingFamily" :page="tab === 'family'" :initial-tab="familyEditorTab" @close="editingFamily = false" />
    <AddDishesSheet v-if="addingOrderId" :order="addingOrder" :entries="menuEntries" :member-id="state.activeMemberId" :today="today" :saving="additionSaving" :error="additionError" @close="closeAdditions" @save="saveAdditions" />
    <Sheet v-if="cartOpen" page variant="checkout" title="安排" @close="cartOpen = false">
      <view class="checkout-cards">
        <view class="checkout-card checkout-schedule"><MealBar :meal-error="mealRequired && !meal" :date="date" :meal="meal" :today="today" @update:date="updateMealSlot('date', $event)" @update:meal="updateMealSlot('meal', $event)" /><view v-if="checkout.tip" class="checkout-tip" :class="{ warning: checkout.warning }" role="status"><template v-if="checkout.action === 'occupied'"><text>这一餐已安排，</text><button role="button" class="checkout-view-link" @click="revealOrder(currentOrder?.id)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><text class="checkout-view-label">去看看</text><view class="checkout-view-arrow" aria-hidden="true" /></button></template><text v-else>{{ checkout.tip }}</text></view></view>
        <view class="checkout-card checkout-dishes"><view class="checkout-card-heading"><text class="subheading">已选 {{ dishCount }} 道菜</text><button role="button" class="text-button" @click="$feedback(); cartOpen = false" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90"><AppIcon name="plus" :size="16" />继续选菜</button></view><MealDishList v-if="dishCount" :rows="cartRows" :posts="state.posts" removable @open="orderRecipe = $event" @remove="removeCartDish" /><text v-else class="checkout-empty">还没有选菜</text></view>
        <view class="checkout-card checkout-note"><FormField multiline v-model="note" field-class="textarea short" placeholder="给大厨的备注" placeholder-style="font-size: 15px; line-height: 22px; font-weight: 400;" maxlength="200" aria-label="安排备注" /></view>
      </view>
      <view class="checkout-actions"><view v-if="submitError" class="checkout-tip warning checkout-submit-error" role="alert"><text>{{ submitError }}</text></view><button role="button" class="primary-button full checkout-submit" :disabled="checkout.action === 'blocked' || submitting" @click="submit" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">{{ submitting ? '正在提交…' : checkout.label }}</button></view>
    </Sheet>
    <MealPreparationSheet v-if="preparingOrderId" :order-id="preparingOrderId" :today="today" @close="preparingOrderId = ''" @open="orderRecipe = $event" />
    <Sheet v-if="mealHistoryOpen" :key="`history:${cloudStatus.userId}:${state.family.id}`" :title="`饮食日记 · ${state.family.kind === 'personal' ? '自己' : '家庭'}`" variant="meal-diary" page :fit-content="false" :footer-visible="false" @close="mealHistoryOpen = false" @reach-bottom="mealTimeline?.loadMore()">
      <MealTimeline ref="mealTimeline" :orders="state.orders" :today="today" :active="!mealPublishing && !orderRecipe" @open="orderRecipe = $event" @record="recordMeal()" @changed="diaryChanged" />
    </Sheet>
    <MealPublishSheet v-if="mealPublishing" :key="state.family.id" :order="mealShareOrder" :orders="state.orders.filter(order => !isPendingRecord(order.id))" @close="mealPublishing = false; mealShareOrder = null" @saved="mealSaved" />
    <RecipeSheet v-if="orderRecipe" :recipe="orderMenuRecipe || orderRecipe" :read-only="!orderMenuRecipe" :selected="Boolean(cart[orderRecipe.id])" :busy="removingMenuEntry" @close="orderRecipe = null" @add="addDetail($event, 'dish')" @share="item => { orderRecipe = null; shareEntry({ ...item, kind: 'dish' }); }" @edit="createDish" @supplement="createDish($event, true)" @remove="item => { orderRecipe = null; remove({ ...item, kind: 'dish' }); }" />
    <MutationSyncStatus v-if="cloudMode" />
    <view v-if="cloudMode && cloudStatus.error && !mutationStatus.failures.length && !mutationStatus.pending.length" class="cloud-sync-warning" role="alert"><text>暂未同步：{{ cloudStatus.error }}</text><button role="button" class="text-button" @click="runAction(connectCloud)" hover-class="touch-feedback" :hover-start-time="0" :hover-stay-time="90">重试</button></view>
    </template>
  </view>
</template>

<style scoped>
.meals-cover { position: relative; margin: 0 calc(-1 * var(--page-gutter)); }
.meals-cover-content { position: relative; box-sizing: border-box; min-height: calc(var(--home-cover-content-height) - 12px); padding: 12px 20px 12px; color: var(--white); }
.meals-cover-date { display: block; color: rgba(255, 255, 255, .96); font-size: var(--type-meta); line-height: 18px; letter-spacing: .5px; }
.meals-cover-title { display: block; margin-top: 12px; color: var(--white); font-family: 'Songti SC', 'STSong', serif; font-size: var(--type-display); font-weight: 600; line-height: 38px; letter-spacing: 1px; }
.meals-cover-date, .meals-cover-title, .meals-cover-summary { text-shadow: 0 1px 3px rgba(22, 28, 32, .45); }
.meals-cover-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 22px; }
.meal-section-switch { position: relative; display: flex; flex: 0 0 160px; align-items: center; box-sizing: border-box; width: 160px; padding: 0 3px; border: 0; border-radius: 999px; background: rgba(0, 0, 0, .32); }
.meal-section-button { position: relative; display: flex; flex: 1 1 0; align-items: center; justify-content: center; min-width: 0; min-height: 44px; height: 44px; margin: 0; padding: 0 12px; border-radius: 999px; background: transparent; color: rgba(255, 255, 255, .88); font-size: var(--type-body); line-height: 22px; transition: none; }
.meal-section-button::after { border: 0; }
.meal-section-button.selected { color: var(--green); font-weight: 500; }
.meal-section-button.selected::before { content: ''; position: absolute; inset: 3px 0; border-radius: 999px; background: var(--white); pointer-events: none; }
.meal-section-label { position: relative; display: inline-flex; align-items: center; }
.meals-cover-summary { flex-shrink: 0; color: rgba(255, 255, 255, .96); font-size: var(--type-caption); line-height: 18px; }
.kitchen-continue { display: flex; align-items: center; justify-content: center; min-height: 96px; padding: 0; margin: calc(-1 * (var(--page-gutter) + 6px)) calc(-1 * (var(--page-gutter) + 6px)) 4px; border-bottom: 0.5px solid var(--line); }
.kitchen-idle-title { font-size: var(--type-body); font-weight: 400; color: var(--muted); }
.square-page .content { height: 100vh; padding-bottom: 0; overflow: hidden; }
/* Native disabled styling must not bleach optimistic meal cards while they sync. */
.order-progress-actions .primary-button.meal-record-button { background: var(--green); color: var(--white); opacity: 1; transition: none; }
.order-progress-actions .primary-button.meal-record-button.is-unavailable { background: var(--green-light); color: var(--muted); }
.meal-record-label { display: block; color: inherit; font-size: var(--type-control); line-height: 22px; white-space: nowrap; }
.orders-view { padding-top: 0; }
</style>

<style scoped>
.meals-home > .menu-home, .meals-home > .activity-view { position: relative; margin: calc(-1 * var(--radius-sheet)) calc(-1 * var(--page-gutter)) 0; padding: calc(6px + var(--radius-sheet)) var(--page-gutter) 0; border-radius: var(--radius-sheet) var(--radius-sheet) 0 0; background: var(--white); }
.meals-home > .menu-home, .meals-home > .activity-view { padding-top: 10px; }
.meals-home > .activity-view { padding-top: calc(var(--page-gutter) + 12px); padding-right: calc(var(--page-gutter) + 6px); padding-left: calc(var(--page-gutter) + 6px); }
</style>

<style scoped>
.meal-section-count { position: absolute; top: 0; left: calc(100% + 3px); width: 5px; height: 5px; border-radius: 50%; background: var(--notification); }
</style>
