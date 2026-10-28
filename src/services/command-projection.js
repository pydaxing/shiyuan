import { actionNames, createKitchenActions } from '../domain/actions.js';
import { clone, localDate } from '../domain/kitchen.js';
import { dishPreparationSignature, preparationEditSignature } from '../domain/meal-preparation.js';
import { shoppingEditSignature } from '../domain/meal-shopping.js';

const labels = {
  submitOrder: '保存选菜', addOrderDishes: '加菜', removeOrderDish: '移除本餐菜品', updateOrder: '更新餐单', removeOrder: '删除餐单',
  setDishPrepared: '更新备菜状态', saveDishPreparation: '保存本餐调整', saveShoppingDraft: '保存采购清单', removeShoppingDraft: '移除采购清单',
  saveRecipe: '保存菜品', saveMealSet: '保存套餐', customizeFamily: '保存家庭设置', removeFamilyEntry: '移除家庭菜单',
  addStock: '记录食材', removeStock: '删除食材', changeStockImage: '保存食材图片', recordPurchase: '记录采购',
  setChef: '保存大厨设置', setFeature: '保存功能设置', setPreferences: '保存功能设置',
  addCollection: '加入家庭菜单', publishToCommunity: '发布分享', deleteCommunityPost: '删除分享', addComment: '发布评论', toggleCommentLike: '更新点赞',
};
const metadataOnly = new Set(['recordPurchase', 'addCollection', 'publishToCommunity', 'addComment']);
const recipeFields = ['id', 'title', 'category', 'servings', 'minutes', 'image', 'nutrition', 'ingredients', 'steps', 'provenance'];
const pick = (value, fields) => value ? Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field, value[field]])) : null;
const find = (items, id) => items?.find(item => item.id === id);
const invalid = message => { throw Object.assign(new Error(message), { code: 'INVALID' }); };
const validId = value => typeof value === 'string' && /^[\w-]{1,200}$/.test(value) && !/^(pending|temporary|tmp)-/.test(value);
const requireId = value => { if (!validId(value)) invalid('记录尚未同步或标识无效，请等待同步完成'); };

function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (!value || typeof value !== 'object') return value ?? null;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['updatedAt', 'updatedBy', 'preparedAt', 'preparedBy', 'createdAt', 'completedAt', 'cancelledAt', 'shareId'].includes(key)).map(key => [key, semantic(value[key])]));
}

export function commandDependencies(snapshot, name, args) {
  const [target, second] = args;
  const member = find(snapshot.family.members, snapshot.activeMemberId);
  const order = find(snapshot.orders, target);
  const item = order?.items?.find(entry => entry.recipe.id === second);
  let values;
  if (name === 'setChef') values = { chef: member?.isChef };
  else if (name === 'setFeature') values = { [target]: snapshot.family.features[target] };
  else if (name === 'setPreferences') values = Object.fromEntries(Object.keys(target).sort().map(key => [key, key === 'chef' ? member?.isChef : snapshot.family.features[key]]));
  else if (name === 'customizeFamily') values = pick(snapshot.family, Object.keys(target));
  else if (name === 'saveRecipe') values = second ? pick(find(snapshot.recipes, second), recipeFields) : null;
  else if (name === 'saveMealSet') values = { set: second ? pick(find(snapshot.mealSets, second), ['id', 'title', 'image', 'recipeIds']) : null, recipes: target.recipeIds.map(id => [id, Boolean(find(snapshot.recipes, id))]) };
  else if (name === 'removeFamilyEntry') values = second === 'set' ? find(snapshot.mealSets, target) : { recipe: pick(find(snapshot.recipes, target), recipeFields), sets: snapshot.mealSets.filter(entry => entry.recipeIds.includes(target)) };
  else if (name === 'removeStock') values = find(snapshot.inventory, target);
  else if (name === 'changeStockImage') values = pick(find(snapshot.inventory, target), ['id', 'image']);
  else if (['setDishPrepared', 'saveDishPreparation', 'saveShoppingDraft', 'removeShoppingDraft'].includes(name)) values = {
    order: pick(order, ['id', 'status']), item,
    edit: order?.preparationEdits?.find(entry => entry.recipeId === second) || null,
    prepared: order?.preparedDishes?.find(entry => entry.recipeId === second) || null,
    shopping: order?.shoppingDrafts?.find(entry => entry.recipeId === second) || null,
  };
  else if (['updateOrder', 'removeOrder', 'removeOrderDish'].includes(name)) values = {
    order, purchases: snapshot.purchases.filter(entry => entry.orderIds?.includes(target)),
    ...(name === 'updateOrder' && second === 'accepted' && order?.status === 'cancelled' ? { slot: snapshot.orders.filter(entry => entry.id !== target && entry.date === order.date && entry.meal === order.meal) } : {}),
  };
  else if (name === 'toggleCommentLike') {
    const comment = find(snapshot.comments, target);
    values = comment ? { id: comment.id, postId: comment.postId, liked: Boolean(comment.likes?.includes(snapshot.activeMemberId)) } : null;
  } else if (name === 'deleteCommunityPost') values = pick(find(snapshot.posts, target), ['id', 'publisherId', 'publisherType', 'familyId']);
  else values = null;
  return JSON.stringify(semantic(values));
}

