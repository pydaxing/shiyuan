import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc';
import postcss from 'postcss';
import * as Vue from 'vue';
import { profileNameError } from '../src/domain/family.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const source = name => readFileSync(new URL(`../src/components/${name}.vue`, import.meta.url), 'utf8');

function mount(name, overrides = {}, props = {}) {
  const events = [];
  const notices = [];
  const unmounted = [];
  const modules = {
    ...Vue,
    profileNameError,
    presentMutation,
    onUnmounted: callback => unmounted.push(callback),
    NATIVE_UI_COLORS: { primary: '#304d60', muted: '#69777a' },
    dismissFocusedKeyboard() {},
    cloudMode: true,
    accountProfile: Vue.ref({ name: '原来的昵称', avatar: 'cloud://saved-avatar' }),
    accountProfilePreview: Vue.ref(null),
    state: Vue.ref({ family: { id: 'family', kind: 'family', name: '我们的小家', cover: '', members: [] } }),
    cloudStatus: Vue.ref({ userId: 'me', busy: false }),
    saveAccountProfile: payload => overrides.manageFamily?.('updateProfile', payload),
    activeMember: Vue.ref({ name: '家人', avatar: '' }),
    notify: message => notices.push(message),
    uni: { getSystemInfoSync: () => ({ uniPlatform: 'mp-weixin' }) },
    ...overrides,
  };
  const descriptor = parse(source(name)).descriptor;
  let script = compileScript(descriptor, { id: 'profile-editor-test' }).content;
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', 'uni', script.replace('export default', 'return'))(modules, modules.uni);
  const api = component.setup(props, { expose() {}, emit: (...args) => events.push(args) });
  return { api, events, notices, unmount: () => unmounted.forEach(callback => callback()) };
}

function render(name, api, props = {}) {
  const descriptor = parse(source(name)).descriptor;
  const script = compileScript(descriptor, { id: 'profile-editor-test' });
  const template = compileTemplate({ id: 'profile-editor-test', source: descriptor.template.content, filename: `${name}.vue`, compilerOptions: { bindingMetadata: script.bindings } });
  assert.deepEqual(template.errors, []);
  const code = template.code.replace(/import \{([^}]+)\} from "vue"/g, (_, imports) => `const {${imports.replace(/ as /g, ': ')}} = Vue;`).replace('export function render', 'return function render');
  const renderTemplate = new Function('Vue', code)({ ...Vue, resolveComponent: tag => tag });
  return renderTemplate({ $image: value => value, $emit: api.emit }, [], props, Vue.proxyRefs(api), {}, {});
}

function nodes(node) {
  if (!node || typeof node !== 'object') return [];
  const children = Array.isArray(node.children) ? node.children : Object.values(node.children || {}).filter(value => typeof value === 'function').flatMap(slot => slot());
  return [node, ...children.flatMap(nodes)];
}

test('the avatar is the single native picker entry without separate photo or WeChat actions', async () => {
  const props = { name: '小厨师', avatar: 'cloud://avatar' };
  const { api, events } = mount('ProfileFields', {}, props);
  const rendered = nodes(render('ProfileFields', api, props));
  const avatar = rendered.find(node => node.props?.['aria-label'] === '编辑头像');
  assert.equal(avatar.type, 'button');
  assert.equal(avatar.props.onClick, api.choosePhoto);
  assert.equal(Boolean(avatar.props.disabled), false);
  assert.equal(nodes(avatar).filter(node => node.type === 'button').length, 1);
  const camera = nodes(avatar).find(node => node.props?.name === 'camera-inverse');
  assert.equal(camera.props.size, 12);
  assert.ok(nodes(avatar).some(node => node.props?.src === props.avatar && node.props?.mode === 'aspectFill'));
  const wechatAvatar = rendered.find(node => node.props?.['open-type'] === 'chooseAvatar');
  assert.equal(wechatAvatar, avatar);
  assert.equal(wechatAvatar.props.onChooseavatar, api.choose);
  assert.equal(rendered.filter(node => node.type === 'button').length, 1);
  assert.ok(!rendered.some(node => typeof node.children === 'string' && /拍照\s*\/\s*相册|使用微信头像|使用微信昵称/.test(node.children)));
  await avatar.props.onClick();
  assert.equal(api.uploading.value, false);
  assert.deepEqual(events, []);
});

