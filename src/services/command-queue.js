import { clone } from '../domain/kitchen.js';
import { prepareCommand, projectCommand, dependenciesMatch, commandDependencies, commandWireArgs, commandSignature } from './command-projection.js';

const errorWith = (message, code) => Object.assign(new Error(message), { code });
const rejectedCodes = new Set(['INVALID', 'FORBIDDEN', 'CONFLICT', 'ALREADY_SHARED', 'RATE_LIMIT', 'CAPACITY']);
const replacements = new Set(['saveRecipe', 'saveMealSet', 'customizeFamily', 'setChef', 'setFeature', 'setPreferences', 'changeStockImage', 'saveDishPreparation', 'saveShoppingDraft', 'setDishPrepared']);
function canRebaseReplacement(previous, remaining, operation) {
  if (!replacements.has(operation.name)) return false;
  if (!['setDishPrepared', 'saveShoppingDraft'].includes(operation.name)) return true;
  const preparation = { ...operation, name: 'saveDishPreparation' };
  return commandSignature(previous, preparation) === commandSignature(remaining, preparation);
}
const restored = operation => {
  const uncertain = operation.hadUncertain || operation.committed || (operation.sent && operation.status !== 'failed');
  return { ...operation, status: uncertain ? 'uncertain' : operation.status === 'failed' ? 'failed' : 'blocked', hadUncertain: Boolean(uncertain), message: uncertain ? '上次同步结果尚未确认，请重试核对；不会重复提交' : operation.message || '已恢复待同步操作，请确认后重试' };
};

