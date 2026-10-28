import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationStatusMatches, readLegacyPublicationStatus } from '../src/services/legacy-publication-status.js';

const post = (overrides = {}) => ({ id: 'post-dish', kind: 'dish', familyItemId: 'dish', familyId: 'home', status: 'published', ...overrides });
const card = ({ id, kind, familyItemId, familyKind }) => ({ id, kind, familyItemId, ...(familyKind ? { familyKind } : {}) });

function fixture({ pages = [{ posts: [], cursor: '' }], posts = [], dishes = ['dish'], sets = ['set'] } = {}) {
  const snapshot = { family: { id: 'home', revision: 3 }, activeMemberId: 'member', recipes: dishes.map(id => ({ id })), mealSets: sets.map(id => ({ id })) };
  const context = { snapshot, requests: [], active: true };
  let pageIndex = 0;
  context.handlers = {
    feed: async () => pages[pageIndex++],
    readPost: async ({ postId }) => ({ post: posts.find(entry => entry.id === postId) }),
    bootstrap: async () => ({ unchanged: true, familyId: 'home', userId: 'member', revision: 3 }),
  };
  context.sync = () => readLegacyPublicationStatus({
    getSnapshot: () => context.snapshot,
    isActive: () => context.active,
    request: async (action, payload) => {
      context.requests.push({ action, payload });
      return context.handlers[action](payload);
    },
  });
  return context;
}

test('legacy lookup reads through all pages and verifies matching records against their family', async () => {
  const foreign = post({ id: 'foreign', familyId: 'other-home' });
  const shared = post();
  const context = fixture({
    pages: [
      { posts: [card(foreign), card(post({ id: 'unrelated', familyItemId: 'another-dish' }))], cursor: 'page-two' },
      { posts: [card(shared)], cursor: 'page-three' },
      { posts: [], cursor: '' },
    ],
    posts: [foreign, shared],
  });
  const before = structuredClone(context.snapshot);
  const result = await context.sync();
  assert.deepEqual(result, { familyId: 'home', memberId: 'member', revision: 3, items: [{ kind: 'dish', itemId: 'dish', postId: 'post-dish' }] });
  assert.deepEqual(context.snapshot, before);
  assert.deepEqual(context.requests.map(request => request.action), ['feed', 'readPost', 'feed', 'readPost', 'feed', 'bootstrap']);
  assert.deepEqual(context.requests.filter(request => request.action === 'feed').map(request => request.payload.cursor), ['', 'page-two', 'page-three']);
  for (const request of context.requests) {
    assert.equal(request.payload.includeImageManifests, false);
    if (request.action === 'feed') {
      assert.equal(request.payload.compact, true);
      assert.equal(request.payload.search, '');
      assert.equal(request.payload.type, '全部');
      assert.equal(request.payload.category, '全部');
    }
    if (request.action === 'readPost') assert.equal(request.payload.includeComments, false);
  }
  assert.deepEqual(context.requests.at(-1).payload, { knownFamilyId: 'home', knownRevision: 3, includeFeed: false, includeImageManifests: false });
});

test('dish and legacy menu records with the same source ID remain distinct', async () => {
  const dish = post({ familyItemId: 'same' });
  const set = post({ id: 'post-set', kind: 'menu', familyItemId: 'same' });
  const context = fixture({ dishes: ['same'], sets: ['same'], pages: [{ posts: [card(dish), card(set)], cursor: 'unneeded-page' }], posts: [dish, set] });
  const result = await context.sync();
  assert.deepEqual(result.items, [{ kind: 'dish', itemId: 'same', postId: 'post-dish' }, { kind: 'set', itemId: 'same', postId: 'post-set' }]);
  assert.deepEqual(context.requests.map(request => request.action), ['feed', 'readPost', 'readPost', 'bootstrap']);
});

test('foreign families and no-longer-published details cannot mark local items as shared', async () => {
  const foreign = post({ familyId: 'other-home' });
  const deleted = post({ id: 'deleted', status: 'deleted' });
  const context = fixture({ pages: [{ posts: [card(foreign), card(deleted)], cursor: '' }], posts: [foreign, deleted] });
  assert.deepEqual((await context.sync()).items, []);
  assert.equal(context.requests.at(-1).action, 'bootstrap');
});

test('duplicate feed cards only require one detail read without skipping remaining pages', async () => {
  const shared = post();
  const context = fixture({ pages: [{ posts: [card(shared)], cursor: 'next' }, { posts: [card(shared)], cursor: '' }], posts: [shared] });
  assert.equal((await context.sync()).items.length, 1);
  assert.equal(context.requests.filter(request => request.action === 'readPost').length, 1);
  assert.equal(context.requests.filter(request => request.action === 'feed').length, 2);
});

test('empty feed is a verified empty result, not an unknown or failed response', async () => {
  const context = fixture();
  assert.deepEqual((await context.sync()).items, []);
  assert.deepEqual(context.requests.map(request => request.action), ['feed', 'bootstrap']);
});

