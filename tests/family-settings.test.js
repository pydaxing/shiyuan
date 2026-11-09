import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import * as Vue from 'vue';
import * as familyHelpers from '../src/domain/family.js';
import * as presentation from '../src/domain/presentation.js';
import { NATIVE_UI_COLORS } from '../src/domain/ui-theme.js';
import { coverFrameStyle } from '../src/domain/image-crop.js';
import { emptySnapshot } from '../src/domain/empty.js';
import { createSeed } from '../src/data/seed.js';
import { imageUploadLabel } from '../src/services/images.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const source = name => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');
const editableDefaults = { name: '我们的小家', cover: '', coverTitle: '都是我喜欢的味道！' };
function mount(context, name, overrides = {}, props = {}) {
  const events = [];
  const notices = [];
  const mounted = [];
  const unmounted = [];
  const modals = [];
  const members = [{ id: 'me', name: '我' }, { id: 'other', name: '家人' }];
  const modules = {
    APP_VERSION: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, ...Vue, ...familyHelpers, presentMutation, NATIVE_UI_COLORS, coverFrameStyle, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    state: Vue.ref({ family: { name: '我们的小家', cover: '', coverTitle: '', ownerId: 'me', members }, activeMemberId: 'me' }),
    cloudMode: true, cloudStatus: Vue.ref({ userId: 'me', familyId: 'current' }), preferencePending: Vue.ref(false),
    companionDays: Vue.ref(null), familyModePreview: Vue.ref(null), personalModePreview: Vue.ref(null), useReceivedMealLikes: () => ({ count: Vue.ref(0), mealCount: Vue.ref(0), error: Vue.ref(''), refresh: async () => {} }),
    familyFeatures: Vue.ref({ fridge: false, shopping: false }),
    activeMember: Vue.ref(members[0]), sheetOpen: Vue.ref(false), useNavigationAppearance() {}, dismissFocusedKeyboard() {}, notify: message => notices.push(message), useSheetContentResize: () => () => {},
    ...overrides,
  };
  const previous = globalThis.uni;
  globalThis.uni = { showModal: options => modals.push(options), getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }) };
  context.after(() => { unmounted.forEach(callback => callback()); globalThis.uni = previous; });
  let script = compileScript(parse(source(name)).descriptor, { id: 'family-settings' }).content;
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', script.replace('export default', 'return'))(modules);
  const api = component.setup(props, { expose() {}, emit: (...args) => events.push(args) });
  return { api, events, modals, mounted, unmounted, modules, notices };
}

function renderTemplate(name, api, props, templateContext = {}) {
  const descriptor = parse(source(name)).descriptor;
  const script = compileScript(descriptor, { id: 'family-render' });
  const template = compileTemplate({ id: 'family-render', source: descriptor.template.content, filename: `${name}.vue`, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const code = template.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  const render = new Function('Vue', code)({
    ...Vue,
    resolveComponent: tag => tag,
    renderSlot: (slots, name, slotProps, fallback) => Vue.h(Vue.Fragment, slots[name]?.(slotProps) ?? fallback?.() ?? []),
  });
  return render({ $feedback() {}, $image: value => value, $slots: {}, ...templateContext }, [], props, Vue.proxyRefs(api), {}, {});
}

function renderedNodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(renderedNodes) : [])];
}

function familyNodes(api, context = {}) {
  function descend(node) {
    if (!node || typeof node !== 'object') return [];
    const children = Array.isArray(node.children) ? node.children : [...(node.children?.navigation?.() || []), ...(node.children?.default?.() || []), ...(node.children?.content?.() || [])];
    return [node, ...children.flatMap(descend)];
  }
  return descend(renderTemplate('FamilyView', api, {}, context));
}

test('family management shows current check and reveals protected actions only in management mode', context => {
  const props = { active: true };
  const { api, modules } = mount(context, 'FamilyManagement', {}, props);
  modules.state.value.family.ownerId = 'other';
  api.families.value = [
    { id: 'current', name: '我们的小家', cover: '', memberCount: 2, owner: true, current: true },
    { id: 'parents', name: '爸妈家', cover: 'cloud://parents-cover', memberCount: 3, owner: true, current: false },
    { id: 'friends', name: '朋友家', cover: '', memberCount: 4, owner: false, current: false },
  ];
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const cards = nodes.filter(node => node.props?.class?.split(' ').includes('family-choice-card'));
  assert.equal(cards.length, 3);
  assert.equal(cards.filter(node => node.props.class.includes('active')).length, 1);
  assert.deepEqual(nodes.filter(node => node.props?.class === 'family-choice-name').map(node => node.children), ['我们的小家', '爸妈家', '朋友家']);
  for (const card of cards) {
    const cardNodes = renderedNodes(card);
    assert.ok(cardNodes.find(node => node.props?.class === 'family-choice-cover-frame'));
    const selector = cardNodes.find(node => node.props?.class === 'family-choice-select');
    assert.equal(renderedNodes(selector).filter(node => node.type === 'button').length, 1, 'destructive buttons are siblings, never inside the switch button');
    assert.equal(cardNodes.some(node => node.props?.class === 'family-choice-actions'), false);
  }
  assert.deepEqual(nodes.filter(node => node.type === api.FamilyCoverImage).map(node => [node.props.src, node.props.variant]), [['', 'cover'], ['cloud://parents-cover', 'card'], ['', 'card']]);
  assert.deepEqual(nodes.filter(node => node.props?.class === 'family-choice-select').map(node => node.props['aria-pressed']), [true, false, false]);
  assert.equal(nodes.filter(node => node.props?.class === 'family-choice-check').length, 1);
  const list = nodes.find(node => node.props?.class === 'family-choice-list');
  assert.equal(renderedNodes(list).filter(node => node.props?.class === 'family-add-row').length, 1);
  nodes.find(node => node.props?.class === 'family-manage-toggle').props.onClick();
  const editing = renderedNodes(renderTemplate('FamilyManagement', api, props));
  assert.deepEqual(editing.filter(node => node.props?.['aria-label']?.startsWith('退出「')).map(node => node.props['aria-label']), ['退出「我们的小家」', '退出「爸妈家」', '退出「朋友家」']);
  assert.equal(editing.filter(node => node.props?.class === 'family-choice-check').length, 0);
  assert.equal(editing.some(node => node.props?.class === 'family-add-row'), false);
  assert.ok(editing.filter(node => node.props?.class === 'family-choice-select').every(node => node.props.disabled));
  assert.equal(editing.filter(node => node.props?.class?.includes('is-current-locked')).length, 0);
  assert.doesNotMatch(source('FamilyManagement'), /selectedMember|is-self|member-profile-button/);
});

test('family action icons stop the row tap and retain confirmation without switching households', async context => {
  const calls = [];
  const props = { active: true };
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, props);
  api.families.value = [{ id: 'parents', name: '爸妈家', memberCount: 2, owner: true }];
  api.editingFamilies.value = true;
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const buttons = nodes.filter(node => node.type === 'button' && /^退出「/.test(node.props?.['aria-label'] || ''));
  assert.equal(buttons.length, 2);
  let stopped = 0;
  for (const button of buttons) {
    const pending = button.props.onClick({ stopPropagation() { stopped += 1; } });
    assert.equal(api.busy.value, true);
    assert.match(modals.at(-1).title, /退出|删除/);
    modals.at(-1).success({ confirm: false });
    await pending;
    await Vue.nextTick();
    assert.equal(api.busy.value, false);
  }
  assert.equal(stopped, 2);
  assert.deepEqual(calls, [], 'cancelling removal never switches, exits or deletes a family');
  api.editingFamilies.value = false;
  await api.exitFamily({ id: 'current' });
  assert.equal(modals.length, 2, 'stale actions outside management cannot start an exit');
});

test('family card selection is a no-op for the current family and still uses the existing switch flow', async context => {
  const calls = [];
  const { api } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  await api.selectFamily({ id: 'current' });
  assert.deepEqual(calls, []);
  await api.selectFamily({ id: 'parents' });
  assert.deepEqual(calls, [['switchFamily', { familyId: 'parents' }]]);
});

test('the family member count sits beside its heading in the direct management page', () => {
  const management = source('FamilyManagement');
  assert.match(management, /class="section-line family-members-heading"/);
  assert.match(management, /\.section-line\.family-members-heading\s*\{[^}]*justify-content:\s*flex-start;[^}]*gap:\s*8px;/);
});

test('the family entry directly opens selection, members and creation without a nested management route', context => {
  const { api } = mount(context, 'FamilyView');
  assert.equal(familyNodes(api).some(node => node.type === api.FamilyManagement), false);
  familyNodes(api).find(node => node.props?.['aria-label'] === '查看我的家庭').props.onClick({ stopPropagation() {} });
  assert.equal(familyNodes(api).filter(node => node.type === api.FamilyManagement).length, 1);
  const management = mount(context, 'FamilyManagement', {}, { active: true });
  const nodes = renderedNodes(renderTemplate('FamilyManagement', management.api, { active: true }));
  const sections = nodes.filter(node => ['family-selection-section', 'family-members-section', 'family-create-section'].includes(node.props?.class));
  assert.deepEqual(sections.map(node => node.props.class), ['family-selection-section', 'family-members-section']);
  assert.equal(nodes.filter(node => node.props?.class === 'family-add-row').length, 1);
  assert.equal(nodes.filter(node => node.props?.class === 'member-avatar-image').length, management.modules.state.value.family.members.length);
  assert.equal(nodes.filter(node => node.type === management.api.FamilyInviteCard).length, 1);
  assert.equal(nodes.some(node => node.props?.class?.includes('is-self') || node.props?.class === 'member-profile-button'), false);
});

test('the current household and updated self profile are visible before the remote family list arrives', async context => {
  let finish;
  const { api, modules } = mount(context, 'FamilyManagement', { invokeCloud: () => new Promise(resolve => { finish = resolve; }) }, { active: true });
  const pending = api.load();
  assert.equal(api.loading.value, true);
  assert.deepEqual(api.familyChoices.value.map(family => family.id), ['current']);
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, { active: true }));
  assert.equal(nodes.find(node => node.props?.class === 'family-choice-name').children, '我们的小家');
  for (const node of nodes.filter(node => node.type === 'button')) assert.equal(Boolean(node.props?.disabled), false, 'background refresh must not disable existing actions');
  assert.equal(nodes.some(node => node.props?.class === 'family-loading-label'), false);
  api.create();
  assert.equal(api.creating.value, true, 'creation form opens before the background list returns');
  api.back();
  modules.activeMember.value = { id: 'me', name: '刚保存的昵称', avatar: 'cloud://updated-avatar' };
  assert.equal(api.displayedMembers.value[0].name, '刚保存的昵称');
  assert.equal(api.displayedMembers.value[0].avatar, 'cloud://updated-avatar');
  finish({ families: [{ id: 'parents', name: '爸妈家', memberCount: 2 }] });
  await pending;
  assert.deepEqual(api.familyChoices.value.map(family => family.id), ['current', 'parents']);
  modules.state.value.family.kind = 'personal';
  modules.cloudStatus.value.familyId = 'personal';
  assert.deepEqual(api.familyChoices.value.map(family => family.id), ['parents']);
  assert.equal(renderedNodes(renderTemplate('FamilyManagement', api, { active: true })).some(node => node.props?.class === 'family-members-section'), false);
});

