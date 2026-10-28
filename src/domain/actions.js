import { clone, completeOrder, importCollection, matchesImportedSource, makeOrder, mergeMealSelection, rebuildMealOrder, assertMealEditable, validateIngredient, validatePurchase, validateRecipe, validateMealSet, validDate, purchaseQuantity, STOCK_LOCATIONS, validateReservation, shoppingOrders, localDate, hasTextAmount, normalizedIngredient, aggregateItems, requirementSignature } from './kitchen.js';
import { familyPublications, publishedFamilyKeys, publicationKey } from './community-publications.js';
import { validateImage, cleanSteps } from './presentation.js';
import { makeShare, parseShare } from './sharing.js';
import { canDeleteCommunityPost } from './community-policy.js';
import { appendOrderDishes } from './meal-additions.js';
import { removeDishFromOrder } from './meal-removal.js';
import { dishPreparationSignature, preparationEditSignature, normalizePreparationDraft } from './meal-preparation.js';
import { normalizeShoppingDraft, shoppingEditSignature, assertShoppingSources } from './meal-shopping.js';

export const actionNames = ["submitOrder","addOrderDishes","removeOrderDish","updateOrder","removeOrder","setDishPrepared","saveDishPreparation","saveShoppingDraft","removeShoppingDraft","addStock","removeStock","saveRecipe","addCollection","saveMealSet","removeFamilyEntry","setChef","setPreferences","publishToCommunity","setFeature","recordPurchase","switchMember","renameFamily","customizeFamily","changeStockImage","deleteCommunityPost","addComment","toggleCommentLike"];