export function commandSignature(snapshot, operation) {
  const [orderId, recipeId] = operation.args;
  const order = find(snapshot.orders, orderId);
  const item = order?.items?.find(entry => entry.recipe.id === recipeId);
  if (['saveShoppingDraft', 'removeShoppingDraft'].includes(operation.name)) return shoppingEditSignature(order, recipeId);
  if (!item) return '';
  const edit = order.preparationEdits?.find(entry => entry.recipeId === recipeId);
  if (operation.name === 'saveDishPreparation') return preparationEditSignature(item, edit);
  if (operation.name === 'setDishPrepared') return dishPreparationSignature(item, edit);
  return '';
}

function simulate(snapshot, operation, { admission = false } = {}) {
  let next = clone(snapshot);
  let sequence = 0;
  const args = clone(operation.args);
  if (operation.name === 'saveRecipe') args[0].servings = 2;
  if (!admission && ['saveDishPreparation', 'setDishPrepared', 'saveShoppingDraft', 'removeShoppingDraft'].includes(operation.name)) {
    const index = operation.name === 'removeShoppingDraft' ? 2 : 3;
    args[index] = commandSignature(next, operation);
  }
  if (operation.name === 'toggleCommentLike' && !admission) {
    const comment = find(next.comments, args[0]);
    if (!comment) return next;
    const likes = comment.likes || [];
    comment.likes = operation.liked ? [...new Set([...likes, next.activeMemberId])] : likes.filter(id => id !== next.activeMemberId);
    return next;
  }
  const actions = createKitchenActions({ getState: () => next, commit: value => { next = value; }, newId: prefix => `pending-${operation.id}-${prefix}-${++sequence}`, today: () => localDate(new Date(operation.createdAt)), now: () => operation.createdAt });
  actions[operation.name](...args);
  for (const field of ['recipes', 'mealSets', 'orders', 'inventory']) {
    for (const entry of next[field]) if (entry.id.startsWith(`pending-${operation.id}-`)) {
      entry.pendingOperationId = operation.id;
      if (entry.createdAt) entry.createdAt = new Date(operation.createdAt).toISOString();
    }
  }
  if (['saveRecipe', 'saveMealSet'].includes(operation.name) && args[1]) {
    const field = operation.name === 'saveRecipe' ? 'recipes' : 'mealSets';
    const original = find(snapshot[field], args[1]);
    const saved = find(next[field], args[1]);
    if (original.shareId === undefined) delete saved.shareId;
    else saved.shareId = original.shareId;
  }
  if (operation.name === 'saveDishPreparation') {
    const edit = find(next.orders, args[0])?.preparationEdits?.find(entry => entry.recipeId === args[1]);
    if (edit) edit.updatedAt = new Date(operation.createdAt).toISOString();
  }
  return next;
}

export function prepareCommand(snapshot, name, input, { id, createdAt }) {
  if (!actionNames.includes(name) || ['switchMember', 'renameFamily'].includes(name)) invalid('不支持此操作');
  if (!Array.isArray(input)) invalid('请求格式无效');
  const args = clone(input);
  const operation = { id, name, args, createdAt, label: labels[name], projected: !metadataOnly.has(name) };
  if (['saveRecipe', 'saveMealSet'].includes(name)) {
    if (args[1]) requireId(args[1]);
    if (name === 'saveMealSet') args[0]?.recipeIds?.forEach(requireId);
  } else if (name === 'submitOrder' || name === 'addOrderDishes') {
    if (name === 'addOrderDishes') requireId(args[0]);
    const cart = args[name === 'submitOrder' ? 0 : 1];
    if (!cart || typeof cart !== 'object' || Object.keys(cart).length > 60) invalid('一餐最多选择 60 项');
    Object.keys(cart).forEach(key => requireId(key.replace(/^set:/, '')));
  } else if (['updateOrder', 'removeOrder', 'removeOrderDish', 'setDishPrepared', 'saveDishPreparation', 'saveShoppingDraft', 'removeShoppingDraft', 'removeStock', 'removeFamilyEntry', 'changeStockImage', 'publishToCommunity', 'deleteCommunityPost', 'addComment', 'toggleCommentLike'].includes(name)) {
    requireId(args[0]);
    if (['removeOrderDish', 'setDishPrepared', 'saveDishPreparation', 'saveShoppingDraft', 'removeShoppingDraft'].includes(name)) requireId(args[1]);
  }
  if (name === 'addCollection') {
    requireId(args[0]?.id);
    if (args[0].recipes) simulate(snapshot, operation, { admission: true });
  } else if (name === 'addComment') {
    if (typeof args[1] !== 'string' || !args[1].trim() || args[1].trim().length > 300) invalid('评论需要 1～300 个字');
    if (args[2]) requireId(args[2]);
  } else if (name === 'deleteCommunityPost' && !find(snapshot.posts, args[0])) operation.projected = false;
  else simulate(snapshot, operation, { admission: true });
  if (name === 'toggleCommentLike') operation.liked = !find(snapshot.comments, args[0])?.likes?.includes(snapshot.activeMemberId);
  operation.dependencies = commandDependencies(snapshot, name, args);
  return operation;
}

export function projectCommand(snapshot, operation) {
  return operation.projected ? simulate(snapshot, operation) : snapshot;
}

export function commandWireArgs(snapshot, operation) {
  const args = clone(operation.args);
  if (['saveDishPreparation', 'setDishPrepared', 'saveShoppingDraft', 'removeShoppingDraft'].includes(operation.name)) args[operation.name === 'removeShoppingDraft' ? 2 : 3] = commandSignature(snapshot, operation);
  return args;
}

export function dependenciesMatch(snapshot, operation) {
  return commandDependencies(snapshot, operation.name, operation.args) === operation.dependencies;
}
