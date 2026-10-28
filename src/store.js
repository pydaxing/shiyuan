import { computed, ref } from 'vue';
import { createSeed, communityPosts } from './data/seed.js';
import { normalizeSnapshot } from './domain/kitchen.js';
import { createKitchenActions } from './domain/actions.js';
import { cloudMode, refreshCloud, cloudStatus, remoteAction, bindCloudState, commandQueueStatus } from './services/cloud.js';
import { emptySnapshot } from './domain/empty.js';
import { hasIngredientManagement } from './domain/navigation.js';
export { cloudMode, cloudStatus };
export { commandQueueStatus, mutationStatus, retryCommand, discardCommand, retryMutation, dismissMutation, mergeCloudCommunity } from './services/cloud.js';

const STORAGE_KEY = 'shiyuan-local-v1';
export const storageError = ref('');
let storageBlocked = false;

function load() {
  if (cloudMode) return emptySnapshot();
  try {
    const saved = uni.getStorageSync(STORAGE_KEY);
    if (!saved) return normalizeSnapshot(createSeed());
    const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
    const next = normalizeSnapshot(parsed);
    next.activeMemberId = next.family.members.find((member) => member.id === 'me')?.id || next.activeMemberId;
    return next;
  } catch {
    storageBlocked = true;
    storageError.value = '存储无法读取，原数据未覆盖。请保留当前数据并联系支持，暂勿清理缓存。';
    return normalizeSnapshot(createSeed());
  }
}

export const state = ref(load());
bindCloudState(state);
export const activeMember = computed(() => {
  return state.value.family.members.find((entry) => entry.id === state.value.activeMemberId) || state.value.family.members[0];
});
export const familyFeatures = computed(() => state.value.family.features);
export const ingredientManagementEnabled = computed(() => hasIngredientManagement(familyFeatures.value));
export const preferencePending = computed(() => commandQueueStatus.value.operations.some(operation => ['setChef', 'setFeature', 'setPreferences'].includes(operation.name) && operation.status !== 'failed'));
const newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

function commit(next, allowReset = false) {
  if (storageBlocked && !allowReset) throw new Error(storageError.value);
  try {
    uni.setStorageSync(STORAGE_KEY, JSON.stringify(next));
  } catch {
    storageError.value = '保存失败，可能是本机空间不足。本次修改未保存，请释放空间后重试。';
    throw new Error(storageError.value);
  }
  state.value = next;
  storageBlocked = false;
  storageError.value = '';
}

const localActions = createKitchenActions({ getState: () => state.value, commit, newId, getPublicPosts: () => communityPosts });

export const submitOrder = (...args) => cloudMode ? remoteAction('submitOrder', args) : localActions.submitOrder(...args);
export const addOrderDishes = (...args) => cloudMode ? remoteAction('addOrderDishes', args) : localActions.addOrderDishes(...args);
export const removeOrderDish = (...args) => cloudMode ? remoteAction('removeOrderDish', args) : localActions.removeOrderDish(...args);
export const updateOrder = (...args) => cloudMode ? remoteAction('updateOrder', args) : localActions.updateOrder(...args);
export const removeOrder = (...args) => cloudMode ? remoteAction('removeOrder', args) : localActions.removeOrder(...args);
export const setDishPrepared = (...args) => cloudMode ? remoteAction('setDishPrepared', args) : localActions.setDishPrepared(...args);
export const saveDishPreparation = (...args) => cloudMode ? remoteAction('saveDishPreparation', args) : localActions.saveDishPreparation(...args);
export const saveShoppingDraft = (...args) => cloudMode ? remoteAction('saveShoppingDraft', args) : localActions.saveShoppingDraft(...args);
export const removeShoppingDraft = (...args) => cloudMode ? remoteAction('removeShoppingDraft', args) : localActions.removeShoppingDraft(...args);
export const addStock = (...args) => cloudMode ? remoteAction('addStock', args) : localActions.addStock(...args);
export const removeStock = (...args) => cloudMode ? remoteAction('removeStock', args) : localActions.removeStock(...args);
export const saveRecipe = (...args) => cloudMode ? remoteAction('saveRecipe', args) : localActions.saveRecipe(...args);
export const addCollection = (...args) => cloudMode ? remoteAction('addCollection', args) : localActions.addCollection(...args);
export const saveMealSet = (...args) => cloudMode ? remoteAction('saveMealSet', args) : localActions.saveMealSet(...args);
export const removeFamilyEntry = (...args) => cloudMode ? remoteAction('removeFamilyEntry', args) : localActions.removeFamilyEntry(...args);
export const setChef = (enabled) => cloudMode ? remoteAction('setChef', [enabled]) : localActions.setChef(enabled);
export const publishToCommunity = (...args) => cloudMode ? remoteAction('publishToCommunity', args) : localActions.publishToCommunity(...args);
export const setFeature = (feature, enabled) => cloudMode ? remoteAction('setFeature', [feature, enabled]) : localActions.setFeature(feature, enabled);
export const setFridgeEnabled = enabled => setFeature('fridge', Boolean(enabled));
export const setIngredientManagement = (enabled) => {
  const values = { fridge: Boolean(enabled), shopping: Boolean(enabled) };
  return cloudMode ? remoteAction('setPreferences', [values]) : localActions.setPreferences(values);
};
export const recordPurchase = (...args) => cloudMode ? remoteAction('recordPurchase', args) : localActions.recordPurchase(...args);
export const switchMember = (...args) => cloudMode ? remoteAction('switchMember', args) : localActions.switchMember(...args);
export const renameFamily = (...args) => cloudMode ? remoteAction('renameFamily', args) : localActions.renameFamily(...args);
export const customizeFamily = (...args) => cloudMode ? remoteAction('customizeFamily', args) : localActions.customizeFamily(...args);
export const changeStockImage = (...args) => cloudMode ? remoteAction('changeStockImage', args) : localActions.changeStockImage(...args);
export const deleteCommunityPost = (...args) => cloudMode ? remoteAction('deleteCommunityPost', args) : localActions.deleteCommunityPost(...args);
export const addComment = (...args) => cloudMode ? remoteAction('addComment', args) : localActions.addComment(...args);
export const toggleCommentLike = (...args) => cloudMode ? remoteAction('toggleCommentLike', args) : localActions.toggleCommentLike(...args);

export function resetDemo() {
  if (cloudMode) throw new Error('云端数据不能通过本机重置清除');
  commit(normalizeSnapshot(createSeed()), true);
}

export function notify(message) {
  uni.showToast({ title: message, icon: 'none', duration: 2600, mask: false });
}

export function runAction(action) {
  try {
    const result = action();
    return result?.catch ? result.catch(error => { notify(error.message || '操作失败，请重试'); return false; }) : result;
  } catch (error) { notify(error.message || '操作失败，请重试'); return false; }
}

export async function connectCloud(options) {
  if (!cloudMode) return;
  return refreshCloud(options);
}