export function createCommandQueue({ snapshot, send, reconcile, refresh, journal, onChange = () => {}, onStatus = () => {}, onFailure = () => {}, now = Date.now, newId = () => `command-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` }) {
  let base = clone(snapshot);
  let view = base;
  let revision = 0;
  let context = { scope: '', familyId: '', userId: '' };
  let operations = [];
  let generation = 0;
  let running;
  let journalError;
  let journalUnreadable = false;
  let paused = false;
  const waiters = new Map();

  function persist() {
    if (journalUnreadable) throw journalError;
    if (context.scope) journal.write(context.scope, operations.map(operation => clone(operation)));
  }

  function statusEntry(operation) {
    const uncertain = operation.status === 'uncertain';
    const retryable = uncertain || (['failed', 'blocked'].includes(operation.status) && dependenciesMatch(base, operation));
    const discardable = !uncertain && operation.status !== 'sending' && !operation.hadUncertain && !operation.committed;
    const { id, name, args, label, status, message, code, scope, projected, expectedSignature, createdAt } = operation;
    return { id, name, args: clone(args), label, status, message, code, scope, projected, expectedSignature, createdAt, retryable, canRetry: retryable, discardable, canDismiss: discardable };
  }

  function publish() {
    view = base;
    for (const operation of operations) {
      if (['failed', 'blocked'].includes(operation.status)) continue;
      try {
        view = projectCommand(view, operation);
        operation.expectedSignature = commandSignature(view, operation);
      } catch {}
    }
    const entries = operations.map(statusEntry);
    const failures = entries.filter(operation => ['failed', 'blocked', 'uncertain'].includes(operation.status));
    if (journalError) failures.unshift({ id: 'journal', name: 'journal', label: '保存待同步记录', args: [], status: 'failed', message: journalError.message, canRetry: true, retryable: true, canDismiss: false, discardable: false });
    // Renderers patch reactive objects in place; never expose the confirmed
    // baseline or projected view to those mutations.
    onChange(clone(view));
    onStatus({ operations: entries, pendingCount: entries.filter(operation => operation.status !== 'failed').length, syncing: entries.some(operation => operation.status === 'sending'), failures });
  }

  function saveStatus() {
    try { persist(); journalError = undefined; }
    catch (error) { journalError = error; }
    publish();
  }

  function settle(operation, error, value) {
    const waiting = waiters.get(operation.id) || [];
    waiters.delete(operation.id);
    for (const waiter of waiting) if (error) waiter.reject(error); else waiter.resolve(value);
  }

  function promiseFor(operation) {
    const promise = new Promise((resolve, reject) => {
      const waiting = waiters.get(operation.id) || [];
      waiting.push({ resolve, reject });
      waiters.set(operation.id, waiting);
    });
    promise.accepted = true;
    promise.operationId = operation.id;
    promise.projected = operation.projected;
    Object.defineProperty(promise, 'expectedSignature', { get: () => operation.expectedSignature || '' });
    return promise;
  }

  function activate(next, current, { restore = true } = {}) {
    if (context.scope !== current.scope) {
      for (const operation of operations) {
        if (operation.status === 'sending') { operation.status = 'uncertain'; operation.hadUncertain = true; operation.message = '家庭或账号已变化，请回到原家庭核对同步结果'; }
        settle(operation, errorWith('家庭或账号已变化，操作保留在原家庭', 'SCOPE_CHANGED'));
      }
      try { persist(); } catch {}
      generation += 1;
      context = { scope: current.scope, familyId: current.familyId, userId: current.userId };
      operations = [];
      journalError = undefined;
      journalUnreadable = false;
      if (restore && current.scope) try {
        operations = journal.read(current.scope).map(restored);
      } catch (error) { journalError = error; journalUnreadable = true; }
    }
    base = clone(next);
    revision = current.revision ?? revision;
    publish();
  }

  function receive(next, nextRevision, acknowledgedId) {
    if (nextRevision < revision) return false;
    base = clone(next);
    revision = nextRevision;
    const acknowledged = operations.find(operation => operation.id === acknowledgedId);
    if (acknowledged) {
      acknowledged.expectedSignature = commandSignature(base, acknowledged);
      operations = operations.filter(operation => operation !== acknowledged);
    }
    saveStatus();
    return true;
  }

  function fail(operation, error, status) {
    if (status === 'failed' && dependenciesMatch(base, operation)) {
      let previous = base;
      let remaining = base;
      for (const entry of operations) {
        if (['failed', 'blocked'].includes(entry.status)) continue;
        if (entry !== operation && entry.status === 'queued' && !entry.sent && canRebaseReplacement(previous, remaining, entry) && dependenciesMatch(previous, entry)) entry.dependencies = commandDependencies(remaining, entry.name, entry.args);
        try { previous = projectCommand(previous, entry); } catch {}
        if (entry !== operation) try { remaining = projectCommand(remaining, entry); } catch {}
      }
    }
    operation.status = status;
    operation.message = error.message || '同步失败，请重试';
    operation.code = error.code || 'NETWORK';
    if (status === 'uncertain') operation.hadUncertain = true;
    saveStatus();
    settle(operation, error);
    onFailure(error, operation);
  }

  async function drain() {
    const epoch = generation;
    while (!paused && !journalError && epoch === generation) {
      const operation = operations.find(entry => !['failed', 'blocked'].includes(entry.status));
      if (!operation || operation.status === 'uncertain') return;
      if (!operation.sent && !dependenciesMatch(base, operation)) {
        fail(operation, errorWith('相关内容已变化，已保留本次修改，请重新打开核对后保存', 'CONFLICT'), 'blocked');
        continue;
      }
      const previouslySent = operation.sent;
      if (!operation.sent) {
        const requestName = operation.name === 'customizeFamily' && operation.args[0]?.coverSubtitle !== undefined ? 'customizeFamilyWithSubtitle' : operation.name;
        operation.sent = { name: requestName, args: commandWireArgs(base, operation), familyId: context.familyId, requestId: operation.id, revision, responseMode: 'changes', commentMode: 'patch', includeFeed: false };
      }
      operation.status = 'sending';
      operation.message = '';
      try { persist(); }
      catch (error) {
        if (!previouslySent) delete operation.sent;
        fail(operation, error, operation.hadUncertain || operation.committed ? 'uncertain' : 'failed');
        return;
      }
      publish();
      try {
        const response = operation.committed ? operation.response : await send(clone(operation.sent), operation);
        if (epoch !== generation) return;
        operation.committed = true;
        operation.response = response;
        await reconcile(response, operation.id);
        if (epoch !== generation) return;
        if (operations.includes(operation)) throw errorWith('操作已提交，正在等待确认最新状态，请重试核对', 'SYNC_BUSY');
        settle(operation, undefined, response.value);
      } catch (error) {
        if (epoch !== generation) return;
        if (error.code === 'CONFLICT' && !operation.hadUncertain && !operation.committed && !operation.rebased) {
          try {
            await refresh();
            if (epoch !== generation) return;
            if (dependenciesMatch(base, operation)) {
              operation.rebased = true;
              operation.sent.revision = revision;
              operation.status = 'queued';
              saveStatus();
              continue;
            }
          } catch {}
        } else if (error.code === 'ALREADY_SHARED' && !operation.hadUncertain && !operation.committed) {
          try { await refresh(); } catch {}
          if (epoch !== generation) return;
        }
        if (epoch !== generation) return;
        if (operation.sent.name !== operation.name && /不支持.*操作/.test(error.message)) error.message = '请更新家庭服务后再保存主副标题';
        const uncertain = operation.hadUncertain || operation.committed || !rejectedCodes.has(error.code);
        fail(operation, error, uncertain ? 'uncertain' : 'failed');
        if (uncertain) return;
      }
    }
  }

  function start() {
    if (running || paused || journalError || operations.find(entry => !['failed', 'blocked'].includes(entry.status))?.status !== 'queued') return;
    const work = drain();
    running = work;
    work.finally(() => { if (running === work) { running = undefined; start(); } }).catch(() => {});
  }

  function enqueue(name, args) {
    try {
      if (journalError) throw journalError;
      if (!context.scope) throw errorWith('请先创建或加入家庭', 'NO_FAMILY');
      const operation = { ...prepareCommand(view, name, args, { id: newId(), createdAt: now() }), status: 'queued', message: '', scope: context.scope };
      operations.push(operation);
      try { persist(); } catch (error) { operations.pop(); throw error; }
      const promise = promiseFor(operation);
      publish();
      start();
      return promise;
    } catch (error) { return Promise.reject(error); }
  }

  function retry(id) {
    if (id === 'journal') {
      try {
        if (journalUnreadable) {
          operations = journal.read(context.scope).map(restored);
          journalUnreadable = false;
        } else persist();
        journalError = undefined;
        publish();
        start();
        return Promise.resolve();
      }
      catch (error) { return Promise.reject(error); }
    }
    const operation = operations.find(entry => entry.id === id);
    if (!operation || !['failed', 'blocked', 'uncertain'].includes(operation.status)) return Promise.reject(errorWith('没有可重试的操作', 'INVALID'));
    if (operation.status !== 'uncertain' && !dependenciesMatch(base, operation)) return Promise.reject(errorWith('相关内容已变化，请重新打开编辑，不会覆盖家人的修改', 'CONFLICT'));
    if (operation.status !== 'uncertain') { delete operation.sent; delete operation.rebased; }
    operation.status = 'queued';
    operation.message = '';
    try { persist(); } catch (error) { operation.status = operation.hadUncertain ? 'uncertain' : 'failed'; saveStatus(); return Promise.reject(error); }
    const promise = promiseFor(operation);
    publish();
    if (running) running.finally(start).catch(() => {}); else start();
    return promise;
  }

  function discard(id) {
    const operation = operations.find(entry => entry.id === id);
    if (!operation || !statusEntry(operation).discardable) return Promise.reject(errorWith('同步结果尚未确认，不能放弃；请先重试核对', 'UNCERTAIN'));
    const previous = operations;
    operations = operations.filter(entry => entry !== operation);
    try { persist(); } catch (error) { operations = previous; return Promise.reject(error); }
    settle(operation, errorWith('已放弃未提交的操作', 'DISCARDED'));
    publish();
    start();
    return Promise.resolve();
  }

  return {
    enqueue, retry, discard, activate, receive,
    getBase: () => base,
    getRevision: () => revision,
    getScope: () => context.scope,
    isRunning: () => Boolean(running),
    hasUnresolved: () => operations.length > 0,
    pause: () => { paused = true; },
    resume: () => { paused = false; start(); },
    whenIdle: () => running || Promise.resolve(),
  };
}
