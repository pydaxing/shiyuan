import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { clone, matchesImportedSource } from '../src/domain/kitchen.js';
import { emptySnapshot } from '../src/domain/empty.js';
import { filterPosts, commentThreads, foodCover } from '../src/domain/presentation.js';
import { FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall } from '../src/domain/food-feed.js';
import { canDeleteCommunityPost, editableCommunityEntry, communityPublisherName } from '../src/domain/community-policy.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { presentMutation } from '../src/services/mutation-feedback.js';
import { createImportProvenance } from '../src/services/import-provenance.js';
import { useRecipeAccordion } from '../src/composables/useRecipeAccordion.js';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';
import { useCommunityFeedViewport } from '../src/composables/useCommunityFeedViewport.js';

// An optional, read-only source snapshot lets the same regression prove the old behavior.
const sourcePath = process.env.COMMUNITY_IMPORT_FEEDBACK_SOURCE || new URL('../src/components/CommunityView.vue', import.meta.url);
const isCustomElement = tag => ['view', 'scroll-view', 'text', 'image'].includes(tag);
const descriptor = parse(readFileSync(sourcePath, 'utf8'), { templateParseOptions: { isCustomElement } }).descriptor;
const compiled = compileScript(descriptor, {
  id: 'community-import-feedback',
  inlineTemplate: true,
  templateOptions: { compilerOptions: { isCustomElement, hoistStatic: false } },
});
const componentCode = compiled.content
  .replace(/import\s+(\{[^}]+\}|\w+)\s+from\s+['"][^'"]+['"];?/g, (_, binding) => binding.startsWith('{')
    ? `const ${binding.replace(/\s+as\s+/g, ': ')} = modules;`
    : `const ${binding} = modules.${binding};`)
  .replace('export default', 'return');
const instantiate = new Function('modules', 'uni', componentCode);

const tick = async () => { for (let index = 0; index < 8; index += 1) await Vue.nextTick(); };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function post(id, recipeId = `${id}-recipe`, extra = {}) {
  return {
    id, title: id === 'first' ? '香煎鸡胸肉' : '清炒时蔬', kind: 'dish', familyId: 'source-family',
    publisherId: 'publisher', publisherType: 'user', author: '分享者', image: '', importedFamilyCount: 3,
    recipes: [{ id: recipeId, title: '分享菜品', category: '荤菜', minutes: 20, image: '', ingredients: [], steps: [] }],
    ...extra,
  };
}
function snapshot(familyId = 'family-a', userId = 'member-a') {
  const value = emptySnapshot();
  value.family = { ...value.family, id: familyId, members: [{ id: userId, name: '家人' }] };
  value.activeMemberId = userId;
  return value;
}

function hostRenderer() {
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null });
  const remove = child => {
    if (!child.parent) return;
    const siblings = child.parent.children;
    siblings.splice(siblings.indexOf(child), 1);
    child.parent = null;
  };
  const renderer = Vue.createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text; },
    setElementText: (target, text) => { target.children.forEach(child => { child.parent = null; }); target.children = []; target.text = text; },
    insert: (child, parent, anchor = null) => {
      remove(child);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child);
    },
    remove, patchProp: (target, key, previous, value) => { target.props[key] = value; },
    parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] || null,
  });
  return { renderer, root: node('root') };
}
function nodes(target) { return [target, ...target.children.flatMap(nodes)]; }
function textOf(target) { return `${target.type === '#comment' ? '' : target.text}${target.children.map(textOf).join('')}`; }
function hasClass(target, name) { return String(target.props.class || '').split(/\s+/).includes(name); }

