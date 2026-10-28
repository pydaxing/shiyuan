import { validateImage, stepImages } from './presentation.js';

export const UNITS = ['g', 'kg', '斤', '两', 'ml', 'L', '个', '根', '只', '条', '块', '片', '张', '颗', '粒', '瓣', '朵', '棵', '把', '束', '勺', '茶匙', '汤匙', '杯', '碗', '瓶', '罐', '盒', '袋', '包', '头', '段', '滴', '撮', '盘', '泵', '副', '芽', '小勺', '大勺', '铲勺'];
export const SELECTABLE_UNITS = UNITS.filter(unit => !['小勺', '大勺', '铲勺'].includes(unit));
export const MEALS = ['早餐', '午餐', '晚餐', '宵夜'];
export const CATEGORIES = ['荤菜', '素菜', '汤羹', '主食', '小食', '饮品', '其他'];
export const MAX_RECIPE_STEPS = 60;
export const STOCK_LOCATIONS = ['冷藏', '冷冻', '常温'];
const conversions = { g: ['g', 1], kg: ['g', 1000], 斤: ['g', 500], 两: ['g', 50], ml: ['ml', 1], L: ['ml', 1000] };
const aliases = { 西红柿: '番茄', 土豆: '马铃薯', 青葱: '小葱' };

export const clone = (value) => JSON.parse(JSON.stringify(value));
export const round = (value) => Math.round(value * 1000000) / 1000000;
export const formatQuantity = (value) => Number(Number(value).toFixed(2)).toString();
export const purchaseQuantity = (quantity, unit) => {
  const factor = conversions[unit]?.[1] || 1;
  return round(Math.ceil(round(quantity * factor)) / factor);
};

export const hasTextAmount = (ingredient) => ingredient?.amountText !== undefined;
export const needsShopping = (item) => item.needsConfirmation === true || item.missing > 0;

export function formatAmount(quantity, unit, amountText) {
  if (typeof amountText === 'string' && amountText.trim()) return amountText.trim();
  if (quantity === null || quantity === undefined || !Number.isFinite(Number(quantity))) return '用量待确认';
  if (UNITS.includes(unit) && !conversions[unit]) {
    const value = Number(quantity);
    const whole = Math.floor(value);
    const remainder = value - whole;
    // Accommodate the existing six-decimal quantity precision, without snapping ordinary decimals to fractions.
    for (const denominator of [2, 3, 4, 6, 8]) {
      const numerator = Math.round(remainder * denominator);
      if (value <= 0 || numerator <= 0 || numerator >= denominator || Math.abs(remainder - numerator / denominator) > 0.0000005) continue;
      if (denominator === 2) return whole ? `${whole}${unit}半` : `半${unit}`;
      return `${whole ? `${whole} 又 ` : ''}${numerator}/${denominator} ${unit}`;
    }
  }
  const normalized = normalizedIngredient({ name: '', quantity, unit });
  const digits = ['g', 'ml'].includes(normalized.unit) && normalized.quantity >= 10 ? 0 : 2;
  const displayed = Number(normalized.quantity.toFixed(digits));
  return `${displayed === normalized.quantity ? '' : '约 '}${displayed === 0 && normalized.quantity > 0 ? '<0.01' : displayed} ${normalized.unit}`;
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.valueOf()) && localDate(parsed) === value;
}

export function dateOffset(days, date = new Date()) {
  const target = new Date(date);
  target.setDate(target.getDate() + days);
  return localDate(target);
}

export function reservationDays(today = localDate()) {
  return ['今天', '明天', '后天'].map((label, index) => ({ label, date: dateOffset(index, new Date(`${today}T12:00:00`)) }));
}

export function validateReservation(selection, today = localDate()) {
  if (!reservationDays(today).some((day) => day.date === selection.date)) throw new Error('只能预订今天、明天或后天，请重新选择');
  if (!MEALS.includes(selection.meal)) throw new Error('请选择有效的餐次');
}

export function calendarDateLabel(date) {
  return validDate(date) ? `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日` : '';
}

export function mealDateLabel(date, today = localDate()) {
  if (date === dateOffset(-1, new Date(`${today}T12:00:00`))) return '昨天';
  return reservationDays(today).find((day) => day.date === date)?.label || calendarDateLabel(date);
}

export function kitchenOrders(orders, today = localDate()) {
  const days = new Set(reservationDays(today).map(day => day.date));
  return sortMealOrders(orders.filter(order => days.has(order.date)), today);
}