test('my home page responds to personal and family modes without remounting the view', context => {
  const { api, modules } = mount(context, 'FamilyView');
  const title = () => familyNodes(api).find(node => node.type === api.PageHeader).props.title;
  assert.equal(title(), '');
  modules.state.value.family.kind = 'personal';
  assert.equal(title(), '');
  assert.equal(familyNodes(api).some(node => node.props?.['aria-label'] === '编辑菜单外观'), false);
  modules.state.value.family.kind = undefined;
  assert.equal(title(), '');
});

for (const failure of ['write', 'reload']) {
  test(`a non-current family card is removed only after a successful exit when ${failure} fails`, async context => {
    const { api, modals, events } = mount(context, 'FamilyManagement', {
      manageFamily: async () => { if (failure === 'write') throw new Error('退出失败，请重试'); },
      invokeCloud: async () => { throw new Error('列表读取失败，请重试'); },
    });
    api.families.value = [{ id: 'current', name: '我们的小家', memberCount: 2, owner: true }, { id: 'parents', name: '爸妈家', memberCount: 3, owner: false }];
    const pending = api.leave(api.families.value[1]);
    modals[0].success({ confirm: true });
    await pending;
    assert.deepEqual(api.families.value.map(family => family.id), failure === 'write' ? ['current', 'parents'] : ['current']);
    assert.match(api.error.value, /失败，请重试/);
    assert.equal(api.busy.value, false);
    assert.equal(events.some(([name]) => name === 'changed'), false);
  });
}

test('family defaults are shared by new families, local previews and the reset form without storing the packaged image', () => {
  const defaults = familyHelpers.FAMILY_APPEARANCE_DEFAULTS;
  assert.deepEqual(defaults, { name: '我们的小家', cover: '', coverTitle: '都是我喜欢的味道！', coverSubtitle: '一日三餐四季，都要好好吃饭' });
  assert.equal(Object.isFrozen(defaults), true);
  for (const family of [emptySnapshot().family, createSeed().family, familyHelpers.familyAppearance()]) {
    assert.equal(family.name, defaults.name);
    assert.equal(family.cover, defaults.cover);
    assert.equal(family.coverTitle, defaults.coverTitle);
    assert.equal(family.coverSubtitle, defaults.coverSubtitle);
    assert.notEqual(family.cover, familyHelpers.DEFAULT_FAMILY_COVER);
  }
});

test('family backgrounds are usable without uploading while custom covers keep their original image loader', context => {
  const props = Vue.reactive({ src: '', variant: 'detail' });
  const { api } = mount(context, 'FamilyCoverImage', {}, props);
  const defaults = renderedNodes(renderTemplate('FamilyCoverImage', api, props));
  assert.ok(defaults.some(node => node.type === 'image' && node.props?.src === familyHelpers.DEFAULT_FAMILY_COVER && node.props?.mode === 'aspectFill'));
  props.src = 'cloud://saved-family-cover';
  const custom = renderedNodes(renderTemplate('FamilyCoverImage', api, props));
  assert.equal(custom.some(node => node.props?.src === familyHelpers.DEFAULT_FAMILY_COVER), false);
  assert.ok(custom.some(node => node.props?.src === props.src && node.props?.variant === 'detail' && node.props?.mode === 'aspectFill'));
});

test('empty recipe covers render a decorative local background without selecting an image', context => {
  const props = Vue.reactive({ modelValue: '', fallback: '', label: '拍照/相册', frame: 'recipe', emptyCover: true, compact: false, disabled: false });
  const { api, events } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
  const nodes = renderedNodes(renderTemplate('ImagePicker', api, props));
  const background = nodes.find(node => node.props?.class === 'upload-preview upload-placeholder');
  const button = nodes.find(node => node.props?.['aria-label'] === props.label);
  assert.equal(background.props.src, '/static/cover-upload-background.jpg');
  assert.equal(background.props['aria-hidden'], 'true');
  assert.equal(background.props.mode, 'aspectFill');
  assert.equal(button.props.style.paddingTop, coverFrameStyle('recipe').paddingTop);
  assert.equal(button.props.class.includes('filled'), false);
  assert.equal(button.props.disabled, false);
  assert.equal(nodes.some(node => node.props?.class === 'image-picker-actions'), false);
  assert.equal(props.modelValue, '');
  assert.deepEqual(events, []);
});

test('real, fallback and uploading covers replace the decoration while family and compact pickers keep their own backgrounds', context => {
  const props = Vue.reactive({ modelValue: '', fallback: '', label: '拍照/相册', frame: 'recipe', emptyCover: true, compact: false });
  const { api } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
  const hasBackground = () => renderedNodes(renderTemplate('ImagePicker', api, props)).some(node => node.props?.class === 'upload-preview upload-placeholder');
  for (const [key, value] of [['modelValue', 'cloud://photo'], ['fallback', '/static/tofu.png'], ['frame', 'family'], ['compact', true], ['emptyCover', false]]) {
    const previous = props[key];
    props[key] = value;
    assert.equal(hasBackground(), false, key);
    props[key] = previous;
    assert.equal(hasBackground(), true, key);
  }
  api.preview.value = 'blob:upload-in-progress';
  const nodes = renderedNodes(renderTemplate('ImagePicker', api, props));
  assert.equal(hasBackground(), false);
  assert.equal(nodes.find(node => node.props?.['aria-label'] === props.label).props.class.includes('filled'), true);
  api.preview.value = '';
  assert.equal(hasBackground(), true);
});

test('decoration stays out of upload results after cancel, failure, success and external reset', async context => {
  const props = Vue.reactive({ modelValue: '', fallback: '', label: '拍照/相册', frame: 'recipe', emptyCover: true, compact: false, disabled: false });
  let selection = 'cancel';
  const { api, events } = mount(context, 'ImagePicker', {
    coverFrameStyle, releaseCropFile() {},
    async chooseLocalImage(sources) {
      assert.deepEqual(sources, ['album', 'camera']);
      if (selection === 'fail') throw new Error('上传失败，请重试');
      return selection === 'success' ? 'cloud://uploaded-cover' : '';
    },
  }, props);
  await api.choose();
  selection = 'fail';
  await api.choose();
  assert.equal(api.error.value, '上传失败，请重试');
  assert.equal(events.some(event => event[0] === 'update:modelValue'), false);
  assert.equal(props.modelValue, '');
  assert.equal(api.busy.value, false);
  selection = 'success';
  await api.choose();
  assert.deepEqual(events.filter(event => event[0] === 'update:modelValue'), [['update:modelValue', 'cloud://uploaded-cover']]);
  props.modelValue = 'cloud://uploaded-cover';
  props.modelValue = '';
  assert.deepEqual(events.filter(event => event[0] === 'update:modelValue'), [['update:modelValue', 'cloud://uploaded-cover']]);
  assert.ok(renderedNodes(renderTemplate('ImagePicker', api, props)).some(node => node.props?.class === 'upload-preview upload-placeholder'));
});

test('recipe and set editors use their own default cover without changing their saved image fields', () => {
  for (const [name, fallback] of [['RecipeEditor', 'DEFAULT_DISH_COVER'], ['SetEditor', 'DEFAULT_SET_COVER']]) {
    const editor = source(name);
    assert.ok(editor.includes(`<ImagePicker v-model="image" :fallback="${fallback}" label="拍照/相册"`));
    assert.match(editor, /const image = ref\(props\.[^;]+\?\.image \|\| ''\);/);
    assert.match(editor, /image: image\.value/);
    assert.doesNotMatch(editor, /cover-upload-background/);
  }
});

test('selected food defaults stay visible without selecting or uploading an image and return after external reset', context => {
  for (const fallback of [presentation.DEFAULT_DISH_COVER, presentation.DEFAULT_SET_COVER]) {
    const props = Vue.reactive({ modelValue: '', fallback, frame: 'recipe', label: '拍照/相册' });
    const { api, events } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
    const nodes = () => renderedNodes(renderTemplate('ImagePicker', api, props));
    assert.ok(nodes().some(node => node.props?.src === fallback && node.props?.variant === 'detail'));
    assert.equal(nodes().some(node => node.props?.class === 'image-picker-actions'), false);
    assert.deepEqual(events, []);
    props.modelValue = 'cloud://saved-photo';
    assert.ok(nodes().some(node => node.props?.src === props.modelValue));
    assert.equal(nodes().some(node => node.props?.src === fallback), false);
    props.modelValue = '';
    assert.deepEqual(events, []);
    assert.ok(nodes().some(node => node.props?.src === fallback));
  }
});

test('food thumbnails and detail previews fill their frames for defaults and custom photos', context => {
  for (const name of ['FoodThumbnail', 'RecipeCover']) {
    for (const kind of ['dish', 'set', 'menu']) {
      const previews = [];
      const props = Vue.reactive({ image: '', src: '', kind, title: '测试菜品' });
      const { api } = mount(context, name, { ...presentation, coverFrameStyle, previewImages: (...args) => previews.push(args) }, props);
      const nodes = () => renderedNodes(renderTemplate(name, api, props));
      const fallback = presentation.foodCover('', kind);
      assert.ok(nodes().some(node => node.props?.src === fallback && node.props?.mode === 'aspectFill'));
      if (name === 'RecipeCover') {
        nodes().find(node => node.props?.onClick).props.onClick();
        assert.deepEqual(previews[0], [[fallback], fallback]);
      }
      props.image = props.src = 'cloud://saved-photo';
      assert.ok(nodes().some(node => node.props?.src === 'cloud://saved-photo' && node.props?.mode === 'aspectFill'));
      assert.equal(nodes().some(node => node.props?.src === fallback), false);
      if (name === 'RecipeCover') {
        nodes().find(node => node.props?.onClick).props.onClick();
        assert.deepEqual(previews[1], [['cloud://saved-photo'], 'cloud://saved-photo']);
      }
    }
  }
});