function mount(context, initialPosts = [post('first'), post('second')]) {
  const state = Vue.ref(snapshot());
  state.value.posts = clone(initialPosts);
  const cloudStatus = Vue.ref({ userId: 'member-a', familyId: 'family-a' });
  const feed = Vue.ref({ posts: clone(initialPosts), cursor: 'next-page', loading: false, ready: true, error: '' });
  const readablePosts = new Map(initialPosts.map(entry => [entry.id, clone(entry)]));
  const receipts = new Map();
  const provenance = createImportProvenance({ cache: { get: key => receipts.get(key), set: (key, value) => receipts.set(key, clone(value)), delete: key => receipts.delete(key) } });
  const scope = () => `${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
  const modals = [];
  const requests = [];
  const notices = [];
  const actions = [];
  let feedRefreshes = 0;
  const Empty = Vue.defineComponent({ setup: () => () => null });
  const AppIcon = Vue.defineComponent({
    props: { name: String }, inheritAttrs: false,
    setup: props => () => Vue.h('test-icon', { name: props.name }),
  });
  const FoodDetailSheet = Vue.defineComponent({
    props: { title: String, familyCount: Number }, inheritAttrs: false,
    // Invoke the actual compiled action slot inside a mounted component render effect.
    setup: (props, { slots }) => () => Vue.h('test-detail', { title: props.title, familyCount: props.familyCount }, slots.action?.()),
  });
  const modules = {
    ...Vue, NATIVE_UI_COLORS, state, cloudStatus, cloudMode: true, communityPosts: [], sheetOpen: Vue.ref(false),
    filterPosts, commentThreads, foodCover, FOOD_CATEGORIES, foodFeedQuery, orderFoodPosts, buildFoodWaterfall,
    canDeleteCommunityPost, editableCommunityEntry, communityPublisherName, matchesImportedSource, presentMutation,
    useRecipeAccordion, useCommunityNavigation, useCommunityFeedViewport, communityFeedRevision: Vue.ref(0),
    COMMUNITY_COMMENTS_ENABLED: false, tapFeedback() {}, dismissFocusedKeyboard() {}, rememberMedia() {},
    resolveImage: value => value, dishShareCard: value => value,
    createCommunityFeed: () => ({ state: feed, select() {}, refresh() { feedRefreshes += 1; }, dispose() {} }),
    invokeCloud: () => { throw new Error('This test must not call a cloud service'); },
    peekCommunityPost: id => ({ post: clone(readablePosts.get(id)), comments: [] }),
    readCommunityPost: async id => ({ post: clone(readablePosts.get(id)), comments: [] }),
    mergeCloudCommunity() {},
    notify: message => notices.push(message),
    runAction: action => {
      const pending = Promise.resolve(action()).catch(error => { notices.push(error.message); return false; });
      actions.push(pending);
      return pending;
    },
    addCollection: async entry => {
      const completion = deferred();
      requests.push({ post: clone(entry), ...completion });
      const result = await completion.promise;
      if (result?.apply !== false) {
        const confirmed = result?.post || clone(entry);
        // Reconcile the authoritative response as the real client does: replace changed fields.
        const before = state.value;
        const next = { ...before, recipes: [...before.recipes, ...confirmed.recipes.map(recipe => ({
          ...recipe, id: `import-${recipe.id}`, sourceId: recipe.id,
          ...(result?.legacy ? {} : { sourceFamilyId: confirmed.familyId, sourcePostId: confirmed.id }),
        }))], posts: result?.legacy ? before.posts : before.posts.map(existing => existing.id === confirmed.id ? clone(confirmed) : existing) };
        // Use the real compatibility reconciler with the exact provider response shape.
        provenance.record(scope(), before, next, confirmed);
        const reconciled = provenance.apply(scope(), next);
        state.value.recipes = reconciled.recipes;
        state.value.posts = reconciled.posts;
      }
      return 1;
    },
    addComment() {}, toggleCommentLike() {}, deleteCommunityPost() {},
    AppIcon, FoodDetailSheet,
  };
  for (const name of ['FormField', 'SelectField', 'RecipeContent', 'CommunityByline', 'CommunityFamilyCount', 'PageHeader', 'RecipeListMeta', 'CommentItem', 'LazyImage', 'FoodThumbnail']) modules[name] = Empty;
  const platform = { showModal: options => modals.push(options) };
  const { renderer, root } = hostRenderer();
  const app = renderer.createApp(instantiate(modules, platform), { active: true });
  app.config.globalProperties.$feedback = () => {};
  app.mount(root);
  context.after(() => app.unmount());
  const find = predicate => nodes(root).find(predicate);
  const detail = () => find(target => target.type === 'test-detail');
  const actionButton = () => find(target => target.type === 'button' && hasClass(target, 'menu-detail-order'));
  return {
    state, cloudStatus, feed, readablePosts, modals, requests, notices, root, detail, actionButton,
    get feedRefreshes() { return feedRefreshes; },
    async open(id) {
      const entry = feed.value.posts.find(item => item.id === id);
      const button = find(target => target.type === 'button' && hasClass(target, 'feed-cover') && target.props['aria-label'] === `查看${entry.title}`);
      assert.ok(button, `feed button for ${id}`);
      await button.props.onClick({});
      await tick();
    },
    async begin() {
      actionButton().props.onClick({});
      modals.at(-1).success({ confirm: true });
      await tick();
    },
    async receive(next) { state.value = provenance.apply(scope(), next); await tick(); },
    async settle(index, result) { requests[index].resolve(result); await Promise.all(actions); await tick(); },
    async fail(index, message = '网络暂时不可用') { requests[index].reject(new Error(message)); await Promise.all(actions); await tick(); },
  };
}
function assertAction(view, { text, icon, disabled, busy = false }) {
  const button = view.actionButton();
  assert.ok(button, 'the detail action remains mounted');
  assert.equal(textOf(button), text);
  assert.equal(nodes(button).find(target => target.type === 'test-icon')?.props.name, icon);
  assert.equal(Boolean(button.props.disabled), disabled);
  assert.equal(Boolean(button.props['aria-busy']), busy);
  assert.equal(hasClass(button, 'is-complete'), text === '已加入');
}

test('an open stale detail adopts the confirmed source and renders joined feedback without reopening', async context => {
  const cached = post('first', 'cached-old-source');
  const view = mount(context, [cached]);
  await view.open('first');
  const detail = view.detail();
  const feed = view.feed.value;
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
  await view.begin();
  assertAction(view, { text: '加入中', icon: 'plus-inverse', disabled: true, busy: true });
  await view.settle(0, { post: post('first', 'confirmed-new-source', { importedFamilyCount: 4 }) });
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
  assert.equal(view.detail(), detail, 'the open detail is updated in place');
  assert.equal(view.detail().props.familyCount, 4);
  assert.equal(view.feed.value, feed, 'joining does not replace the feed or its cursor');
  assert.equal(view.feedRefreshes, 0);
});

test('a normal import updates the mounted action and family count from its successful patch', async context => {
  const view = mount(context);
  await view.open('first');
  await view.begin();
  await view.settle(0, { post: post('first', 'first-recipe', { importedFamilyCount: 4 }) });
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
  assert.equal(view.detail().props.familyCount, 4);
  assert.equal(view.requests.length, 1);
});

test('a failed import restores an enabled action and the next confirmed retry can succeed', async context => {
  const view = mount(context);
  await view.open('first');
  await view.begin();
  await view.fail(0);
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
  assert.deepEqual(view.notices, ['网络暂时不可用']);
  assert.equal(view.state.value.recipes.length, 0);
  await view.begin();
  assert.equal(view.requests.length, 2);
  await view.settle(1, { post: post('first', 'first-recipe', { importedFamilyCount: 4 }) });
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
});

test('repeated taps and repeated modal confirmation while waiting submit only one import', async context => {
  const view = mount(context);
  await view.open('first');
  const click = view.actionButton().props.onClick;
  await view.begin();
  click({});
  view.actionButton().props.onClick({});
  view.modals[0].success({ confirm: true });
  await tick();
  assert.equal(view.modals.length, 1);
  assert.equal(view.requests.length, 1);
  assertAction(view, { text: '加入中', icon: 'plus-inverse', disabled: true, busy: true });
  await view.settle(0, { post: post('first') });
});

for (const changed of ['family', 'account']) {
  test(`a late import from the previous ${changed} cannot replace the same post opened in the new scope`, async context => {
    const view = mount(context);
    await view.open('first');
    await view.begin();
    const nextIdentity = changed === 'family'
      ? { familyId: 'family-b', userId: 'member-a' }
      : { familyId: 'family-a', userId: 'member-b' };
    view.cloudStatus.value = nextIdentity;
    view.state.value = snapshot(nextIdentity.familyId, nextIdentity.userId);
    view.state.value.posts = [post('first', 'old-response-source', { title: '旧请求确认内容', importedFamilyCount: 99 })];
    view.readablePosts.set('first', post('first', 'current-scope-source', { title: '当前身份打开的详情', importedFamilyCount: 8 }));
    await view.open('first');
    const detail = view.detail();
    await view.settle(0, { apply: false });
    assert.equal(view.detail(), detail);
    assert.equal(view.detail().props.title, '当前身份打开的详情');
    assert.equal(view.detail().props.familyCount, 8);
    assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
  });
}

test('a late success updates the menu without replacing another post already open in the detail', async context => {
  const view = mount(context);
  await view.open('first');
  await view.begin();
  await view.open('second');
  const detail = view.detail();
  await view.settle(0, { post: post('first', 'confirmed-new-source', { title: '第一个帖子的确认内容', importedFamilyCount: 4 }) });
  assert.equal(view.detail(), detail);
  assert.equal(view.detail().props.title, '清炒时蔬');
  assert.equal(view.detail().props.familyCount, 3);
  assert.equal(view.state.value.recipes[0].sourcePostId, 'first');
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
});

test('confirming an old modal after changing identity does not import into the new family', async context => {
  const view = mount(context);
  await view.open('first');
  view.actionButton().props.onClick({});
  view.cloudStatus.value = { familyId: 'family-b', userId: 'member-b' };
  view.state.value = snapshot('family-b', 'member-b');
  await tick();
  view.modals[0].success({ confirm: true });
  await tick();
  assert.equal(view.requests.length, 0);
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
});


test('the deployed legacy response updates the still-open action without postChanges or modern provenance', async context => {
  const view = mount(context);
  await view.open('first');
  const detail = view.detail();
  await view.begin();
  await view.settle(0, { legacy: true });
  assert.equal(view.detail(), detail);
  assert.equal(view.state.value.recipes.length, 1);
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
});


test('legacy joined feedback survives a raw refresh and clears after the imported dish is removed', async context => {
  const view = mount(context);
  await view.open('first');
  await view.begin();
  await view.settle(0, { legacy: true });
  const raw = clone(view.state.value);
  delete raw.recipes[0].sourceFamilyId;
  delete raw.recipes[0].sourcePostId;
  await view.receive(raw);
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
  await view.receive({ ...raw, recipes: [] });
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
});

test('a confirmed legacy import never marks a different source family with the same recipe ID joined', async context => {
  const first = post('first', 'shared-recipe-id');
  const second = post('second', 'shared-recipe-id', { familyId: 'different-source-family' });
  const view = mount(context, [first, second]);
  await view.open('first');
  await view.begin();
  await view.settle(0, { legacy: true });
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
  await view.open('second');
  assertAction(view, { text: '加入菜单', icon: 'plus-inverse', disabled: false });
  assert.equal(view.requests.length, 1);
});

test('an old completion does not overwrite a newer reading after reopening the same detail', async context => {
  const view = mount(context);
  await view.open('first');
  await view.begin();
  view.readablePosts.set('first', post('first', 'first-recipe', { title: '重新打开后的新详情', importedFamilyCount: 8 }));
  await view.open('first');
  await view.settle(0, { post: post('first', 'first-recipe', { title: '旧请求中的详情', importedFamilyCount: 4 }) });
  assert.equal(view.detail().props.title, '重新打开后的新详情');
  assert.equal(view.detail().props.familyCount, 8);
  assertAction(view, { text: '已加入', icon: 'check', disabled: true });
});
