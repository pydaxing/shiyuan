import { effectScope, nextTick, reactive, ref, watch } from 'vue';
import { clone, hasTextAmount, preparationFieldErrors } from '../domain/kitchen.js';
import { ingredientListGroups, normalizePreparationDraft, preparationDefaults, preparationEditSignature, preparationIngredients } from '../domain/meal-preparation.js';
import { presentMutation } from '../services/mutation-feedback.js';

const conflictMessage = '家人已更新这道菜，草稿已保留，请载入最新内容后再调整';
const unavailableMessage = '这一餐已结束、已取消或菜品已移除，不能再修改';
const draftOf = entry => ({ ingredients: entry.ingredients.map(({ key, choice, ...ingredient }) => ingredient), note: entry.note });
const fingerprint = value => JSON.stringify(value);
const failure = (message, code) => Object.assign(new Error(message), { code });
const rejectedCodes = new Set(['INVALID', 'FORBIDDEN', 'CONFLICT', 'ALREADY_SHARED', 'RATE_LIMIT', 'CAPACITY']);
const expectedSignature = request => request?.operation?.expectedSignature || request?.expected;

export function createPreparationAutosave({ getState, getScope, isBusy = () => false, send, retryOperation, discardOperation, getOperations, debounceMs = 500 }) {
  const lifetime = effectScope(true);
  const records = new Map();
  const registryVersion = ref(0);
  const queued = new Set();
  let sequence = 0;
  let running = false;
  let disposed = false;

  function source(record) {
    if (record.entry.scope !== getScope()) return null;
    const order = getState().orders.find(entry => entry.id === record.entry.orderId && ['pending', 'accepted'].includes(entry.status));
    const item = order?.items.find(entry => entry.recipe.id === record.entry.recipeId);
    if (!item) return null;
    const edit = order.preparationEdits?.find(entry => entry.recipeId === item.recipe.id);
    return { item, signature: preparationEditSignature(item, edit), draft: { ingredients: preparationIngredients(item, edit), note: edit?.note || '' } };
  }

  function signal(record) {
    for (const resolve of record.waiters) resolve();
    record.waiters.clear();
  }

  function cancelQueued(record) {
    clearTimeout(record.timer);
    record.timer = undefined;
    queued.delete(record);
  }

  function validate(record) {
    const raw = draftOf(record.entry);
    const errors = preparationFieldErrors(raw);
    raw.ingredients.forEach((ingredient, index) => {
      if (!hasTextAmount(ingredient) && typeof ingredient.quantity === 'string' && !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(ingredient.quantity.trim())) errors[`ingredients.${index}.quantity`] = '请填写完整的数量';
    });
    record.entry.validation = errors;
    const clean = Object.keys(errors).length ? null : normalizePreparationDraft(raw);
    record.entry.dirty = !clean || fingerprint(clean) !== fingerprint(record.confirmed);
    return record.entry.composing ? null : clean;
  }

  function setDraft(record, draft) {
    record.entry.ingredients = draft.ingredients.map(ingredient => {
      const amount = hasTextAmount(ingredient) ? ingredient.amountText.trim() : '';
      return { ...clone(ingredient), key: ++sequence, choice: hasTextAmount(ingredient) ? ['适量', '少许'].includes(amount) ? amount : '原用量' : ingredient.unit };
    });
    record.entry.rowOrder = ingredientListGroups(record.entry.ingredients).flatMap(group => group.items.map(entry => entry.index));
    record.entry.note = draft.note;
    record.observed = fingerprint(draftOf(record.entry));
    record.entry.composing = false;
    record.entry.touched = false;
    record.entry.version += 1;
    validate(record);
    signal(record);
  }

  function adopt(record, current) {
    record.confirmed = clone(current.draft);
    record.signature = current.signature;
    record.entry.conflict = false;
    record.entry.error = '';
    record.entry.uncertain = false;
    record.entry.externalSaving = false;
    record.failedRequest = null;
    record.failure = null;
    setDraft(record, current.draft);
  }

  function synchronize(record) {
    validate(record);
    const current = source(record);
    record.entry.unavailable = !current ? record.entry.scope !== getScope() ? '家庭已切换，草稿保留在原家庭' : unavailableMessage : '';
    if (!current) { cancelQueued(record); signal(record); return; }
    const own = current.signature === record.signature || current.signature === expectedSignature(record.inflight) || current.signature === expectedSignature(record.failedRequest);
    if (!own) {
      if (record.entry.dirty || record.inflight || record.failure) {
        record.entry.conflict = true;
        cancelQueued(record);
        signal(record);
      } else adopt(record, current);
    }
  }

  function synchronizeOperation(record) {
    const request = record.failedRequest;
    if (!getOperations || !request?.operationId || record.inflight || record.reloading || record.entry.scope !== getScope()) return;
    const operation = getOperations().find(operation => operation.id === request.operationId);
    record.entry.externalSaving = Boolean(operation && ['queued', 'sending'].includes(operation.status));
    if (operation) {
      if (!record.entry.externalSaving) {
        record.failure = failure(operation.message || record.entry.error, operation.code);
        record.entry.error = record.failure.message;
        record.entry.uncertain = operation.status === 'uncertain' || operation.hadUncertain === true;
      }
      signal(record);
      return;
    }
    const current = source(record);
    if (!current) { signal(record); return; }
    record.failedRequest = null;
    record.failure = null;
    record.entry.error = '';
    record.entry.uncertain = false;
    if (current.signature === expectedSignature(request) && fingerprint(current.draft) === fingerprint(request.draft)) {
      record.confirmed = clone(request.draft);
      record.signature = current.signature;
      record.entry.conflict = false;
      schedule(record, true);
    } else if (current.signature === record.signature) {
      record.entry.conflict = false;
      if (fingerprint(draftOf(record.entry)) === request.raw) adopt(record, current);
      else schedule(record, true);
    } else {
      record.entry.conflict = true;
      cancelQueued(record);
    }
    signal(record);
  }

  function schedule(record, immediate = false) {
    cancelQueued(record);
    const clean = validate(record);
    if (disposed || record.reloading || !clean || (!record.entry.dirty && !record.failedRequest) || (record.entry.conflict && !record.entry.uncertain) || record.entry.unavailable || record.failure) { signal(record); return; }
    const enqueue = () => { record.timer = undefined; queued.add(record); void drain(); };
    if (immediate) enqueue();
    else record.timer = setTimeout(enqueue, debounceMs);
    signal(record);
  }

  function changed(record) {
    const raw = fingerprint(draftOf(record.entry));
    if (raw !== record.observed) {
      record.observed = raw;
      record.entry.version += 1;
      record.entry.notice = '';
    }
    schedule(record);
  }

  function makeRequest(record, draft, current) {
    return {
      draft: clone(draft), signature: current.signature, raw: fingerprint(draftOf(record.entry)),
      expected: preparationEditSignature(current.item, { ...draft, quantity: current.item.quantity * (current.item.scale ?? 1) }),
    };
  }

  async function save(record, request) {
    record.inflight = request;
    record.entry.saving = true;
    signal(record);
    try {
      if (request.operationId && !retryOperation) throw failure('无法重试原同步请求，请保留草稿', 'RETRY_UNAVAILABLE');
      const operation = request.operationId ? retryOperation(request.operationId) : send(record.entry.orderId, record.entry.recipeId, clone(request.draft), request.signature);
      request.operationId = operation?.operationId || request.operationId;
      request.operation = operation;
      const result = await operation;
      if (record.inflight !== request) return;
      record.confirmed = clone(request.draft);
      record.signature = expectedSignature(request);
      const latest = source(record);
      record.entry.conflict = Boolean(latest && (latest.signature !== record.signature || fingerprint(latest.draft) !== fingerprint(request.draft)));
      record.failedRequest = null;
      record.failure = null;
      record.entry.error = '';
      record.entry.uncertain = false;
      if (result?.readyReset) record.entry.notice = '用量已更新，请重新确认备齐';
    } catch (error) {
      if (record.inflight !== request) return;
      record.failure = error;
      record.entry.error = error?.message || '自动保存失败，草稿已保留，请重试';
      record.entry.uncertain = !rejectedCodes.has(error?.code);
      record.failedRequest = request.operationId || record.entry.uncertain ? request : null;
      if (error?.code === 'CONFLICT') record.entry.conflict = true;
    } finally {
      if (record.inflight === request) {
        record.inflight = null;
        record.entry.saving = false;
        synchronizeOperation(record);
        validate(record);
        synchronize(record);
        if (!record.failure) schedule(record, true);
      }
      signal(record);
    }
  }

  async function drain() {
    if (running || disposed || isBusy() || [...records.values()].some(record => record.entry.scope === getScope() && record.failure && record.entry.uncertain && record.failedRequest?.operationId)) return;
    running = true;
    try {
      while (queued.size && !disposed && !isBusy()) {
        const record = [...queued].find(record => record.failedRequest && !record.failure) || queued.values().next().value;
        queued.delete(record);
        if (record.inflight) continue;
        synchronize(record);
        const clean = validate(record);
        if (record.entry.unavailable || (record.entry.conflict && !record.entry.uncertain) || record.failure || (!record.failedRequest && (!clean || !record.entry.dirty))) { signal(record); continue; }
        const current = source(record);
        await save(record, record.failedRequest || makeRequest(record, clean, current));
        if (record.failure && record.entry.uncertain && record.failedRequest?.operationId) break;
      }
    } finally { running = false; }
  }

  function identity(orderId, recipeId) { return fingerprint([getScope(), orderId, recipeId]); }

  function edit(orderId, recipeId) {
    const key = identity(orderId, recipeId);
    if (records.has(key)) return records.get(key).entry;
    const entry = reactive({ scope: getScope(), orderId, recipeId, ingredients: [], rowOrder: [], note: '', title: '', version: 0, dirty: false, saving: false, externalSaving: false, composing: false, conflict: false, uncertain: false, unavailable: '', error: '', notice: '', validation: {}, touched: false, actionBusy: '', actionError: null });
    const record = { entry, confirmed: { ingredients: [], note: '' }, signature: '', observed: '', waiters: new Set(), inflight: null, failure: null, failedRequest: null };
    records.set(key, record);
    registryVersion.value += 1;
    const current = source(record);
    if (current) { entry.title = current.item.recipe.title; adopt(record, current); }
    else { entry.unavailable = unavailableMessage; record.observed = fingerprint(draftOf(entry)); }
    lifetime.run(() => watch(() => [fingerprint(draftOf(entry)), entry.composing], () => changed(record)));
    return entry;
  }

  function getRecord(orderId, recipeId) { registryVersion.value; return records.get(identity(orderId, recipeId)); }

  function assertReady(record) {
    synchronizeOperation(record);
    synchronize(record);
    const clean = validate(record);
    if (record.entry.unavailable) throw failure(record.entry.unavailable, 'PREPARATION_UNAVAILABLE');
    if (record.entry.conflict && !record.entry.uncertain) throw failure(conflictMessage, 'CONFLICT');
    if (!clean) { record.entry.touched = true; throw failure('请先补全这道菜的食材和用量，草稿已保留', 'PREPARATION_INVALID'); }
    if (record.failure && !record.entry.externalSaving) throw record.failure;
  }

  async function flush(orderId, recipeId) {
    await nextTick();
    const record = getRecord(orderId, recipeId);
    if (!record) return;
    const scope = record.entry.scope;
    while (!disposed) {
      if (getScope() !== scope) throw failure('家庭已切换，请重新操作', 'PREPARATION_UNAVAILABLE');
      assertReady(record);
      if (!record.entry.dirty && !record.inflight && !record.failedRequest) return;
      schedule(record, true);
      if (!record.inflight && !queued.has(record)) { assertReady(record); if (!record.entry.dirty) return; }
      await new Promise(resolve => record.waiters.add(resolve));
      await nextTick();
    }
    throw failure('备菜编辑已关闭', 'PREPARATION_UNAVAILABLE');
  }

  async function admit(orderId, recipeId) {
    await nextTick();
    const record = getRecord(orderId, recipeId);
    if (!record) return;
    assertReady(record);
    const clean = validate(record);
    const current = source(record);
    const operation = record.inflight?.operation;
    if (!record.inflight && !record.entry.dirty && !record.failedRequest) return;
    if (!getOperations || record.failedRequest || record.entry.externalSaving || isBusy() || (record.inflight && !(operation?.accepted && operation?.projected))) return flush(orderId, recipeId);
    if (fingerprint(current.draft) === fingerprint(clean)) return;
    cancelQueued(record);
    const request = makeRequest(record, clean, current);
    const work = save(record, request);
    if (request.operation?.accepted && request.operation?.projected) return;
    await work;
    return flush(orderId, recipeId);
  }

  async function retry(orderId, recipeId) {
    await nextTick();
    const record = getRecord(orderId, recipeId);
    if (!record) return;
    synchronizeOperation(record);
    synchronize(record);
    if (record.entry.externalSaving || (record.entry.conflict && !record.entry.uncertain) || record.entry.unavailable) return flush(orderId, recipeId);
    record.failure = null;
    record.entry.error = '';
    if (record.failedRequest) { queued.add(record); void drain(); }
    return flush(orderId, recipeId);
  }

  function defaults(orderId, recipeId) {
    const record = getRecord(orderId, recipeId);
    const current = record && source(record);
    if (!current) return;
    if (record.entry.conflict || record.failedRequest) return;
    record.failure = null;
    record.entry.error = '';
    setDraft(record, preparationDefaults(current.item, record.entry.note));
    schedule(record, true);
  }

  async function reload(orderId, recipeId) {
    const record = getRecord(orderId, recipeId);
    if (record) synchronizeOperation(record);
    const current = record && source(record);
    if (!current || record.inflight || record.reloading || record.entry.externalSaving || record.entry.uncertain) return;
    cancelQueued(record);
    const raw = fingerprint(draftOf(record.entry));
    const operationId = record.failedRequest?.operationId;
    if (operationId) {
      const operation = getOperations?.().find(operation => operation.id === operationId);
      if (!discardOperation || !operation || !(operation.canDismiss || operation.discardable)) throw failure('请先核对原同步请求，草稿已保留', 'UNCERTAIN');
      record.reloading = true;
      try { await discardOperation(operationId); }
      finally { record.reloading = false; }
    }
    const latest = source(record);
    if (latest) {
      if (fingerprint(draftOf(record.entry)) === raw) adopt(record, latest);
      else {
        synchronizeOperation(record);
        synchronize(record);
        if (!record.entry.conflict) schedule(record, true);
      }
    }
  }

  async function dispatch(orderId, recipeId) {
    await nextTick();
    const record = getRecord(orderId, recipeId);
    if (record) schedule(record, true);
  }

  function add(orderId, recipeId) {
    const record = getRecord(orderId, recipeId);
    if (!record || record.entry.unavailable || record.entry.ingredients.length >= 30) return;
    record.entry.rowOrder.push(record.entry.ingredients.length);
    record.entry.ingredients.push({ name: '', quantity: 0, unit: 'g', key: ++sequence, choice: 'g' });
  }

  function remove(orderId, recipeId, ingredientKey) {
    const record = getRecord(orderId, recipeId);
    if (!record || record.entry.unavailable || !source(record)) return false;
    const index = record.entry.ingredients.findIndex(ingredient => ingredient.key === ingredientKey);
    if (index < 0) return false;
    record.entry.ingredients.splice(index, 1);
    record.entry.rowOrder = record.entry.rowOrder.filter(position => position !== index).map(position => position > index ? position - 1 : position);
    record.entry.touched = true;
    return true;
  }

  async function act(orderId, recipeId, kind, action, { immediate = false, materialBarrier = true } = {}) {
    const entry = edit(orderId, recipeId);
    if (entry.actionBusy) return false;
    const record = getRecord(orderId, recipeId);
    const revision = record.actionRevision = (record.actionRevision || 0) + 1;
    entry.actionBusy = kind;
    entry.actionError = null;
    const scope = getScope();
    const barrier = async () => {
      if (scope !== getScope()) throw failure('家庭已切换，请重新操作', 'PREPARATION_UNAVAILABLE');
      if (materialBarrier) await (immediate ? admit(orderId, recipeId) : flush(orderId, recipeId));
      else {
        await nextTick();
        if (disposed || !source(record)) throw failure(unavailableMessage, 'PREPARATION_UNAVAILABLE');
      }
      if (scope !== getScope()) throw failure('家庭已切换，请重新操作', 'PREPARATION_UNAVAILABLE');
    };
    const release = () => { if (record.actionRevision === revision) entry.actionBusy = ''; };
    try {
      await barrier();
      return await action(barrier, operation => presentMutation(operation, release));
    } catch (error) {
      if (record.actionRevision === revision) entry.actionError = { key: `${orderId}:${recipeId}`, kind, message: error?.message || '操作失败，请重试' };
      return false;
    } finally { release(); }
  }

  lifetime.run(() => watch(() => [getScope(), getState().orders, isBusy(), getOperations?.()], () => {
    for (const record of records.values()) { synchronizeOperation(record); synchronize(record); }
    void drain();
  }, { deep: true }));

  return {
    edit, flush, retry, defaults, reload, dispatch, add, remove, act,
    peek: (orderId, recipeId) => getRecord(orderId, recipeId)?.entry,
    entries: () => { registryVersion.value; return [...records.values()].filter(record => record.entry.scope === getScope()).map(record => record.entry); },
    dispose() { disposed = true; for (const record of records.values()) { cancelQueued(record); signal(record); } lifetime.stop(); },
  };
}