test('family covers keep only one accessible photo selection button, without separate deletion', context => {
  const props = Vue.reactive({ modelValue: 'cloud://family-cover', label: '选择家庭照片', frame: 'family', compact: false, disabled: false, fallback: '' });
  const { api } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
  const nodes = renderedNodes(renderTemplate('ImagePicker', api, props));
  const buttons = nodes.filter(node => node.type === 'button');
  assert.deepEqual(buttons.map(button => button.props['aria-label']), ['选择家庭照片']);
  const frame = nodes.find(node => node.props?.class === 'image-picker-frame');
  assert.ok(frame.children.includes(buttons[0]));
  assert.equal(buttons[0].props.style.paddingTop, coverFrameStyle('family').paddingTop);
  assert.equal(nodes.some(node => node.props?.class === 'image-picker-actions'), false);
  assert.equal(buttons[0].props.disabled, false);
  props.modelValue = '';
  assert.deepEqual(renderedNodes(renderTemplate('ImagePicker', api, props)).filter(node => node.type === 'button').map(button => button.props['aria-label']), ['选择家庭照片']);
});

test('cover selection is blocked during upload or save without exposing adjustment or removal buttons', async context => {
  const props = Vue.reactive({ modelValue: 'cloud://recipe-cover', label: '选择菜品封面', frame: 'recipe', compact: false, disabled: false, fallback: '' });
  let selections = 0;
  const { api, events } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {}, chooseLocalImage() { selections += 1; } }, props);
  const selectionButton = () => renderedNodes(renderTemplate('ImagePicker', api, props)).find(node => node.props?.['aria-label'] === props.label);
  for (const lock of ['upload', 'save']) {
    api.busy.value = lock === 'upload';
    props.disabled = lock === 'save';
    assert.equal(selectionButton().props.disabled, true);
    await selectionButton().props.onClick();
    assert.deepEqual(events, []);
  }
  api.busy.value = false; props.disabled = false;
  api.error.value = '上次上传失败';
  await selectionButton().props.onClick();
  assert.deepEqual(events, [['busy', true], ['busy', false]]);
  assert.equal(props.modelValue, 'cloud://recipe-cover');
  assert.equal(api.error.value, '');
  assert.equal(selections, 1);
  assert.equal(renderedNodes(renderTemplate('ImagePicker', api, props)).filter(node => node.type === 'button').length, 1);
  assert.equal(api.remove, undefined);
});

test('recipe, set and compact pickers keep only their photo-selection button', context => {
  const props = Vue.reactive({ modelValue: 'cloud://recipe-cover', label: '选择套餐封面', frame: 'recipe', compact: false, disabled: false, fallback: '' });
  const { api } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
  for (const variant of [{ frame: 'recipe', compact: false }, { frame: 'family', compact: true }]) {
    Object.assign(props, variant);
    const nodes = renderedNodes(renderTemplate('ImagePicker', api, props));
    assert.equal(api.familyCover.value, false);
    assert.equal(nodes.some(node => node.props?.class === 'image-picker-actions'), false);
    assert.deepEqual(nodes.filter(node => node.type === 'button').map(button => button.props['aria-label']), ['选择套餐封面']);
    assert.equal(nodes.some(node => node.props?.class === 'family-cover-remove'), false);
  }
});

test('all cover sizes render progress inside the image frame instead of below it', context => {
  for (const variant of [{ frame: 'family', compact: false }, { frame: 'recipe', compact: false }, { frame: 'recipe', compact: true }]) {
    const props = Vue.reactive({ ...variant, modelValue: 'cloud://cover', label: '拍照/相册', disabled: false });
    const { api } = mount(context, 'ImagePicker', { coverFrameStyle, releaseCropFile() {} }, props);
    api.busy.value = true;
    api.progress.value = '46%';
    const nodes = renderedNodes(renderTemplate('ImagePicker', api, props));
    const frame = nodes.find(node => node.props?.class === 'image-picker-frame');
    const overlay = nodes.find(node => node.props?.value === '46%');
    const button = nodes.find(node => node.type === 'button');
    assert.ok(frame.children.includes(overlay));
    assert.equal(overlay.props.compact, variant.compact);
    assert.equal(button.props.disabled, true);
    assert.equal(renderedNodes(button).includes(overlay), false);
    assert.equal(nodes.some(node => node.props?.class === 'upload-caption'), false);
    assert.equal(nodes.some(node => node.props?.class === 'photo-count'), false);
    api.busy.value = false;
    const settled = renderedNodes(renderTemplate('ImagePicker', api, props));
    assert.equal(settled.some(node => node.props?.value === '46%'), false);
    assert.ok(settled.some(node => node.props?.class === 'upload-caption'));
  }
});

test('percentage overlays expose accessible numeric progress without visible status prose', context => {
  for (const compact of [false, true]) {
    const props = { value: '46%', compact };
    const { api } = mount(context, 'ImageUploadProgress', {}, props);
    const nodes = renderedNodes(renderTemplate('ImageUploadProgress', api, props));
    const overlay = nodes.find(node => node.props?.role === 'progressbar');
    assert.equal(overlay.props['aria-valuenow'], 46);
    assert.equal(overlay.props['aria-valuemin'], '0');
    assert.equal(overlay.props['aria-valuemax'], '100');
    assert.equal(overlay.props.class.includes('is-compact'), compact);
    assert.deepEqual(nodes.filter(node => node.type === 'text').map(node => node.children), ['46%']);
  }
});

test('step upload tiles use the same grid and center a percentage on each image', context => {
  const props = { modelValue: ['cloud://saved-step'], label: '步骤1图片' };
  const { api } = mount(context, 'StepImagePicker', { imageUploadLabel }, props);
  api.entries.value = [
    { path: 'uploading.jpg', preview: 'small-upload.jpg', status: 'uploading', stage: 'uploading', progress: 42 },
    { path: 'saving.jpg', status: 'uploading', stage: 'saving' },
    { path: 'finished.jpg', status: 'uploading', stage: 'done' },
    { path: 'failed.jpg', status: 'failed' },
  ];
  const nodes = renderedNodes(renderTemplate('StepImagePicker', api, props));
  const grid = nodes.find(node => node.props?.class === 'step-photo-grid');
  const pending = renderedNodes(grid).filter(node => node.props?.class === 'step-photo-tile photo-processing-tile');
  assert.equal(pending.length, 4);
  assert.equal(pending[0].children[0].props.src, 'small-upload.jpg');
  const percentages = pending.flatMap(renderedNodes).filter(node => node.props?.value);
  assert.deepEqual(percentages.map(node => node.props.value), ['42%', '99%', '100%']);
  assert.ok(percentages.every(node => node.props.compact === ''));
  assert.equal(nodes.some(node => node.props?.class === 'photo-count'), false);
});

test('avatar uploads center their percentage inside the portrait while hiding the camera badge', context => {
  const props = { name: '家人', avatar: '' };
  const { api } = mount(context, 'ProfileFields', {}, props);
  api.uploading.value = true;
  api.pendingPreview.value = 'camera-avatar.jpg';
  api.progress.value = '58%';
  const nodes = renderedNodes(renderTemplate('ProfileFields', api, props));
  const frame = nodes.find(node => node.props?.class === 'profile-avatar-frame');
  const overlay = nodes.find(node => node.props?.value === '58%');
  assert.ok(frame.children.includes(overlay));
  assert.equal(overlay.props.compact, '');
  assert.ok(renderedNodes(frame).some(node => node.type === 'image' && node.props.src === 'camera-avatar.jpg'));
  assert.equal(nodes.some(node => node.props?.class === 'profile-avatar-camera'), false);
});

test('family photo selection still uses the shared crop flow and preserves the cover on cancellation or failure', async context => {
  const props = Vue.reactive({ modelValue: 'cloud://family-cover', label: '选择家庭照片', frame: 'family', compact: false, disabled: false, fallback: '' });
  let fail = false;
  let selections = 0;
  const { api, events } = mount(context, 'ImagePicker', {
    coverFrameStyle, releaseCropFile() {}, chooseLocalImage: async (sources, update, crop) => {
      selections += 1;
      assert.deepEqual(sources, ['album', 'camera']);
      assert.equal(typeof update, 'function');
      assert.equal(typeof crop, 'function');
      if (fail) throw new Error('图片上传失败，请重试');
      return '';
    },
  }, props);
  const chooseButton = () => renderedNodes(renderTemplate('ImagePicker', api, props)).find(node => node.props?.['aria-label'] === '选择家庭照片');
  await chooseButton().props.onClick();
  assert.equal(api.busy.value, false);
  assert.equal(api.error.value, '');
  fail = true;
  await chooseButton().props.onClick();
  assert.equal(api.error.value, '图片上传失败，请重试');
  assert.equal(api.busy.value, false);
  assert.deepEqual(events, [['busy', true], ['busy', false], ['busy', true], ['busy', false]]);
  props.disabled = true;
  assert.equal(chooseButton().props.disabled, true);
  await chooseButton().props.onClick();
  assert.equal(selections, 2);
  assert.equal(props.modelValue, 'cloud://family-cover');
});

test('household name edits confirm discard and retry without overwriting saved legacy menu copy', async context => {
  const family = { name: '我们的小家', cover: '', coverTitle: '我家的拿手菜', coverSubtitle: '一起认真吃饭' };
  const savedState = Vue.ref({ family: { ...family } });
  const calls = [];
  let fail = true;
  const { api, modals, events } = mount(context, 'FamilyEditor', {
    state: savedState,
    customizeFamily: async value => {
      calls.push(value);
      if (fail) throw new Error('保存失败，请重试');
      savedState.value.family = { ...savedState.value.family, ...value };
    },
  });
  api.openEditor('name');
  api.name.value = '  三餐有家人陪伴  ';
  assert.equal(api.dirty.value, true);
  const closing = api.close();
  modals[0].success({ confirm: false });
  await closing;
  assert.deepEqual(events, []);
  assert.deepEqual(savedState.value.family, family);
  await api.save();
  assert.equal(api.error.value, '保存失败，请重试');
  assert.equal(api.name.value, '  三餐有家人陪伴  ');
  assert.deepEqual(savedState.value.family, family);
  fail = false;
  await api.save();
  assert.deepEqual(events, []);
  assert.equal(api.section.value, '');
  assert.equal(savedState.value.family.name, '三餐有家人陪伴');
  assert.equal(savedState.value.family.coverTitle, family.coverTitle);
  assert.equal(savedState.value.family.coverSubtitle, family.coverSubtitle);
  assert.ok(calls.every(value => !Object.hasOwn(value, 'coverSubtitle')));
  const reopened = mount(context, 'FamilyEditor', { state: savedState });
  assert.equal(reopened.api.name.value, '三餐有家人陪伴');
  assert.equal(reopened.api.coverTitle, undefined);
  assert.equal(reopened.api.coverSubtitle, undefined);
  assert.equal(reopened.api.dirty.value, false);
});

