import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';

const root = new URL('../dist/build/mp-weixin/', import.meta.url);
function elements(filename) {
  const result = [];
  function walk(node) {
    if (node.type !== 1) return;
    result.push(node);
    node.children.forEach(walk);
  }
  baseParse(readFileSync(new URL(filename, root), 'utf8')).children.forEach(walk);
  return result;
}
const attribute = (node, name) => node.props.find((prop) => prop.name === name)?.value?.content;
const fields = elements('components/FormField.wxml');
const input = fields.find((node) => node.tag === 'input');
const textarea = fields.find((node) => node.tag === 'textarea');
assert.equal(attribute(fields[0], 'mark:keyboardfield'), 'true', 'native input-internal targets must inherit the field exclusion marker');
assert.ok(attribute(fields[0], 'catchtap'), 'field taps must not cross a custom-component boundary as unmarked outside taps');
for (const field of [fields[0], input, textarea]) {
  assert.equal(attribute(field, 'data-keyboard-field'), 'true', 'field taps must be identifiable without blocking native touch events');
  for (const event of ['touchstart', 'touchend', 'mousedown']) assert.equal(attribute(field, `catch${event}`), undefined, 'input containers must not intercept native focus gestures');
}
assert.equal(attribute(input, 'always-embed'), '{{true}}', 'iOS input must retain same-layer rendering');
assert.match(attribute(textarea, 'fixed') || '', /^\{\{(?!false\}\})\w+\}\}$/, 'textarea must declare the fixed sheet coordinate system');
assert.equal(attribute(textarea, 'disable-default-padding'), '{{true}}', 'iOS textarea geometry must not gain unmeasured native padding');
const family = elements('components/FamilyEditor.wxml');
assert.ok(family.every(node => attribute(node, 'hidden') === undefined), 'inactive family forms must be removed instead of hiding native inputs');
assert.ok(attribute(elements('components/FamilyManagement.wxml')[0], 'wx:if'), 'inactive management must not retain native input surfaces');
for (const field of [input, textarea]) {
  assert.equal(attribute(field, 'hold-keyboard'), '{{false}}', 'native outside taps must dismiss without a second scripted hideKeyboard');
  assert.ok(attribute(field, 'bindfocus'));
  assert.ok(attribute(field, 'bindblur'));
  assert.ok(attribute(field, 'bindkeyboardheightchange'));
  assert.equal(attribute(field, 'data-eventsync'), 'true', 'input touch events must not arrive after focus');
}
const sheet = elements('components/Sheet.wxml');
assert.ok(attribute(sheet.find((node) => /(?:^sheet$|'sheet')/.test(attribute(node, 'class') || '')), 'catchtap'), 'outside field taps must stay in the active sheet');
const scroll = sheet.find((node) => node.tag === 'scroll-view');
assert.equal(attribute(scroll, 'scroll-with-animation'), '{{false}}', 'input repositioning must not animate native scroll coordinates');
assert.equal(attribute(scroll, 'scroll-anchoring'), '{{false}}');
assert.ok(sheet.some((node) => node.tag === 'root-portal'));
for (const name of ['sheet-mask', 'sheet-header', 'sheet-footer']) {
  const chrome = sheet.find((node) => attribute(node, 'class') === name);
  assert.ok(attribute(chrome, 'catchtouchmove'), `${name} must not scroll the underlying page`);
}
assert.equal(attribute(scroll, 'catchtouchmove'), undefined, 'content must retain native scroll gestures');
const closeIcon = sheet.find((node) => node.tag === 'image' && attribute(node, 'class') === 'sheet-close-icon');
assert.ok(attribute(closeIcon, 'src'));
assert.ok(readFileSync(new URL('static/icon-close.png', root)).length > 0);
assert.match(readFileSync(new URL('common/assets.js', root), 'utf8'), /\/static\/icon-close\.png/);
const page = elements('pages/index/index.wxml');
assert.equal(page[0].tag, 'page-meta');
assert.ok(attribute(page[1], 'style'), 'background page needs a physical scroll lock');
assert.ok(attribute(page[1], 'bindtap'), 'the page must handle outside taps for search keyboards');
for (const file of ['pages/index/index.wxml', ...readdirSync(new URL('components/', root)).filter((file) => file.endsWith('.wxml')).map((file) => `components/${file}`)]) {
  for (const node of elements(file)) {
    if (node.tag === 'view' && attribute(node, 'slot') && !attribute(node, 'bindtap') && !attribute(node, 'catchtap')) continue;
    if (['button', 'view', 'text', 'image', 'input', 'textarea', 'scroll-view'].includes(node.tag)) assert.equal(attribute(node, 'data-eventsync'), 'true', `${file}: ${node.tag} must dispatch a tap without another timer`);
  }
}
const css = postcss.parse(readFileSync(new URL('app.wxss', root), 'utf8'));
css.walkRules((rule) => {
  if (!rule.selectors.some((selector) => /\.sheet(?:$|-(?:backdrop|scroll|content|footer|header)$)/.test(selector))) return;
  rule.walkDecls((declaration) => {
    if (/^(?:transition|animation)/.test(declaration.prop)) assert.equal(declaration.value, 'none', `${rule.selector}: native input geometry cannot animate`);
  });
});
console.log('微信产物检查通过：同步点击、同层输入、非动画滚动、键盘事件、portal、背景锁定与关闭图标。');
