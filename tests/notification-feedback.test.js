import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
const declarations = parse(source, { sourceType: 'module' }).program.body
  .filter(node => node.type === 'ExportNamedDeclaration' && ['notify', 'runAction'].includes(node.declaration?.id?.name))
  .map(node => source.slice(node.declaration.start, node.declaration.end)).join('\n');

function feedback() {
  const notices = [];
  const api = new Function('uni', `${declarations}\nreturn { notify, runAction };`)({ showToast: notice => notices.push(notice) });
  return { ...api, notices };
}

test('shared notices are icon-free, transient and never mask the page', () => {
  const view = feedback();
  view.notify('接入中，敬请期待');
  assert.deepEqual(view.notices, [{ title: '接入中，敬请期待', icon: 'none', duration: 2600, mask: false }]);
});

test('synchronous and asynchronous successful actions do not show a success notice', async () => {
  const view = feedback();
  assert.equal(view.runAction(() => 'updated'), 'updated');
  assert.equal(await view.runAction(async () => 'removed'), 'removed');
  assert.deepEqual(view.notices, []);
});

test('action failures still show the real error instead of silently implying success', async () => {
  const view = feedback();
  assert.equal(view.runAction(() => { throw new Error('没有删除权限'); }), false);
  assert.equal(await view.runAction(async () => { throw new Error('网络暂不可用，请重试'); }), false);
  assert.equal(await view.runAction(async () => { throw new Error(); }), false);
  assert.deepEqual(view.notices.map(notice => notice.title), ['没有删除权限', '网络暂不可用，请重试', '操作失败，请重试']);
});
