import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { coverFrameStyle, COVER_RATIOS } from '../src/domain/image-crop.js';

const editor = readFileSync(new URL('../src/components/StockEditor.vue', import.meta.url), 'utf8');
const picker = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
const editorNodes = elements(parse(editor).descriptor.template.ast);
const pickerNodes = elements(parse(picker).descriptor.template.ast);

function elements(node) {
  return [...(node.type === 1 ? [node] : []), ...(node.children || []).flatMap(elements)];
}

function hasClass(node, name) {
  return node.props.some(prop => prop.type === 6 && prop.name === 'class' && prop.value.content.split(/\s+/).includes(name));
}

function directive(node, name, argument) {
  return node.props.find(prop => prop.type === 7 && prop.name === name && prop.arg?.content === argument);
}

function declarations(selector) {
  const result = new Map();
  styles.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => result.set(declaration.prop, declaration.value));
  });
  return result;
}

test('the purchase sheet uses the ingredient name as its only heading and fits its content', () => {
  const sheet = editorNodes.find(node => node.tag === 'Sheet');
  const title = new Function('purchase', 'draft', `return ${directive(sheet, 'bind', 'title').exp.content}`);
  for (const name of ['胡萝卜', '鲜香菇', '火锅用鲜切牛肉片']) assert.equal(title(true, { name }), name);
  assert.equal(title(true, { name: '' }), '确认采购');
  assert.equal(title(false, { name: '胡萝卜' }), '记录食材');
  assert.equal(directive(sheet, 'bind', 'preferred-height'), undefined);
  assert.doesNotMatch(editor, /purchase-summary/);
  assert.equal(declarations('.purchase-summary-media').size, 0);
  assert.equal(declarations('.sheet-heading').get('text-align'), 'center');
});

test('purchase and inventory photos share the full-width golden-ratio uploader and in-frame percentage', () => {
  const uploaders = editorNodes.filter(node => node.tag === 'ImagePicker');
  assert.equal(uploaders.length, 1);
  const imagePicker = uploaders[0];
  assert.ok(!imagePicker.props.some(prop => prop.name === 'compact' || prop.arg?.content === 'compact'));
  assert.equal(imagePicker.props.find(prop => prop.name === 'frame').value.content, 'recipe');
  assert.equal(declarations('.image-upload').get('width'), '100%');
  assert.equal(coverFrameStyle('recipe').paddingTop, `${100 / COVER_RATIOS.recipe}%`);
  const frame = pickerNodes.find(node => hasClass(node, 'image-picker-frame'));
  const overlay = elements(frame).find(node => node.tag === 'ImageUploadProgress');
  assert.ok(overlay);
  assert.equal(directive(overlay, 'if').exp.content, 'busy');
  assert.equal(directive(overlay, 'bind', 'compact').exp.content, 'compact');
  assert.equal(directive(overlay, 'bind', 'value').exp.content, 'progress');
  assert.doesNotMatch(picker, /调整展示位置|移除图片|上传原图|photo-count|image-picker-actions/);
  const caption = pickerNodes.find(node => hasClass(node, 'upload-caption'));
  assert.equal(directive(caption, 'if').exp.content, '!busy');
});

test('purchase image layout preserves fridge-off presentation and upload/save guards', () => {
  const photo = editorNodes.find(node => node.tag === 'ImagePicker');
  const canUpload = new Function('purchase', 'state', `return ${directive(photo, 'if').exp.content}`);
  for (const fridge of [false, true]) {
    assert.equal(canUpload(false, { family: { features: { fridge } } }), true);
    assert.equal(canUpload(true, { family: { features: { fridge } } }), fridge);
  }
  assert.equal(directive(photo, 'model').exp.content, 'draft.image');
  assert.equal(directive(photo, 'on', 'busy').exp.content, 'busy = $event');
  assert.equal(directive(photo, 'bind', 'disabled').exp.content, 'saving');
  const fallback = editorNodes.find(node => hasClass(node, 'stock-cover-fallback'));
  assert.ok(directive(fallback, 'else'));
  assert.ok(hasClass(fallback, 'image-picker'));
  const fallbackFrame = elements(fallback).find(node => hasClass(node, 'image-upload'));
  assert.equal(directive(fallbackFrame, 'bind', 'style').exp.content, "coverFrameStyle('recipe')");
  assert.ok(elements(fallback).every(node => node.tag !== 'button' && node.tag !== 'ImagePicker'));
  assert.equal(elements(fallback).find(node => node.tag === 'image').props.find(prop => prop.name === 'mode').value.content, 'aspectFill');
  const saveButton = editorNodes.find(node => node.tag === 'button' && directive(node, 'on', 'click')?.exp.content === 'save');
  assert.equal(directive(saveButton, 'bind', 'disabled').exp.content, 'busy || saving');
  assert.match(editor, /if \(busy\.value \|\| saving\.value\) return;/);
  assert.match(picker, /<text v-if="error \|\| validationError" class="error-message" role="alert"/);
});

test('remaining compact uploaders keep their centered camera and home controls stay unchanged', () => {
  const caption = pickerNodes.find(node => hasClass(node, 'upload-caption'));
  const camera = elements(caption).find(node => node.tag === 'AppIcon');
  assert.equal(directive(camera, 'bind', 'size').exp.content, 'compact ? 14 : 16');
  const compact = declarations('.compact-image-picker .upload-caption');
  assert.equal(compact.get('top'), '50%');
  assert.equal(compact.get('left'), '50%');
  assert.equal(compact.get('right'), 'auto');
  assert.equal(compact.get('bottom'), 'auto');
  assert.equal(compact.get('transform'), 'translate(-50%, -50%)');
  for (const dimension of ['width', 'height', 'min-height']) assert.equal(compact.get(dimension), '28px');
  assert.equal(compact.get('background'), 'var(--photo-action-surface)');
  for (const dimension of ['width', 'height']) assert.equal(declarations('.compact-image-picker .image-upload').get(dimension), '60px');
  assert.equal(declarations('.upload-caption').get('pointer-events'), 'none');
  assert.equal(declarations('.hero-edit').get('right'), '6px');
  assert.equal(declarations('.hero-edit').get('bottom'), '6px');
  assert.equal(declarations('.hero-edit').get('width'), '44px');
});
