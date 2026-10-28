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
    ...Vue, ...familyHelpers, presentMutation, NATIVE_UI_COLORS, coverFrameStyle, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    state: Vue.ref({ family: { name: '我们的小家', cover: '', coverTitle: '', ownerId: 'me', members }, activeMemberId: 'me' }),
    cloudMode: true, cloudStatus: Vue.ref({ userId: 'me', familyId: 'current' }), preferencePending: Vue.ref(false),
    familyFeatures: Vue.ref({ fridge: false, shopping: false }),
    activeMember: Vue.ref(members[0]), dismissFocusedKeyboard() {}, notify: message => notices.push(message), useSheetContentResize: () => () => {},
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
  const render = new Function('Vue', code)({ ...Vue, resolveComponent: tag => tag });
  return render({ $feedback() {}, ...templateContext }, [], props, Vue.proxyRefs(api), {}, {});
}

function renderedNodes(node) {
  if (!node || typeof node !== 'object') return [];
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(renderedNodes) : [])];
}

test('family banner follows the persisted public ID without exposing or changing relationship IDs', context => {
  const { api, modules } = mount(context, 'FamilyView');
  const label = () => renderedNodes(renderTemplate('FamilyView', api, {})).find(node => node.props?.class === 'family-banner-caption family-id')?.children;
  const internalId = 'family-1792647111258-fcb7c18538b6245e1029dcec';
  modules.state.value.family.id = internalId;
  assert.equal(label(), undefined, 'unallocated IDs must not be fabricated or expose the long key');
  modules.state.value.family.publicId = 'sy-a1b2c3';
  assert.equal(label(), 'ID: sy-a1b2c3');
  assert.equal(modules.state.value.family.id, internalId);
  modules.state.value = { ...modules.state.value, family: { ...modules.state.value.family, id: 'parents-internal', publicId: 'sy-000001' } };
  assert.equal(label(), 'ID: sy-000001', 'switching family must update the visible ID immediately');
  modules.state.value.family.publicId = 'sy-ABC123';
  assert.equal(label(), undefined, 'only the exact lowercase six-character format is displayed');
});

test('family management cards share golden covers, select without checkmarks and expose actions per family', context => {
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
    assert.equal(cardNodes.find(node => node.props?.class === 'family-choice-cover-frame').props.style.paddingTop, coverFrameStyle('family').paddingTop);
    const selector = cardNodes.find(node => node.props?.class === 'family-choice-select');
    assert.equal(renderedNodes(selector).filter(node => node.type === 'button').length, 1, 'destructive buttons are siblings, never inside the switch button');
    const actions = cardNodes.find(node => node.props?.class === 'family-choice-actions');
    assert.equal(renderedNodes(actions).filter(node => node.type === 'text').length, 0, 'right-side actions are icon-only');
    for (const icon of renderedNodes(actions).filter(node => node.type === api.AppIcon)) assert.equal(icon.props.size, 18);
  }
  assert.deepEqual(nodes.filter(node => node.type === api.FamilyCoverImage).map(node => [node.props.src, node.props.variant]), [['', 'card'], ['cloud://parents-cover', 'card'], ['', 'card']]);
  assert.deepEqual(nodes.filter(node => node.props?.class === 'family-choice-select').map(node => node.props['aria-pressed']), [true, false, false]);
  assert.equal(nodes.filter(node => node.props?.['aria-label']?.startsWith('退出「')).length, 3);
  assert.deepEqual(nodes.filter(node => node.props?.['aria-label']?.startsWith('删除「')).map(node => node.props['aria-label']), ['删除「爸妈家」']);
  assert.doesNotMatch(source('FamilyManagement'), /family-choice-check|family-group-grid|family-group-hint|family-exit-actions|selectedMember|FamilyInviteCard/);
  assert.doesNotMatch(source('FamilyManagement'), />\s*text:first-child/);
  assert.match(source('FamilyManagement'), /\.family-choice-card\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/);
  assert.match(source('FamilyManagement'), /\.family-choice-action\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/);
  assert.doesNotMatch(source('FamilyManagement'), /\.family-choice-actions\s*\{[^}]*border-top/);
});