test('avatar upload progress stays centered while the camera hides and the picker prevents duplicate uploads', () => {
  const props = { name: '小厨师', avatar: 'cloud://avatar' };
  const { api } = mount('ProfileFields', {}, props);
  api.pendingPreview.value = 'pending-photo.jpg';
  api.progress.value = '45%';
  api.uploading.value = true;
  const rendered = nodes(render('ProfileFields', api, props));
  const avatar = rendered.find(node => node.props?.['aria-label'] === '头像上传中');
  assert.equal(avatar.props.disabled, true);
  assert.equal(avatar.props['aria-busy'], true);
  assert.equal(rendered.find(node => node.props?.['open-type'] === 'chooseAvatar').props.disabled, true);
  assert.ok(rendered.some(node => node.props?.src === 'pending-photo.jpg'));
  assert.ok(rendered.some(node => node.type === api.ImageUploadProgress && node.props.value === '45%' && node.props.compact === ''));
  assert.ok(!rendered.some(node => node.props?.name === 'camera-inverse'));
});

test('the nickname input preserves native suggestions and manual editing without a separate action', () => {
  const props = { name: '原来的昵称', avatar: '' };
  const { api, events } = mount('ProfileFields', {}, props);
  assert.equal(props.name, '原来的昵称');
  assert.deepEqual(events, []);
  const rendered = nodes(render('ProfileFields', api, props));
  const field = rendered.find(node => node.type === api.FormField);
  assert.equal(field.props.type, 'nickname');
  assert.equal(field.props.focus, false);
  assert.equal(field.props['model-value'], props.name);
  assert.equal(field.props['aria-label'], '昵称');
  assert.ok(!rendered.some(node => node.type === 'button' && node.children === '使用微信昵称'));
  field.props.onFocus();
  assert.equal(api.nicknameFocused.value, true);
  assert.equal(props.name, '原来的昵称');
  assert.deepEqual(events, []);
});

test('non-WeChat avatar editing retains the original photo picker without a native open type', async () => {
  const selections = [];
  const props = { name: '小厨师', avatar: '' };
  const { api, events } = mount('ProfileFields', {
    uni: { getSystemInfoSync: () => ({ uniPlatform: 'web' }) },
    cloudMode: false,
    chooseLocalImage: async sources => { selections.push(sources); return 'local-avatar.jpg'; },
  }, props);
  const avatar = nodes(render('ProfileFields', api, props)).find(node => node.props?.['aria-label'] === '编辑头像');
  assert.equal(avatar.props['open-type'], undefined);
  await avatar.props.onClick();
  assert.deepEqual(selections, [['album', 'camera']]);
  assert.deepEqual(events, [['busy', true], ['update:avatar', 'local-avatar.jpg'], ['busy', false]]);
});

test('manual and WeChat nickname changes are retained, including clearing the field and dismissing the keyboard', () => {
  const props = { name: '原来的昵称', avatar: '' };
  const { api, events } = mount('ProfileFields', {}, props);
  const field = nodes(render('ProfileFields', api, props)).find(node => node.type === api.FormField);
  field.props['onUpdate:modelValue']('手写昵称');
  api.nicknameFocused.value = true;
  api.blurNickname({ detail: { value: '微信昵称' } });
  assert.equal(api.nicknameFocused.value, false);
  api.blurNickname({ detail: { value: '' } });
  api.blurNickname({ detail: {} });
  assert.deepEqual(events, [['update:name', '手写昵称'], ['update:name', '微信昵称'], ['update:name', '']]);
});