test('missing and whitespace menu lines use the shared defaults while custom copy is trimmed', () => {
  for (const coverTitle of [undefined, null, '', '  \n  ']) {
    assert.equal(familyHelpers.familyAppearance({ coverTitle }).coverTitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
    assert.equal(familyHelpers.familyAppearance({ coverSubtitle: coverTitle }).coverSubtitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverSubtitle);
  }
  assert.equal(familyHelpers.familyAppearance({ coverTitle: '  周末一起做饭  ' }).coverTitle, '周末一起做饭');
  assert.equal(familyHelpers.familyAppearance({ coverSubtitle: '  吃饱了才有力气  ' }).coverSubtitle, '吃饱了才有力气');
});

test('family mode switch sends a scoped request, prevents duplicate taps and retains help', async context => {
  const requests = []; let finish;
  const { api, modules, notices } = mount(context, 'FamilyView', { manageFamily: (...args) => { requests.push(args); return new Promise(resolve => { finish = resolve; }); } });
  modules.state.value.family.id = 'family-one';
  assert.equal(familyNodes(api).some(node => node.props?.role === 'switch'), true);
  assert.equal(api.settingsOpen, undefined);
  const control = () => familyNodes(api).find(node => node.props?.role === 'switch');
  const identity = () => familyNodes(api).find(node => node.props?.class?.includes('account-identity-symbol')).props['aria-label'];
  assert.equal(control().props['aria-label'], '家庭模式');
  assert.equal(control().props['aria-checked'], true);
  assert.equal(identity(), '家庭');
  const pending = api.toggleMode(); await api.toggleMode();
  assert.deepEqual(requests, [['switchWorkspace', { mode: 'personal', expectedSpaceId: 'family-one' }]]);
  assert.equal(control().props.disabled, true);
  assert.equal(familyNodes(api).find(node => node.props?.role === 'status')?.children, '关闭中...');
  assert.equal(identity(), '个人', 'identity and switch respond before the cloud request completes');
  assert.equal(familyNodes(api).some(node => node.props?.class === 'account-family-name'), false);
  assert.deepEqual(notices, ['关闭中...'], 'announce the requested mode immediately');
  finish(); await pending;
  assert.deepEqual(notices, ['关闭中...', '已关闭家庭模式']);
  assert.equal(familyNodes(api).some(node => node.props?.role === 'status'), false);
  assert.equal(control().props.disabled, undefined);
  assert.equal(modules.state.value.family.id, 'family-one', 'view never deletes or edits household membership locally');
  modules.state.value.family = { ...modules.state.value.family, id: 'personal-one', kind: 'personal' };
  const enabling = api.toggleMode(); await api.toggleMode();
  assert.deepEqual(requests.at(-1), ['switchWorkspace', { mode: 'family', expectedSpaceId: 'personal-one' }]);
  assert.deepEqual(notices, ['关闭中...', '已关闭家庭模式', '开启中...']);
  modules.state.value.family = { ...modules.state.value.family, id: 'family-one', kind: 'family' };
  finish(); await enabling;
  assert.deepEqual(notices, ['关闭中...', '已关闭家庭模式', '开启中...', '已开启家庭模式'], 'notice uses the requested mode even after the cloud snapshot changes');
  familyNodes(api).find(node => node.props?.class === 'account-row family-help-entry').props.onClick({ stopPropagation() {} });
  assert.equal(api.about.value, true);
});

test('ordinary onboarding has no family choice and starts a personal workspace', async context => {
  const calls = [];
  const { api } = mount(context, 'CloudConnection', { accountProfile: Vue.ref({ name: '小厨师', avatar: 'cloud://avatar' }), cloudStatus: Vue.ref({ phase: 'onboarding' }), manageFamily: async (...args) => calls.push(args) });
  assert.equal(api.name.value, '小厨师');
  assert.equal(api.consent.value, false);
  assert.equal(api.mode, undefined);
  assert.doesNotMatch(source('CloudConnection'), /onboarding-modes|createFamily|家庭名称/);
  api.consent.value = true;
  await api.enter();
  assert.deepEqual(calls, [['updateProfile', { name: '小厨师', avatar: 'cloud://avatar' }], ['switchWorkspace', { mode: 'personal', expectedSpaceId: '' }]]);
});

test('onboarding receives late profile defaults but never overwrites an edited nickname or avatar', async context => {
  const profile = Vue.ref({ name: '', avatar: '' });
  const { api } = mount(context, 'CloudConnection', { accountProfile: profile, cloudStatus: Vue.ref({ phase: 'connecting' }) });
  profile.value = { name: '一口小饭团', avatar: '/static/default-avatars/food-01.png' };
  await Vue.nextTick();
  assert.equal(api.name.value, profile.value.name);
  assert.equal(api.avatar.value, profile.value.avatar);
  api.name.value = '自己填写'; api.avatar.value = 'cloud://picked';
  profile.value = { name: '后台新昵称', avatar: '/static/default-avatars/food-02.png' };
  await Vue.nextTick();
  assert.equal(api.name.value, '自己填写'); assert.equal(api.avatar.value, 'cloud://picked');
});

test('personal onboarding guards consent, upload, duplicate submission and profile failure', async context => {
  const calls = [];
  let finish;
  const { api } = mount(context, 'CloudConnection', { accountProfile: Vue.ref({ name: '我', avatar: '' }), manageFamily: (...args) => { calls.push(args); return args[0] === 'updateProfile' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(); } });
  await api.enter();
  assert.equal(calls.length, 0);
  assert.equal(api.fieldErrors.value.consent, '请先阅读并同意隐私协议');
  api.consent.value = true;
  api.uploading.value = true;
  await api.enter();
  assert.equal(calls.length, 0);
  api.uploading.value = false;
  const pending = api.enter();
  await api.enter();
  assert.equal(calls.length, 1);
  finish(); await pending;
  assert.deepEqual(calls.map(call => call[0]), ['updateProfile', 'switchWorkspace']);
  assert.equal(api.busy.value, false);
  const failed = mount(context, 'CloudConnection', { accountProfile: Vue.ref({ name: '我', avatar: '' }), manageFamily: async action => { assert.equal(action, 'updateProfile'); throw new Error('网络不可用'); } }).api;
  failed.consent.value = true;
  await failed.enter();
  assert.equal(failed.error.value, '网络不可用');
  assert.equal(failed.busy.value, false);
  assert.equal(failed.name.value, '我');
});

test('compiled management template follows the active prop across repeated tab roundtrips', context => {
  const props = Vue.reactive({ active: true });
  const { api } = mount(context, 'FamilyManagement', {}, props);
  api.families.value = [{ id: 'current', name: '我们的小家', current: true, memberCount: 2 }];
  for (let round = 0; round < 3; round += 1) {
    props.active = true;
    assert.equal(renderTemplate('FamilyManagement', api, props).props.class, 'family-management-panel');
    props.active = false;
    assert.equal(renderTemplate('FamilyManagement', api, props).type, Vue.Comment, 'inactive panel must remove its entire native subtree');
    assert.equal(api.families.value.length, 1);
  }
});

test('profile editing is launched from the unified account entry and member cards have no duplicate editor', context => {
  const { api } = mount(context, 'FamilyView');
  assert.equal(api.editingProfile.value, false);
  api.editProfile();
  assert.equal(api.editingProfile.value, true);
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(parse(source('FamilyView')).descriptor.template.content).children.forEach(walk);
  const attribute = (node, name) => node.props.find(prop => prop.name === name);
  const profile = nodes.find(node => attribute(node, 'class')?.value?.content === 'account-profile');
  assert.equal(attribute(profile, 'aria-label').value.content, '编辑我的资料与封面');
  assert.ok(attribute(profile, 'on').modifiers.includes('stop'));
  assert.doesNotMatch(source('FamilyView'), /dataOpen|resetDemo|switchMember|member-profile-button|FamilyAppearanceDetails/);
  assert.doesNotMatch(source('FamilyManagement'), /member-profile-button|ProfileEditor/);
  assert.match(source('FamilyView'), /<ProfileEditor v-if="editingProfile"/);
});

test('entering creation resets synchronously before a new input can acquire focus', async context => {
  const { api, events } = mount(context, 'FamilyManagement');
  api.create();
  assert.deepEqual(events, [['section-change']]);
  api.familyName.value = '开始输入';
  await Vue.nextTick();
  assert.deepEqual(events, [['section-change']]);
});

test('new family asks only for cover and name while retaining a compatible hidden menu default', context => {
  const props = { active: true };
  const { api } = mount(context, 'FamilyManagement', {}, props);
  api.create();
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const fields = nodes.find(node => node.type === api.FamilyCreationFields);
  assert.equal(fields.props.name, '');
  assert.equal(fields.props.cover, '');
  assert.match(fields.props['request-id'], /^create-family-/);
  assert.equal(api.coverTitle.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.coverSubtitle, undefined);
  assert.equal(nodes.some(node => node.props?.class === 'family-management-heading'), false);
  assert.equal(api.canCreate.value, true);
  assert.doesNotMatch(source('FamilyManagement'), /family-avatar-picker|FAMILY_AVATARS|每个家庭有独立的菜单/);
});

test('family cover uploads lock creation and navigation without discarding entered content', async context => {
  const calls = [];
  const props = { active: true };
  const { api, events } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, props);
  api.create();
  api.familyName.value = '周末小家';
  api.coverTitle.value = '三餐四季';
  api.imageBusy(true);
  assert.equal(api.locked.value, true);
  assert.deepEqual(events.at(-1), ['busy', true]);
  api.back();
  api.create();
  await api.submitCreation();
  assert.equal(api.creating.value, true);
  assert.equal(api.familyName.value, '周末小家');
  assert.equal(api.coverTitle.value, '三餐四季');
  assert.equal(calls.length, 0);
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  assert.ok(nodes.filter(node => node.type === api.FormField).every(node => node.props.disabled));
  api.imageBusy(false);
  assert.equal(api.locked.value, false);
  assert.deepEqual(events.at(-1), ['busy', false]);
});

