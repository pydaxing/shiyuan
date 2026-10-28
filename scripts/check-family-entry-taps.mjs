import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { baseParse } from '@vue/compiler-dom';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot } from '../src/domain/kitchen.js';
import * as nativeShare from '../src/services/native-share.js';
import { tapFeedback } from '../src/services/feedback.js';
import * as mutationFeedback from '../src/services/mutation-feedback.js';

const root = new URL('../dist/build/mp-weixin/', import.meta.url);
const source = readFileSync(new URL('pages/index/index.js', root), 'utf8');
const runtime = readFileSync(new URL('../node_modules/@dcloudio/uni-mp-vue/dist/vue.runtime.esm.js', import.meta.url), 'utf8');
const bindingCode = runtime.slice(runtime.indexOf('function vOn('), runtime.indexOf('function patchMPEvent('));
const attribute = (node, name) => node.props.find((prop) => prop.name === name)?.value?.content;
const hasClass = (node, name) => attribute(node, 'class')?.includes(name);
const value = (data, expression) => expression.replace(/^\{\{|\}\}$/g, '').split('.').reduce((entry, key) => entry?.[key], data);
function elements(filename) {
  const nodes = [];
  function collect(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(collect); } }
  baseParse(readFileSync(new URL(filename, root), 'utf8')).children.forEach(collect);
  return nodes;
}
const pageNodes = elements('pages/index/index.wxml');
const appearanceNodes = elements('components/FamilyEditor.wxml');
assert.deepEqual(appearanceNodes.filter(node => hasClass(node, 'subheading')).map(node => node.children.filter(child => child.type === 2).map(child => child.content).join('')), ['家庭封面', '家庭名称', '菜单主标题'], '家庭设置原生产物只保留封面、名称和菜单主标题');
const managementNodes = elements('components/FamilyManagement.wxml');
for (const nodes of [appearanceNodes, managementNodes]) assert.ok(nodes.every(node => !node.loc.source.includes('菜单副标题')), '家庭编辑与创建均不再展示副标题配置');
const managementStyles = readFileSync(new URL('components/FamilyManagement.wxss', root), 'utf8');
assert.ok(managementNodes.some(node => hasClass(node, 'family-choice-name')), '家庭名称使用明确的原生样式类');
const familyActions = managementNodes.filter(node => node.tag === 'button' && hasClass(node, 'family-choice-action'));
assert.equal(familyActions.length, 2, '家庭卡片保留退出与管理员删除两个图标入口');
for (const action of familyActions) {
  assert.ok(attribute(action, 'catchtap'), '家庭管理图标阻断冒泡，不触发家庭切换');
  assert.ok(attribute(action, 'aria-label'), '纯图标按钮仍保留无障碍名称');
  assert.equal(action.children.some(child => child.type === 1 && child.tag === 'text'), false, '家庭操作不再显示文字标签');
}
assert.match(managementStyles, /\.family-choice-name\b/);
assert.doesNotMatch(managementStyles, />\s*text\b/, '家庭名称不能依赖微信组件不支持的标签选择器');
const pageRoot = pageNodes.find((node) => hasClass(node, 'app-shell'));
const editor = pageNodes.find((node) => node.tag === 'family-editor');
const navigation = pageNodes.find((node) => hasClass(node, 'nav-item'));
const entries = [
  { name: 'family-banner-edit', control: elements('components/FamilyView.wxml').find((node) => hasClass(node, 'family-banner-edit')), owner: pageNodes.find((node) => node.tag === 'family-view'), event: 'bindcustomize', initialTab: 'appearance' },
  { name: '家庭设置', control: elements('components/FamilyView.wxml').find((node) => hasClass(node, 'family-management-entry')), owner: pageNodes.find((node) => node.tag === 'family-view'), event: 'bindcustomize', initialTab: 'appearance' },
];
const dependencies = {};
for (const match of source.matchAll(/require\("([^"]+)"\)/g)) {
  if (/^\.\.\/\.\.\/(domain|composables)\//.test(match[1])) dependencies[match[1]] = await import(new URL(match[1].replace('../../', '../src/'), import.meta.url));
}

for (const photo of [false, true]) for (const entry of entries) {
  const instance = { $ei: 0, ctx: { $mpPlatform: 'mp-weixin', $scope: {} } };
  const bind = new Function('getCurrentInstance', 'isString', 'patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', bindingCode + '; return vOn;')(() => instance, item => typeof item === 'string', () => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler);
  const seed = normalizeSnapshot(createSeed());
  if (photo) { seed.family.cover = '/static/tomato.png'; seed.family.coverTitle = '一家人的餐桌'; seed.family.features.fridge = true; }
  let keyboardDismissals = 0;
  const confirmations = [];
  const vendor = { ...Vue, index: { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }), pageScrollTo() {}, showModal(options) { confirmations.push(options); options.success({ confirm: false }); } }, onMounted() {}, onUnmounted() {}, onShow() {}, onPageScroll() {}, onReachBottom() {}, onResize() {}, onShareAppMessage() {}, e: Object.assign, f: Vue.renderList, t: String, n: Vue.normalizeClass, s: item => item, sr() {}, p: item => item, o: bind };
  vendor.index.createSelectorQuery = () => ({
    in() { return this; }, select() { return this; }, boundingClientRect() { return this; }, selectViewport() { return this; }, scrollOffset() { return this; },
    exec(callback) { callback([null, { scrollTop: 0 }]); },
  });
  const cloud = { cloudMode: true, cloudStatus: Vue.ref({ phase: 'ready', error: '' }), mutationStatus: Vue.ref({ pending: [], failures: [] }) };
  const modules = { ...dependencies, '../../common/vendor.js': vendor, '../../common/assets.js': {}, '../../store.js': { ...cloud, state: Vue.ref(seed), storageError: Vue.ref('') }, '../../services/cloud.js': cloud, '../../services/feedback.js': { tapFeedback }, '../../services/keyboard.js': { dismissFocusedKeyboard() { keyboardDismissals += 1; } } };
  modules['../../services/native-share.js'] = nativeShare;
  modules['../../services/mutation-feedback.js'] = mutationFeedback;
  modules['../../store.js'].familyFeatures = Vue.computed(() => seed.family.features);
  let page;
  new Function('require', 'wx', source)(name => { assert.ok(modules[name], `unmocked dependency: ${name}`); return modules[name]; }, { createPage: component => { page = component; } });
  const scope = Vue.effectScope();
  const originalUni = globalThis.uni;
  globalThis.uni = vendor.index;
  try {
    const render = scope.run(() => page.setup({}));
    const draw = () => { instance.$ei = 0; return render({ $feedback: tapFeedback, $image: value => value }, []); };
    const tap = { type: 'tap', target: { dataset: { eventsync: 'true' } } };
    let before = draw();
    {
      const items = value(before, attribute(navigation, 'wx:for'));
      const selected = items.find(item => value({ item }, attribute(navigation, 'aria-label')) === '我家');
      instance.ctx.$scope[value({ item: selected }, attribute(navigation, 'bindtap'))](tap);
      before = draw();
    }
    assert.equal(value(before, attribute(editor, 'wx:if')), false);
    const oldAncestor = value(before, attribute(pageRoot, 'bindtap'));
    const launch = value(before, attribute(entry.owner, entry.event));
    assert.equal(typeof instance.ctx.$scope[launch], 'function', `${entry.name}: launch is bound`);
    instance.ctx.$scope[launch](tap);
    const opened = draw();
    assert.equal(value(opened, attribute(editor, 'wx:if')), true, `${entry.name}: editor opens`);
    assert.equal(value(opened, attribute(editor, 'u-p'))['initial-tab'], entry.initialTab, `${entry.name}: opens the intended editor section`);
    const stops = Boolean(attribute(entry.control, 'catchtap'));
    if (!stops) instance.ctx.$scope[oldAncestor](tap);
    assert.equal(value(draw(), attribute(editor, 'wx:if')), true, `${entry.name}: opening tap must not close the editor after rerender`);
    assert.ok(stops, `${entry.name}: native control must isolate its opening tap`);
    assert.equal(keyboardDismissals, 1, `${entry.name}: shared launcher dismisses an existing keyboard once`);
    instance.ctx.$scope[value(opened, attribute(editor, 'bindclose'))]({ type: 'close' });
    assert.equal(value(draw(), attribute(editor, 'wx:if')), false, `${entry.name}: explicit close still works`);
    if (!photo && entry.name === 'family-banner-edit') {
      const items = value(draw(), attribute(navigation, 'wx:for'));
      const menuNavigation = items.find(item => value({ item }, attribute(navigation, 'aria-label')) === '菜单');
      instance.ctx.$scope[value({ item: menuNavigation }, attribute(navigation, 'bindtap'))](tap);
      const menu = pageNodes.find(node => node.tag === 'home-menu');
      const options = pageNodes.find(node => node.tag === 'sheet' && node.children.some(child => child.type === 1 && hasClass(child, 'menu-create-options')));
      for (const [label, tag] of [['创建菜品', 'recipe-editor'], ['创建套餐', 'set-editor']]) {
        instance.ctx.$scope[value(draw(), attribute(menu, 'bindcreate'))](tap);
        assert.equal(value(draw(), attribute(options, 'wx:if')), true, '新增 opens the real create picker');
        const control = pageNodes.find(node => attribute(node, 'aria-label') === label);
        const panel = pageNodes.find(node => node.tag === tag);
        instance.ctx.$scope[value(draw(), attribute(control, 'catchtap'))](tap);
        const created = draw();
        assert.equal(value(created, attribute(panel, 'wx:if')), true, `${label}: opens on the first tap`);
        assert.equal(value(created, attribute(options, 'wx:if')), false, 'the picker closes before the editor opens');
        instance.ctx.$scope[value(created, attribute(panel, 'bindclose'))]({ type: 'close' });
        assert.equal(value(draw(), attribute(panel, 'wx:if')), false);
      }
      const trigger = (event, ...args) => instance.ctx.$scope[value(draw(), attribute(menu, event))]({ type: event.slice(4), detail: { __args__: args } });
      const menuProps = () => value(draw(), attribute(menu, 'u-p'));
      const dish = menuProps().entries.find(item => item.kind === 'dish');
      assert.ok(dish, 'the compiled page exposes an existing dish');
      trigger('bindtoggle', dish.key);
      const selected = { ...menuProps().selected };
      assert.equal(Boolean(selected[dish.key]), true, 'the native selection event selects the dish');
      assert.equal(attribute(menu, 'bindupdateEditing'), undefined, 'the obsolete edit mode is removed');
      const exampleSet = { id: 'native-check-set', title: '双人家常餐', kind: 'set', recipeIds: [dish.id] };
      for (const [kind, tag, draft, prop] of [['dish', 'recipe-editor', dish, 'recipe'], ['set', 'set-editor', exampleSet, 'meal-set']]) {
        const panel = pageNodes.find(node => node.tag === tag);
        trigger('bindcreate', '饮品', kind);
        assert.equal(value(draw(), attribute(panel, 'wx:if')), true, `${kind}: the direct create action opens the original editor`);
        assert.equal(value(draw(), attribute(options, 'wx:if')), false, `${kind}: direct create does not stack the old picker`);
        if (kind === 'dish') assert.equal(value(draw(), attribute(panel, 'u-p'))['initial-category'], '饮品');
        instance.ctx.$scope[value(draw(), attribute(panel, 'bindclose'))]({ type: 'close' });
        trigger('bindeditEntry', draft);
        assert.equal(value(draw(), attribute(panel, 'wx:if')), true, `${kind}: row editing opens immediately`);
        assert.equal(value(draw(), attribute(panel, 'u-p'))[prop].id, draft.id, `${kind}: editing receives the existing record`);
        instance.ctx.$scope[value(draw(), attribute(panel, 'bindclose'))]({ type: 'close' });
        await trigger('bindremoveEntry', draft);
        assert.equal(confirmations.at(-1).title, `删除${draft.title}？`, `${kind}: removal uses the native confirmation`);
        assert.equal(menuProps().busy, false, 'cancelling removal unlocks menu editing');
        assert.deepEqual(menuProps().selected, selected, 'cancelling removal preserves selections');
      }
      trigger('bindcreate', '荤菜');
      const discover = pageNodes.find(node => attribute(node, 'aria-label') === '发现美食');
      instance.ctx.$scope[value(draw(), attribute(discover, 'catchtap'))](tap);
      await Vue.nextTick();
      assert.equal(value(draw(), attribute(options, 'wx:if')), false, '发现美食 closes the create picker');
      const feedContainer = pageNodes.find(node => hasClass(node, 'community-tab'));
      const feedComponent = pageNodes.find(node => node.tag === 'community-view');
      assert.equal(value(draw(), attribute(feedContainer, 'wx:if')), true, '发现美食 lazily mounts the real food page');
      assert.equal(value(draw(), attribute(feedComponent, 'u-p')).active, true);
      const feedKey = value(draw(), attribute(feedComponent, 'key'));
      for (const label of ['菜单', '美食']) {
        const items = value(draw(), attribute(navigation, 'wx:for'));
        const item = items.find(item => value({ item }, attribute(navigation, 'aria-label')) === label);
        instance.ctx.$scope[value({ item }, attribute(navigation, 'bindtap'))](tap);
        await Vue.nextTick();
        assert.equal(value(draw(), attribute(feedContainer, 'wx:if')), true, 'tab switching keeps the feed mounted');
        assert.equal(value(draw(), attribute(feedComponent, 'u-p')).active, label === '美食');
        assert.equal(value(draw(), attribute(feedComponent, 'key')), feedKey, 'tab switching keeps the same feed instance');
      }
    }
  } finally { scope.stop(); globalThis.uni = originalUni; }
}
console.log('微信家庭编辑入口检查通过：顶部家庭设置卡、右侧编辑按钮都默认打开名称与封面；默认/自定义缩略图下单次打开、阻断冒泡、显式关闭。');
console.log('微信点餐入口检查通过：三项新增选择、菜品与套餐创建/编辑、删除确认、发现美食；保留选菜、面板互斥，无点击震动。');