test('families with no shareable items only verify scope without querying the community', async () => {
  const context = fixture({ dishes: [], sets: [] });
  assert.deepEqual((await context.sync()).items, []);
  assert.deepEqual(context.requests.map(request => request.action), ['bootstrap']);
});

test('malformed or incomplete feed responses never become an empty shared list', async () => {
  for (const page of [undefined, null, {}, { posts: [] }, { posts: [], cursor: null }, { posts: {}, cursor: '' }, { posts: [null], cursor: '' }, { posts: [{ id: 1 }], cursor: '' }]) {
    const context = fixture({ pages: [page] });
    await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SYNC_FAILED');
    assert.equal(context.requests.some(request => request.action === 'bootstrap'), false);
  }
});

test('malformed or changed matching details fail closed with a retryable message', async () => {
  for (const detail of [undefined, null, {}, { post: post({ id: 'replaced' }) }, { post: post({ familyId: '' }) }, { post: post({ kind: 'menu' }) }, { post: post({ familyItemId: 'changed' }) }, { post: post({ status: undefined }) }]) {
    const context = fixture({ pages: [{ posts: [card(post())], cursor: '' }] });
    context.handlers.readPost = async () => detail;
    await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SYNC_FAILED' && error.message.includes('重新同步'));
    assert.equal(context.requests.some(request => request.action === 'bootstrap'), false);
  }
});

test('request failures propagate at every read stage instead of allowing a duplicate publish', async () => {
  for (const action of ['feed', 'readPost', 'bootstrap']) {
    const context = fixture({ pages: [{ posts: [card(post())], cursor: '' }], posts: [post()] });
    const failure = new Error('网络连接失败');
    context.handlers[action] = async () => { throw failure; };
    await assert.rejects(context.sync(), error => error === failure);
  }
});

test('repeated cursors fail rather than treating a partial feed as complete', async () => {
  const context = fixture({ pages: [{ posts: [], cursor: 'next' }, { posts: [], cursor: 'next' }] });
  await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SYNC_FAILED');
  assert.equal(context.requests.length, 2);
});

test('nonterminating pagination is bounded and never enables unverified items', async () => {
  const context = fixture();
  let pageIndex = 0;
  context.handlers.feed = async () => ({ posts: [], cursor: `page-${++pageIndex}` });
  await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SYNC_FAILED');
  assert.equal(context.requests.length, 100);
  assert.ok(context.requests.every(request => request.action === 'feed'));
});

test('family, identity, or revision changes invalidate every asynchronous lookup stage', async () => {
  const changes = [
    snapshot => { snapshot.family.id = 'another-home'; },
    snapshot => { snapshot.activeMemberId = 'another-member'; },
    snapshot => { snapshot.family.revision += 1; },
  ];
  for (const action of ['feed', 'readPost', 'bootstrap']) {
    for (const change of changes) {
      const context = fixture({ pages: [{ posts: [card(post())], cursor: '' }], posts: [post()] });
      const handler = context.handlers[action];
      context.handlers[action] = async payload => { const result = await handler(payload); change(context.snapshot); return result; };
      await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SCOPE_CHANGED');
      assert.equal(context.requests.at(-1).action, action);
    }
  }
});

test('closing the sheet cancels pending results at each read boundary', async () => {
  for (const action of ['feed', 'readPost', 'bootstrap']) {
    const context = fixture({ pages: [{ posts: [card(post())], cursor: '' }], posts: [post()] });
    const handler = context.handlers[action];
    context.handlers[action] = async payload => { const result = await handler(payload); context.active = false; return result; };
    await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SCOPE_CHANGED');
    assert.equal(context.requests.at(-1).action, action);
  }
});

test('server-side scope changes and malformed verification responses invalidate otherwise complete results', async () => {
  for (const response of [undefined, null, {}, { needsFamily: true, userId: 'member' }, { familyId: 'home', userId: 'member', revision: 4 }, { familyId: 'another-home', userId: 'member', revision: 3 }, { familyId: 'home', userId: 'another-member', revision: 3 }]) {
    const context = fixture();
    context.handlers.bootstrap = async () => response;
    await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_CHANGED');
  }
});

test('missing identity or revision cannot establish a compatibility snapshot', async () => {
  for (const change of [snapshot => { delete snapshot.family.revision; }, snapshot => { snapshot.family.id = ''; }, snapshot => { snapshot.activeMemberId = ''; }]) {
    const context = fixture();
    change(context.snapshot);
    await assert.rejects(context.sync(), error => error.code === 'PUBLICATION_SCOPE_CHANGED');
    assert.equal(context.requests.length, 0);
  }
});

test('compatibility snapshots remain usable only for the same family, member, and revision', () => {
  const context = fixture();
  const status = { familyId: 'home', memberId: 'member', revision: 3, items: [] };
  assert.equal(publicationStatusMatches(status, context.snapshot), true);
  assert.equal(publicationStatusMatches(null, context.snapshot), false);
  assert.equal(publicationStatusMatches({ ...status, revision: '3' }, context.snapshot), false);
  for (const other of [{ familyId: 'other' }, { memberId: 'other' }, { revision: 4 }]) assert.equal(publicationStatusMatches({ ...status, ...other }, context.snapshot), false);
});