test('family creation saves the selected cover and menu title with a stable retry request', async context => {
  const calls = [];
  let failing = true;
  const { api, events } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => { calls.push(args); if (failing) throw new Error('网络暂不可用'); } }, { active: true });
  api.create();
  await api.submitCreation();
  assert.equal(calls.length, 0);
  api.familyName.value = ' 周末小家 ';
  api.cover.value = 'cloud://family-cover-draft';
  api.coverTitle.value = ' 一起吃饭 ';
  await api.submitCreation();
  assert.equal(api.error.value, '网络暂不可用');
  assert.equal(api.cover.value, 'cloud://family-cover-draft');
  assert.equal(api.busy.value, false);
  assert.equal(events.some(([name]) => name === 'changed'), false);
  failing = false;
  await api.submitCreation();
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0][1], { familyName: '周末小家', cover: 'cloud://family-cover-draft', coverTitle: '一起吃饭', requestId: calls[0][1].requestId });
  assert.equal(calls[0][0], 'createFamily');
  assert.equal(events.filter(([name]) => name === 'changed').length, 1);
  api.back();
  api.create();
  assert.equal(api.familyName.value, '');
  assert.equal(api.cover.value, '');
  assert.equal(api.coverTitle.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.coverSubtitle, undefined);
  api.familyName.value = '另一个家';
  await api.submitCreation();
  assert.notEqual(calls[2][1].requestId, calls[0][1].requestId);
  assert.equal(calls[2][1].cover, '');
  assert.equal(calls[2][1].coverTitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(Object.hasOwn(calls[2][1], 'coverSubtitle'), false);
});

test('family section navigation cannot schedule a hideKeyboard after a new field focuses', async context => {
  const operations = [];
  const { api } = mount(context, 'FamilyEditor', { dismissFocusedKeyboard: () => operations.push('dismiss-old') });
  api.sheet.value = { resetScroll: () => operations.push('reset') };
  api.resetScroll();
  operations.push('focus-delete');
  await Vue.nextTick();
  assert.deepEqual(operations, ['dismiss-old', 'reset', 'focus-delete']);
});

test('failed appearance save preserves edits and shows an error without closing', async context => {
  const { api, events } = mount(context, 'FamilyEditor', { customizeFamily: async () => { throw new Error('网络暂时不可用'); } });
  api.openEditor('name');
  api.name.value = '保留我的修改';
  await api.save();
  assert.equal(api.name.value, '保留我的修改');
  assert.equal(api.error.value, '网络暂时不可用');
  assert.equal(api.locked.value, false);
  assert.deepEqual(events, []);
});

test('switching families honours discard cancellation and locks controls until the operation finishes', async context => {
  const calls = [];
  let allow = false;
  const { api, events } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, { beforeChange: async () => allow });
  await api.perform('switchFamily', { familyId: 'second' });
  assert.equal(calls.length, 0);
  assert.deepEqual(events, [['busy', true], ['busy', false]]);
  allow = true; events.length = 0;
  await api.perform('switchFamily', { familyId: 'second' });
  assert.deepEqual(calls, [['switchFamily', { familyId: 'second' }]]);
  assert.deepEqual(events, [['busy', true], ['changed'], ['busy', false]]);
});

test('leaving another family does not discard current appearance drafts or close shared settings', async context => {
  let confirmations = 0;
  let reloads = 0;
  const calls = [];
  const { api, events, modals } = mount(context, 'FamilyManagement', {
    manageFamily: async (...args) => calls.push(args), invokeCloud: async () => { reloads += 1; return { families: [] }; },
  }, { unsavedChanges: true, beforeChange: async () => { confirmations += 1; return false; } });
  const target = { id: 'parents', name: '爸妈家', memberCount: 3, owner: false };
  api.families.value = [target];
  const cancelled = api.leave(target);
  assert.equal(modals.length, 1);
  assert.match(modals[0].title, /爸妈家/);
  assert.doesNotMatch(modals[0].content, /未保存|交接/);
  modals[0].success({ confirm: false });
  await cancelled;
  assert.equal(reloads, 0);
  events.length = 0;
  const confirmed = api.leave(target);
  modals[1].success({ confirm: true });
  await confirmed;
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'parents', expectedCurrentFamilyId: 'current' }]]);
  assert.equal(confirmations, 0);
  assert.equal(reloads, 1);
  assert.deepEqual(events, [['busy', true], ['busy', false]]);
});

test('family management keeps failures actionable and suppresses duplicate writes or pending preferences', async context => {
  let calls = 0;
  const { api, events, modules } = mount(context, 'FamilyManagement', { manageFamily: async () => { calls += 1; throw new Error('稍后重试'); } });
  modules.preferencePending.value = true;
  await api.perform('createFamily');
  assert.equal(calls, 0);
  modules.preferencePending.value = false;
  api.busy.value = true;
  await api.perform('createFamily');
  assert.equal(calls, 0);
  api.busy.value = false;
  await api.perform('createFamily');
  assert.equal(api.error.value, '稍后重试');
  assert.equal(api.busy.value, false);
  assert.deepEqual(events, [['busy', true], ['busy', false]]);
});

test('uncertain family removal exposes a read-only retry and blocks family mutations until recovery succeeds', async context => {
  const props = { active: true };
  let online = false;
  let reads = 0;
  let writes = 0;
  const cloudStatus = Vue.ref({ userId: 'me', familyId: 'current', familyRecoveryRequired: true, error: '退出或删除的结果尚未确认，请重新同步家庭状态后再操作。' });
  const { api, modals } = mount(context, 'FamilyManagement', {
    cloudStatus,
    manageFamily: async () => { writes += 1; },
    invokeCloud: async () => { throw new Error('must use authoritative recovery'); },
    recoverFamilyState: async () => {
      reads += 1;
      if (!online) throw new Error('请重新同步家庭状态');
      cloudStatus.value.familyRecoveryRequired = false;
      cloudStatus.value.error = '';
      return { families: [{ id: 'current', name: '我们的小家', memberCount: 2, owner: true }] };
    },
  }, props);
  api.families.value = [{ id: 'current', name: '我们的小家', memberCount: 2, owner: true }, { id: 'parents', name: '爸妈家', memberCount: 2, owner: false }];
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const retry = nodes.find(node => node.type === 'button' && node.children === '重新同步家庭状态');
  assert.ok(retry);
  assert.equal(retry.props.disabled, false);
  assert.ok(nodes.filter(node => node.props?.class?.includes?.('family-choice') && node.type === 'button').every(node => node.props.disabled));
  await api.leave(api.families.value[1]);
  assert.equal(modals.length, 0);
  assert.equal(writes, 0);
  await api.load();
  assert.equal(reads, 1);
  assert.equal(api.loading.value, false);
  assert.equal(api.recoveryRequired.value, true);
  assert.match(api.displayedError.value, /重新同步家庭状态/);
  online = true;
  await api.load();
  assert.equal(reads, 2);
  assert.equal(writes, 0);
  assert.equal(api.recoveryRequired.value, false);
  assert.equal(api.displayedError.value, '');
  assert.deepEqual(api.families.value.map(family => family.id), ['current']);
});

test('late family-list responses do not update an unmounted panel', async context => {
  let finish;
  const { api, mounted, unmounted } = mount(context, 'FamilyManagement', { invokeCloud: () => new Promise(resolve => { finish = resolve; }) });
  const loading = mounted[0]();
  unmounted[0]();
  finish({ families: [{ id: 'late' }] });
  await loading;
  assert.deepEqual(api.families.value, []);
});

test('family deletion uses an empty native name prompt after an irreversible warning', async context => {
  const calls = [];
  const { api, modals, events } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  const pending = api.deleteFamily();
  await api.deleteFamily();
  assert.equal(modals.length, 1, 'repeated taps cannot open duplicate confirmations');
  assert.equal(api.busy.value, true);
  assert.match(modals[0].content, /不能撤销/);
  modals[0].success({ confirm: true });
  await Vue.nextTick();
  assert.equal(modals[1].editable, true);
  assert.equal(modals[1].placeholderText, '我们的小家');
  assert.ok(!modals[1].content, 'never prefill the required confirmation name');
  assert.deepEqual(calls, []);
  modals[1].success({ confirm: true, content: '我们的小家' });
  await pending;
  assert.deepEqual(calls, [['deleteFamily', { familyId: 'current', expectedCurrentFamilyId: 'current', confirmName: '我们的小家' }]]);
  assert.deepEqual(events, [['busy', true], ['changed'], ['busy', false]]);
  assert.equal(api.busy.value, false);
  assert.doesNotMatch(source('FamilyManagement'), /<FormField[^>]*confirmName/);
});

for (const result of [{ confirm: false }, { confirm: true, content: '' }, { confirm: true, content: '我们' }, { confirm: true, content: '我们的小家 ' }]) {
  test(`native deletion cancellation or non-exact name cannot write: ${JSON.stringify(result)}`, async context => {
    const calls = [];
    const { api, modals, events } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
    const pending = api.deleteFamily();
    modals[0].success({ confirm: true });
    await Vue.nextTick();
    modals[1].success(result);
    await pending;
    assert.deepEqual(calls, []);
    assert.deepEqual(events, [['busy', true], ['busy', false]]);
    assert.equal(api.busy.value, false);
    if (result.confirm) assert.match(api.error.value, /名称不一致/);
  });
}

test('warning cancellation and native dialog failure both unlock the family editor without writing', async context => {
  const calls = [];
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  const cancelled = api.deleteFamily();
  modals[0].success({ confirm: false });
  await cancelled;
  assert.equal(modals.length, 1);
  assert.equal(api.busy.value, false);
  const failed = api.deleteFamily();
  modals[1].fail({ errMsg: 'showModal:fail' });
  await failed;
  assert.equal(api.busy.value, false);
  assert.match(api.error.value, /无法打开确认窗口/);
  assert.deepEqual(calls, []);
});

test('native name confirmation preserves the appearance discard guard', async context => {
  const calls = [];
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, { beforeChange: async () => false });
  const pending = api.deleteFamily();
  modals[0].success({ confirm: true });
  await Vue.nextTick();
  modals[1].success({ confirm: true, content: '我们的小家' });
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(api.busy.value, false);
});

test('deletion checks the family again after awaiting the appearance discard confirmation', async context => {
  const calls = [];
  let modules;
  const mounted = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, {
    beforeChange: async () => { modules.cloudStatus.value.familyId = 'changed-while-confirming'; return true; },
  });
  modules = mounted.modules;
  const pending = mounted.api.deleteFamily();
  mounted.modals[0].success({ confirm: true });
  await Vue.nextTick();
  mounted.modals[1].success({ confirm: true, content: '我们的小家' });
  await pending;
  assert.deepEqual(calls, []);
  assert.match(mounted.api.error.value, /家庭状态已变化/);
});

