import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseParse } from '@vue/compiler-dom';

const project = resolve('dist/release');
const output = resolve('artifacts/deployment/input-cover-20260914');
const receipt = { keyboardEvents: 'focus/input handler simulation only; does not verify native tap-to-focus or a physical iPhone keyboard', destructiveActions: false };
const run = (tool, args = []) => {
  const text = execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', tool, '--project', project, ...args], { encoding: 'utf8', timeout: 90000 });
  const result = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(result.ok, true, text);
  assert.notEqual(result.result?.success, false, text);
  return result.result?.result?.result ?? result.result;
};
const evaluate = code => run('automation_evaluate', ['--fn-source', code]);
const screenshot = name => run('simulator_screenshot', ['--path', `${output}/${name}.png`, '--optimize', 'false']);
function nodes(file) {
  const result = [];
  function walk(node) { if (node.type === 1) { result.push(node); node.children.forEach(walk); } }
  baseParse(readFileSync(`${project}/miniprogram/${file}.wxml`, 'utf8')).children.forEach(walk);
  return result;
}
const attribute = (node, name) => node.props.find(prop => prop.name === name)?.value?.content;
const binding = (node, name) => attribute(node, name).slice(2, -2);
const fieldNodes = nodes('components/FormField');
const nativeField = multiline => fieldNodes.find(node => node.tag === (multiline ? 'textarea' : 'input'));
const sheetNodes = nodes('components/Sheet');
const sheetNode = sheetNodes.find(node => attribute(node, 'class') === 'sheet');
const managementNodes = nodes('components/FamilyManagement');
const deletionNode = managementNodes.find(node => attribute(node, 'class') === 'secondary-button danger full');
const event = (scope, key, type = 'tap', detail = '{}', keyboardField = false) => `getApp().__inputCoverQA.fire(${scope}, ${JSON.stringify(key)}, ${JSON.stringify(type)}, ${detail}, ${keyboardField})`;
function typeField(label, value, multiline = false) {
  const field = nativeField(multiline);
  return evaluate(`function(){const qa=getApp().__inputCoverQA;const field=qa.find('FormField', ${JSON.stringify(label)});const scope=field.$scope;const sheet=qa.find('Sheet').$scope;
    ${event('scope', binding(field, 'bindfocus'), 'focus', '{height:300}')};
    ${event('sheet', binding(sheetNode, 'bindtouchstart'), 'touchstart', '{}', true)};
    ${event('scope', binding(field, 'bindinput'), 'input', `{value:${value}}`)};
    ${event('sheet', binding(sheetNode, 'bindtouchend'), 'touchend', '{}', true)};
    ${event('sheet', binding(sheetNode, 'catchtap'), 'tap', '{}', true)};
    return {hidden:qa.hidden,fieldDisabled:Boolean(field.$props.disabled)};
  }`);
}
try {
  evaluate(`function(){const app=getApp();if(app.__inputCoverQA)throw new Error('Existing input QA must be restored first');const cloud=require('services/cloud.js');
    const qa=app.__inputCoverQA={hidden:0,hide:wx.hideKeyboard,manageFamily:cloud.manageFamily,cloudWrites:0};
    wx.hideKeyboard=function(){qa.hidden++;return qa.hide.apply(this,arguments);};
    cloud.manageFamily=function(){qa.cloudWrites++;throw new Error('Family writes disabled during input QA');};
    qa.find=function(name,label){function walk(vm){if(vm.$options.__name===name&&(!label||vm.$props.ariaLabel===label))return vm;for(const child of vm.$children){const found=walk(child);if(found)return found;}}return walk(getCurrentPages()[0].$vm);};
    qa.fire=function(scope,key,type,detail,keyboardField){if(typeof scope[scope.data[key]]!=='function')throw new Error('Missing native handler '+key);scope[scope.data[key]]({type:type,detail:detail||{},target:{dataset:{eventsync:true,keyboardField:keyboardField}},currentTarget:{dataset:{eventsync:true}},changedTouches:[{clientX:120,clientY:200}]});};
    if(!qa.find('FamilyEditor'))qa.find('PageHeader').$emit('edit');return true;}`);
  const managementTab = nodes('components/FamilyEditor').find(node => node.tag === 'button' && node.loc.source.includes('>切换与管理</button>'));
  evaluate(`function(){const qa=getApp().__inputCoverQA;${event("qa.find('FamilyEditor').$scope", binding(managementTab, 'bindtap'))};return true;}`);
  const deleteEntry = managementNodes.find(node => attribute(node, 'class') === 'family-exit-button danger');
  evaluate(`function(){const qa=getApp().__inputCoverQA;if(!qa.find('FormField','输入家庭名称确认')){${event("qa.find('FamilyManagement').$scope", binding(deleteEntry, 'bindtap'))};}qa.hidden=0;return true;}`);
  receipt.deleteTyping = typeField('输入家庭名称确认', "require('store.js').state.value.family.name");
  assert.deepEqual(receipt.deleteTyping, { hidden: 0, fieldDisabled: false });
  receipt.deleteConfirmation = evaluate(`function(){const qa=getApp().__inputCoverQA;const field=qa.find('FormField','输入家庭名称确认');return {nameMatches:field.$props.modelValue===require('store.js').state.value.family.name,buttonDisabled:qa.find('FamilyManagement').$scope.data.${binding(deletionNode, 'disabled')},cloudWrites:qa.cloudWrites};}`);
  assert.deepEqual(receipt.deleteConfirmation, { nameMatches: true, buttonDisabled: false, cloudWrites: 0 });
  screenshot('delete-name-input');
  evaluate(`function(){const qa=getApp().__inputCoverQA;${event("qa.find('FormField','输入家庭名称确认').$scope", binding(nativeField(false), 'bindblur'), 'blur')};qa.find('FamilyEditor').$emit('close');return true;}`);
  const createButton = nodes('pages/index/index').find(node => attribute(node, 'aria-label') === '创建菜品');
  evaluate(`function(){${event('getCurrentPages()[0]', binding(createButton, 'catchtap'))};getApp().__inputCoverQA.hidden=0;return true;}`);
  receipt.nutritionTyping = typeField('营养疗效', "'营养输入回归，未保存'", true);
  assert.equal(receipt.nutritionTyping.hidden, 0);
  receipt.stepTyping = typeField('步骤1介绍', "'步骤输入回归，未保存'", true);
  assert.equal(receipt.stepTyping.hidden, 0);
  receipt.recipeDraft = evaluate(`function(){const qa=getApp().__inputCoverQA;return {nutrition:qa.find('FormField','营养疗效').$props.modelValue,step:qa.find('FormField','步骤1介绍').$props.modelValue};}`);
  assert.deepEqual(receipt.recipeDraft, { nutrition: '营养输入回归，未保存', step: '步骤输入回归，未保存' });
  screenshot('recipe-step-input');
  receipt.outsideTouch = evaluate(`function(){const qa=getApp().__inputCoverQA;const scope=qa.find('Sheet').$scope;${event('scope', binding(sheetNode, 'bindtouchstart'), 'touchstart')};${event('scope', binding(sheetNode, 'bindtouchend'), 'touchend')};${event('scope', binding(sheetNode, 'catchtap'))};return qa.hidden;}`);
  assert.equal(receipt.outsideTouch, 1);
  evaluate(`function(){getApp().__inputCoverQA.find('RecipeEditor').$emit('close');return true;}`);
  receipt.cover = evaluate(`async function(){const invite=require('services/family-invitation.js').familyInvitation.prepared.value;if(!invite)throw new Error('No existing invitation; do not mint one in this test');const cloud=require('services/cloud.js');const result=await cloud.invokeCloud('readInvite',{token:invite.token});const family=require('store.js').state.value.family;if(result.familyCover!==family.cover)throw new Error('Invitation must use current family cover');cloud.setInviteMediaToken(invite.token);const image=await cloud.loadImage(result.familyCover,'detail');cloud.setInviteMediaToken();getApp().__inputCoverQA.invitePath='/pages/invite/index?token='+invite.token;return {matchesFamilyCover:true,imageLoaded:Boolean(image),isCloudCover:result.familyCover.startsWith('cloud://')};}`);
  assert.equal(receipt.cover.imageLoaded, true);
  evaluate(`function(){wx.navigateTo({url:getApp().__inputCoverQA.invitePath});return true;}`);
  for (let attempt = 0; attempt < 15; attempt += 1) {
    receipt.coverFrame = evaluate(`async function(){const page=getCurrentPages()[getCurrentPages().length-1];if(page.route!=='pages/invite/index')return null;const vm=page.$vm.$children.find(vm=>vm.$options.__name==='LazyImage');if(!vm)return null;return new Promise(resolve=>wx.createSelectorQuery().in(vm.$scope).select('.lazy-photo-image').boundingClientRect().exec(rects=>resolve(rects[0])));}`);
    if (receipt.coverFrame?.width > 200 && receipt.coverFrame?.height > 100) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(receipt.coverFrame?.width > 200 && receipt.coverFrame?.height > 100, 'Invitation cover must visibly render, not merely return an image ID');
  screenshot('invitation-family-cover');
  receipt.ok = true;
} catch (failure) { receipt.error = failure.message; throw failure; }
finally {
  receipt.restored = evaluate(`function(){const app=getApp();const qa=app.__inputCoverQA;if(qa){wx.hideKeyboard=qa.hide;require('services/cloud.js').manageFamily=qa.manageFamily;delete app.__inputCoverQA;}return true;}`);
  writeFileSync(`${output}/native-input-cover.json`, JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify(receipt));
