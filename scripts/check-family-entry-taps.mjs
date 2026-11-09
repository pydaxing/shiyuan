import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Vue from 'vue';
import { baseParse } from '@vue/compiler-dom';
import { createSeed } from '../src/data/seed.js';
import { normalizeSnapshot } from '../src/domain/kitchen.js';
import * as nativeShare from '../src/services/native-share.js';
import * as moments from '../src/services/moments.js';
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
const appearanceSource = readFileSync(new URL('components/FamilyEditor.js', root), 'utf8');
const appearanceDependencies = {};
for (const match of appearanceSource.matchAll(/require\("([^\"]+)"\)/g)) {
  if (match[1].startsWith('../domain/')) appearanceDependencies[match[1]] = await import(new URL(match[1].replace('../', '../src/'), import.meta.url));
}
for (const personal of [false, true]) for (const initialTab of ['appearance', 'cover', ...(personal ? [] : ['name']), 'management']) {
  const seed = normalizeSnapshot(createSeed());
  if (personal) seed.family.kind = 'personal';
  const modules = { ...appearanceDependencies, '../common/vendor.js': { ...Vue, onUnmounted() {}, e: Object.assign, t: String, p: item => item, o: item => item, sr() {}, _export_sfc: (component, entries) => Object.assign(component, Object.fromEntries(entries)) }, '../store.js': { state: Vue.ref(seed), cloudMode: true }, '../services/keyboard.js': {}, '../services/mutation-feedback.js': mutationFeedback, '../services/cloud.js': {} };
  let component;
  new Function('require', 'wx', appearanceSource)(name => { assert.ok(modules[name], `unmocked appearance dependency: ${name}`); return modules[name]; }, { createComponent: value => { component = value; } });
  const scope = Vue.effectScope();
  try {
    const render = scope.run(() => component.setup({ initialTab, page: true }, { emit() {} }));
    const data = render({}, []);
    const sheet = appearanceNodes.find(node => node.tag === 'sheet');
    const expectedTitle = { appearance: '封面与名称', cover: personal ? '个人封面' : '家庭封面', name: '家庭名称', management: '我的家庭' }[initialTab];
    const sheetProps = value(data, attribute(sheet, 'u-p'));
    assert.equal(sheetProps.title, expectedTitle, '原生独立编辑页标题必须匹配字段与身份');
    assert.equal(sheetProps.page, true, '从我家进入的编辑页保持全屏返回层级');
    if (initialTab === 'cover') {
      const picker = appearanceNodes.find(node => node.tag === 'inline-photo-editor');
      assert.equal(value(data, attribute(picker, 'u-p')).value, seed.family.cover, '封面独立编辑使用当前封面草稿');
    }
    if (initialTab === 'management') {
      const manager = appearanceNodes.find(node => node.tag === 'family-management');
      assert.equal(value(data, attribute(manager, 'wx:if')), true, '管理入口直接打开家庭管理');
    }
    assert.equal(appearanceNodes.some(node => hasClass(node, 'family-settings-tabs')), false, '不再编译旧综合设置标签栏');
  } finally { scope.stop(); }
}
const managementNodes = elements('components/FamilyManagement.wxml');
for (const nodes of [appearanceNodes, managementNodes]) assert.ok(nodes.every(node => !node.loc.source.includes('菜单副标题')), '家庭编辑与创建均不再展示副标题配置');
const managementStyles = readFileSync(new URL('components/FamilyManagement.wxss', root), 'utf8');
assert.ok(managementNodes.some(node => hasClass(node, 'family-choice-name')), '家庭名称使用明确的原生样式类');
const familyActions = managementNodes.filter(node => node.tag === 'button' && hasClass(node, 'family-choice-action'));
assert.equal(familyActions.length, 1, '管理态每个家庭仅保留退出入口');
for (const action of familyActions) {
  assert.ok(attribute(action, 'catchtap'), '家庭管理按钮阻断冒泡，不触发家庭切换');
  assert.ok(attribute(action, 'aria-label'), '管理按钮保留无障碍名称');
  assert.equal(action.children.some(child => child.type === 1 && child.tag === 'text'), true, '管理态操作使用明确文字标签');
}
assert.match(managementStyles, /\.family-choice-name\b/);
assert.doesNotMatch(managementStyles, />\s*text\b/, '家庭名称不能依赖微信组件不支持的标签选择器');
const navigation = pageNodes.find((node) => hasClass(node, 'nav-item'));
const familyComponents = {};
const familyDependencies = { ...appearanceDependencies };
for (const name of ['FamilyView', 'ProfileEditor', 'FamilyAppearanceDetails', 'FamilyEditor']) {
  const code = readFileSync(new URL(`components/${name}.js`, root), 'utf8');
  familyComponents[name] = { code, nodes: elements(`components/${name}.wxml`) };
  for (const match of code.matchAll(/require\("([^"]+)"\)/g)) {
    if (/^\.\.\/(domain|composables)\//.test(match[1]) && !familyDependencies[match[1]]) {
      familyDependencies[match[1]] = await import(new URL(match[1].replace('../', '../src/'), import.meta.url));
    }
  }
}
const nativeTap = () => ({ type: 'tap', target: { dataset: { eventsync: 'true' } } });
const customEvent = (type, ...args) => ({ type, detail: { __args__: args } });
function nativeFamilyComponent(name, props, environment, emit = () => {}) {
  const instance = { $ei: 0, ctx: { $mpPlatform: 'mp-weixin', $scope: {} } };
  const bind = new Function('getCurrentInstance', 'isString', 'patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', bindingCode + '; return vOn;')(() => instance, item => typeof item === 'string', () => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler);
  const vendor = {
    ...Vue, index: globalThis.uni, onMounted() {}, onUnmounted() {},
    e: Object.assign, f: Vue.renderList, t: String, n: Vue.normalizeClass,
    s: item => item, p: item => item, o: bind, sr() {}, nextTick$1: Vue.nextTick,
    _export_sfc: (component, entries) => Object.assign(component, Object.fromEntries(entries)),
  };
  const modules = {
    ...familyDependencies, '../common/vendor.js': vendor,
    '../store.js': environment.store, '../services/cloud.js': environment.cloud,
    '../services/keyboard.js': environment.keyboard,
    '../services/mutation-feedback.js': mutationFeedback,
  };
  let component;
  new Function('require', 'wx', familyComponents[name].code)(dependency => {
    assert.ok(modules[dependency], `${name}: unmocked dependency ${dependency}`);
    return modules[dependency];
  }, { createComponent: result => { component = result; } });
  const scope = Vue.effectScope();
  const render = scope.run(() => component.setup(props, { emit, expose() {} }));
  const draw = () => {
    instance.$ei = 0;
    return render({ $emit: emit, $feedback: tapFeedback, $image: item => item }, []);
  };
  const dispatch = (node, event, payload = nativeTap()) => {
    assert.ok(node, `${name}: native event owner exists`);
    const expression = attribute(node, event);
    assert.ok(expression, `${name}: ${event} is compiled on the actual event owner`);
    const handler = instance.ctx.$scope[value(draw(), expression)];
    assert.equal(typeof handler, 'function', `${name}: ${event} is bound`);
    return handler(payload);
  };
  return { draw, dispatch, nodes: familyComponents[name].nodes, stop: () => scope.stop() };
}