for (const change of ['removed', 'owner', 'name', 'hidden']) {
  test(`another family's deletion prompt rejects a stale ${change} card`, async context => {
    const calls = [];
    const props = Vue.reactive({ active: true });
    const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, props);
    api.families.value = [{ id: 'parents', name: '爸妈家', memberCount: 3, owner: true }];
    const pending = api.deleteFamily(api.families.value[0]);
    modals[0].success({ confirm: true });
    await Vue.nextTick();
    if (change === 'removed') api.families.value = [];
    if (change === 'owner') api.families.value[0].owner = false;
    if (change === 'name') api.families.value[0].name = '已改名';
    if (change === 'hidden') props.active = false;
    modals[1].success({ confirm: true, content: '爸妈家' });
    await pending;
    assert.deepEqual(calls, []);
    assert.ok(api.error.value);
    assert.equal(api.busy.value, false);
  });
}

for (const change of ['name', 'family', 'owner', 'unmount']) {
  test(`a stale native deletion prompt cannot delete after ${change} changes`, async context => {
    const calls = [];
    const { api, modals, modules, unmounted } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
    const pending = api.deleteFamily();
    modals[0].success({ confirm: true });
    await Vue.nextTick();
    if (change === 'name') modules.state.value.family.name = '改名';
    if (change === 'family') modules.cloudStatus.value.familyId = 'another';
    if (change === 'owner') modules.state.value.family.ownerId = 'other';
    if (change === 'unmount') unmounted[0]();
    modals[1].success({ confirm: true, content: '我们的小家' });
    await pending;
    assert.deepEqual(calls, []);
    assert.equal(api.busy.value, false);
    assert.ok(api.error.value);
  });
}

test('family deletion stays owner-only and never offers the prompt to an ordinary member', async context => {
  const { api, modals, modules } = mount(context, 'FamilyManagement');
  modules.state.value.family.ownerId = 'other';
  await api.deleteFamily();
  assert.equal(modals.length, 0);
  const management = source('FamilyManagement');
  assert.match(management, /state.value.family.ownerId === cloudStatus.value.userId/);
  assert.match(management, /confirmation.content !== familyName/);
  assert.match(management, /v-if="editingFamilies" class="family-choice-actions"/);
  assert.match(management, /class="family-choice-action-label">退出<\/text>/);
  assert.doesNotMatch(management, /class="family-choice-action-label">解散<\/text>/);
  assert.doesNotMatch(management, /<text>删除家庭<\/text>/);
});

test('owner exit uses one confirmation and lets the server choose a successor', async context => {
  const calls = [];
  const { api, modals, events, notices } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  const cancelled = api.leave();
  assert.equal(api.creating.value, false);
  assert.equal(modals.length, 1);
  assert.equal(modals[0].content, '');
  assert.equal(modals[0].editable, undefined);
  modals[0].success({ confirm: false });
  await cancelled;
  assert.equal(calls.length, 0);
  const confirmed = api.leave();
  await api.leave();
  assert.equal(modals.length, 2, 'duplicate taps must not open duplicate prompts');
  modals[1].success({ confirm: true });
  await confirmed;
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'current', expectedCurrentFamilyId: 'current' }]]);
  assert.equal(events.filter(([name]) => name === 'changed').length, 1);
  assert.deepEqual(notices, ['请等当前设置保存后再操作']);
  assert.equal(api.busy.value, false);
  assert.doesNotMatch(source('FamilyManagement'), /v-else-if="leaving"|successors|转交并退出/);
});

test('ordinary members can exit with confirmation but cannot delete their family', async context => {
  const calls = [];
  const { api, modules, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  modules.state.value.family.ownerId = 'other';
  await api.deleteFamily();
  assert.equal(modals.length, 0);
  const pending = api.leave();
  assert.equal(modals.length, 1);
  assert.doesNotMatch(modals[0].content, /交接/);
  assert.equal(modals[0].content, '');
  modals[0].success({ confirm: true });
  await pending;
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'current', expectedCurrentFamilyId: 'current' }]]);
});

test('last-member exit keeps a title-only confirmation without asking for a name', async context => {
  const calls = [];
  const { api, modules, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  modules.state.value.family.members = [modules.state.value.family.members[0]];
  const pending = api.leave();
  assert.equal(modals[0].content, '');
  assert.equal(modals[0].confirmText, '确认退出');
  assert.equal(modals[0].editable, undefined);
  modals[0].success({ confirm: true });
  await pending;
  assert.equal(modals.length, 1);
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'current', expectedCurrentFamilyId: 'current' }]]);
});

test('title-only exit confirmation still handles unsaved appearance edits', async context => {
  const calls = [];
  let discardPrompts = 0;
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, { unsavedChanges: true, beforeChange: async () => { discardPrompts += 1; return false; } });
  const pending = api.leave();
  assert.equal(modals[0].content, '');
  modals[0].success({ confirm: true });
  await pending;
  assert.equal(discardPrompts, 0);
  assert.equal(modals.length, 1);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(source('FamilyEditor'), /family-settings-tabs/);
});

for (const change of ['family', 'unmount', 'hidden']) {
  test(`exit refuses confirmation after a ${change} change`, async context => {
    const calls = [];
    const props = Vue.reactive({ active: true });
    const { api, modals, modules, unmounted } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, props);
    const pending = api.leave();
    if (change === 'family') modules.cloudStatus.value.familyId = 'other';
    if (change === 'unmount') unmounted[0]();
    if (change === 'hidden') props.active = false;
    modals[0].success({ confirm: true });
    await pending;
    assert.deepEqual(calls, []);
    assert.match(api.error.value, /家庭状态已变化/);
    assert.equal(api.busy.value, false);
  });
}

test('exit failures unlock controls and do not close the editor; preference writes block exit', async context => {
  const { api, modals, modules, events } = mount(context, 'FamilyManagement', { manageFamily: async () => { throw new Error('网络暂时不可用'); } });
  modules.preferencePending.value = true;
  await api.leave();
  assert.equal(modals.length, 0);
  modules.preferencePending.value = false;
  const failedModal = api.leave();
  modals[0].fail();
  await failedModal;
  assert.equal(api.busy.value, false);
  assert.match(api.error.value, /无法打开确认窗口/);
  const failedWrite = api.leave();
  modals[1].success({ confirm: true });
  await failedWrite;
  assert.equal(api.busy.value, false);
  assert.equal(api.error.value, '网络暂时不可用');
  assert.equal(events.some(([name]) => name === 'changed'), false);
});

test('deleting another family uses its name and administrator role without discarding current appearance', async context => {
  const calls = [];
  let discardPrompts = 0;
  const { api, modals, events, modules } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args), invokeCloud: async () => ({ families: [] }) }, { beforeChange: async () => { discardPrompts += 1; return false; } });
  modules.state.value.family.ownerId = 'other';
  const target = { id: 'parents', name: '爸妈家', memberCount: 3, owner: true };
  api.families.value = [target];
  const pending = api.deleteFamily(target);
  assert.match(modals[0].content, /将删除「爸妈家」/);
  modals[0].success({ confirm: true });
  await Vue.nextTick();
  assert.equal(modals[1].placeholderText, '爸妈家');
  modals[1].success({ confirm: true, content: '爸妈家' });
  await pending;
  assert.deepEqual(calls, [['deleteFamily', { familyId: 'parents', expectedCurrentFamilyId: 'current', confirmName: '爸妈家' }]]);
  assert.equal(discardPrompts, 0);
  assert.equal(modules.cloudStatus.value.familyId, 'current');
  assert.equal(modules.state.value.family.name, '我们的小家');
  assert.equal(events.some(([name]) => name === 'changed'), false);
});

test('invitation entry reuses a prewarmed card immediately and cold entry keeps its label and touch feedback', context => {
  let attempts = 0;
  const invite = { token: 'a'.repeat(48), expiresAt: Date.now() + 86400000 };
  const familyInvitation = { prepared: Vue.ref(invite), busy: Vue.ref(false), error: Vue.ref(''), resume: async () => {}, ensure: async () => { attempts += 1; } };
  const first = mount(context, 'FamilyInviteCard', { familyInvitation, invitationCard: card => card }, { compact: true });
  const second = mount(context, 'FamilyInviteCard', { familyInvitation, invitationCard: card => card });
  assert.equal(first.api.card.value.token, invite.token);
  assert.equal(second.api.card.value.token, invite.token);
  assert.equal(first.api.buttonClass.value, 'group-invite-button');
  familyInvitation.prepared.value = null; familyInvitation.busy.value = true;
  first.api.fallback();
  assert.equal(attempts, 0);
  assert.match(first.notices[0], /正在连接/);
  familyInvitation.busy.value = false; familyInvitation.error.value = '网络暂时不可用';
  first.api.fallback();
  assert.equal(attempts, 1);
  assert.equal(first.notices[1], '网络暂时不可用');
  assert.doesNotMatch(source('FamilyInviteCard'), /disabled="busy|准备中|重试邀请/);
  assert.match(source('FamilyInviteCard'), /@click.stop="\$feedback\(\); fallback\(\)"/);
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const selector of ['.group-portrait', '.group-invite-button .invite-portrait']) {
    const rule = styles.slice(styles.indexOf(`${selector} {`)).split('}')[0];
    assert.match(rule, /border-radius: 50%/);
  }
});

test('management hides the native footer container, not just the save button', () => {
  assert.match(source('FamilyEditor'), /:footer-visible="false"/);
  assert.match(source('Sheet'), /footerVisible: \{ type: Boolean, default: true \}/);
  assert.match(source('Sheet'), /v-if="footerVisible && \$slots.footer"/);
  assert.match(source('Sheet'), /v-if="!footerVisible \|\| !\$slots.footer"/);
});

test('new family uses an inline creation action and the common page header without a fixed footer', context => {
  const { api } = mount(context, 'FamilyEditor', {}, { initialTab: 'management' });
  api.management.value = Vue.reactive({ creating: false });
  assert.equal(renderTemplate('FamilyEditor', api, {}).props['footer-visible'], false);
  api.management.value.creating = true;
  const tree = renderTemplate('FamilyEditor', api, {});
  assert.equal(tree.props['footer-visible'], false);
  assert.equal(tree.props.title, '新建家庭');
  assert.equal(tree.props['preferred-height'], 0);
  assert.match(source('FamilyManagement'), /class="family-creation-controls"/);
});

test('creation name edits are local, validate blank input and cancel without replacing the draft', async context => {
  const { api, events } = mount(context, 'FamilyCreationFields', {}, { name: '周末小家', cover: '', requestId: 'create-family-1' });
  api.editName(); api.draft.value = '另一个名字'; api.close();
  assert.equal(events.length, 0);
  api.editName(); assert.equal(api.draft.value, '周末小家');
  api.draft.value = '  '; await api.save();
  assert.ok(api.error.value); assert.equal(api.section.value, 'name');
  assert.equal(events.length, 0);
  api.draft.value = ' 新名字 '; await api.save();
  assert.deepEqual(events, [['update:name', '新名字']]);
  assert.equal(api.section.value, '');
});