test('profile fields center the avatar without a visible label and preserve the compact nickname row', () => {
  const props = { name: '小厨师', avatar: 'cloud://avatar' };
  const { api } = mount('ProfileFields', {}, props);
  const rendered = nodes(render('ProfileFields', api, props));
  const headings = rendered.filter(node => node.props?.class === 'subheading profile-field-heading');
  assert.deepEqual(headings.map(node => node.children), ['昵称']);
  const avatarRow = rendered.find(node => node.props?.class === 'profile-photo-actions');
  const nicknameRow = rendered.find(node => node.props?.class === 'field-label profile-nickname-field');
  assert.ok(!rendered.some(node => node.type === 'text' && node.children === '头像'));
  assert.ok(nicknameRow.children.includes(headings[0]));
  assert.ok(nodes(avatarRow).some(node => node.type === 'button' && node.props['open-type'] === 'chooseAvatar'));
  assert.ok(nodes(nicknameRow).some(node => node.type === api.FormField && node.props.type === 'nickname'));
  const styles = postcss.parse(parse(source('ProfileFields')).descriptor.styles.map(style => style.content).join('\n'));
  const rules = new Map();
  styles.walkRules(rule => {
    if (rule.parent.type === 'atrule') return;
    rules.set(rule.selector, Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value])));
  });
  assert.equal(rules.get('.profile-fields').padding, '0');
  assert.equal(rules.get('.profile-fields').gap, '16px');
  assert.equal(rules.get('.profile-photo-actions')['justify-content'], 'center');
  assert.equal(rules.get('.profile-photo-actions').gap, rules.get('.profile-nickname-field').gap);
  assert.equal(rules.get('.profile-field-heading').flex, '0 0 48px');
  assert.equal(rules.get('.profile-photo-actions .profile-avatar-button').margin, '0');
  assert.equal(rules.get('.profile-photo-actions .profile-avatar-button').padding, '4px');
  assert.equal(rules.get('.profile-nickname-field').margin, '0');
  assert.equal(rules.get('.profile-nickname-input')['min-width'], '0');
  assert.equal(rules.get('.profile-nickname-input :deep(.input)')['margin-top'], '0');
  assert.equal(rules.get('.profile-avatar-frame').width, '64px');
  assert.equal(rules.get('.profile-avatar-frame').height, '64px');
  assert.equal(rules.get('.profile-photo-actions .profile-avatar-button')['min-height'], '72px');
  const editor = mount('ProfileEditor');
  assert.equal(nodes(render('ProfileEditor', editor.api)).find(node => node.props?.title === '我的资料').props['preferred-height'], undefined);
});

test('the profile overview groups the cover with native avatar and nickname controls, opening only one editor at a time', () => {
  const { api, events } = mount('ProfileEditor');
  const overview = nodes(render('ProfileEditor', api));
  const appearance = overview.find(node => node.type === api.FamilyAppearanceDetails);
  assert.equal(appearance.props.family.name, '我们的小家');
  assert.deepEqual(nodes(appearance).filter(node => node.type === 'button').map(node => node.props['aria-label']), ['查看和更换头像', '编辑昵称']);
  appearance.props.onEdit('cover');
  assert.equal(api.appearanceSection.value, 'cover');
  const editor = nodes(render('ProfileEditor', api)).find(node => node.type === api.FamilyEditor);
  assert.equal(editor.props['initial-tab'], 'cover');
  api.openEditor('nickname');
  api.close();
  assert.equal(api.section.value, '');
  assert.deepEqual(events, []);
  editor.props.onClose();
  api.openEditor('nickname');
  api.openAppearance('name');
  assert.equal(api.section.value, 'nickname');
  assert.equal(api.appearanceSection.value, '');
});

test('personal appearance allows cover editing without exposing household name or obsolete menu title', () => {
  const state = Vue.ref({ family: { id: 'personal', kind: 'personal', cover: 'cloud://personal-cover' } });
  const cloudStatus = Vue.ref({ userId: 'me', busy: false });
  const { api } = mount('ProfileEditor', { state, cloudStatus });
  for (const field of ['name', 'coverTitle', 'unknown']) {
    api.openAppearance(field);
    assert.equal(api.appearanceSection.value, '');
  }
  cloudStatus.value.busy = true;
  api.openAppearance('cover');
  assert.equal(api.appearanceSection.value, '');
  cloudStatus.value.busy = false;
  api.openAppearance('cover');
  assert.equal(api.appearanceSection.value, 'cover');
  assert.equal(nodes(render('ProfileEditor', api)).find(node => node.type === api.FamilyAppearanceDetails).props.family.cover, 'cloud://personal-cover');
});

test('onboarding and profile editing reuse the same centered avatar field', () => {
  for (const component of ['CloudConnection', 'ProfileEditor']) {
    assert.match(source(component), /<ProfileFields.*v-model:name="name" v-model:avatar="avatar".*:name-error="[^"]+".*@busy="uploading = \$event"/);
    assert.doesNotMatch(source(component), /profile-photo-actions|profile-avatar-button/);
  }
});

test('the camera stays small at the lower-right without inheriting the avatar image styling', () => {
  const styles = postcss.parse(parse(source('ProfileFields')).descriptor.styles.map(style => style.content).join('\n'));
  let camera;
  styles.walkRules('.profile-avatar-camera', rule => { camera = Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value])); });
  assert.equal(camera.width, '24px');
  assert.equal(camera.height, '24px');
  assert.equal(camera.position, 'absolute');
  assert.equal(camera.right, '-2px');
  assert.equal(camera.bottom, '-2px');
  assert.equal(camera.left, undefined);
  assert.equal(camera.transform, undefined);
  assert.equal(camera['pointer-events'], 'none');
  assert.equal(camera['border-radius'], '50%');
  assert.equal(camera.background, 'var(--photo-action-surface)');
  assert.match(styles.toString(), /:deep\(\.app-icon\)\s*\{\s*border-radius: 0; background: transparent;/);
});

