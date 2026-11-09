import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountEntry } from '../src/services/account-entry-state.js';
const status = phoneBound => ({ accountLoginVersion: 1, phoneBound });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ bound = false, request: custom } = {}) {
  const calls = []; let isBound = bound;
  const entry = createAccountEntry({ request: async (action, data) => {
    calls.push({ action, data });
    if (custom) return custom(action, data);
    if (action === 'bindAccountPhone') isBound = true;
    return status(isBound);
  } });
  return { entry, calls };
}
test('returning bound users skip login; all concurrent entry requests share one check', async () => {
  const f = fixture({ bound: true }); await Promise.all([f.entry.ensureReady(), f.entry.ensureReady(), f.entry.ensureReady()]);
  assert.equal(f.entry.getState().phase, 'ready'); assert.equal(f.calls.length, 1);
});
test('new user waits for phone; successful binding releases the original destinations', async () => {
  const f = fixture(); let entered = false;
  const waiting = f.entry.ensureReady().then(() => { entered = true; }); await tick();
  assert.equal(f.entry.getState().phase, 'phone'); assert.equal(entered, false);
  await f.entry.bind({ code: 'x' }, true);
  await waiting; assert.equal(f.entry.getState().phase, 'ready'); assert.equal(entered, true);
});
test('missing consent or cancelled phone authorization never invokes binding', async () => {
  const f = fixture(); await f.entry.check(); await f.entry.bind({ code: 'x' }, false); await f.entry.bind({}, true);
  assert.equal(f.entry.getState().phase, 'phone'); assert.equal(f.calls.length, 1);
});
test('phone network timeout reconciles committed server state without replaying code', async () => {
  let bound = false;
  const f = fixture({ request: async action => { if (action === 'bindAccountPhone') { bound = true; throw new Error('timeout'); } return status(bound); } });
  await f.entry.check(); await f.entry.bind({ code: 'x' }, true);
  assert.equal(f.entry.getState().phase, 'ready'); assert.equal(f.calls.filter(c => c.action === 'bindAccountPhone').length, 1);
});
test('phone verification failure remains on login and allows another authorization', async () => {
  const f = fixture({ request: async action => { if (action === 'bindAccountPhone') throw new Error('failed'); return status(false); } });
  await f.entry.check(); await f.entry.bind({ code: 'x' }, true);
  assert.equal(f.entry.getState().phase, 'phone'); assert.equal(f.entry.getState().busy, false);
});
test('old backend or network failure does not bypass phone gate; retry can recover', async () => {
  let broken = true;
  const f = fixture({ request: async () => broken ? {} : status(true) });
  await f.entry.check(); assert.equal(f.entry.getState().phase, 'error');
  broken = false; await f.entry.check(); assert.equal(f.entry.getState().phase, 'ready');
});
test('repeated tap while a phone request is pending sends only one code', async () => {
  let finish;
  const f = fixture({ request: action => action === 'bindAccountPhone' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(status(false)) });
  await f.entry.check(); const pending = f.entry.bind({ code: 'x' }, true); await f.entry.bind({ code: 'y' }, true);
  finish(status(true)); await pending;
  assert.equal(f.calls.filter(c => c.action === 'bindAccountPhone').length, 1);
});
