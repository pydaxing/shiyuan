import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';
import { profileNameError } from '../src/domain/family.js';

const source = readFileSync(new URL('../src/pages/invite/index.vue', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function mount(context, overrides = {}) {
  const calls = [];
  const routes = [];
  const notices = [];
  const modules = {
    ...Vue, profileNameError, onLoad() {}, onUnload() {}, setInviteMediaToken() {}, cloudMode: true, connectCloud: async () => {},
    accountProfile: Vue.ref({ name: '小林', avatar: '/static/family-garden.png' }),
    invokeCloud: async () => ({ familyName: '我们的小家', memberCount: 2, joined: false }),
    manageFamily: async (...args) => { calls.push(args); },
    notify: message => notices.push(message), dismissFocusedKeyboard() {}, ...overrides,
  };
  const previous = globalThis.uni;
  globalThis.uni = { reLaunch: options => routes.push(options.url) };
  context.after(() => { globalThis.uni = previous; });
  let script = compileScript(parse(source).descriptor, { id: 'invitation-page' }).content;
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, binding) => `const ${binding} = ${binding.startsWith('{') ? 'modules' : '{}'};`);
  const component = new Function('modules', script.replace('export default', 'return'))(modules);
  const api = component.setup({}, { expose() {} });
  return { api, calls, routes, notices };
}

test('reading an invitation displays the family without joining or switching it', async context => {
  const { api, calls, routes } = mount(context);
  await api.read();
  assert.equal(api.loading.value, false);
  assert.equal(api.invite.value.familyName, '我们的小家');
  assert.equal(api.name.value, '小林');
  assert.equal(api.consent.value, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(routes, []);
  await api.join();
  assert.deepEqual(calls, []);
});

test('first-time joining retains explicit consent and avatar upload guards', async context => {
  const { api, calls, routes, notices } = mount(context);
  api.token.value = 'invite-token';
  await api.read();
  api.consent.value = true;
  api.uploading.value = true;
  await api.join();
  assert.deepEqual(calls, []);
  api.uploading.value = false;
  await api.join();
  assert.deepEqual(calls, [['joinFamily', { token: 'invite-token', name: '小林', avatar: '/static/family-garden.png' }]]);
  assert.deepEqual(routes, ['/pages/index/index']);
  assert.deepEqual(notices, []);
});

test('invitation cover access is installed after a successful read and cleared on exit', async context => {
  const tokens = [];
  let unload;
  const { api } = mount(context, { setInviteMediaToken: value => tokens.push(value), onUnload: callback => { unload = callback; }, invokeCloud: async () => ({ familyName: '小家', familyCover: 'cloud://env/family-photo', joined: false }) });
  api.token.value = 'invitation-token';
  await api.read();
  assert.equal(api.invite.value.familyCover, 'cloud://env/family-photo');
  assert.deepEqual(tokens, ['invitation-token']);
  unload();
  assert.deepEqual(tokens, ['invitation-token', undefined]);
});

test('existing members enter directly and repeated taps cannot submit twice', async context => {
  let finish;
  let writes = 0;
  const { api, routes, notices } = mount(context, {
    invokeCloud: async () => ({ familyName: '家', memberCount: 3, joined: true }),
    manageFamily: () => { writes += 1; return new Promise(resolve => { finish = resolve; }); },
  });
  await api.read();
  const pending = api.join();
  assert.equal(api.busy.value, true);
  await api.join();
  assert.equal(writes, 1);
  finish();
  await pending;
  assert.equal(api.busy.value, false);
  assert.deepEqual(routes, ['/pages/index/index']);
  assert.deepEqual(notices, []);
});

test('a late invitation response cannot restore cover permissions after leaving the page', async context => {
  const tokens = [];
  let unload;
  let finish;
  const { api } = mount(context, { setInviteMediaToken: value => tokens.push(value), onUnload: callback => { unload = callback; }, invokeCloud: () => new Promise(resolve => { finish = resolve; }) });
  const pending = api.read();
  await Promise.resolve();
  unload();
  finish({ familyName: '迟到的邀请', familyCover: 'cloud://env/private-cover' });
  await pending;
  assert.equal(api.invite.value, null);
  assert.deepEqual(tokens, [undefined]);
});

test('an expired retry clears old family details and old consent', async context => {
  const { api, calls } = mount(context, { invokeCloud: async () => { throw new Error('邀请已过期，请家人重新邀请'); } });
  api.invite.value = { familyName: '旧邀请', joined: true };
  api.consent.value = true;
  await api.read();
  assert.equal(api.invite.value, null);
  assert.equal(api.consent.value, false);
  assert.equal(api.loading.value, false);
  assert.match(api.error.value, /邀请已过期/);
  await api.join();
  assert.deepEqual(calls, []);
});

test('join failures keep the form available and do not navigate away', async context => {
  const { api, routes } = mount(context, { manageFamily: async () => { throw new Error('网络连接失败，请重试'); } });
  await api.read();
  api.consent.value = true;
  await api.join();
  assert.equal(api.busy.value, false);
  assert.equal(api.consent.value, true);
  assert.equal(api.invite.value.familyName, '我们的小家');
  assert.match(api.error.value, /网络连接失败/);
  assert.deepEqual(routes, []);
});

test('invitation layout contains artwork, status, profile consent and touch-friendly actions without fixed layers', () => {
  assert.match(source, /class="invitation-paper"/);
  assert.match(source, /<FamilyCoverImage :src="invite\?\.familyCover" variant="detail"/);
  assert.match(source, /class="invitation-cover" :style="coverFrameStyle\('family'\)"/);
  assert.match(source, /v-if="invite.joined" class="invitation-member-state"/);
  assert.match(source, /v-else class="invitation-profile"/);
  assert.match(source, /role="checkbox" :aria-checked="consent"/);
  assert.match(source, /invite.joined \? '正在进入…' : '正在加入…'/);
  assert.match(source, /class="invitation-error" role="alert"/);
  assert.doesNotMatch(source, /一张餐桌|entry-emblem|invite-emblem|position:\s*fixed/);
  assert.match(styles, /\.invitation-home \{[^}]*justify-content: center;[^}]*min-height: 48px;/);
  assert.match(styles, /\.invitation-submit \{[^}]*min-height: 52px;/);
  assert.match(styles, /\.invitation-submit\[disabled\] \{[^}]*opacity: 1;/);
  assert.match(styles, /\.invitation-title \{[^}]*overflow-wrap: anywhere;/);
  assert.ok(readFileSync(new URL('../src/static/family-home-default.jpg', import.meta.url)).length > 100);
});