// FamilyView owns its profile and management pages. ProfileEditor, rather than
// index.vue, owns the cover/name editor opened by FamilyAppearanceDetails.
for (const personal of [false, true]) for (const photo of [false, true]) {
  const seed = normalizeSnapshot(createSeed());
  if (personal) seed.family.kind = 'personal';
  if (photo) seed.family.cover = '/static/tomato.png';
  const state = Vue.ref(seed);
  const member = seed.family.members.find(item => item.id === seed.activeMemberId) || seed.family.members[0];
  const cloudStatus = Vue.ref({ phase: 'ready', busy: false, userId: 'native-entry-user' });
  const cloud = {
    cloudMode: true, cloudStatus, companionDays: Vue.ref(1), familyModePreview: Vue.ref(null), personalModePreview: Vue.ref(null),
    accountProfile: Vue.ref({ name: member.name, avatar: member.avatar || '' }), accountProfilePreview: Vue.ref(null),
    manageFamily() { assert.fail('entry checks must not change a family'); },
    saveAccountProfile() { assert.fail('entry checks must not save a profile'); },
  };
  const confirmations = [];
  const environment = {
    store: { ...cloud, state, activeMember: Vue.computed(() => member), notify() {}, customizeFamily() { assert.fail('entry checks must not save appearance'); } },
    cloud, keyboard: { dismissFocusedKeyboard() {} },
  };
  const originalUni = globalThis.uni;
  globalThis.uni = { setNavigationBarColor() {}, showModal(options) { confirmations.push(options); options.success({ confirm: false }); } };
  const mounted = [];
  const mount = (...args) => { const component = nativeFamilyComponent(...args); mounted.push(component); return component; };
  try {
    const rootEvents = [];
    const family = mount('FamilyView', {}, environment, (...args) => rootEvents.push(args));
    const profileEntry = family.nodes.find(node => hasClass(node, 'account-profile'));
    const profilePanel = family.nodes.find(node => node.tag === 'profile-editor');
    assert.ok(attribute(profileEntry, 'catchtap'), '头像昵称入口的原生点击必须阻断冒泡');
    assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), false);
    family.dispatch(profileEntry, 'catchtap');
    assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), true, '第一次点击头像昵称立即打开资料页');
    assert.equal(value(family.draw(), attribute(profilePanel, 'u-p')).page, true, '资料页保留全屏返回层级');
    assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), true, '开页点击不会在重新渲染后关闭资料页');

    const profile = mount('ProfileEditor', { page: true }, environment, (event, ...args) => {
      if (event === 'close') family.dispatch(profilePanel, 'bindclose', customEvent(event, ...args));
    });
    const profileSheet = profile.nodes.find(node => node.tag === 'sheet');
    assert.equal(value(profile.draw(), attribute(profileSheet, 'u-p')).title, '我的资料');
    const detailOwner = profile.nodes.find(node => node.tag === 'family-appearance-details');
    const fieldPanel = profile.nodes.find(node => node.tag === 'family-editor');
    const details = mount('FamilyAppearanceDetails', { family: state.value.family }, environment, (event, ...args) => {
      assert.equal(event, 'edit');
      profile.dispatch(detailOwner, 'bindedit', customEvent(event, ...args));
    });
    const nameRows = details.nodes.find(node => hasClass(node, 'family-detail-rows'));
    assert.equal(Boolean(value(details.draw(), attribute(nameRows, 'wx:if'))), !personal, '个人模式隐藏家庭名称编辑行');
    for (const field of ['cover', ...(personal ? [] : ['name'])]) {
      const control = details.nodes.find(node => node.tag === 'button' && hasClass(node, field === 'cover' ? 'family-full-cover' : 'family-detail-row'));
      assert.ok(attribute(control, 'catchtap'), `${field}: 分项原生点击必须阻断冒泡`);
      assert.equal(Boolean(value(profile.draw(), attribute(fieldPanel, 'wx:if'))), false);
      details.dispatch(control, 'catchtap');
      assert.equal(Boolean(value(profile.draw(), attribute(fieldPanel, 'wx:if'))), true, `${field}: 在资料页内部首次点击立即打开`);
      const fieldProps = value(profile.draw(), attribute(fieldPanel, 'u-p'));
      assert.equal(fieldProps['initial-tab'], field, `${field}: 原生事件传入正确编辑字段`);
      assert.equal(fieldProps.page, true, `${field}: 子编辑页为全屏页`);
      profile.dispatch(profileSheet, 'bindclose', customEvent('close'));
      assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), true, `${field}: 子页存在时父资料页不会误关闭`);
      assert.equal(Boolean(value(profile.draw(), attribute(fieldPanel, 'wx:if'))), true, `${field}: 打开点击和父层事件不会关掉刚打开的编辑页`);
      const editor = mount('FamilyEditor', { page: true, initialTab: field }, environment, (event, ...args) => {
        if (event === 'close') profile.dispatch(fieldPanel, 'bindclose', customEvent(event, ...args));
      });
      await editor.dispatch(editor.nodes.find(node => node.tag === 'sheet'), 'bindclose', customEvent('close'));
      assert.equal(Boolean(value(profile.draw(), attribute(fieldPanel, 'wx:if'))), false, `${field}: 返回关闭当前编辑子页`);
      assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), true, `${field}: 返回后保留我的资料`);
    }
    if (personal) {
      profile.dispatch(detailOwner, 'bindedit', customEvent('edit', 'name'));
      assert.equal(Boolean(value(profile.draw(), attribute(fieldPanel, 'wx:if'))), false, '个人模式也拒绝遗留的家庭名称编辑事件');
    }
    profile.dispatch(profileSheet, 'bindclose', customEvent('close'));
    assert.equal(Boolean(value(family.draw(), attribute(profilePanel, 'wx:if'))), false, '资料页显式返回恢复我的页面');
    assert.deepEqual(rootEvents, [], '新资料入口不再向 index 页面发送旧 customize 事件');

    const membersEntry = family.nodes.find(node => hasClass(node, 'family-members-entry'));
    assert.ok(attribute(membersEntry, 'catchtap'), '我的家庭入口的原生点击阻断冒泡');
    assert.equal(Boolean(value(family.draw(), attribute(membersEntry, 'wx:if'))), !personal, '仅家庭模式显示我的家庭入口');
    if (!personal) {
      const managementSheet = family.nodes.find(node => node.tag === 'sheet' && node.children.some(child => child.type === 1 && child.tag === 'family-management'));
      const managementOwner = family.nodes.find(node => node.tag === 'family-management');
      assert.equal(Boolean(value(family.draw(), attribute(managementSheet, 'wx:if'))), false);
      family.dispatch(membersEntry, 'catchtap');
      assert.equal(Boolean(value(family.draw(), attribute(managementSheet, 'wx:if'))), true, '我的家庭入口首次点击打开内部管理页');
      const managementProps = value(family.draw(), attribute(managementSheet, 'u-p'));
      assert.equal(managementProps.page, true);
      assert.equal(managementProps.title, '我的家庭');
      assert.equal(Boolean(value(family.draw(), attribute(managementSheet, 'wx:if'))), true, '打开点击不会重新关闭家庭管理页');
      family.dispatch(managementOwner, 'bindbusy', customEvent('busy', true));
      family.dispatch(managementSheet, 'bindclose', customEvent('close'));
      assert.equal(Boolean(value(family.draw(), attribute(managementSheet, 'wx:if'))), true, '家庭操作未完成时返回不会提前关闭管理页');
      family.dispatch(managementOwner, 'bindbusy', customEvent('busy', false));
      family.dispatch(managementSheet, 'bindclose', customEvent('close'));
      assert.equal(Boolean(value(family.draw(), attribute(managementSheet, 'wx:if'))), false, '家庭管理页空闲时正常返回');
    }
    assert.deepEqual(confirmations, [], '只打开和返回未修改的资料不弹放弃修改确认');
  } finally {
    mounted.reverse().forEach(component => component.stop());
    globalThis.uni = originalUni;
  }
}
const dependencies = {};
for (const match of source.matchAll(/require\("([^"]+)"\)/g)) {
  if (/^\.\.\/\.\.\/(domain|composables)\//.test(match[1])) dependencies[match[1]] = await import(new URL(match[1].replace('../../', '../src/'), import.meta.url));
}

// Navigation and menu editing checks are independent of the account entry path.
{
  const instance = { $ei: 0, ctx: { $mpPlatform: 'mp-weixin', $scope: {} } };
  const bind = new Function('getCurrentInstance', 'isString', 'patchMPEvent', 'callWithAsyncErrorHandling', 'patchStopImmediatePropagation', bindingCode + '; return vOn;')(() => instance, item => typeof item === 'string', () => {}, (handler, instance, code, args) => handler(...args), (event, handler) => handler);
  const seed = normalizeSnapshot(createSeed());
  let keyboardDismissals = 0;
  const confirmations = [];
  let timelineShare;
  const vendor = { ...Vue, index: { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }), pageScrollTo() {}, showModal(options) { confirmations.push(options); options.success({ confirm: false }); } }, onMounted() {}, onUnmounted() {}, onShow() {}, onPageScroll() {}, onReachBottom() {}, onResize() {}, onShareAppMessage() {}, onShareTimeline(callback) { timelineShare = callback; }, e: Object.assign, f: Vue.renderList, t: String, n: Vue.normalizeClass, s: item => item, sr() {}, p: item => item, o: bind };
  vendor._export_sfc = (component, entries) => Object.assign(component, Object.fromEntries(entries));
  vendor.nextTick$1 = Vue.nextTick;
  vendor.index.createSelectorQuery = () => ({
    in() { return this; }, select() { return this; }, boundingClientRect() { return this; }, selectViewport() { return this; }, scrollOffset() { return this; },
    exec(callback) { callback([null, { scrollTop: 0 }]); },
  });
  const cloud = { cloudMode: true, cloudStatus: Vue.ref({ phase: 'ready', error: '' }), mutationStatus: Vue.ref({ pending: [], failures: [] }) };
  const modules = { ...dependencies, '../../common/vendor.js': vendor, '../../common/assets.js': {}, '../../store.js': { ...cloud, state: Vue.ref(seed), storageError: Vue.ref('') }, '../../services/cloud.js': cloud, '../../services/feedback.js': { tapFeedback }, '../../services/keyboard.js': { dismissFocusedKeyboard() { keyboardDismissals += 1; } } };
  modules['../../services/native-share.js'] = nativeShare;
  modules['../../services/moments.js'] = moments;
  modules['../../services/account-entry.js'] = { accountEntryStatus: Vue.ref({ phase: 'ready' }) };
  modules['../../services/mutation-feedback.js'] = mutationFeedback;
  modules['../../store.js'].familyFeatures = Vue.computed(() => seed.family.features);
  let page;
  new Function('require', 'wx', source)(name => { assert.ok(modules[name], `unmocked dependency: ${name}`); return modules[name]; }, { createPage: component => { page = component; } });
  const scope = Vue.effectScope();
  const originalUni = globalThis.uni;
  globalThis.uni = vendor.index;
  try {
    const render = scope.run(() => page.setup({}));
    assert.deepEqual(timelineShare(), moments.momentsCard(), '编译后页面保留朋友圈分享回调与公开卡片');
    const draw = () => { instance.$ei = 0; return render({ $feedback: tapFeedback, $image: value => value }, []); };
    const tap = { type: 'tap', target: { dataset: { eventsync: 'true' } } };
    {
      const items = value(draw(), attribute(navigation, 'wx:for'));
      assert.deepEqual(items.map(item => value({ item }, attribute(navigation, 'aria-label'))), ['小灶', '美食', '发现', '我的'], 'the bottom navigation combines menu and reservations in 小灶');
      const navigationItem = label => value(draw(), attribute(navigation, 'wx:for')).find(item => value({ item }, attribute(navigation, 'aria-label')) === label);
      const selectBottom = label => {
        const destination = navigationItem(label);
        assert.ok(destination, `${label}: bottom navigation exists`);
        instance.ctx.$scope[value({ item: destination }, attribute(navigation, 'bindtap'))](tap);
      };
      const mealSection = label => pageNodes.find(node => hasClass(node, 'meal-section-button') && attribute(node, 'aria-label') === label);
      const selectSection = label => {
        const section = mealSection(label);
        assert.ok(section, `${label}: the shared header exposes its section control`);
        instance.ctx.$scope[value(draw(), attribute(section, 'bindtap'))](tap);
        assert.equal(value(draw(), attribute(section, 'aria-selected')), true, `${label}: section selection updates on the same render`);
      };
      selectBottom('小灶');
      const menu = pageNodes.find(node => node.tag === 'home-menu');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, true, 'entering 小灶 opens 菜单 immediately without another section tap');
      assert.equal(value(draw(), attribute(mealSection('菜单'), 'aria-selected')), true);
      assert.ok(pageNodes.some(node => node.tag === 'page-header' && value(draw(), attribute(node, 'u-p'))?.title === ''), 'menu and reservations share the untitled cover header');
      selectSection('安排');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, false, 'reservations pause the menu viewport');
      const reservation = pageNodes.find(node => hasClass(node, 'activity-view'));
      assert.equal(value(draw(), attribute(reservation, 'wx:if')), true, '安排 opens the existing order view');
      assert.equal(value({ item: navigationItem('小灶') }, attribute(navigation, 'aria-pressed')), true, 'reservations keep 小灶 selected in the bottom navigation');
      selectSection('菜单');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, true, 'the top 菜单 control resumes the menu viewport');
      selectSection('安排');
      selectBottom('小灶');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, true, 'tapping 小灶 again defaults back to 菜单');
      selectBottom('发现');
      assert.ok(pageNodes.some(node => node.tag === 'meal-square'), '发现 retains the square component');
      assert.ok(pageNodes.some(node => hasClass(node, 'square-view')), '发现 retains its own page container');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, false, '发现 keeps the menu viewport inactive');
      assert.equal(pageNodes.some(node => node.tag === 'section-page-header'), false, 'kitchen no longer nests a social section tab');
      selectBottom('小灶');
      assert.equal(value(draw(), attribute(menu, 'u-p')).active, true, 'returning home reactivates menu scrolling');

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
      for (const label of ['小灶', '美食']) {
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
console.log('微信家庭编辑入口检查通过：头像昵称打开我的资料，资料内编辑个人/家庭封面与家庭名称，我的家庭独立管理；默认/自定义封面下单次打开、阻断冒泡、逐层返回。');
console.log('微信点餐入口检查通过：三项新增选择、菜品与套餐创建/编辑、删除确认、发现美食；保留选菜、面板互斥，无点击震动。');