test('saving a nickname preserves the confirmed avatar, guards uploads and duplicate submits, then returns to the list', async () => {
  const calls = [];
  let finish;
  const { api, events, notices } = mount('ProfileEditor', { manageFamily: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  assert.doesNotMatch(source('ProfileEditor'), /由你主动选择|实名认证|class="hint"/);
  api.openEditor('nickname');
  api.name.value = '新的昵称';
  api.avatar.value = 'cloud://unrelated-draft';
  api.uploading.value = true;
  await api.save();
  assert.equal(calls.length, 0);
  api.uploading.value = false;
  const saving = api.save();
  await api.save();
  assert.deepEqual(calls, [['updateProfile', { name: '新的昵称', avatar: 'cloud://saved-avatar' }]]);
  finish();
  await saving;
  assert.equal(api.busy.value, false);
  assert.equal(api.section.value, '');
  assert.equal(api.saved.value.name, '新的昵称');
  assert.deepEqual(events, []);
  api.close();
  assert.deepEqual(events, [['close']]);
  assert.deepEqual(notices, []);
});

test('profile saving failures leave the selected avatar and nickname available for retry', async () => {
  const { api, events } = mount('ProfileEditor', { manageFamily: async () => { throw new Error('网络暂时不可用'); } });
  api.openEditor('avatar');
  api.name.value = '保留的昵称';
  api.avatar.value = 'cloud://selected-avatar';
  await api.save();
  assert.equal(api.name.value, '保留的昵称');
  assert.equal(api.avatar.value, 'cloud://selected-avatar');
  assert.equal(api.error.value, '网络暂时不可用');
  assert.equal(api.busy.value, false);
  assert.deepEqual(events, []);
});

test('an accepted profile edit immediately returns to the updated list and restores its draft on failure', async () => {
  let reject;
  const { api } = mount('ProfileEditor', { saveAccountProfile: () => Object.assign(new Promise((resolve, fail) => { reject = fail; }), { accepted: true }) });
  api.openEditor('nickname'); api.name.value = '马上显示';
  const pending = api.save();
  assert.equal(api.section.value, '');
  assert.equal(api.saved.value.name, '马上显示');
  api.openEditor('avatar'); assert.equal(api.section.value, '', 'no second save can race the pending one');
  reject(new Error('保存失败')); await pending;
  assert.equal(api.section.value, 'nickname');
  assert.equal(api.saved.value.name, '原来的昵称');
  assert.equal(api.name.value, '马上显示');
  assert.equal(api.error.value, '保存失败');
  assert.equal(api.dirty.value, true);
});

test('users can leave the accepted profile save and still receive a failure message after unmount', async () => {
  let reject;
  const { api, events, notices, unmount } = mount('ProfileEditor', { saveAccountProfile: () => Object.assign(new Promise((resolve, fail) => { reject = fail; }), { accepted: true }) });
  api.openEditor('avatar'); api.avatar.value = 'cloud://new';
  const pending = api.save();
  api.close(); assert.deepEqual(events, [['close']]);
  unmount(); reject(new Error('头像未保存，请重试')); await pending;
  assert.deepEqual(notices, ['头像未保存，请重试']);
  assert.equal(api.section.value, '');
});

test('profile overview opens separate editors while native WeChat controls remain owned by ProfileFields', () => {
  const { api } = mount('ProfileEditor');
  const list = nodes(render('ProfileEditor', api));
  assert.ok(list.some(node => node.props?.['aria-label'] === '查看和更换头像'));
  assert.ok(list.some(node => node.props?.['aria-label'] === '编辑昵称'));
  assert.ok(!list.some(node => node.type === api.ProfileFields));
  api.openEditor('nickname');
  const edit = nodes(render('ProfileEditor', api));
  assert.ok(edit.some(node => node.type === api.ProfileFields && node.props.mode === 'nickname'));
  assert.equal(edit.find(node => node.props?.['aria-label'] === '完成编辑').props.disabled, false);
  api.name.value = '改后的昵称';
  assert.equal(nodes(render('ProfileEditor', api)).find(node => node.props?.['aria-label'] === '完成编辑').props.disabled, false);
});

test('avatar page keeps native chooseAvatar, large original preview, and no nickname field', () => {
  const props = { mode: 'avatar', avatar: 'cloud://original' };
  const { api } = mount('ProfileFields', {}, props);
  const tree = nodes(render('ProfileFields', api, props));
  assert.equal(tree.filter(node => node.props?.['open-type'] === 'chooseAvatar').length, 1);
  assert.ok(tree.some(node => node.type === api.LazyImage && node.props.variant === 'original'));
  assert.ok(!tree.some(node => node.type === api.FormField));
});

test('nickname page retains native nickname entry and accessible clear without an avatar picker', async () => {
  const props = { mode: 'nickname', name: '原昵称' };
  const { api, events } = mount('ProfileFields', {}, props);
  const tree = nodes(render('ProfileFields', api, props));
  assert.ok(tree.some(node => node.type === api.FormField && node.props.type === 'nickname'));
  assert.ok(!tree.some(node => node.props?.['open-type'] === 'chooseAvatar'));
  const clear = tree.find(node => node.props?.['aria-label'] === '清空昵称');
  clear.props.onClick({ stopPropagation() {} });
  await Vue.nextTick();
  assert.deepEqual(events, [['update:name', '']]);
  assert.equal(api.nicknameFocused.value, true);
});

test('avatar completion uses the newest confirmed nickname and never changes the service contract', async () => {
  const calls = [];
  const accountProfile = Vue.ref({ name: '旧昵称', avatar: 'cloud://old' });
  const { api } = mount('ProfileEditor', { accountProfile, manageFamily: async (...args) => calls.push(args) });
  api.openEditor('avatar');
  api.avatar.value = 'cloud://new';
  accountProfile.value = { name: '已同步昵称', avatar: 'cloud://old' };
  await api.save();
  assert.deepEqual(calls, [['updateProfile', { name: '已同步昵称', avatar: 'cloud://new' }]]);
  assert.equal(api.saved.value.avatar, 'cloud://new');
});

for (const section of ['nickname', 'avatar']) test(`unchanged ${section} can be saved while preserving the other confirmed field and blocking duplicate saves`, async () => {
  const calls = []; let finish;
  const accountProfile = Vue.ref({ name: '原昵称', avatar: 'cloud://original' });
  const { api } = mount('ProfileEditor', { accountProfile, manageFamily: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  api.openEditor(section);
  assert.equal(api.dirty.value, false);
  const button = nodes(render('ProfileEditor', api)).find(node => node.props?.['aria-label'] === '完成编辑');
  assert.equal(button.props.disabled, false);
  accountProfile.value[section === 'nickname' ? 'avatar' : 'name'] = section === 'nickname' ? 'cloud://latest' : '已同步昵称';
  const pending = button.props.onClick({ stopPropagation() {} });
  assert.equal(nodes(render('ProfileEditor', api)).find(node => node.props?.['aria-label'] === '完成编辑').props.disabled, true);
  await api.save();
  assert.deepEqual(calls, [['updateProfile', { ...accountProfile.value }]]);
  finish(); await pending;
  assert.equal(api.section.value, '');
});

test('invalid nickname stays in the editor and a network failure can be retried', async () => {
  let attempts = 0;
  const { api } = mount('ProfileEditor', { manageFamily: async () => { if (++attempts === 1) throw new Error('网络断开'); } });
  api.openEditor('nickname');
  api.name.value = '   ';
  await api.save();
  assert.equal(attempts, 0);
  assert.equal(api.nameError.value, '昵称需要 1～16 个字');
  api.name.value = '小厨师';
  await api.save();
  assert.equal(api.error.value, '网络断开');
  assert.equal(api.section.value, 'nickname');
  await api.save();
  assert.equal(attempts, 2);
  assert.equal(api.section.value, '');
});

test('cancel preserves drafts when requested and discards only after confirmation; upload prevents leaving', async () => {
  let decision = false;
  let dialogs = 0;
  const { api, events } = mount('ProfileEditor', { uni: { showModal(options) { dialogs++; options.success({ confirm: decision }); } } });
  api.openEditor('nickname');
  api.name.value = '未保存昵称';
  api.uploading.value = true;
  await api.cancelEditing();
  api.close();
  assert.equal(dialogs, 0);
  assert.deepEqual(events, []);
  api.uploading.value = false;
  await api.cancelEditing();
  assert.equal(api.section.value, 'nickname');
  assert.equal(api.name.value, '未保存昵称');
  decision = true;
  await api.cancelEditing();
  assert.equal(api.section.value, '');
  assert.equal(api.name.value, '原来的昵称');
  assert.equal(dialogs, 2);
  api.openEditor('avatar');
  await api.cancelEditing();
  assert.equal(dialogs, 2);
});
