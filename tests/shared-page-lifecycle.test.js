import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';

const source = readFileSync(new URL('../src/pages/shared/index.vue', import.meta.url), 'utf8');
const sharedPost = (id = 'post-a') => ({ id, title: '番茄炒蛋', kind: 'dish', image: '', recipes: [{ id: 'recipe-a', title: '番茄炒蛋' }] });
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function mount(context, overrides = {}) {
  const calls = []; const writes = []; const tokens = []; const notices = []; const modals = [];
  let load; let unload;
  const cloudStatus = Vue.ref({ phase: 'ready', userId: 'user-a', familyId: 'family-a' });
  const modules = {
    ...Vue, cloudMode: true, cloudStatus,
    NATIVE_UI_COLORS: { primary: '#345', muted: '#888' },
    onLoad: callback => { load = callback; }, onUnload: callback => { unload = callback; }, onShareAppMessage() {},
    connectCloud: async () => {},
    invokeCloud: async (...args) => { calls.push(args); return { post: sharedPost() }; },
    manageFamily: async (...args) => { writes.push(args); },
    addCollection: async post => { writes.push(['addCollection', post]); },
    setShareMediaToken: token => tokens.push(token),
    resolveImage: value => value, dishShareCard: value => value, shareMessage() {}, dismissFocusedKeyboard() {},
    notify: message => notices.push(message),
    useRecipeAccordion: () => ({ expanded: Vue.ref(''), recipeAnchor: index => `recipe-${index}`, toggleRecipe() {}, resetRecipes() {}, cancelRecipeScroll() {} }),
    ...overrides,
  };
  const previous = globalThis.uni;
  globalThis.uni = { showModal: options => modals.push(options), reLaunch() {}, pageScrollTo() {} };
  let script = compileScript(parse(source).descriptor, { id: 'shared-page-lifecycle' }).content;
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', script.replace('export default', 'return'))(modules);
  const scope = Vue.effectScope();
  const api = scope.run(() => component.setup({}, { expose() {} }));
  context.after(() => { scope.stop(); globalThis.uni = previous; });
  return { api, calls, writes, tokens, notices, modals, cloudStatus, load: query => load(query), unload: () => unload() };
}

test('token and legacy public-post links retain their existing read contracts', async context => {
  const { api, calls, tokens } = mount(context);
  api.token.value = 'share-token';
  await api.read();
  assert.deepEqual(calls[0], ['readShare', { token: 'share-token' }]);
  assert.equal(api.post.value.id, 'post-a');
  assert.equal(tokens.at(-1), 'share-token');
  api.token.value = ''; api.postId.value = 'legacy-post';
  await api.read();
  assert.deepEqual(calls[1], ['readPost', { postId: 'legacy-post', paginateComments: true }]);
  assert.equal(api.loading.value, false);
});

test('late share reads cannot revive a post or its media permission after unload', async context => {
  const response = deferred();
  const { api, tokens, unload } = mount(context, { invokeCloud: () => response.promise });
  api.token.value = 'share-token';
  const pending = api.read();
  await settle();
  unload();
  response.resolve({ post: sharedPost() });
  await pending;
  assert.equal(api.post.value, null);
  assert.ok(tokens.every(token => !token));
});

test('leaving during connection prevents the subsequent share request', async context => {
  const connection = deferred();
  const { api, calls, unload } = mount(context, { connectCloud: () => connection.promise });
  const pending = api.read();
  unload(); connection.resolve();
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(api.post.value, null);
});

test('a failed authorization retry removes the previously visible post and import state', async context => {
  const { api, tokens, writes } = mount(context, { invokeCloud: async () => { throw new Error('分享已失效'); } });
  api.post.value = sharedPost(); api.added.value = true;
  await api.read();
  assert.equal(api.post.value, null);
  assert.equal(api.added.value, false);
  assert.equal(api.loading.value, false);
  assert.match(api.error.value, /分享已失效/);
  assert.equal(tokens.at(-1), undefined);
  await api.importDish();
  assert.deepEqual(writes, []);
});

test('an older failed request cannot erase a newer successful read', async context => {
  const old = deferred(); let count = 0;
  const { api, tokens } = mount(context, { invokeCloud: () => ++count === 1 ? old.promise : Promise.resolve({ post: sharedPost('new-post') }) });
  api.token.value = 'share-token';
  const first = api.read();
  await settle();
  await api.read();
  old.reject(new Error('旧请求已失效'));
  await first;
  assert.equal(api.post.value.id, 'new-post');
  assert.equal(api.error.value, '');
  assert.equal(api.loading.value, false);
  assert.equal(tokens.at(-1), 'share-token');
});

test('scope changes clear old content immediately and ignore the old response', async context => {
  const old = deferred(); let count = 0;
  const { api, cloudStatus, load, tokens } = mount(context, { invokeCloud: () => ++count === 1 ? old.promise : Promise.resolve({ post: sharedPost('current-post') }) });
  load({ token: 'share-token' });
  await settle();
  api.added.value = true;
  cloudStatus.value = { ...cloudStatus.value, familyId: 'family-b' };
  assert.equal(api.post.value, null);
  assert.equal(api.added.value, false);
  await settle();
  assert.equal(api.post.value.id, 'current-post');
  old.resolve({ post: sharedPost('old-post') });
  await settle();
  assert.equal(api.post.value.id, 'current-post');
  assert.equal(tokens.at(-1), 'share-token');
});

test('bootstrap identity initialization still completes exactly one active share read', async context => {
  const cloudStatus = Vue.ref({ phase: 'connecting', userId: '', familyId: '' });
  const { api, calls, load } = mount(context, {
    cloudStatus,
    connectCloud: async () => { cloudStatus.value = { phase: 'ready', userId: 'user-a', familyId: 'family-a' }; },
  });
  load({ token: 'share-token' });
  await settle();
  assert.equal(api.post.value.id, 'post-a');
  assert.equal(api.loading.value, false);
  assert.equal(calls.length, 1);
});

test('a confirmation opened for another household cannot import into the new one', async context => {
  const { api, cloudStatus, modals, writes } = mount(context);
  await api.read();
  await api.importDish();
  cloudStatus.value = { ...cloudStatus.value, familyId: 'family-b' };
  await modals[0].success({ confirm: true });
  assert.deepEqual(writes, []);
  assert.equal(api.added.value, false);
});

test('successful token imports are bound to the confirmed household', async context => {
  const { api, modals, writes } = mount(context);
  api.token.value = 'share-token';
  await api.read();
  await api.importDish();
  await modals[0].success({ confirm: true });
  assert.deepEqual(writes, [['importShare', { token: 'share-token', familyId: 'family-a' }]]);
  assert.equal(api.added.value, true);
  assert.equal(api.busy.value, false);
});

test('late imports never mark another account or household as already imported', async context => {
  const response = deferred();
  const { api, cloudStatus, modals, notices } = mount(context, { manageFamily: () => response.promise });
  api.token.value = 'share-token';
  await api.read();
  await api.importDish();
  const pending = modals[0].success({ confirm: true });
  assert.equal(api.busy.value, true);
  cloudStatus.value = { ...cloudStatus.value, userId: 'user-b' };
  response.resolve(); await pending;
  assert.equal(api.added.value, false);
  assert.equal(api.busy.value, false);
  assert.deepEqual(notices, []);
});
