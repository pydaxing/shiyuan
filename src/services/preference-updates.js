import { ref, watch } from 'vue';

export function createPreferenceUpdates({ getScope, isBusy, send, sendBatch, debounceMs = 120 }) {
  const pending = ref({});
  const queue = new Map();
  let running = false;
  let sequence = 0;
  let timer;

  function value(key, fallback) {
    const entry = pending.value[key];
    return entry?.scope === getScope() ? entry.value : fallback;
  }

  function waitUntilIdle() {
    return new Promise(resolve => {
      const stop = watch(isBusy, busy => { if (!busy) { stop(); resolve(); } });
    });
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.size) {
        while (isBusy()) await waitUntilIdle();
        const batch = sendBatch ? [...queue.entries()] : [queue.entries().next().value];
        for (const [key] of batch) queue.delete(key);
        const scope = batch[0][1].scope;
        let failure;
        try {
          if (scope !== getScope() || batch.some(([, entry]) => entry.scope !== scope)) throw new Error('家庭已变更，请重新设置');
          const commit = () => sendBatch ? sendBatch(Object.fromEntries(batch.map(([key, entry]) => [key, entry.value]))) : send(batch[0][0], batch[0][1].value);
          try { await commit(); }
          catch (error) {
            if (error.code !== 'CONFLICT' || scope !== getScope() || batch.some(([key, entry]) => pending.value[key]?.id !== entry.id)) throw error;
            await commit();
          }
        } catch (error) { failure = error; }
        for (const [key, entry] of batch) {
          const latest = pending.value[key]?.id === entry.id;
          if (latest) {
            const next = { ...pending.value };
            delete next[key];
            pending.value = next;
          }
          if (failure && latest && entry.scope === getScope()) entry.reject(failure);
          else entry.resolve(!failure);
        }
      }
    } finally { running = false; }
  }

  function updateMany(values) {
    const scope = getScope();
    const next = { ...pending.value };
    const results = Object.entries(values).map(([key, enabled]) => {
      const previous = queue.get(key);
      if (previous) previous.resolve(false);
      return new Promise((resolve, reject) => {
        const entry = { id: ++sequence, scope, value: Boolean(enabled), resolve, reject };
        next[key] = entry;
        queue.set(key, entry);
      });
    });
    pending.value = next;
    if (sendBatch && !running) { clearTimeout(timer); timer = setTimeout(() => { void drain(); }, debounceMs); }
    else void drain();
    return Promise.all(results).then(saved => saved.every(Boolean));
  }

  function update(key, enabled) { return updateMany({ [key]: enabled }); }

  return { pending, value, update, updateMany };
}