test('family action icons stop the row tap and retain confirmation without switching households', async context => {
  const calls = [];
  const props = { active: true };
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, props);
  api.families.value = [{ id: 'current', name: '我们的小家', memberCount: 2, owner: true }];
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const buttons = nodes.filter(node => node.type === 'button' && /^(退出|删除)「/.test(node.props?.['aria-label'] || ''));
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
  assert.deepEqual(calls, [], 'cancelling either icon never switches, exits or deletes a family');
});

test('family card selection is a no-op for the current family and still uses the existing switch flow', async context => {
  const calls = [];
  const { api } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  await api.selectFamily({ id: 'current' });
  assert.deepEqual(calls, []);
  await api.selectFamily({ id: 'parents' });
  assert.deepEqual(calls, [['switchFamily', { familyId: 'parents' }]]);
});

test('the family member count sits beside its heading without moving the other section headings', () => {
  const familyView = source('FamilyView');
  assert.match(familyView, /class="section-line family-members-heading"/);
  assert.match(familyView, /\.section-line\.family-members-heading\s*\{[^}]*justify-content:\s*flex-start;[^}]*gap:\s*8px;/);
});

test('family members share a card with their heading and invitation without changing profile editing', context => {
  const { api, modules } = mount(context, 'FamilyView');
  const page = renderTemplate('FamilyView', api, {});
  const panel = renderedNodes(page).find(node => node.props?.class === 'feature-panel family-members-panel');
  assert.ok(panel);
  assert.equal(panel.type, 'view');
  assert.equal(panel.props.onClick, undefined);
  const heading = panel.children.find(node => node.props?.class === 'section-line family-members-heading');
  const grid = panel.children.find(node => node.props?.class === 'member-grid family-member-grid');
  assert.ok(heading && grid);
  assert.equal(heading.children[1].children, `${modules.state.value.family.members.length} 人`);
  assert.equal(renderedNodes(grid).filter(node => node.props?.class === 'member-avatar-image').length, modules.state.value.family.members.length);
  assert.equal(renderedNodes(grid).filter(node => node.type === api.FamilyInviteCard).length, 1);
  const preferences = renderedNodes(page).find(node => node.props?.class === 'feature-panel family-preferences');
  assert.ok(page.children.indexOf(panel) < page.children.indexOf(preferences));
  let stopped = 0;
  const edit = renderedNodes(panel).find(node => node.props?.['aria-label'] === '编辑我的头像与昵称');
  edit.props.onClick({ stopPropagation() { stopped += 1; } });
  assert.equal(stopped, 1);
  assert.equal(api.editingProfile.value, true);
});

