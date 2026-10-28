import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ref, computed, nextTick } from 'vue';

const source = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
const preparation = source.slice(source.indexOf('const { share: prepareMenuShare }'), source.indexOf('onShareAppMessage(event'));
const actions = source.slice(source.indexOf('function share(item, kind, card)'), source.indexOf('watch(() => cloudStatus.value.familyId'));

function fixture() {
  const friendSharing = ref(null), swipeSharing = ref(null), sharing = ref(null);
  const requests = [];
  const context = runInNewContext(`${preparation}\n${actions}\n({ shareEntry, closeFriendShare, publishFriendShare, retryFriendShare });`, {
    friendSharing, swipeSharing, sharing, computed, nextTick,
    removingMenuEntry: ref(false), cloudMode: true, isPendingRecord: () => false, notify: () => {},
    state: ref({ recipes: [{ id: 'dish', title: '凉拌黄瓜' }], mealSets: [] }),
    useFriendShare: (selection, deliver) => ({ share: () => new Promise(resolve => {
      const itemId = selection.value.itemId;
      requests.push({ itemId, finish: () => { deliver({ title: '分享菜品', path: '/pages/share/index?id=existing-test-ticket' }); resolve(); } });
    }) }),
  });
  return { ...context, friendSharing, swipeSharing, sharing, requests };
}

test('left-swipe sharing opens the picker before waiting for the friend-share ticket', async () => {
  const page = fixture();
  const pending = page.shareEntry({ id: 'dish', kind: 'dish' });
  assert.equal(page.friendSharing.value.itemId, 'dish');
  assert.equal(page.friendSharing.value.preparing, true);
  assert.equal(page.friendSharing.value.card, null);
  await new Promise(setImmediate);
  assert.equal(page.requests.length, 1);
  assert.equal(page.swipeSharing.value.id, 'dish');
  page.requests[0].finish();
  await pending;
  assert.equal(page.friendSharing.value.card.title, '分享菜品');
  assert.equal(page.friendSharing.value.preparing, false);
  assert.equal(page.swipeSharing.value, null);
});

test('closing or choosing public sharing discards a late friend-share result', async () => {
  for (const action of ['closeFriendShare', 'publishFriendShare']) {
    const page = fixture();
    const pending = page.shareEntry({ id: 'dish', kind: 'dish' });
    await new Promise(setImmediate);
    page[action]();
    assert.equal(page.friendSharing.value, null);
    page.requests[0].finish();
    await pending;
    assert.equal(page.friendSharing.value, null);
    assert.equal(page.swipeSharing.value, null);
    if (action === 'publishFriendShare') assert.equal(page.sharing.value.itemId, 'dish');
  }
});

test('duplicate clicks cannot start additional preparation or replace the selected entry', async () => {
  const page = fixture();
  const pending = page.shareEntry({ id: 'dish', kind: 'dish' });
  await page.shareEntry({ id: 'other-dish', kind: 'dish' });
  await new Promise(setImmediate);
  assert.equal(page.friendSharing.value.itemId, 'dish');
  assert.equal(page.requests.length, 1);
  page.requests[0].finish();
  await pending;
});