test('creation cover errors preserve the draft and unlocking allows a successful retry', async context => {
  const { api, events } = mount(context, 'FamilyCreationFields', {}, { name: '周末小家', cover: '', requestId: 'create-family-1' });
  api.edit('cover');
  api.photo.value = { save: async () => { throw new Error('网络暂不可用'); } };
  await api.save();
  assert.equal(api.section.value, 'cover'); assert.equal(api.error.value, '网络暂不可用');
  assert.equal(api.locked.value, false);
  assert.equal(events.some(([key]) => key === 'update:cover'), false);
  api.photo.value = { save: async () => 'cloud://draft' };
  await api.save();
  assert.ok(events.some(([key, value]) => key === 'update:cover' && value === 'cloud://draft'));
  assert.equal(api.section.value, '');
});

test('appearance details expose a full cover and independent fields without displaying family IDs', context => {
  const props = Vue.reactive({ family: { id: 'private-key', name: '三餐四季', cover: 'cloud://photo', coverTitle: '一起吃饭' } });
  const { api } = mount(context, 'FamilyAppearanceDetails', {}, props);
  const events = []; let stops = 0;
  const nodes = () => renderedNodes(renderTemplate('FamilyAppearanceDetails', api, props, { $emit: (...args) => events.push(args) }));
  assert.equal(nodes().some(node => node.props?.class === 'family-detail-row family-id-row'), false);
  for (const publicId of ['sy-a1b2c3', 'sy-000001', 'sy-ABC123']) {
    props.family.publicId = publicId;
    assert.equal(nodes().some(node => node.props?.class === 'family-detail-row family-id-row'), false);
    assert.equal(nodes().some(node => typeof node.children === 'string' && /家庭 ID|sy-|private-key/.test(node.children)), false);
    assert.equal(props.family.publicId, publicId, 'hiding the ID does not change the household data');
  }
  for (const button of nodes().filter(node => node.type === 'button')) button.props.onClick({ stopPropagation() { stops += 1; } });
  assert.deepEqual(events, [['edit', 'cover'], ['edit', 'name']]);
  assert.equal(stops, 2);
  const frame = nodes().find(node => node.props?.class === 'family-full-cover-frame');
  assert.equal(frame.props.style.paddingTop, coverFrameStyle('family').paddingTop);
  const photo = nodes().find(node => node.type === api.FamilyCoverImage);
  assert.equal(photo.props.src, 'cloud://photo'); assert.equal(photo.props.variant, 'detail');
  props.family.kind = 'personal'; props.family.publicId = 'sy-a1b2c3';
  assert.equal(nodes().some(node => node.props?.class === 'family-detail-row family-id-row'), false);
  assert.equal(nodes().some(node => node.props?.['aria-label'] === '编辑空间名称'), false);
  assert.deepEqual(nodes().filter(node => node.type === 'button').map(node => node.props['aria-label']), ['编辑个人封面']);
});

test('both account modes share the same cover layout and retain only the household-specific management entry', context => {
  let navigationAppearance;
  const { api, modules } = mount(context, 'FamilyView', { useNavigationAppearance: value => { navigationAppearance = value; } });
  modules.state.value.family.cover = 'cloud://family-cover';
  const events = [];
  for (const personal of [true, false]) {
    modules.state.value.family.kind = personal ? 'personal' : 'family';
    const nodes = familyNodes(api, { $emit: (...args) => events.push(args) });
    assert.equal(nodes.filter(node => node.props?.role === 'switch').length, 1);
    assert.equal(api.pageTitle.value, '');
    const cover = nodes.find(node => node.type === api.StretchCover);
    assert.equal(cover.props.enabled, true);
    assert.equal(navigationAppearance.value, 'dark');
    assert.equal(cover.props.src, 'cloud://family-cover');
    assert.equal(cover.props.active, true);
    assert.equal(cover.props['at-top'], true);
    api.onScroll({ scrollTop: 30 });
    assert.equal(api.headerOpacity.value, 0.47);
    assert.equal(navigationAppearance.value, 'light');
    api.onScroll({ scrollTop: 64 });
    assert.equal(api.headerOpacity.value, 1);
    assert.equal(navigationAppearance.value, 'light');
    api.onScroll({ scrollTop: 0 });
    assert.equal(api.headerOpacity.value, 0);
    assert.equal(navigationAppearance.value, 'dark');
    assert.equal(nodes.some(node => node.props?.['aria-label'] === '查看我的家庭'), !personal);
    assert.equal(nodes.some(node => node.props?.['aria-label'] === '编辑菜单外观'), false);
    assert.equal(nodes.some(node => node.props?.['aria-label'] === '打开设置'), false);
    assert.equal(nodes.find(node => node.props?.class?.includes('account-identity-symbol')).props['aria-label'], personal ? '个人' : '家庭');
    const familyName = nodes.find(node => node.props?.class === 'account-family-name');
    assert.equal(familyName?.children, personal ? undefined : modules.state.value.family.name);
    const symbol = nodes.find(node => node.props?.class?.includes('account-identity-symbol'));
    assert.ok(symbol);
    assert.equal(symbol.props.class.includes('is-family'), !personal);
  }
  assert.deepEqual(events, []);
});

test('family switch failures preserve mode and missing family routes to management', async context => {
  let code = 'NETWORK';
  const { api, modules, events, notices } = mount(context, 'FamilyView', { manageFamily: async () => { throw Object.assign(new Error('切换失败'), { code }); } });
  modules.state.value.family.kind = 'personal';
  const identity = () => familyNodes(api).find(node => node.props?.class?.includes('account-identity-symbol')).props['aria-label'];
  const pending = api.toggleMode();
  assert.equal(identity(), '家庭');
  assert.equal(familyNodes(api).some(node => node.props?.class === 'account-family-name'), false, 'personal workspace name must never appear as a household name');
  assert.equal(familyNodes(api).find(node => node.type === api.StretchCover).props.enabled, true);
  assert.equal(api.familyDisplay.value.cover, '', 'enabling family mode projects the default cover immediately even without a remembered family');
  assert.equal(api.pageTitle.value, '');
  await pending; assert.equal(api.modeError.value, '切换失败');
  assert.equal(identity(), '个人', 'failed switch restores the previous identity badge');
  assert.equal(modules.state.value.family.kind, 'personal'); assert.equal(api.modeBusy.value, false);
  code = 'FAMILY_REQUIRED'; await api.toggleMode();
  assert.deepEqual(events, [['manage']]); assert.equal(api.modeError.value, '');
  assert.deepEqual(notices, ['开启中...', '切换失败', '开启中...', '请先创建或加入家庭'], 'failed optimistic switches replace the immediate notice with actionable feedback');
});

test('the whole profile projects the requested mode before cloud acknowledgement and rolls back together', async context => {
  const family = { id: 'household', kind: 'family', name: '共同的小家', cover: 'cloud://family-cover', members: [{ id: 'me', name: '我' }, { id: 'other' }] };
  const personal = { id: 'personal', kind: 'personal', name: '个人空间', cover: 'cloud://personal-cover', members: [family.members[0]] };
  let finish; const calls = [];
  const { api, modules } = mount(context, 'FamilyView', {
    state: Vue.ref({ family: personal, activeMemberId: 'me' }),
    familyModePreview: Vue.ref({ userId: 'me', id: family.id, name: family.name, cover: family.cover, memberCount: 2 }),
    personalModePreview: Vue.ref({ userId: 'me', id: personal.id, name: personal.name, cover: personal.cover, memberCount: 1 }),
    manageFamily: (...args) => { calls.push(args); return new Promise((resolve, reject) => { finish = { resolve, reject }; }); },
  });
  const pending = api.toggleMode();
  const projected = familyNodes(api);
  assert.equal(projected.find(node => node.type === api.StretchCover).props.enabled, true);
  assert.equal(api.familyDisplay.value.cover, family.cover);
  assert.equal(projected.find(node => node.props?.class === 'account-family-name').children, family.name);
  const entry = projected.find(node => node.props?.['aria-label'] === '查看我的家庭');
  assert.equal(Boolean(entry.props.disabled), false);
  assert.equal(entry.props.class.includes('is-pending'), false);
  entry.props.onClick({ stopPropagation() {} });
  assert.equal(api.familyOpen.value, true, 'family entry opens before the mode request finishes');
  assert.equal(projected.some(node => node.props?.['aria-label'] === '编辑菜单外观'), false);
  assert.equal(modules.state.value.family.id, personal.id, 'visual preview never grants household identity');
  await api.toggleMode(); assert.equal(calls.length, 1);
  modules.state.value.family = family;
  finish.resolve(); await pending;
  assert.equal(api.familyDisplay.value.cover, family.cover);
  assert.equal(Boolean(familyNodes(api).find(node => node.props?.['aria-label'] === '查看我的家庭').props.disabled), false);
  assert.equal(api.familyOpen.value, true, 'mode acknowledgement keeps the opened family page visible');
  const closing = api.toggleMode();
  assert.equal(familyNodes(api).find(node => node.type === api.StretchCover).props.enabled, true);
  assert.equal(api.familyDisplay.value.cover, personal.cover);
  assert.equal(api.pageTitle.value, '');
  assert.equal(familyNodes(api).some(node => node.props?.['aria-label'] === '编辑菜单外观'), false);
  finish.reject(new Error('网络断开')); await closing;
  assert.equal(familyNodes(api).find(node => node.type === api.StretchCover).props.enabled, true);
  assert.equal(api.familyDisplay.value.cover, family.cover);
  assert.match(api.modeError.value, /网络断开/);
});

test('a previous account appearance is ignored and confirmed space changes close nested editors', async context => {
  const { api, modules } = mount(context, 'FamilyView', {
    familyModePreview: Vue.ref({ userId: 'someone-else', name: '别人的家庭', cover: 'cloud://private' }),
    personalModePreview: Vue.ref({ userId: 'someone-else', name: '别人的个人空间', cover: 'cloud://private-personal' }),
  });
  modules.state.value.family.kind = 'personal';
  api.requestedFamilyMode.value = true;
  assert.equal(api.displayedFamily.value, null);
  assert.equal(familyNodes(api).some(node => node.props?.class === 'account-family-name'), false);
  modules.state.value.family.kind = 'family';
  api.requestedFamilyMode.value = false;
  assert.equal(api.displayedPersonal.value, null);
  assert.equal(api.familyDisplay.value.cover, '', 'foreign-account personal covers cannot flash during a pending mode change');
  api.familyOpen.value = true; api.editingProfile.value = true;
  api.onScroll({ scrollTop: 50 });
  modules.state.value.family.id = 'another-space'; await Vue.nextTick();
  assert.equal(api.familyOpen.value, false);
  assert.equal(api.editingProfile.value, false);
  assert.equal(api.headerOpacity.value, 0);
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(page, /<FamilyView[^>]*:key="cloudStatus.userId \|\| state.activeMemberId"/);
});