export function sortMealOrders(orders, today = localDate()) {
  const start = today;
  const finishedTime = (order) => {
    const value = order.status === 'completed' ? order.completedAt : order.cancelledAt;
    const timestamp = typeof value === 'number' ? value : Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  return [...orders].sort((left, right) => {
    const leftFinished = ['completed', 'cancelled'].includes(left.status);
    const rightFinished = ['completed', 'cancelled'].includes(right.status);
    if (leftFinished !== rightFinished) return leftFinished ? 1 : -1;
    if (leftFinished) return finishedTime(right) - finishedTime(left);
    if ((left.date < start) !== (right.date < start)) return left.date < start ? 1 : -1;
    return left.date.localeCompare(right.date) || MEALS.indexOf(left.meal) - MEALS.indexOf(right.meal);
  });
}

export function shoppingOrders(orders, today = localDate()) {
  const lastDay = dateOffset(2, today);
  return kitchenOrders(orders, today).filter((order) => ['pending', 'accepted'].includes(order.status) && order.date >= today && order.date <= lastDay);
}

export function shoppingDraftFieldErrors(draft) {
  const errors = {};
  if (!draft || !Array.isArray(draft.ingredients) || !draft.ingredients.length || draft.ingredients.length > 30) {
    errors.ingredients = '请勾选 1～30 项需要购买的食材 / 配料';
    return errors;
  }
  const keys = new Set();
  draft.ingredients.forEach((ingredient, index) => {
    if (!ingredient || typeof ingredient.sourceKey !== 'string' || !ingredient.sourceKey || ingredient.sourceKey.length > 100 || keys.has(ingredient.sourceKey)) errors[`ingredients.${index}.sourceKey`] = '食材已变化，请重新选择';
    else keys.add(ingredient.sourceKey);
    for (const [field, message] of Object.entries(ingredientFieldErrors(ingredient, true, true))) errors[`ingredients.${index}.${field}`] = message;
  });
  return errors;
}

export function normalizeName(name) {
  const clean = String(name || '').trim().replace(/\s+/g, '');
  return aliases[clean] || clean;
}

export function normalizedIngredient(ingredient) {
  const name = normalizeName(ingredient.name);
  if (hasTextAmount(ingredient)) return { name, unit: '', factor: 1, quantity: null, amountText: ingredient.amountText.trim(), key: `${name}|text:${ingredient.amountText.trim()}` };
  const [unit, factor] = conversions[ingredient.unit] || [ingredient.unit, 1];
  return { name, unit, factor, quantity: round(Number(ingredient.quantity) * factor), key: `${name}|${unit}` };
}

export function ingredientFieldErrors(ingredient, allowText = false, allowZero = false) {
  const errors = {};
  if (!ingredient || typeof ingredient.name !== 'string' || !normalizeName(ingredient.name) || ingredient.name.trim().length > 30) errors.name = '请填写 1～30 字的食材名称';
  if (hasTextAmount(ingredient)) {
    if (!allowText) errors.quantity = '库存和实际购买数量需要填写数字';
    else if (typeof ingredient.amountText !== 'string' || !ingredient.amountText.trim() || ingredient.amountText.length > 60 || /[\u0000-\u001f\u007f]/.test(ingredient.amountText)) errors.amountText = '请填写 1～60 字的用量，如适量、少许';
    if (ingredient.quantity !== null || ingredient.unit !== '') errors.amountText = '文字用量不能同时填写数字数量或单位';
    return errors;
  }
  const zero = allowZero && (typeof ingredient?.quantity === 'number' || typeof ingredient?.quantity === 'string' && ingredient.quantity.trim() !== '') && Number(ingredient.quantity) === 0;
  if (!zero && (!Number.isFinite(Number(ingredient?.quantity)) || Number(ingredient?.quantity) <= 0 || Number(ingredient?.quantity) > 100000)) errors.quantity = allowZero ? '请填写 0～100000 的食材数量' : '食材数量需要大于 0，且不超过 100000';
  else if (!zero && Number(ingredient.quantity) < 0.001) errors.quantity = '食材数量最小为 0.001';
  if (!UNITS.includes(ingredient?.unit)) errors.unit = '请选择支持的食材单位';
  return errors;
}

export function validateIngredient(ingredient) {
  const error = Object.values(ingredientFieldErrors(ingredient))[0];
  if (error) throw new Error(error);
}

export function preparationFieldErrors(draft) {
  const errors = {};
  if (!Array.isArray(draft?.ingredients) || draft.ingredients.length > 30) errors.ingredients = '每道菜最多填写 30 项食材与配料';
  else draft.ingredients.forEach((ingredient, index) => {
    for (const [field, message] of Object.entries(ingredientFieldErrors(ingredient, true, true))) errors[`ingredients.${index}.${field}`] = message;
    if (ingredient?.enabled !== undefined && typeof ingredient.enabled !== 'boolean') errors[`ingredients.${index}.enabled`] = '请选择本餐是否需要这项食材';
  });
  if (typeof draft?.note !== 'string' || draft.note.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(draft.note)) errors.note = '备注请控制在 200 字以内';
  return errors;
}

export function validatePurchase(purchase) {
  if (purchase?.kind !== 'confirmation') return validateIngredient(purchase);
  const error = Object.values(ingredientFieldErrors(purchase, true))[0];
  if (error) throw new Error(error);
  if (!hasTextAmount(purchase)) throw new Error('按需备料确认需要文字用量');
}

export function recipeFieldErrors(recipe, { requireStepTitles = false } = {}) {
  const errors = {};
  if (!recipe || typeof recipe.title !== 'string' || !recipe.title.trim() || recipe.title.trim().length > 30) errors.title = '菜名需要 1～30 个字';
  if (!CATEGORIES.includes(recipe?.category)) errors.category = '请选择菜品分类';
  if (!Number.isInteger(Number(recipe?.servings)) || Number(recipe?.servings) < 1 || Number(recipe?.servings) > 20) errors.servings = '基础份量需要是 1～20 人份';
  if (recipe?.minutes !== null && (!Number.isInteger(Number(recipe?.minutes)) || Number(recipe?.minutes) < 1 || Number(recipe?.minutes) > 600)) errors.minutes = '耗时需要是 1～600 分钟';
  if (!Array.isArray(recipe?.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 30) errors.ingredients = '请填写 1～30 项食材';
  else recipe.ingredients.forEach((ingredient, index) => {
    for (const [field, message] of Object.entries(ingredientFieldErrors(ingredient, true))) errors[`ingredients.${index}.${field}`] = message;
  });
  if (requireStepTitles) {
    if (!Array.isArray(recipe?.steps) || !recipe.steps.length) errors.steps = '请至少添加一个做法步骤并填写标题';
    else if (recipe.steps.length > MAX_RECIPE_STEPS) errors.steps = `做法最多 ${MAX_RECIPE_STEPS} 步`;
    else recipe.steps.forEach((step, index) => {
      if (typeof step?.title !== 'string' || !step.title.trim() || step.title.trim().length > 40) errors[`steps.${index}.title`] = '请填写 1～40 字的步骤标题';
      if (step?.text !== undefined && (typeof step.text !== 'string' || step.text.length > 1000)) errors[`steps.${index}.text`] = '步骤介绍最多 1000 字';
    });
  }
  return errors;
}

export function validateRecipe(recipe, options) {
  const error = Object.values(recipeFieldErrors(recipe, options))[0];
  if (error) throw new Error(error);
  validateImage(recipe.image);
  if (recipe.nutrition !== undefined && (typeof recipe.nutrition !== 'string' || recipe.nutrition.length > 500)) throw new Error('营养疗效最多 500 字');
  if (recipe.provenance !== undefined) {
    const provenance = recipe.provenance;
    const limits = { source: 120, url: 1500, license: 120, attribution: 300, note: 1500 };
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.entries(provenance).some(([key, value]) => !limits[key] || typeof value !== 'string' || value.length > limits[key])) throw new Error('菜谱来源信息无效');
    if (!provenance.source?.trim() || !/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(provenance.url || '')) throw new Error('菜谱来源需要名称和 HTTPS 链接');
  }
  if (!Array.isArray(recipe.steps) || recipe.steps.length > MAX_RECIPE_STEPS || recipe.steps.some((step) => !step || (step.title !== undefined && (typeof step.title !== 'string' || step.title.length > 40)) || (step.text !== undefined && (typeof step.text !== 'string' || step.text.length > 1000)) || !(step.title?.trim() || step.text?.trim() || stepImages(step).length))) throw new Error(`做法最多 ${MAX_RECIPE_STEPS} 步，每步至少添加标题、介绍或图片之一；标题最多 40 字，介绍最多 1000 字`);
  recipe.steps.forEach((step) => {
    validateImage(step.image);
    if (step.images !== undefined && (!Array.isArray(step.images) || step.images.length > 9 || step.images.some((image) => typeof image !== 'string' || !image))) throw new Error('每个步骤最多 9 张图片');
    stepImages(step).forEach(validateImage);
  });
}

export function validateSnapshot(snapshot) {
  const invalid = () => { throw new Error('本机存储格式不兼容或已损坏'); };
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.recipes) || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.inventory) || !Array.isArray(snapshot.family?.members) || !snapshot.family.members.length || typeof snapshot.family.name !== 'string') invalid();
  for (const member of snapshot.family.members) if (typeof member?.id !== 'string' || typeof member.name !== 'string') invalid();
  if (!snapshot.family.members.some((member) => member.id === snapshot.activeMemberId)) invalid();
  validateImage(snapshot.family.cover);
  if (snapshot.family.coverTitle !== undefined && (typeof snapshot.family.coverTitle !== 'string' || snapshot.family.coverTitle.length > 30)) invalid();
  if (snapshot.family.coverSubtitle !== undefined && (typeof snapshot.family.coverSubtitle !== 'string' || snapshot.family.coverSubtitle.length > 50)) invalid();
  if (snapshot.comments !== undefined && (!Array.isArray(snapshot.comments) || snapshot.comments.some((comment) => !comment || typeof comment.id !== 'string' || typeof comment.postId !== 'string' || typeof comment.author !== 'string' || typeof comment.text !== 'string' || !comment.text.trim() || comment.text.length > 300))) invalid();
  for (const comment of snapshot.comments || []) {
    if (comment.likes !== undefined && (!Array.isArray(comment.likes) || comment.likes.some((id) => typeof id !== 'string') || new Set(comment.likes).size !== comment.likes.length)) invalid();
    for (const key of ['parentId', 'replyToId', 'memberId']) if (comment[key] !== undefined && typeof comment[key] !== 'string') invalid();
    if (comment.parentId && !snapshot.comments.some((parent) => parent.id === comment.parentId && parent.postId === comment.postId && !parent.parentId)) invalid();
    if (comment.replyToId && !snapshot.comments.some((parent) => parent.id === comment.replyToId && parent.postId === comment.postId)) invalid();
  }
  snapshot.recipes.forEach(validateRecipe);
  if (snapshot.mealSets !== undefined) {
    if (!Array.isArray(snapshot.mealSets)) invalid();
    snapshot.mealSets.forEach((mealSet) => { if (typeof mealSet?.id !== 'string') invalid(); validateMealSet(mealSet, snapshot.recipes); });
  }
  if (snapshot.family.features !== undefined && (!snapshot.family.features || typeof snapshot.family.features.fridge !== 'boolean' || typeof snapshot.family.features.shopping !== 'boolean')) invalid();
  if (snapshot.family.members.some((member) => member.isChef !== undefined && typeof member.isChef !== 'boolean')) invalid();
  if (snapshot.posts !== undefined) {
    if (!Array.isArray(snapshot.posts)) invalid();
    for (const post of snapshot.posts) {
      if (!post || typeof post.id !== 'string' || typeof post.title !== 'string' || typeof post.author !== 'string' || !['dish', 'menu'].includes(post.kind) || !Array.isArray(post.categories) || post.categories.some((category) => typeof category !== 'string') || !Array.isArray(post.recipes) || !post.recipes.length) invalid();
      post.recipes.forEach(validateRecipe);
      validateImage(post.image);
    }
  }
  if (snapshot.purchases !== undefined) {
    if (!Array.isArray(snapshot.purchases)) invalid();
    for (const purchase of snapshot.purchases) {
      validatePurchase(purchase);
      if (purchase.expiresOn && !validDate(purchase.expiresOn)) invalid();
      if (!Array.isArray(purchase.orderIds) || purchase.orderIds.some((id) => typeof id !== 'string')) invalid();
      if (purchase.kind === 'confirmation' && (typeof purchase.signature !== 'string' || !purchase.signature || purchase.signature.length > 50000 || purchase.orderIds.length !== 1)) invalid();
    }
  }
  for (const batch of snapshot.inventory) {
    validateIngredient(batch);
    validateImage(batch.image);
    if (typeof batch.id !== 'string' || typeof batch.quantity !== 'number' || (batch.expiresOn && !validDate(batch.expiresOn))) invalid();
  }
  for (const order of snapshot.orders) {
    if (!order || typeof order.id !== 'string' || typeof order.memberName !== 'string' || !validDate(order.date) || !MEALS.includes(order.meal) || !['pending', 'accepted', 'completed', 'cancelled'].includes(order.status) || !Array.isArray(order.items) || (!order.items.length && order.status !== 'cancelled')) invalid();
    if (!order.items.length && (order.entries?.length || order.selections?.length)) invalid();
    if (order.preparedDishes !== undefined && (!Array.isArray(order.preparedDishes) || order.preparedDishes.length > order.items.length || new Set(order.preparedDishes.map(record => record?.recipeId)).size !== order.preparedDishes.length || order.preparedDishes.some(record => !record || typeof record.recipeId !== 'string' || !order.items.some(item => item.recipe?.id === record.recipeId) || typeof record.signature !== 'string' || !record.signature || record.signature.length > 50000 || typeof record.preparedBy !== 'string' || typeof record.preparedAt !== 'string' || !Number.isFinite(Date.parse(record.preparedAt))))) invalid();
    if (order.preparationEdits !== undefined) {
      if (!Array.isArray(order.preparationEdits) || order.preparationEdits.length > order.items.length || new Set(order.preparationEdits.map(record => record?.recipeId)).size !== order.preparationEdits.length) invalid();
      for (const record of order.preparationEdits) {
        if (!record || typeof record.recipeId !== 'string' || !order.items.some(item => item.recipe?.id === record.recipeId) || !Number.isFinite(record.quantity) || record.quantity <= 0 || record.quantity > 400 || Object.keys(preparationFieldErrors(record)).length || record.ingredients.some(ingredient => !hasTextAmount(ingredient) && typeof ingredient.quantity !== 'number') || typeof record.updatedBy !== 'string' || !record.updatedBy || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) invalid();
      }
    }
    if (order.shoppingDrafts !== undefined) {
      if (!Array.isArray(order.shoppingDrafts) || order.shoppingDrafts.length > order.items.length || new Set(order.shoppingDrafts.map(record => record?.recipeId)).size !== order.shoppingDrafts.length) invalid();
      for (const record of order.shoppingDrafts) {
        if (!record || !order.items.some(item => item.recipe?.id === record.recipeId) || Object.keys(shoppingDraftFieldErrors(record)).length || record.ingredients.some(ingredient => !hasTextAmount(ingredient) && typeof ingredient.quantity !== 'number') || typeof record.sourceSignature !== 'string' || !record.sourceSignature || record.sourceSignature.length > 50000 || typeof record.updatedBy !== 'string' || !record.updatedBy || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) invalid();
      }
    }
    if (order.diners !== undefined && (!Number.isInteger(order.diners) || order.diners < 1 || order.diners > 20)) invalid();
    if (order.entries !== undefined && (!Array.isArray(order.entries) || order.entries.some((entry) => !entry || typeof entry.title !== 'string' || !['dish', 'set'].includes(entry.kind) || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 20))) invalid();
    for (const item of order.items) {
      if (!item || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) invalid();
      if (item.scale !== undefined && (!Number.isFinite(item.scale) || item.scale <= 0 || item.scale > 20)) invalid();
      validateRecipe(item.recipe);
    }
    if (order.selections !== undefined) {
      if (!Array.isArray(order.selections) || (order.items.length && !order.selections.length) || new Set(order.selections.map((selection) => selection?.memberId)).size !== order.selections.length) invalid();
      for (const selection of order.selections) {
        if (!selection || typeof selection.memberId !== 'string' || typeof selection.memberName !== 'string' || typeof selection.note !== 'string' || !Array.isArray(selection.entries) || !Array.isArray(selection.items) || !selection.items.length) invalid();
        if (selection.entries.some((entry) => !entry || typeof entry.id !== 'string' || typeof entry.title !== 'string' || !['dish', 'set'].includes(entry.kind))) invalid();
        selection.items.forEach((item) => validateRecipe(item?.recipe));
      }
    }
  }
}