test('my home page title reacts to family changes without remounting the view', context => {
  const { api, modules } = mount(context, 'FamilyView', { ingredientManagementEnabled: Vue.ref(false) });
  const title = () => renderedNodes(renderTemplate('FamilyView', api, {})).find(node => node.type === api.PageHeader).props.title;
  assert.equal(title(), '我们的小家');
  const originalFamily = modules.state.value.family;
  modules.state.value = { ...modules.state.value, family: { ...originalFamily, id: 'parents', name: '爸妈家' } };
  assert.equal(title(), '爸妈家');
  modules.state.value.family.name = '  三餐小家  ';
  assert.equal(title(), '三餐小家');
  modules.state.value.family.name = '';
  assert.equal(title(), '我们的小家');
  modules.state.value.family = originalFamily;
  assert.equal(title(), '我们的小家');
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
  api.busy.value = true;
  api.pendingPhotos.value = [
    { path: 'uploading.jpg', preview: 'small-upload.jpg', status: 'uploading', progress: 42 },
    { path: 'saving.jpg', status: 'saving' },
    { path: 'finished.jpg', status: 'done' },
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

test('restore defaults resets name, cover and menu title only in the draft until an explicit save', async context => {
  const family = { name: '周末小家', cover: 'cloud://family-cover', coverTitle: '一起好好吃饭', coverSubtitle: '周末一起做拿手菜' };
  const calls = [];
  const { api, modules, events } = mount(context, 'FamilyEditor', { state: Vue.ref({ family }), customizeFamily: async value => calls.push(value) });
  for (const field of ['busy', 'saving', 'managing', 'confirming']) {
    api[field].value = true;
    api.restoreDefaults();
    assert.equal(api.name.value, family.name);
    assert.equal(api.cover.value, family.cover);
    assert.equal(api.coverTitle.value, family.coverTitle);
    assert.equal(api.coverSubtitle, undefined);
    api[field].value = false;
  }
  api.error.value = '上次保存失败';
  api.restoreDefaults();
  assert.equal(api.cover.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.cover);
  assert.equal(api.coverTitle.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.coverSubtitle, undefined);
  assert.equal(api.name.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.name);
  assert.equal(api.error.value, '');
  assert.equal(api.dirty.value, true);
  assert.deepEqual(modules.state.value.family, family);
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
  await api.save();
  assert.deepEqual(calls, [{ ...editableDefaults }]);
  assert.deepEqual(events, [['close']]);
});

test('family photo selection uses a centered camera capsule without external controls, and reset remains red footer text', () => {
  const editor = source('FamilyEditor');
  const picker = source('ImagePicker');
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(editor, /:preferred-height="tab === 'management' && !creatingFamily \? 660 : 0"/);
  assert.match(editor, /<template v-if="tab === 'appearance' \|\| creatingFamily" #footer>\s*<view v-if="tab === 'appearance'" class="family-appearance-footer">\s*<text v-if="error"[^>]*role="alert"[^>]*>\{\{ error \}\}<\/text>\s*<button role="button" class="text-button family-cover-reset" :disabled="locked"[^>]*>恢复默认设置<\/button>\s*<button role="button" class="primary-button full"/);
  assert.match(css, /\.family-appearance-footer \.family-cover-reset\s*\{[^}]*justify-content: center;[^}]*width: 100%;[^}]*min-height: 44px;[^}]*color: var\(--danger\);/);
  assert.match(picker, /<AppIcon name="camera-inverse" :size="compact \? 14 : 16"/);
  assert.match(picker, /\.cover-image-picker:not\(\.compact-image-picker\) \.upload-caption\s*\{[^}]*top: 50%; left: 50%;[^}]*transform: translate\(-50%, -50%\);[^}]*border-radius: 999px;/);
  assert.match(picker, /<text v-if="!compact" class="upload-caption-label">拍照\/相册<\/text>/);
  assert.match(css, /\.hero-edit, \.upload-caption\s*\{[^}]*right: 6px; bottom: 6px;[^}]*width: 44px; height: 44px; min-height: 44px;/);
  assert.doesNotMatch(picker, /\.cover-image-picker \.upload-caption\s*\{/);
  assert.doesNotMatch(picker, /family-cover-remove|删除家庭封面|调整展示位置|移除图片|photo-count/);
});

test('empty legacy appearance uses editable defaults without dirtying or mutating the saved family', context => {
  const family = { name: '我们的小家', cover: '', coverTitle: '', members: [{ id: 'me', name: '我' }] };
  const { api, modules, events } = mount(context, 'FamilyEditor', { state: Vue.ref({ family }) });
  assert.equal(api.name.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.name);
  assert.equal(api.coverTitle.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.dirty.value, false);
  api.restoreDefaults();
  assert.equal(api.dirty.value, false);
  assert.equal(modules.state.value.family.coverTitle, '');
  assert.deepEqual(modules.state.value.family.members, family.members);
  assert.deepEqual(events, []);
});

test('reset drafts can be abandoned without changing the family and failed saves keep the draft for retry', async context => {
  const family = { name: '旧名称', cover: 'cloud://old-cover', coverTitle: '旧标题' };
  let fail = true;
  const calls = [];
  const { api, modules, modals, events } = mount(context, 'FamilyEditor', {
    state: Vue.ref({ family }),
    customizeFamily: async value => { calls.push(value); if (fail) throw new Error('保存失败，请重试'); },
  });
  api.restoreDefaults();
  const closing = api.close();
  assert.equal(modals.length, 1);
  modals[0].success({ confirm: false });
  await closing;
  assert.deepEqual(events, []);
  assert.deepEqual(modules.state.value.family, family);
  await api.save();
  assert.equal(api.error.value, '保存失败，请重试');
  assert.equal(api.saving.value, false);
  assert.equal(api.dirty.value, true);
  assert.deepEqual(events, []);
  fail = false;
  await api.save();
  assert.deepEqual(calls, [{ ...editableDefaults }, { ...editableDefaults }]);
  assert.deepEqual(events, [['close']]);
});

