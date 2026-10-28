import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextTick, ref } from 'vue';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { isPendingRecord, presentMutation } from '../src/services/mutation-feedback.js';

const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const removeSource = source.match(/async function remove\(entry\) \{[\s\S]*?(?=\nasync function orderAction)/)[0];

function removalContext({ fail = false, related = false, operation } = {}) {
  const modals = [];
  const writes = [];
  const messages = [];
  const resetCalls = [];
  const removingMenuEntry = ref(false);
  const detail = ref({ id: 'dish' });
  const setDetail = ref(null);
  const bindings = {
    NATIVE_UI_COLORS, isPendingRecord, presentMutation, nextTick, removingMenuEntry, detail, setDetail,
    state: ref({ mealSets: related ? [{ recipeIds: ['dish', 'second'] }] : [] }),
    uni: { showModal: options => modals.push(options) },
    homeMenu: ref({ reset: () => resetCalls.push(true) }),
    notify: message => messages.push(message),
    removeFamilyEntry: (id, kind) => { if (fail) throw new Error('保存失败'); writes.push({ id, kind }); return operation; },
    runAction: async action => { try { return await action(); } catch (error) { messages.push(error.message); return false; } },
  };
  const remove = new Function(...Object.keys(bindings), `let menuRemovalRevision = 0; ${removeSource}\nreturn remove;`)(...Object.values(bindings));
  return { remove, modals, writes, messages, resetCalls, removingMenuEntry, detail };
}

test('menu removal uses one confirmation and dispatches the correct existing dish/set command', async () => {
  for (const kind of ['dish', 'set']) {
    const context = removalContext();
    const pending = context.remove({ id: kind, kind, title: '我的菜' });
    assert.equal(context.modals.length, 1);
    assert.equal(context.removingMenuEntry.value, true);
    assert.deepEqual(context.writes, []);
    context.modals[0].success({ confirm: true });
    await pending;
    assert.deepEqual(context.writes, [{ id: kind, kind }]);
    assert.equal(context.detail.value, null);
    assert.equal(context.resetCalls.length, 1);
    assert.equal(context.removingMenuEntry.value, false);
    assert.deepEqual(context.messages, []);
  }
});

test('cancelling or failing to open removal confirmation leaves all menu data and details intact', async () => {
  for (const result of ['cancel', 'fail']) {
    const context = removalContext();
    const pending = context.remove({ id: 'dish', kind: 'dish', title: '香菇滑鸡' });
    if (result === 'cancel') context.modals[0].success({ confirm: false });
    else context.modals[0].fail();
    await pending;
    assert.deepEqual(context.writes, []);
    assert.equal(context.detail.value.id, 'dish');
    assert.deepEqual(context.resetCalls, []);
    assert.equal(context.removingMenuEntry.value, false);
  }
});

test('rapid removal taps cannot stack confirmations or dispatch a duplicate command', async () => {
  const context = removalContext({ related: true });
  const entry = { id: 'dish', kind: 'dish', title: '香菇滑鸡' };
  const pending = context.remove(entry);
  await context.remove(entry);
  assert.equal(context.modals.length, 1);
  assert.match(context.modals[0].content, /套餐/);
  assert.match(context.modals[0].content, /厨房订单和美食分享保留/);
  context.modals[0].success({ confirm: true });
  await pending;
  assert.equal(context.writes.length, 1);
});

test('a failed removal keeps the dish visible and permits a later retry', async () => {
  const context = removalContext({ fail: true });
  const pending = context.remove({ id: 'dish', kind: 'dish', title: '香菇滑鸡' });
  context.modals[0].success({ confirm: true });
  await pending;
  assert.deepEqual(context.writes, []);
  assert.equal(context.detail.value.id, 'dish');
  assert.deepEqual(context.resetCalls, []);
  assert.deepEqual(context.messages, ['保存失败']);
  assert.equal(context.removingMenuEntry.value, false);
});

test('a previous admitted removal cannot unlock a newer confirmation', async () => {
  let finish;
  const operation = Object.assign(new Promise(resolve => { finish = resolve; }), { accepted: true });
  const context = removalContext({ operation });
  const first = context.remove({ id: 'first', kind: 'dish', title: '第一道菜' });
  context.modals[0].success({ confirm: true });
  await nextTick();
  assert.equal(context.removingMenuEntry.value, false);
  const second = context.remove({ id: 'second', kind: 'dish', title: '第二道菜' });
  assert.equal(context.removingMenuEntry.value, true);
  finish();
  await first;
  assert.equal(context.removingMenuEntry.value, true);
  context.modals[1].success({ confirm: false });
  await second;
  assert.equal(context.removingMenuEntry.value, false);
});
