import test from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref } from 'vue';
import { useNavigationAppearance } from '../src/composables/useNavigationAppearance.js';

test('native navigation follows the top page and restores the family cover through nested editors', () => {
  const previous = globalThis.uni;
  const calls = [];
  const scopes = [];
  globalThis.uni = { setNavigationBarColor: value => calls.push(value) };
  function open(initial) {
    const appearance = ref(initial);
    const scope = effectScope();
    scopes.push(scope);
    scope.run(() => useNavigationAppearance(appearance));
    return { appearance, close: () => scope.stop() };
  }
  const front = () => calls.at(-1).frontColor;
  try {
    const family = open('dark');
    assert.equal(front(), '#ffffff');
    const profile = open('light');
    assert.equal(front(), '#000000');
    family.appearance.value = 'light';
    family.appearance.value = 'dark';
    assert.equal(front(), '#000000', 'changes beneath a full-screen editor cannot alter its status bar');
    const avatar = open('dark');
    assert.equal(front(), '#ffffff');
    const dialog = open(null);
    assert.equal(front(), '#ffffff', 'a partial dialog inherits the page underneath');
    dialog.close();
    avatar.close();
    assert.equal(front(), '#000000');
    profile.close();
    assert.equal(front(), '#ffffff');
    family.appearance.value = 'light';
    assert.equal(front(), '#000000', 'scrolling away from the cover uses the standard header');
    family.appearance.value = 'dark';
    family.close();
    assert.equal(front(), '#000000', 'leaving the family tab restores the standard status bar');
  } finally {
    scopes.reverse().forEach(scope => scope.stop());
    globalThis.uni = previous;
  }
});

test('unchanged layered appearances avoid native calls, failures can retry', () => {
  const previous = globalThis.uni;
  const calls = [];
  const scopes = [];
  globalThis.uni = { setNavigationBarColor: value => calls.push(value) };
  const open = value => {
    const appearance = ref(value);
    const scope = effectScope();
    scopes.push(scope);
    scope.run(() => useNavigationAppearance(appearance));
    return { appearance, close: () => scope.stop() };
  };
  try {
    const base = open('dark');
    const editor = open('light');
    for (let index = 0; index < 20; index++) base.appearance.value = index % 2 ? 'dark' : 'light';
    const dialog = open(null);
    dialog.close();
    assert.equal(calls.length, 2, 'covered pages and transparent dialogs do not resend the same color');
    calls.at(-1).fail();
    base.appearance.value = 'light';
    assert.equal(calls.length, 3, 'failed native updates are retried on the next appearance change');
    calls[1].fail();
    base.appearance.value = 'dark';
    assert.equal(calls.length, 3, 'old failure cannot invalidate the newer request');
    editor.close();
    assert.equal(calls.at(-1).frontColor, '#ffffff');
  } finally {
    scopes.reverse().forEach(scope => scope.stop());
    globalThis.uni = previous;
  }
});