test('blank family names show an inline error while cleared menu titles retain their default', async context => {
  const family = { name: '原来的家', cover: 'cloud://family-cover', coverTitle: '周末做饭' };
  const calls = [];
  const { api } = mount(context, 'FamilyEditor', { state: Vue.ref({ family }), customizeFamily: async value => calls.push(value) });
  assert.deepEqual(familyHelpers.familyAppearance(family), { ...family, coverSubtitle: familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverSubtitle });
  api.name.value = '  ';
  api.coverTitle.value = '';
  await api.save();
  assert.deepEqual(calls, []);
  assert.ok(api.fieldErrors.value.name);
  api.name.value = '新的小家';
  await api.save();
  assert.deepEqual(calls, [{ ...editableDefaults, name: '新的小家', cover: family.cover }]);
});

test('title edits confirm discard and retry without overwriting saved legacy subtitles', async context => {
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
  api.coverTitle.value = '  三餐有家人陪伴  ';
  assert.equal(api.dirty.value, true);
  const closing = api.close();
  modals[0].success({ confirm: false });
  await closing;
  assert.deepEqual(events, []);
  assert.deepEqual(savedState.value.family, family);
  await api.save();
  assert.equal(api.error.value, '保存失败，请重试');
  assert.equal(api.coverTitle.value, '  三餐有家人陪伴  ');
  assert.deepEqual(savedState.value.family, family);
  fail = false;
  await api.save();
  assert.deepEqual(events, [['close']]);
  assert.equal(savedState.value.family.coverTitle, '三餐有家人陪伴');
  assert.equal(savedState.value.family.coverSubtitle, family.coverSubtitle);
  assert.ok(calls.every(value => !Object.hasOwn(value, 'coverSubtitle')));
  const reopened = mount(context, 'FamilyEditor', { state: savedState });
  assert.equal(reopened.api.coverTitle.value, '三餐有家人陪伴');
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

test('family appearance presents the cover before the name and both menu lines', context => {
  const { api } = mount(context, 'FamilyEditor');
  const tree = renderTemplate('FamilyEditor', api, {});
  const panel = tree.children.default().flatMap(renderedNodes).find(node => node.props?.class === 'family-appearance-panel');
  const nodes = renderedNodes(panel);
  assert.deepEqual(nodes.filter(node => node.props?.class === 'subheading').map(node => node.children), ['家庭封面', '家庭名称', '菜单主标题']);
  assert.deepEqual(nodes.filter(node => node.type === api.ImagePicker || node.type === api.FormField).map(node => node.props['aria-label'] || node.props.frame), ['family', '家庭名称', '菜单主标题']);
  assert.equal(api.dirty.value, false);
});

test('only the menu title remains configurable and saving sends exactly the displayed copy', async context => {
  const calls = [];
  const { api } = mount(context, 'FamilyEditor', { customizeFamily: async value => calls.push(value) });
  assert.equal(api.coverTitle.value, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(api.coverSubtitle, undefined);
  assert.equal(api.dirty.value, false);
  const tree = renderTemplate('FamilyEditor', api, {});
  const fields = tree.children.default().flatMap(renderedNodes);
  const field = fields.find(node => node.props?.['aria-label'] === '菜单主标题');
  assert.equal(field.props.placeholder, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(field.props.modelValue, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(field.props.maxlength, '30');
  assert.equal(fields.some(node => node.props?.['aria-label'] === '菜单副标题'), false);
  await api.save();
  assert.equal(calls[0].coverTitle, familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle);
  assert.equal(Object.hasOwn(calls[0], 'coverSubtitle'), false);
});

test('family management thumbnail uses the active family photo without a large cover or title overlay', context => {
  const { api, modules } = mount(context, 'FamilyView');
  for (const cover of ['', 'cloud://family-photo']) {
    for (const coverTitle of [undefined, '', '  ', '  一起吃饭  ']) {
      modules.state.value.family = { ...modules.state.value.family, name: '三餐四季的小家', cover, coverTitle };
      const nodes = renderedNodes(renderTemplate('FamilyView', api, {}));
      const frame = nodes.find(node => node.props?.class === 'family-banner-frame');
      assert.equal(frame.props.style.paddingTop, coverFrameStyle('family').paddingTop);
      const image = nodes.find(node => node.type === api.FamilyCoverImage);
      assert.equal(image.props.src, cover);
      assert.equal(image.props.variant, 'card');
      assert.equal(nodes.find(node => node.props?.class === 'subheading family-banner-name').children, '三餐四季的小家');
      assert.ok(!nodes.some(node => /hero/.test(node.props?.class || '')));
    }
  }
});

test('compact family card and edit button both open appearance settings exactly once', context => {
  const { api } = mount(context, 'FamilyView');
  const events = [];
  let stopped = 0;
  const nodes = renderedNodes(renderTemplate('FamilyView', api, {}, { $emit: event => events.push(event) }));
  const banner = nodes.find(node => node.props?.class === 'family-banner');
  assert.equal(banner.children.filter(node => node.type === 'button').length, 2);
  for (const label of ['家庭设置', '编辑家庭名称与封面']) {
    const button = nodes.find(node => node.props?.['aria-label'] === label);
    button.props.onClick({ stopPropagation() { stopped += 1; } });
  }
  assert.deepEqual(events, ['customize', 'customize']);
  assert.equal(stopped, 2);
  const editButton = nodes.find(node => node.props?.class === 'family-banner-edit');
  const surface = editButton.children.find(node => node.props?.class === 'action-icon-circle');
  assert.ok(surface);
  const icon = renderedNodes(surface).find(node => node.type === api.AppIcon);
  assert.equal(icon.props.name, 'edit');
  assert.equal(icon.props.size, 18);
  assert.equal(renderedNodes(editButton).filter(node => node.type === 'button').length, 1);
});

test('shared settings card keeps fridge-only toggling immediate and silent with accessible state and help', context => {
  const features = Vue.ref({ fridge: false, shopping: true });
  const updates = [];
  const { api, modules } = mount(context, 'FamilyView', {
    familyFeatures: features,
    runAction: action => action(),
    setFridgeEnabled(value) { updates.push(value); features.value.fridge = value; },
  });
  for (const checked of [false, true]) {
    const nodes = renderedNodes(renderTemplate('FamilyView', api, {}));
    const panel = nodes.find(node => node.props?.class === 'feature-panel family-preferences');
    const control = renderedNodes(panel).find(node => node.props?.role === 'switch');
    assert.equal(control.props['aria-label'], '冰箱');
    assert.equal(control.props['aria-checked'], checked);
    control.props.onClick();
  }
  assert.deepEqual(updates, [true, false]);
  assert.equal(features.value.shopping, true);
  modules.preferencePending.value = true;
  const nodes = renderedNodes(renderTemplate('FamilyView', api, {}));
  assert.equal(nodes.find(node => node.props?.class === 'feature-row').props['aria-busy'], true);
  assert.equal(nodes.find(node => node.props?.class === 'preference-saving'), undefined);
  assert.equal(nodes.some(node => typeof node.children === 'string' && /保存中|正在同步/.test(node.children)), false);
  nodes.find(node => node.props?.class === 'family-info-row family-help-entry').props.onClick();
  assert.equal(api.about.value, true);
  assert.ok(renderedNodes(renderTemplate('FamilyView', api, {})).some(node => node.type === api.Sheet && node.props.title === '使用说明'));
});

test('onboarding opens directly on the creation form without creation or invitation tabs', context => {
  const { api } = mount(context, 'CloudConnection', { accountProfile: Vue.ref({ name: '小厨师', avatar: 'cloud://avatar' }), cloudStatus: Vue.ref({ phase: 'onboarding' }) });
  assert.equal(api.name.value, '小厨师');
  assert.equal(api.avatar.value, 'cloud://avatar');
  assert.equal(api.familyName.value, '我们的小家');
  const rendered = renderTemplate('CloudConnection', api, {});
  const card = rendered.children.find(node => node.props?.class === 'cloud-card');
  const children = card.children.filter(node => node.type !== Vue.Comment && node.type !== Vue.Text);
  assert.equal(children[0].type, api.ProfileFields);
  const familyNameField = children[1];
  const heading = familyNameField.children.find(node => node.type === 'text');
  assert.equal(heading.children, '家庭名称');
  assert.equal(heading.props.class, 'subheading');
  assert.match(source('ProfileFields'), /<text class="subheading profile-field-heading">昵称<\/text>/);
  assert.deepEqual(children.slice(1).map(node => node.type), ['view', 'button', api.FieldError, 'button']);
  assert.equal(children.at(-1).children, '创建小家');
  assert.doesNotMatch(source('CloudConnection'), /joining|content-types|invitation-help|加入家庭/);
});

test('simplified onboarding retains consent, upload guards, duplicate protection and retry identity', async context => {
  const calls = [];
  let finish;
  const { api, notices } = mount(context, 'CloudConnection', { accountProfile: Vue.ref({ name: '我', avatar: '' }), manageFamily: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  await api.enter();
  assert.equal(calls.length, 0);
  assert.equal(api.fieldErrors.value.consent, '请先确认云端保存说明');
  assert.deepEqual(notices, []);
  api.consent.value = true;
  api.uploading.value = true;
  await api.enter();
  assert.equal(calls.length, 0);
  api.uploading.value = false;
  const pending = api.enter();
  await api.enter();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'createFamily');
  assert.equal(calls[0][1].familyName, '我们的小家');
  assert.equal(calls[0][1].name, '我');
  finish(); await pending;
  assert.equal(api.busy.value, false);
  const repeated = api.enter();
  assert.equal(calls[0][1].requestId, calls[1][1].requestId);
  finish(); await repeated;
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

test('family member profile is launched only from the self card and shared settings contain no duplicate management entry', context => {
  const { api } = mount(context, 'FamilyView');
  assert.equal(api.editingProfile.value, false);
  api.editProfile();
  assert.equal(api.editingProfile.value, true);
  const nodes = [];
  function walk(node) { if (node.type === 1) { nodes.push(node); node.children.forEach(walk); } }
  baseParse(parse(source('FamilyView')).descriptor.template.content).children.forEach(walk);
  const attribute = (node, name) => node.props.find(prop => prop.name === name);
  const button = nodes.find(node => attribute(node, 'class')?.value?.content === 'member-profile-button');
  assert.equal(attribute(button, 'if').exp.content, 'activeMember.id === member.id');
  assert.ok(attribute(button, 'on').modifiers.includes('stop'));
  const tools = nodes.find(node => attribute(node, 'class')?.value?.content === 'feature-panel family-preferences');
  assert.equal(tools.children.filter(node => node.type === 1).length, 2);
  assert.equal(tools.children.filter(node => node.type === 1 && attribute(node, 'aria-label')?.value?.content === '家庭管理').length, 0);
  assert.doesNotMatch(source('FamilyView'), /dataOpen|resetDemo|FamilyManagement|switchMember/);
  assert.match(source('FamilyView'), /<ProfileEditor v-if="editingProfile"/);
});

test('reopening family settings starts on appearance after closing from management', async context => {
  const page = readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8');
  assert.match(page, /<FamilyView[^>]*@customize="editFamily\(\)"/);
  assert.doesNotMatch(page, /@manage="editFamily\('management'\)"/);
  const current = mount(context, 'FamilyEditor');
  current.api.selectTab('management');
  assert.equal(current.api.tab.value, 'management');
  await current.api.close();
  assert.deepEqual(current.events, [['close']]);
  assert.equal(current.modals.length, 0);
  const reopened = mount(context, 'FamilyEditor');
  assert.equal(reopened.api.tab.value, 'appearance');
  assert.equal(reopened.api.managementVisited.value, false);
  assert.equal(reopened.api.dirty.value, false);
});

test('settings tabs retain appearance drafts and management mounts lazily only once', context => {
  let dismissals = 0;
  const { api } = mount(context, 'FamilyEditor', { dismissFocusedKeyboard: () => { dismissals += 1; } });
  assert.equal(api.tab.value, 'appearance');
  assert.equal(api.managementVisited.value, false);
  api.name.value = '周末小家'; api.cover.value = 'cloud://cover'; api.coverTitle.value = '一起吃饭';
  api.selectTab('management');
  assert.equal(api.managementVisited.value, true);
  api.selectTab('appearance');
  assert.equal(api.managementVisited.value, true);
  assert.equal(api.name.value, '周末小家');
  assert.equal(api.cover.value, 'cloud://cover');
  assert.equal(api.coverTitle.value, '一起吃饭');
  assert.equal(api.dirty.value, true);
  assert.equal(dismissals, 2);
  assert.match(source('FamilyEditor'), /<FamilyManagement v-if="cloudMode && managementVisited" :active="tab === 'management'"/);
  assert.match(source('FamilyEditor'), /v-if="tab === 'appearance'" class="family-appearance-panel"/);
  assert.match(source('FamilyManagement'), /v-if="props.active" class="family-management-panel"/);
  assert.doesNotMatch(source('FamilyEditor'), /v-show/);
  assert.doesNotMatch(source('FamilyManagement'), /<Sheet|import Sheet/);
});

test('entering creation resets synchronously before a new input can acquire focus', async context => {
  const { api, events } = mount(context, 'FamilyManagement');
  api.create();
  assert.deepEqual(events, [['section-change']]);
  api.familyName.value = '开始输入';
  await Vue.nextTick();
  assert.deepEqual(events, [['section-change']]);
});

test('new family uses the appearance cover and shared menu copy but keeps the name blank', context => {
  const props = { active: true };
  const { api } = mount(context, 'FamilyManagement', {}, props);
  api.create();
  const nodes = renderedNodes(renderTemplate('FamilyManagement', api, props));
  const picker = nodes.find(node => node.type === api.ImagePicker);
  assert.equal(picker.props.frame, 'family');
  assert.equal(picker.props.modelValue, '');
  assert.match(picker.props['family-draft-request'], /^create-family-/);
  const fields = nodes.filter(node => node.type === api.FormField);
  assert.deepEqual(fields.map(node => node.props['aria-label']), ['新家庭名称', '新家庭菜单主标题']);
  assert.deepEqual(fields.map(node => node.props.modelValue), ['', familyHelpers.FAMILY_APPEARANCE_DEFAULTS.coverTitle]);
  assert.deepEqual(nodes.filter(node => node.props?.class === 'subheading').map(node => node.children), ['新建一个家', '家庭封面', '家庭名称', '菜单主标题']);
  assert.equal(api.coverSubtitle, undefined);
  assert.ok(nodes.indexOf(picker) < nodes.indexOf(fields[0]));
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

test('closing clean settings needs no confirmation; dirty settings may be kept or discarded', async context => {
  const { api, events, modals } = mount(context, 'FamilyEditor');
  await api.close();
  assert.deepEqual(events, [['close']]);
  events.length = 0;
  api.name.value = '新名称';
  const cancelled = api.close();
  assert.equal(api.locked.value, true);
  api.selectTab('management');
  assert.equal(api.tab.value, 'appearance');
  modals[0].success({ confirm: false });
  await cancelled;
  assert.deepEqual(events, []);
  assert.equal(api.name.value, '新名称');
  const confirmed = api.close();
  modals[1].success({ confirm: true });
  await confirmed;
  assert.deepEqual(events, [['close']]);
});

test('upload, save and family writes block closing and tab changes; saving submits only once', async context => {
  const calls = [];
  let finish;
  const { api, events } = mount(context, 'FamilyEditor', { customizeFamily: payload => { calls.push(payload); return new Promise(resolve => { finish = resolve; }); } });
  for (const field of ['busy', 'saving', 'managing']) {
    api[field].value = true;
    api.selectTab('management');
    await api.close(); await api.save();
    assert.equal(api.tab.value, 'appearance');
    assert.deepEqual(events, []);
    assert.equal(calls.length, 0);
    api[field].value = false;
  }
  api.name.value = '周末小家';
  const saving = api.save();
  await api.save(); await api.close();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, '周末小家');
  finish(); await saving;
  assert.deepEqual(events, [['close']]);
  assert.equal(api.locked.value, false);
});

test('failed appearance save preserves edits and shows an error without closing', async context => {
  const { api, events } = mount(context, 'FamilyEditor', { customizeFamily: async () => { throw new Error('网络暂时不可用'); } });
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
  assert.match(management, /v-if="family.owner" class="family-choice-action danger"/);
  assert.match(management, /<AppIcon name="trash-danger" :size="18"/);
  assert.doesNotMatch(management, /<text>删除家庭<\/text>/);
});

test('owner exit uses one confirmation and lets the server choose a successor', async context => {
  const calls = [];
  const { api, modals, events, notices } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  const cancelled = api.leave();
  assert.equal(api.subheading.value, '');
  assert.equal(modals.length, 1);
  assert.match(modals[0].content, /自动交接给最早加入/);
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
  assert.match(modals[0].content, /若退出时已无其他成员，家庭将自动删除/);
  modals[0].success({ confirm: true });
  await pending;
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'current', expectedCurrentFamilyId: 'current' }]]);
});

test('last-member exit warns about automatic deletion without asking for a name', async context => {
  const calls = [];
  const { api, modules, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) });
  modules.state.value.family.members = [modules.state.value.family.members[0]];
  const pending = api.leave();
  assert.match(modals[0].content, /最后一位成员.*自动删除.*不能撤销/);
  assert.equal(modals[0].confirmText, '确认退出');
  assert.equal(modals[0].editable, undefined);
  modals[0].success({ confirm: true });
  await pending;
  assert.equal(modals.length, 1);
  assert.deepEqual(calls, [['leaveFamily', { familyId: 'current', expectedCurrentFamilyId: 'current' }]]);
});

test('exit combines discarding unsaved appearance edits into the same confirmation', async context => {
  const calls = [];
  let discardPrompts = 0;
  const { api, modals } = mount(context, 'FamilyManagement', { manageFamily: async (...args) => calls.push(args) }, { unsavedChanges: true, beforeChange: async () => { discardPrompts += 1; return false; } });
  const pending = api.leave();
  assert.match(modals[0].content, /名称与封面未保存的修改也将放弃/);
  modals[0].success({ confirm: true });
  await pending;
  assert.equal(discardPrompts, 0);
  assert.equal(modals.length, 1);
  assert.equal(calls.length, 1);
  assert.match(source('FamilyEditor'), /:unsaved-changes="dirty"/);
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
  assert.match(source('FamilyEditor'), /:footer-visible="tab === 'appearance' \|\| creatingFamily"/);
  assert.match(source('Sheet'), /footerVisible: \{ type: Boolean, default: true \}/);
  assert.match(source('Sheet'), /v-if="footerVisible && \$slots.footer"/);
  assert.match(source('Sheet'), /v-if="!footerVisible \|\| !\$slots.footer"/);
});

test('new family shares the fixed footer while the management list keeps its footer hidden', context => {
  const { api } = mount(context, 'FamilyEditor');
  let submissions = 0;
  api.management.value = Vue.reactive({ creating: false, canCreate: false, busy: false, submitCreation: () => { submissions += 1; } });
  api.selectTab('management');
  assert.equal(renderTemplate('FamilyEditor', api, {}).props['footer-visible'], false);
  api.management.value.creating = true;
  let tree = renderTemplate('FamilyEditor', api, {});
  assert.equal(tree.props['footer-visible'], true);
  assert.equal(tree.props['preferred-height'], 0);
  let button = tree.children.footer().flatMap(renderedNodes).find(node => node.type === 'button');
  assert.equal(button.children, '创建并切换');
  assert.equal(button.props.disabled, true);
  api.management.value.canCreate = true;
  tree = renderTemplate('FamilyEditor', api, {});
  button = tree.children.footer().flatMap(renderedNodes).find(node => node.type === 'button');
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.equal(submissions, 1);
  api.managing.value = true;
  api.management.value.busy = true;
  button = renderTemplate('FamilyEditor', api, {}).children.footer().flatMap(renderedNodes).find(node => node.type === 'button');
  assert.equal(button.props.disabled, true);
  assert.equal(button.children, '正在创建…');
});