export function isExpired(batch, today = localDate()) {
  return Boolean(batch.expiresOn && batch.expiresOn < today);
}

export function expiryLabel(batch, today = localDate()) {
  if (!batch.expiresOn) return '未填写到期日';
  if (isExpired(batch, today)) return '已过期 · 不计可用';
  if (batch.expiresOn === today) return '今天到期';
  const days = Math.round((new Date(`${batch.expiresOn}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
  return days <= 3 ? `${days} 天内到期` : `${batch.expiresOn.slice(5)} 到期`;
}

export function aggregateItems(items) {
  const grouped = new Map();
  for (const item of items) {
    for (const ingredient of item.recipe.ingredients) {
      const normalized = normalizedIngredient(ingredient);
      const previous = grouped.get(normalized.key) || { ...normalized, quantity: hasTextAmount(normalized) ? null : 0, dishes: [] };
      if (!hasTextAmount(normalized)) previous.quantity = round(previous.quantity + normalized.quantity * item.quantity * (item.scale ?? 1));
      if (!previous.dishes.includes(item.recipe.title)) previous.dishes.push(item.recipe.title);
      grouped.set(normalized.key, previous);
    }
  }
  return [...grouped.values()];
}

export function getRequirements(orders, inventory, selection, today = localDate()) {
  const usableOn = validDate(selection.date) && selection.date > today ? selection.date : today;
  const items = orders.filter((order) => order.date === selection.date && order.meal === selection.meal && ['pending', 'accepted'].includes(order.status)).flatMap((order) => order.items);
  return aggregateItems(items).map((required) => {
    if (hasTextAmount(required)) return { ...required, available: null, missing: null, needsConfirmation: true, unitMismatch: false };
    const available = inventory.filter((batch) => !isExpired(batch, usableOn) && normalizedIngredient(batch).key === required.key).reduce((sum, batch) => sum + normalizedIngredient(batch).quantity, 0);
    const unitMismatch = inventory.some((batch) => !isExpired(batch, usableOn) && normalizeName(batch.name) === required.name && normalizedIngredient(batch).unit !== required.unit);
    return { ...required, available: round(available), missing: round(Math.max(0, required.quantity - available)), unitMismatch };
  });
}

export function makeOrder({ id, recipes, mealSets = [], cart, member, date, meal, note = '' }) {
  if (!validDate(date) || !MEALS.includes(meal)) throw new Error('请选择有效的日期和餐次');
  if (!Object.keys(cart).length) throw new Error('先选几道想吃的菜吧');
  if (note.length > 200) throw new Error('备注不能超过 200 字');
  if (Object.keys(cart).length > 100) throw new Error('一次最多选择 100 项');
  const entries = [];
  const items = Object.entries(cart).flatMap(([recipeId, quantity]) => {
    if (quantity !== 1) throw new Error('每道菜只需选中一次');
    const isSet = recipeId.startsWith('set:');
    const selected = isSet ? mealSets.find((entry) => `set:${entry.id}` === recipeId) : recipes.find((entry) => entry.id === recipeId);
    if (!selected) throw new Error('有一道菜或套餐已不在家庭菜单，请重新选择');
    const dishes = isSet ? selected.recipeIds.map((dishId) => recipes.find((entry) => entry.id === dishId)) : [selected];
    if (!dishes.length || dishes.some((dish) => !dish)) throw new Error('套餐内有菜品已不在家庭菜单');
    entries.push({ id: recipeId, kind: isSet ? 'set' : 'dish', title: selected.title, image: selected.image || '', quantity, dishCount: dishes.length, recipeIds: dishes.map((dish) => dish.id) });
    return dishes.map((recipe) => ({ recipe: clone(recipe), quantity: 1 }));
  });
  return rebuildMealOrder({ id, date, meal, memberId: member.id, memberName: member.name, status: 'accepted', createdAt: new Date().toISOString(), selections: [{ memberId: member.id, memberName: member.name, entries, items, note: note.trim() }] });
}

export function rebuildMealOrder(order) {
  const next = clone(order);
  const dishes = new Map();
  const entries = new Map();
  for (const selection of next.selections) {
    const member = { id: selection.memberId, name: selection.memberName };
    for (const item of selection.items) {
      const dish = dishes.get(item.recipe.id) || { recipe: item.recipe, quantity: 1, chosenBy: [] };
      if (!dish.chosenBy.some((person) => person.id === member.id)) dish.chosenBy.push(member);
      dishes.set(item.recipe.id, dish);
    }
    for (const entry of selection.entries) {
      const selected = entries.get(entry.id) || { ...entry, quantity: 1, chosenBy: [] };
      selected.recipeIds = [...new Set([...(selected.recipeIds || []), ...(entry.recipeIds || [])])];
      if (!selected.chosenBy.some((person) => person.id === member.id)) selected.chosenBy.push(member);
      entries.set(entry.id, selected);
    }
  }
  next.items = [...dishes.values()];
  if (next.preparedDishes) next.preparedDishes = next.preparedDishes.filter(record => dishes.has(record.recipeId));
  if (next.preparationEdits) next.preparationEdits = next.preparationEdits.filter(record => dishes.has(record.recipeId));
  if (next.shoppingDrafts) next.shoppingDrafts = next.shoppingDrafts.filter(record => dishes.has(record.recipeId));
  next.entries = [...entries.values()];
  next.note = next.selections.filter((selection) => selection.note).map((selection) => `${selection.memberName}：${selection.note}`).join('\n');
  delete next.diners;
  return next;
}

export function assertMealEditable(order) {
  if (['pending', 'accepted'].includes(order?.status)) return;
  throw Object.assign(new Error('这一餐已结束或已取消，请重新查看厨房'), { code: 'CONFLICT' });
}

export function mergeMealSelection(existing, incoming, { append = false } = {}) {
  if (existing.date !== incoming.date || existing.meal !== incoming.meal) throw new Error('只能合并同一天同一餐的选菜');
  assertMealEditable(existing);
  const selection = clone(incoming.selections[0]);
  const previousSelection = existing.selections.find((entry) => entry.memberId === selection.memberId);
  if (append && previousSelection) {
    const entries = new Map(previousSelection.entries.map((entry) => [entry.id, clone(entry)]));
    for (const entry of selection.entries) {
      const previous = entries.get(entry.id);
      const recipeIds = [...new Set([...(previous?.recipeIds || []), ...entry.recipeIds])];
      entries.set(entry.id, { ...(previous || entry), recipeIds, dishCount: recipeIds.length });
    }
    selection.entries = [...entries.values()];
    const items = new Map();
    for (const item of [...previousSelection.items, ...selection.items]) if (!items.has(item.recipe.id)) items.set(item.recipe.id, clone(item));
    selection.items = [...items.values()];
    selection.note = previousSelection.note;
  }
  const selections = existing.selections.map((entry) => entry.memberId === selection.memberId ? selection : entry);
  if (!previousSelection) selections.push(selection);
  const next = rebuildMealOrder({ ...existing, selections });
  next.items.forEach((item) => {
    const previous = existing.items.find((dish) => dish.recipe.id === item.recipe.id);
    if (previous) item.recipe = clone(previous.recipe);
  });
  next.selections.forEach((selection) => { selection.items = selection.items.map((item) => ({ recipe: clone(next.items.find((dish) => dish.recipe.id === item.recipe.id).recipe), quantity: 1 })); });
  return next;
}

export function completeOrder(state, orderId, today = localDate(), completedAt = Date.now()) {
  const next = clone(state);
  const order = next.orders.find((entry) => entry.id === orderId);
  if (!order || !['pending', 'accepted'].includes(order.status)) throw new Error('订单状态已变化，已结束的餐单不能重复完成');
  if (order.date !== today) throw new Error('只能当天开饭');
  if (next.purchases) {
    next.purchases = next.purchases.map((purchase) => ({ ...purchase, orderIds: purchase.orderIds.filter((id) => id !== order.id) })).filter((purchase) => purchase.orderIds.length);
  }
  order.status = 'completed';
  order.completedAt = new Date(completedAt).toISOString();
  if (order.shoppingDrafts) order.shoppingDrafts = [];
  return next;
}

export function matchesImportedSource(entry, sourceId, collection, familyId) {
  if (!entry || !sourceId) return false;
  if (collection.familyId && collection.familyId === familyId && (entry.shareId || entry.id) === sourceId) return true;
  if (entry.sourceId !== sourceId) return false;
  if (collection.familyId) return entry.sourceFamilyId === collection.familyId;
  return !entry.sourceFamilyId;
}

export function importCollection(recipes, collection, { newId, familyId } = {}) {
  const additions = [];
  for (const recipe of collection.recipes) {
    if ([...recipes, ...additions].some(entry => matchesImportedSource(entry, recipe.id, collection, familyId))) continue;
    const id = newId ? newId('recipe') : `import-${collection.familyId ? `${collection.familyId}-` : ''}${recipe.id}`;
    additions.push({ ...clone(recipe), id, ...(newId ? { shareId: newId('shared-dish') } : {}), sourceId: recipe.id,
      ...(collection.familyId ? { sourceFamilyId: collection.familyId } : {}),
      ...(collection.id ? { sourcePostId: collection.id } : {}), author: collection.author });
  }
  return [...recipes, ...additions];
}

export function mealSetFieldErrors(mealSet, recipes) {
  const errors = {};
  if (!mealSet || typeof mealSet.title !== 'string' || !mealSet.title.trim() || mealSet.title.trim().length > 30) errors.title = '套餐名称需要 1～30 个字';
  if (!Array.isArray(mealSet?.recipeIds) || mealSet.recipeIds.length < 2 || mealSet.recipeIds.length > 20 || new Set(mealSet.recipeIds).size !== mealSet.recipeIds.length || mealSet.recipeIds.some(id => !recipes.some(recipe => recipe.id === id))) errors.recipeIds = '套餐请选择 2～20 道不同菜品';
  return errors;
}

export function validateMealSet(mealSet, recipes) {
  const error = Object.values(mealSetFieldErrors(mealSet, recipes))[0];
  if (error) throw new Error(error);
  validateImage(mealSet.image);
}

export function normalizeSnapshot(snapshot) {
  validateSnapshot(snapshot);
  const next = clone(snapshot);
  next.mealSets ??= [];
  next.purchases ??= [];
  next.posts ??= [];
  next.comments ??= [];
  next.comments.forEach((comment) => { comment.likes ??= []; });
  next.family.features ??= { fridge: false, shopping: false };
  next.family.members.forEach((member) => { member.isChef ??= false; if (member.id === 'chef' && member.name === '大厨') member.name = '家人'; });
  const meals = new Map();
  next.orders = next.orders.filter((order) => {
    if (!['pending', 'accepted'].includes(order.status)) return true;
    for (const entry of [...(order.entries || []), ...(order.selections || []).flatMap((selection) => selection.entries)]) {
      if (!entry.recipeIds) entry.recipeIds = entry.kind === 'dish' ? [entry.id] : (next.mealSets.find((mealSet) => `set:${mealSet.id}` === entry.id)?.recipeIds || []).filter((id) => order.items.some((item) => item.recipe.id === id));
    }
    const legacy = order.selections || [{ memberId: order.memberId || next.activeMemberId, memberName: order.memberName, entries: order.entries || order.items.map((item) => ({ id: item.recipe.id, title: item.recipe.title, image: item.recipe.image, kind: 'dish', quantity: 1 })), items: order.items, note: order.note || '' }];
    legacy.forEach((selection) => { selection.items = selection.items.map((item) => ({ recipe: item.recipe, quantity: 1 })); selection.entries.forEach((entry) => { entry.quantity = 1; }); });
    Object.assign(order, rebuildMealOrder({ ...order, selections: legacy }));
    delete order.diners;
    const key = `${order.date}|${order.meal}`;
    const existing = meals.get(key);
    if (!existing) { meals.set(key, order); return true; }
    for (const selection of order.selections) {
      const previous = existing.selections.find((entry) => entry.memberId === selection.memberId);
      if (previous) {
        previous.items.push(...selection.items);
        previous.entries.push(...selection.entries);
        previous.note = [previous.note, selection.note].filter(Boolean).join('；');
      } else existing.selections.push(selection);
    }
    if (order.status === 'accepted') existing.status = 'accepted';
    Object.assign(existing, rebuildMealOrder(existing));
    next.purchases.forEach((purchase) => { purchase.orderIds = [...new Set(purchase.orderIds.map((id) => id === order.id ? existing.id : id))]; });
    return false;
  });
  return next;
}

export function requirementSignature(order, key) {
  return JSON.stringify(order.items.filter((item) => item.recipe.ingredients.some((ingredient) => normalizedIngredient(ingredient).key === key)).map((item) => [item.recipe.id, item.quantity, item.scale ?? 1, item.recipe.ingredients.filter((ingredient) => normalizedIngredient(ingredient).key === key).length]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
}

export function getShoppingRequirements(state, today = localDate()) {
  const fridge = state.family?.features?.fridge !== false;
  const stocks = [...(state.purchases || []).filter((batch) => batch.kind !== 'confirmation'), ...(fridge ? state.inventory : [])].map((batch) => ({ ...batch, ...normalizedIngredient(batch) }));
  stocks.sort((left, right) => Number(Boolean(right.orderIds)) - Number(Boolean(left.orderIds)) || (left.expiresOn || '9999').localeCompare(right.expiresOn || '9999'));
  const orders = shoppingOrders(state.orders, today);
  const grouped = new Map();
  for (const order of orders) {
    const usableOn = order.date > today ? order.date : today;
    for (const required of aggregateItems(order.items)) {
      if (hasTextAmount(required)) {
        const result = grouped.get(required.key) || { ...required, available: null, missing: null, toBuy: null, needsConfirmation: false, dishes: [], unitMismatch: false };
        const confirmed = (state.purchases || []).some((purchase) => purchase.kind === 'confirmation' && purchase.orderIds.includes(order.id) && normalizedIngredient(purchase).key === required.key && purchase.signature === requirementSignature(order, required.key));
        result.needsConfirmation ||= !confirmed;
        result.dishes = [...new Set([...result.dishes, ...required.dishes])];
        grouped.set(required.key, result);
        continue;
      }
      const result = grouped.get(required.key) || { ...required, quantity: 0, available: 0, missing: 0, unitMismatch: false, dishes: [] };
      let remaining = required.quantity;
      for (const stock of stocks) {
        if (isExpired(stock, usableOn) || (stock.orderIds && !stock.orderIds.includes(order.id))) continue;
        if (stock.name === required.name && stock.unit !== required.unit) result.unitMismatch = true;
        if (stock.key !== required.key) continue;
        const used = Math.min(remaining, stock.quantity);
        stock.quantity = round(stock.quantity - used);
        remaining = round(remaining - used);
      }
      result.quantity = round(result.quantity + required.quantity);
      result.available = round(result.available + required.quantity - remaining);
      result.missing = round(result.missing + remaining);
      result.dishes = [...new Set([...result.dishes, ...required.dishes])];
      grouped.set(required.key, result);
    }
  }
  return [...grouped.values()].map((item) => ({ ...item, toBuy: hasTextAmount(item) ? null : purchaseQuantity(item.missing, item.unit) }));
}
