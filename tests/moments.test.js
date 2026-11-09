import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isMomentsPreview, momentsCard, enableMomentsMenu } from '../src/services/moments.js';

test('timeline payload never forwards private or invitation query parameters', () => {
  assert.deepEqual(momentsCard({ token: 'secret', familyId: 'family' }), {
    title: '食愿小灶 · 把每一餐过成喜欢的日常', query: '', imageUrl: '/static/tomato.png',
  });
});
test('only actual single-page scene suppresses the authenticated app lifecycle', () => {
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/gm, '');
  let calls = 0;
  const effect = () => { calls++; return Promise.resolve(); };
  const app = new Function('isMomentsPreview', 'familyInvitation', 'refreshAccountVisit', 'cloudMode', `return (() => { ${script.replace('export default', 'return')} })()`)(isMomentsPreview, { resume: effect }, effect, false);
  app.onLaunch({ scene: 1154 });
  app.onShow({ scene: 1154 });
  assert.equal(calls, 0);
  app.onLaunch({ scene: 1001 });
  assert.equal(calls, 2);
  assert.equal(isMomentsPreview({ scene: 1007, query: { scene: 1154 } }), false);
});
test('entry detection follows current scene and enables both native share destinations', context => {
  const previous = globalThis.wx;
  context.after(() => { globalThis.wx = previous; });
  let menu;
  globalThis.wx = { getEnterOptionsSync: () => ({ scene: 1154 }), showShareMenu: options => { menu = options; } };
  assert.equal(isMomentsPreview(), true);
  globalThis.wx.getEnterOptionsSync = () => ({ scene: 1001 });
  assert.equal(isMomentsPreview(), false);
  enableMomentsMenu();
  assert.deepEqual(menu.menus, ['shareAppMessage', 'shareTimeline']);
});