export function createKitchenActions({ getState, commit, newId, today = localDate, now = Date.now, getPublicPosts = () => [] }) {
  const state = { get value() { return getState(); } };
  const activeMember = { get value() { return state.value.family.members.find(member => member.id === state.value.activeMemberId); } };
function submitOrder(cart, selection, note = '') {
  validateReservation(selection, today());
  const next = clone(state.value);
  const index = next.orders.findIndex((order) => order.date === selection.date && order.meal === selection.meal && ['pending', 'accepted'].includes(order.status));
  if (index >= 0) assertMealEditable(next.orders[index]);
  if (index < 0 && next.orders.some((order) => order.date === selection.date && order.meal === selection.meal && order.status === 'completed')) throw new Error('这一餐已经做好了，请选择其他日期或餐次');
  if (!Object.keys(cart).length && index >= 0) {
    const order = next.orders[index];
    if (!order.selections.some((entry) => entry.memberId === activeMember.value.id)) throw new Error('先选几道想吃的菜吧');
    const remaining = order.selections.filter((entry) => entry.memberId !== activeMember.value.id);
    if (remaining.length) next.orders[index] = rebuildMealOrder({ ...order, selections: remaining });
    else {
      order.status = 'cancelled';
      order.cancelledAt = new Date(now()).toISOString();
      if (order.shoppingDrafts) order.shoppingDrafts = [];
    }
  } else {
    const order = makeOrder({ id: newId('order'), recipes: next.recipes, mealSets: next.mealSets, cart, member: activeMember.value, ...selection, note });
    if (index >= 0) next.orders[index] = mergeMealSelection(next.orders[index], order);
    else next.orders.unshift(order);
  }
  commit(next);
}

function addOrderDishes(orderId, cart) {
  const next = clone(state.value);
  const index = next.orders.findIndex((order) => order.id === orderId);
  const order = next.orders[index];
  next.orders[index] = appendOrderDishes(order, { recipes: next.recipes, mealSets: next.mealSets, cart, member: activeMember.value, today: today() });
  commit(next);
  return order.id;
}

function removeOrderDish(orderId, recipeId) {
  const next = clone(state.value);
  const index = next.orders.findIndex(order => order.id === orderId);
  const order = removeDishFromOrder(next.orders[index], recipeId, { today: today(), now: now() });
  next.orders[index] = order;
  if (order.status === 'cancelled') next.purchases = (next.purchases || []).map(purchase => ({ ...purchase, orderIds: purchase.orderIds.filter(id => id !== orderId) })).filter(purchase => purchase.orderIds.length);
  commit(next);
  return order.id;
}

function updateOrder(orderId, action) {
  if (action === 'completed') return commit(completeOrder(state.value, orderId, today(), now()));
  const next = clone(state.value);
  const order = next.orders.find((entry) => entry.id === orderId);
  if (action === 'accepted' && order?.status === 'cancelled') {
    validateReservation(order, today());
    if (!order.items.length) throw Object.assign(new Error('这餐已没有菜品，请从菜单重新预订'), { code: 'CONFLICT' });
    if (next.orders.some(entry => entry.id !== orderId && entry.date === order.date && entry.meal === order.meal && ['pending', 'accepted', 'completed'].includes(entry.status))) throw Object.assign(new Error('这个餐次已有餐单，请先查看厨房，不能重复恢复'), { code: 'CONFLICT' });
    order.status = 'accepted';
    return commit(next);
  }
  if (!order || !['pending', 'accepted'].includes(order.status)) throw new Error('订单状态已变化，请重新查看');
  if (action === 'accepted' && order.status === 'accepted') return;
  if (!['accepted', 'cancelled'].includes(action)) throw new Error('不支持的订单操作');
  order.status = action;
  if (action === 'cancelled') {
    order.cancelledAt = new Date(now()).toISOString();
    if (order.shoppingDrafts) order.shoppingDrafts = [];
    next.purchases = (next.purchases || []).map(purchase => ({ ...purchase, orderIds: purchase.orderIds.filter(id => id !== orderId) })).filter(purchase => purchase.orderIds.length);
  }
  commit(next);
}

function removeOrder(orderId) {
  const next = clone(state.value);
  if (!next.orders.some(order => order.id === orderId)) throw Object.assign(new Error('这一餐已被删除，请重新查看'), { code: 'CONFLICT' });
  next.orders = next.orders.filter(order => order.id !== orderId);
  next.purchases = (next.purchases || []).map(purchase => ({ ...purchase, orderIds: purchase.orderIds.filter(id => id !== orderId) })).filter(purchase => purchase.orderIds.length);
  commit(next);
  return orderId;
}

function setDishPrepared(orderId, recipeId, prepared, signature) {
  if (typeof prepared !== 'boolean' || typeof signature !== 'string' || !signature || signature.length > 50000) throw new Error('备菜信息无效，请重新打开');
  const next = clone(state.value);
  const order = next.orders.find(entry => entry.id === orderId);
  if (!order || !['pending', 'accepted'].includes(order.status)) throw Object.assign(new Error('这一餐已结束或已取消，请重新查看'), { code: 'CONFLICT' });
  const item = order.items.find(entry => entry.recipe.id === recipeId);
  const edit = order.preparationEdits?.find(record => record.recipeId === recipeId);
  if (!item || signature !== dishPreparationSignature(item, edit)) throw Object.assign(new Error('这道菜的备菜用量已变化，请重新确认'), { code: 'CONFLICT' });
  order.preparedDishes = (order.preparedDishes || []).filter(record => record.recipeId !== recipeId);
  if (prepared) {
    order.preparedDishes.push({ recipeId, signature, preparedBy: activeMember.value.id, preparedAt: new Date(now()).toISOString() });
    if (order.shoppingDrafts) order.shoppingDrafts = order.shoppingDrafts.filter(record => record.recipeId !== recipeId);
  }
  commit(next);
  return order.id;
}

function saveDishPreparation(orderId, recipeId, draft, signature) {
  if (typeof signature !== 'string' || !signature || signature.length > 50000) throw new Error('备菜信息无效，请重新打开');
  const clean = normalizePreparationDraft(draft);
  const next = clone(state.value);
  const order = next.orders.find(entry => entry.id === orderId);
  if (!order || !['pending', 'accepted'].includes(order.status)) throw Object.assign(new Error('这一餐已结束或已取消，请重新查看'), { code: 'CONFLICT' });
  const item = order.items.find(entry => entry.recipe.id === recipeId);
  const previous = order.preparationEdits?.find(record => record.recipeId === recipeId);
  if (!item || signature !== preparationEditSignature(item, previous)) throw Object.assign(new Error('这道菜的食材或备注已更新，请载入最新内容后再修改'), { code: 'CONFLICT' });
  const edit = { recipeId, quantity: item.quantity * (item.scale ?? 1), ...clean, updatedBy: activeMember.value.id, updatedAt: new Date().toISOString() };
  const previousSignature = dishPreparationSignature(item, previous);
  const changed = previousSignature !== dishPreparationSignature(item, edit);
  const readyReset = changed && (order.preparedDishes || []).some(record => record.recipeId === recipeId && record.signature === previousSignature);
  order.preparationEdits = [...(order.preparationEdits || []).filter(record => record.recipeId !== recipeId), edit];
  if (changed) order.preparedDishes = (order.preparedDishes || []).filter(record => record.recipeId !== recipeId);
  commit(next);
  return { orderId, readyReset };
}

function currentShoppingOrder(next, orderId, recipeId, signature) {
  const order = next.orders.find(entry => entry.id === orderId);
  if (!order || !['pending', 'accepted'].includes(order.status)) throw Object.assign(new Error('这一餐已结束或已删除，请重新查看'), { code: 'CONFLICT' });
  if (typeof signature !== 'string' || !signature || signature.length > 100000 || signature !== shoppingEditSignature(order, recipeId)) throw Object.assign(new Error('家人已更新备菜或采购清单，请载入最新内容'), { code: 'CONFLICT' });
  return order;
}

function saveShoppingDraft(orderId, recipeId, draft, signature) {
  const clean = normalizeShoppingDraft(draft);
  const next = clone(state.value);
  const order = currentShoppingOrder(next, orderId, recipeId, signature);
  const item = order.items.find(entry => entry.recipe.id === recipeId);
  const edit = order.preparationEdits?.find(entry => entry.recipeId === recipeId);
  const sourceSignature = dishPreparationSignature(item, edit);
  if (order.preparedDishes?.some(record => record.recipeId === recipeId && record.signature === sourceSignature)) throw Object.assign(new Error('这道菜已备齐，需要采购时请先取消已备'), { code: 'CONFLICT' });
  assertShoppingSources(order, recipeId, clean);
  order.shoppingDrafts = [...(order.shoppingDrafts || []).filter(record => record.recipeId !== recipeId), { recipeId, sourceSignature, ...clean, updatedBy: activeMember.value.id, updatedAt: new Date(now()).toISOString() }];
  commit(next);
  return orderId;
}

function removeShoppingDraft(orderId, recipeId, signature) {
  const next = clone(state.value);
  const order = currentShoppingOrder(next, orderId, recipeId, signature);
  order.shoppingDrafts = (order.shoppingDrafts || []).filter(record => record.recipeId !== recipeId);
  commit(next);
  return orderId;
}

function addStock(batch) {
  validateIngredient(batch);
  validateImage(batch.image);
  if (!STOCK_LOCATIONS.includes(batch.location)) throw new Error('请选择存放位置');
  if (batch.expiresOn && !validDate(batch.expiresOn)) throw new Error('请填写正确的到期日期');
  const next = clone(state.value);
  next.inventory.push({ ...batch, id: newId('stock'), name: batch.name.trim(), quantity: Number(batch.quantity) });
  commit(next);
}

function removeStock(id) {
  const next = clone(state.value);
  next.inventory = next.inventory.filter((batch) => batch.id !== id);
  commit(next);
}

function saveRecipe(recipe, editingId) {
  recipe = { ...recipe, nutrition: typeof recipe.nutrition === 'string' ? recipe.nutrition.trim() : recipe.nutrition, steps: cleanSteps(recipe.steps) };
  validateRecipe(recipe, { requireStepTitles: true });
  const next = clone(state.value);
  const index = next.recipes.findIndex((entry) => entry.id === editingId);
  if (editingId && index < 0) throw new Error('菜品已不存在，请重新打开');
  const saved = { ...(index >= 0 ? next.recipes[index] : {}), ...clone(recipe), title: recipe.title.trim(), id: editingId || newId('recipe'), shareId: newId('shared-dish'), author: activeMember.value.name, tag: '家庭私房菜', servings: Number(recipe.servings), minutes: recipe.minutes === null ? null : Number(recipe.minutes), ingredients: recipe.ingredients.map((item) => ({ ...item, name: item.name.trim(), quantity: hasTextAmount(item) ? null : Number(item.quantity), ...(hasTextAmount(item) ? { amountText: item.amountText.trim() } : {}) })) };
  if (index >= 0) next.recipes.splice(index, 1, saved);
  else next.recipes.unshift(saved);
  commit(next);
}

function addCollection(collection) {
  if (!Array.isArray(collection.recipes) || !collection.recipes.length) throw new Error('没有可加入的菜品');
  collection.recipes.forEach(validateRecipe);
  const next = clone(state.value);
  const previous = next.recipes.length;
  next.recipes = importCollection(next.recipes, collection, { newId, familyId: next.family.id });
  if (collection.kind === 'menu' || (!collection.kind && collection.recipes.length > 1)) {
    const mealSet = { id: newId('set'), shareId: newId('shared-set'), sourceId: collection.id, ...(collection.familyId ? { sourceFamilyId: collection.familyId } : {}), sourcePostId: collection.id, title: collection.title, author: collection.author, image: collection.image || '', recipeIds: collection.recipes.map(recipe => next.recipes.find(entry => matchesImportedSource(entry, recipe.id, collection, next.family.id))?.id) };
    validateMealSet(mealSet, next.recipes);
    if (!next.mealSets.some(entry => matchesImportedSource(entry, collection.id, collection))) next.mealSets.unshift(mealSet);
  }
  commit(next);
  return next.recipes.length - previous;
}

function saveMealSet(mealSet, editingId) {
  const next = clone(state.value);
  validateMealSet(mealSet, next.recipes);
  const index = next.mealSets.findIndex((entry) => entry.id === editingId);
  if (editingId && index < 0) throw new Error('套餐已不存在，请重新打开');
  const saved = { ...(index >= 0 ? next.mealSets[index] : {}), ...clone(mealSet), id: editingId || newId('set'), shareId: newId('shared-set'), title: mealSet.title.trim(), author: activeMember.value.name };
  if (index >= 0) next.mealSets.splice(index, 1, saved);
  else next.mealSets.unshift(saved);
  commit(next);
}

function removeFamilyEntry(id, kind = 'dish') {
  const next = clone(state.value);
  if (kind === 'set') next.mealSets = next.mealSets.filter((entry) => entry.id !== id);
  else {
    next.recipes = next.recipes.filter((entry) => entry.id !== id);
    next.mealSets = next.mealSets.map((entry) => ({ ...entry, recipeIds: entry.recipeIds.filter((recipeId) => recipeId !== id) })).filter((entry) => entry.recipeIds.length >= 2);
  }
  commit(next);
}

function setChef(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('大厨设置无效');
  const next = clone(state.value);
  next.family.members.find((member) => member.id === next.activeMemberId).isChef = enabled;
  commit(next);
}

function setPreferences(values) {
  const next = clone(state.value);
  for (const [key, enabled] of Object.entries(values)) {
    if (!['chef', 'fridge', 'shopping'].includes(key) || typeof enabled !== 'boolean') throw new Error('功能设置无效');
    if (key === 'chef') next.family.members.find(member => member.id === next.activeMemberId).isChef = enabled;
    else next.family.features[key] = enabled;
  }
  commit(next);
}

function publishToCommunity(id, kind = 'dish') {
  const next = clone(state.value);
  const item = (kind === 'set' ? next.mealSets : next.recipes).find((entry) => entry.id === id);
  if (!item) throw new Error('请从家庭菜单中选择要分享的菜品或套餐');
  if (publishedFamilyKeys(next).has(publicationKey(kind, id))) throw Object.assign(new Error('这道菜品或套餐已分享，请勿重复发布'), { code: 'ALREADY_SHARED' });
  const content = parseShare(makeShare(item, next.recipes, next.family.name, kind));
  const post = { ...content, id: newId('post'), familyId: next.family.id, familyItemId: id, familyKind: kind, publisherId: activeMember.value.id, publisherType: 'user', image: content.image || '', categories: kind === 'set' ? [] : [content.recipes[0].category], publishedAt: new Date().toISOString() };
  next.sharedItems = [...familyPublications(next), { kind, itemId: id, postId: post.id }];
  next.posts = [post, ...next.posts];
  commit(next);
  return post.id;
}

function setFeature(feature, enabled) {
  if (!['fridge', 'shopping'].includes(feature) || typeof enabled !== 'boolean') throw new Error('功能设置无效');
  const next = clone(state.value);
  next.family.features[feature] = enabled;
  commit(next);
}

function recordPurchase(batch) {
  validatePurchase(batch);
  if (batch.kind === 'confirmation') {
    const next = clone(state.value);
    const required = normalizedIngredient(batch);
    const orders = shoppingOrders(next.orders, today()).filter((order) => aggregateItems(order.items).some((item) => item.key === required.key));
    if (!orders.length) throw new Error('这项食材已不在待做餐食中');
    for (const order of orders) {
      next.purchases = next.purchases.filter((purchase) => !(purchase.kind === 'confirmation' && purchase.orderIds.includes(order.id) && normalizedIngredient(purchase).key === required.key));
      next.purchases.push({ id: newId('confirmation'), kind: 'confirmation', name: batch.name.trim(), quantity: null, unit: '', amountText: batch.amountText.trim(), orderIds: [order.id], signature: requirementSignature(order, required.key) });
    }
    return commit(next);
  }
  if (batch.expiresOn && !validDate(batch.expiresOn)) throw new Error('请填写正确的到期日期');
  if (purchaseQuantity(Number(batch.quantity), batch.unit) !== Number(batch.quantity)) throw new Error(['g', 'kg', 'ml', 'L'].includes(batch.unit) ? '购买数量请精确到整克或整毫升' : `购买数量请填写完整的${batch.unit}数`);
  const next = clone(state.value);
  const orderIds = shoppingOrders(next.orders, today()).map((order) => order.id);
  if (!orderIds.length) throw new Error('当前没有待采购订单');
  next.purchases.push({ id: newId('purchase'), name: batch.name.trim(), quantity: Number(batch.quantity), unit: batch.unit, expiresOn: batch.expiresOn || '', orderIds });
  commit(next);
}

function switchMember(id) {
  if (!state.value.family.members.some((member) => member.id === id)) throw new Error('该家庭成员不存在');
  commit({ ...clone(state.value), activeMemberId: id });
}

function renameFamily(name) {
  if (!name.trim() || name.trim().length > 20) throw new Error('家庭名称需要 1～20 个字');
  const next = clone(state.value);
  next.family.name = name.trim();
  commit(next);
}

function customizeFamily({ name, cover, coverTitle, coverSubtitle }) {
  if (!name.trim() || name.trim().length > 20) throw new Error('家庭名称需要 1～20 个字');
  if (typeof coverTitle !== 'string' || coverTitle.length > 30) throw new Error('菜单主标题最多 30 个字');
  if (coverSubtitle !== undefined && (typeof coverSubtitle !== 'string' || coverSubtitle.length > 50)) throw new Error('菜单副标题最多 50 个字');
  validateImage(cover);
  const next = clone(state.value);
  Object.assign(next.family, { name: name.trim(), cover, coverTitle: coverTitle.trim() });
  if (coverSubtitle !== undefined) next.family.coverSubtitle = coverSubtitle.trim();
  commit(next);
}

function changeStockImage(id, image) {
  validateImage(image);
  const next = clone(state.value);
  const batch = next.inventory.find((entry) => entry.id === id);
  if (!batch) throw new Error('这份食材已不在冰箱中');
  batch.image = image;
  commit(next);
}

function deleteCommunityPost(postId) {
  const next = clone(state.value);
  const post = next.posts.find((entry) => entry.id === postId);
  if (!canDeleteCommunityPost(post, activeMember.value.id, next.family.id)) throw new Error('只能删除自己发布的内容');
  next.sharedItems = familyPublications(next).filter(item => item.postId !== postId);
  next.posts = next.posts.filter((entry) => entry.id !== postId);
  next.comments = next.comments.filter((entry) => entry.postId !== postId);
  commit(next);
}

function addComment(postId, text, replyToId = '') {
  if (typeof text !== 'string' || !text.trim() || text.trim().length > 300) throw new Error('评论需要 1～300 个字');
  if (![...state.value.posts, ...getPublicPosts()].some((post) => post.id === postId)) throw new Error('这条分享已不存在');
  const next = clone(state.value);
  next.comments = next.comments || [];
  const target = next.comments.find((entry) => entry.id === replyToId && entry.postId === postId);
  if (replyToId && !target) throw new Error('要回复的评论已不存在');
  next.comments.push({ id: newId('comment'), postId, memberId: activeMember.value.id, author: activeMember.value.name, text: text.trim(), parentId: target?.parentId || target?.id || '', replyToId, replyToAuthor: target?.author || '', likes: [], createdAt: new Date().toISOString() });
  commit(next);
}

function toggleCommentLike(commentId) {
  const next = clone(state.value);
  const comment = next.comments.find((entry) => entry.id === commentId);
  if (!comment) throw new Error('评论已不存在');
  const likes = comment.likes || [];
  comment.likes = likes.includes(activeMember.value.id) ? likes.filter((id) => id !== activeMember.value.id) : [...likes, activeMember.value.id];
  commit(next);
}


  return { submitOrder, addOrderDishes, removeOrderDish, updateOrder, removeOrder, setDishPrepared, saveDishPreparation, saveShoppingDraft, removeShoppingDraft, addStock, removeStock, saveRecipe, addCollection, saveMealSet, removeFamilyEntry, setChef, setPreferences, publishToCommunity, setFeature, recordPurchase, switchMember, renameFamily, customizeFamily, changeStockImage, deleteCommunityPost, addComment, toggleCommentLike };
}