test('the family manager stays open for its own confirmed switch and returns from creation without losing the list', async context => {
  const { api, modules } = mount(context, 'FamilyView');
  let returned = 0;
  let reloads = 0;
  api.familyManagement.value = Vue.reactive({ creating: false, back() { returned += 1; this.creating = false; }, load() { reloads += 1; } });
  api.familyOpen.value = true;
  api.familyManaging.value = true;
  api.closeFamily();
  assert.equal(api.familyOpen.value, true, 'navigation cannot interrupt an in-flight household operation');
  modules.state.value.family.id = 'switched-household';
  await Vue.nextTick();
  assert.equal(api.familyOpen.value, true);
  api.familyChanged();
  assert.equal(reloads, 1);
  api.familyManaging.value = false;
  api.familyManagement.value.creating = true;
  api.closeFamily();
  assert.equal(returned, 1);
  assert.equal(api.familyOpen.value, true);
  modules.cloudStatus.value.userId = 'another-account';
  await Vue.nextTick();
  assert.equal(api.familyOpen.value, false, 'the old account manager never survives an identity change');
});

for (const edited of ['name', 'cover']) {
  test(`saving ${edited} preserves newer values of the other appearance fields`, async context => {
    const family = { id: 'one', name: '原来的家', cover: 'cloud://old', coverTitle: '原来的标题', coverSubtitle: '保留副标题' };
    const current = Vue.ref({ family }); const calls = [];
    const { api, events } = mount(context, 'FamilyEditor', { state: current, customizeFamily: async payload => { calls.push(payload); } }, { initialTab: edited });
    const updates = { name: '新的名称', cover: 'cloud://new', coverTitle: '新的标题' };
    api[edited].value = updates[edited];
    current.value.family = { ...family, name: '其他成员改的名字', cover: 'cloud://other', coverTitle: '其他成员改的标题' };
    await api.save();
    assert.deepEqual(calls, [{ name: current.value.family.name, cover: current.value.family.cover, coverTitle: current.value.family.coverTitle, [edited]: updates[edited] }]);
    assert.equal(Object.hasOwn(calls[0], 'coverSubtitle'), false);
    assert.deepEqual(events, [['close']]);
  });
}

test('single-field edits validate names, preserve legacy title defaults and refuse writes after a space change', async context => {
  const calls = []; const current = Vue.ref({ family: { id: 'one', name: '小家', cover: '', coverTitle: '原标题' } });
  const name = mount(context, 'FamilyEditor', { state: current, customizeFamily: async p => calls.push(p) }, { initialTab: 'name' });
  name.api.name.value = ' '; await name.api.save(); assert.ok(name.api.fieldErrors.value.name); assert.equal(calls.length, 0);
  name.api.name.value = '正确名称'; current.value.family.id = 'two'; await name.api.save();
  assert.match(name.api.error.value, /空间已变化/); assert.equal(calls.length, 0);
  current.value.family.coverTitle = '';
  const cover = mount(context, 'FamilyEditor', { state: current, customizeFamily: async p => calls.push(p) }, { initialTab: 'cover' });
  cover.api.cover.value = 'cloud://new'; await cover.api.save();
  assert.equal(calls[0].cover, 'cloud://new');
  assert.equal(calls[0].coverTitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
});

test('unchanged legacy fields can be saved and default cover only changes its own draft', async context => {
  const family = { id: 'one', name: '小家', cover: 'cloud://custom', coverTitle: '' }; const calls = [];
  const { api, modules } = mount(context, 'FamilyEditor', { state: Vue.ref({ family }), customizeFamily: async p => calls.push(p) });
  api.openEditor('name'); assert.equal(api.dirty.value, false); await api.save();
  assert.equal(calls.length, 1); assert.equal(calls[0].coverTitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.section.value, '');
  api.openEditor('cover'); api.restoreDefault();
  assert.equal(api.cover.value, ''); assert.equal(api.name.value, family.name); assert.equal(modules.state.value.family.cover, family.cover);
  await api.save(); assert.equal(calls[1].cover, ''); assert.equal(calls[1].name, family.name);
  assert.equal(api.section.value, '');
});

for (const section of ['name', 'cover']) test(`unchanged family ${section} remains enabled and saves the latest other fields`, async context => {
  const calls = [];
  const current = Vue.ref({ family: { id: 'one', name: '小家', cover: 'cloud://original', coverTitle: '原标题' } });
  const props = { initialTab: section };
  const { api, events } = mount(context, 'FamilyEditor', { state: current, customizeFamily: async p => calls.push(p) }, props);
  assert.equal(api.dirty.value, false);
  const tree = renderTemplate('FamilyEditor', api, props);
  const controls = tree.children.default().flatMap(renderedNodes);
  const saveButton = controls.find(node => node.type === 'button' && node.props?.class?.includes('family-field-save'));
  assert.equal(saveButton.props.disabled, false);
  current.value.family[section === 'name' ? 'coverTitle' : 'name'] = '家人刚更新';
  await saveButton.props.onClick({ stopPropagation() {} });
  const { id, ...appearance } = current.value.family;
  assert.deepEqual(calls, [appearance]);
  assert.deepEqual(events, [['close']]);
});

test('field return asks about dirty drafts and returns to the overview without closing it', async context => {
  const { api, modals, events } = mount(context, 'FamilyEditor');
  api.openEditor('name'); api.name.value = '未保存';
  const kept = api.close(); modals[0].success({ confirm: false }); await kept;
  assert.equal(api.section.value, 'name'); assert.equal(api.name.value, '未保存');
  const discarded = api.close(); modals[1].success({ confirm: true }); await discarded;
  assert.equal(api.section.value, ''); assert.deepEqual(events, []);
  api.openEditor('name'); assert.notEqual(api.name.value, '未保存');
  await api.close(); await api.close(); assert.deepEqual(events, [['close']]);
});

test('upload and save lock field navigation and a double tap submits only once', async context => {
  const calls = []; let finish;
  const { api, events } = mount(context, 'FamilyEditor', { customizeFamily: p => { calls.push(p); return new Promise(resolve => { finish = resolve; }); } }, { initialTab: 'name' });
  api.name.value = '新名称';
  for (const key of ['busy', 'saving', 'managing', 'confirming']) {
    api[key].value = true; await api.close(); await api.save(); api.restoreDefault(); api.openEditor('cover');
    assert.equal(api.section.value, 'name'); assert.equal(api.name.value, '新名称');
    assert.equal(calls.length, 0); assert.deepEqual(events, []); api[key].value = false;
  }
  const pending = api.save(); await api.save(); await api.close();
  assert.equal(calls.length, 1); assert.deepEqual(events, []);
  finish(); await pending; assert.deepEqual(events, [['close']]); assert.equal(api.locked.value, false);
});

test('an accepted cover edit returns immediately and recovers its draft when saving fails', async context => {
  let reject;
  const { api } = mount(context, 'FamilyEditor', {
    customizeFamily: () => Object.assign(new Promise((resolve, fail) => { reject = fail; }), { accepted: true }),
  });
  api.openEditor('cover'); api.cover.value = 'cloud://chosen-cover';
  const pending = api.save();
  assert.equal(api.section.value, '');
  assert.equal(api.saving.value, true);
  api.openEditor('name');
  assert.equal(api.section.value, '', 'a second appearance edit cannot race the first save');
  reject(new Error('封面保存失败')); await pending;
  assert.equal(api.section.value, 'cover');
  assert.equal(api.cover.value, 'cloud://chosen-cover');
  assert.equal(api.error.value, '封面保存失败');
  assert.equal(api.dirty.value, true);
});

test('a save failure after leaving the cover editor is reported without reopening an unmounted page', async context => {
  let reject;
  const { api, events, notices, unmounted } = mount(context, 'FamilyEditor', {
    customizeFamily: () => Object.assign(new Promise((resolve, fail) => { reject = fail; }), { accepted: true }),
  }, { initialTab: 'cover' });
  api.cover.value = 'cloud://chosen-cover';
  const pending = api.save();
  assert.deepEqual(events, [['close']]);
  unmounted.forEach(callback => callback());
  reject(new Error('封面未保存，请重试')); await pending;
  assert.deepEqual(notices, ['封面未保存，请重试']);
});

test('management is an independent entry and reopening appearance never remembers that route', async context => {
  const managed = mount(context, 'FamilyEditor', {}, { initialTab: 'management' });
  assert.equal(managed.api.isManagement, true); assert.equal(managed.api.title.value, '我的家庭');
  await managed.api.close(); assert.deepEqual(managed.events, [['close']]);
  const overview = mount(context, 'FamilyEditor');
  assert.equal(overview.api.section.value, ''); assert.equal(overview.api.isManagement, false);
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(page, /@customize="editFamily\(\$event\)"/);
  assert.match(page, /@manage="editFamily\('management'\)"/);
});

test('privacy link navigates independently of consent and has a registered standalone page', context => {
  const { api, events } = mount(context, 'PrivacyConsent');
  const routes = [];
  globalThis.uni.navigateTo = options => routes.push(options.url);
  api.openAgreement();
  assert.deepEqual(routes, ['/pages/privacy/index']);
  assert.deepEqual(events, [], 'reading the agreement must not accept it');
  const pages = JSON.parse(readFileSync(new URL('../src/pages.json', import.meta.url), 'utf8'));
  assert.ok(pages.pages.some(page => page.path === 'pages/privacy/index'));
});


test('profile identity follows mode while statistics do not depend on menu lists', context => {
  const { api, modules } = mount(context, 'FamilyView');
  modules.state.value.family = { id: 'personal', kind: 'personal', members: [] };
  modules.state.value.recipes = [{ id: 'a' }, { id: 'b' }];
  modules.state.value.mealSets = [{ id: 'set' }];
  assert.equal(familyNodes(api).find(node => node.props?.class === 'account-personal-caption').children, '一个人也要好好吃饭~');
  modules.familyModePreview.value = { userId: 'me', id: 'household', name: '家' };
  api.requestedFamilyMode.value = true;
  modules.state.value = { family: { id: 'household', kind: 'family', name: '家', members: [] }, recipes: [], mealSets: [] };
  assert.equal(familyNodes(api).find(node => node.props?.class === 'account-family-name').children, '家');
});
