import test from 'node:test';
import assert from 'node:assert/strict';
import { presentMutation } from '../src/services/mutation-feedback.js';

test('admitted cloud writes reveal the updated view without claiming confirmation', async () => {
  let confirm;
  let visible = false;
  let saved = false;
  const operation = Object.assign(new Promise(resolve => { confirm = resolve; }), { accepted: true });
  const pending = presentMutation(operation, () => { visible = true; }).then(() => { saved = true; });
  assert.equal(visible, true);
  assert.equal(saved, false);
  confirm();
  await pending;
  assert.equal(saved, true);
});

test('validation failures never close the editor', async () => {
  let closed = false;
  await assert.rejects(presentMutation(Promise.reject(new Error('请填写名称')), () => { closed = true; }), /请填写名称/);
  assert.equal(closed, false);
});

test('local writes and nonprojected compatibility requests reveal the view only after confirmation', async () => {
  let confirm;
  let accepted = 0;
  const pending = presentMutation(new Promise(resolve => { confirm = resolve; }), () => { accepted += 1; });
  assert.equal(accepted, 0);
  confirm('saved');
  assert.equal(await pending, 'saved');
  assert.equal(accepted, 1);
  await presentMutation(undefined, () => { accepted += 1; });
  assert.equal(accepted, 2);
});

test('an admitted failure propagates for the retained operation recovery, never emitting success', async () => {
  let fail;
  let accepted = 0;
  const operation = Object.assign(new Promise((resolve, reject) => { fail = reject; }), { accepted: true });
  const pending = presentMutation(operation, () => { accepted += 1; });
  const rejected = assert.rejects(pending, /未同步/);
  fail(new Error('未同步'));
  await rejected;
  assert.equal(accepted, 1);
});
