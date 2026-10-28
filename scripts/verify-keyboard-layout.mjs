import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baseParse } from '@vue/compiler-dom';

const project = resolve('dist/release');
const output = resolve(process.env.KEYBOARD_QA_OUTPUT || 'artifacts/deployment/input-lifecycle-20260914');
mkdirSync(output, { recursive: true });
const receipt = { method: 'Native-renderer layout checks with simulated focus and keyboard-height events. Not physical iPhone typing.', submitted: false, fields: [], familyTabs: [] };
function run(tool, args = []) {
  const text = execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', tool, '--project', project, ...args], { encoding: 'utf8', timeout: 90000 });
  const response = JSON.parse(text.slice(text.indexOf('{')));
  assert.equal(response.ok, true, text);
  assert.equal(response.result.success, true, text);
  return response.result.result?.result ?? response.result;
}
const evaluate = code => run('automation_evaluate', ['--fn-source', code]);
function elements(file) {
  const result = [];
  function walk(node) { if (node.type === 1) { result.push(node); node.children.forEach(walk); } }
  baseParse(readFileSync(`${project}/miniprogram/${file}.wxml`, 'utf8')).children.forEach(walk);
  return result;
}
const attribute = (node, name) => node.props.find(prop => prop.name === name)?.value?.content;
const binding = (node, name) => attribute(node, name).slice(2, -2);
const inputs = elements('components/FormField');
function button(component, predicate) {
  const node = elements(`components/${component}`).find(predicate);
  assert.ok(node, `Missing ${component} button`);
  const key = binding(node, attribute(node, 'bindtap') ? 'bindtap' : 'catchtap');
  evaluate(`function(){const qa=getApp().__keyboardLayoutQA;qa.fire(qa.find(${JSON.stringify(component)}).$scope,${JSON.stringify(key)},'tap',{});return true;}`);
}
const tap = label => run('automation_element_action', ['--selector', `[aria-label="${label}"]`, '--action', 'tap']);
const close = component => evaluate(`function(){getApp().__keyboardLayoutQA.find(${JSON.stringify(component)}).$emit('close');return true;}`);
function verifyField(label, height = 350) {
  const multiline = evaluate(`function(){return Boolean(getApp().__keyboardLayoutQA.find('FormField',${JSON.stringify(label)}).$props.multiline);}`);
  const node = inputs.find(node => node.tag === (multiline ? 'textarea' : 'input'));
  const metrics = evaluate(`async function(){const qa=getApp().__keyboardLayoutQA;const field=qa.find('FormField',${JSON.stringify(label)});qa.fire(field.$scope,${JSON.stringify(binding(node, 'bindfocus'))},'focus',{height:${height}});await qa.settle();return qa.measure(field);}`);
  assert.ok(metrics.field.top >= metrics.viewport.top - 1, `${label}: input above viewport ${JSON.stringify(metrics)}`);
  assert.ok(metrics.field.bottom <= metrics.viewport.bottom + 1, `${label}: input below viewport ${JSON.stringify(metrics)}`);
  assert.equal(metrics.mask.top, 0);
  assert.equal(metrics.mask.bottom, metrics.windowHeight);
  if (metrics.footer) assert.ok(metrics.field.bottom <= metrics.footer.top, `${label}: footer occludes field`);
  const restored = evaluate(`async function(){const qa=getApp().__keyboardLayoutQA;const field=qa.find('FormField',${JSON.stringify(label)});qa.fire(field.$scope,${JSON.stringify(binding(node, 'bindblur'))},'blur',{value:field.$props.modelValue});await qa.settle();const sheet=qa.find('Sheet');sheet.$.provides.sheetKeyboard.keyboard({height:${height}});await qa.settle();return qa.measure(field);}`);
  assert.equal(restored.sheet.bottom, restored.windowHeight, `${label}: blur without height-zero must restore panel`);
  receipt.fields.push({ label, multiline, keyboardHeight: height, visible: true, field: metrics.field, viewport: metrics.viewport, restoredBottom: restored.sheet.bottom });
}

try {
  evaluate(`function(){const app=getApp();if(app.__keyboardLayoutQA)throw new Error('Previous layout QA must be cleaned up');app.__keyboardLayoutQA={
    find(name,label){function walk(vm){if(vm.$options.__name===name&&(!label||vm.$props.ariaLabel===label))return vm;for(const child of vm.$children){const result=walk(child);if(result)return result;}}const result=walk(getCurrentPages()[0].$vm);if(!result)throw new Error('Missing '+name+' '+label);return result;},
    fire(scope,key,type,detail){scope[scope.data[key]]({type,detail,target:{dataset:{eventsync:true,keyboardField:type!=='tap'}},currentTarget:{dataset:{eventsync:true}}});},
    settle(){return new Promise(resolve=>setTimeout(resolve,500));},
    async measure(field){const sheet=this.find('Sheet');const bounds=await new Promise(resolve=>wx.createSelectorQuery().in(field.$scope).select('.form-field').boundingClientRect().exec(resolve));const frame=await new Promise(resolve=>wx.createSelectorQuery().in(sheet.$scope).select('.sheet-scroll').fields({rect:true,size:true,scrollOffset:true}).select('.sheet-mask').boundingClientRect().select('.sheet-footer').boundingClientRect().select('.sheet').boundingClientRect().exec(resolve));return {field:bounds[0],viewport:frame[0],mask:frame[1],footer:frame[2],sheet:frame[3],windowHeight:wx.getWindowInfo().windowHeight};}
  };return true;}`);
  evaluate(`function(){const qa=getApp().__keyboardLayoutQA;try{qa.find('RecipeEditor').$emit('close');}catch(error){}return true;}`);
  tap('点餐');
  tap('创建菜品');
  for (const label of ['菜名', '耗时分钟（选填）', '营养疗效', '食材1名称', '步骤1标题', '步骤1介绍']) verifyField(label);
  for (const [unit, label] of [['适量', '食材1名称'], ['少许', '食材1名称'], ['g', '食材1数量']]) {
    const changed = evaluate(`function(){const qa=getApp().__keyboardLayoutQA;function walk(vm){if(vm.$options.__name==='SelectField'&&vm.$props.label==='食材1用量'){vm.$emit('update:modelValue',${JSON.stringify(unit)});return true;}return vm.$children.some(walk);}return walk(qa.find('RecipeEditor'));}`);
    assert.equal(changed, true, 'Missing ingredient amount selector');
    verifyField(label);
  }
  close('RecipeEditor');
  tap('创建套餐');
  verifyField('套餐名称');
  close('SetEditor');
  evaluate(`function(){getApp().__keyboardLayoutQA.find('PageHeader').$emit('edit');return true;}`);
  verifyField('家庭名称');
  verifyField('封面标题');
  button('FamilyEditor', node => node.tag === 'button' && node.loc.source.includes('>切换与管理</button>'));
  button('FamilyManagement', node => attribute(node, 'class') === 'secondary-button full family-create-button');
  verifyField('新家庭名称');
  for (let round = 0; round < 3; round += 1) {
    for (const tab of ['appearance', 'management']) {
      button('FamilyEditor', node => node.tag === 'button' && node.loc.source.includes(tab === 'appearance' ? '>名称与封面</button>' : '>切换与管理</button>'));
      const panels = evaluate(`async function(){const qa=getApp().__keyboardLayoutQA;await qa.settle();const editor=qa.find('FamilyEditor');const management=qa.find('FamilyManagement');const sheet=qa.find('Sheet');const rect=async(vm,selector)=>new Promise(resolve=>wx.createSelectorQuery().in(vm.$scope).select(selector).boundingClientRect().exec(result=>resolve(result[0])));const fields=[];function walk(vm){if(vm.$options.__name==='FormField')fields.push(vm.$props.ariaLabel);vm.$children.forEach(walk);}walk(editor);return {appearance:Boolean(await rect(editor,'.family-appearance-panel')),management:Boolean(await rect(management,'.family-management-panel')),footer:Boolean(await rect(sheet,'.sheet-footer')),fields};}`);
      assert.equal(panels.appearance, tab === 'appearance');
      assert.equal(panels.management, tab === 'management');
      assert.equal(panels.footer, tab === 'appearance');
      assert.deepEqual(panels.fields.sort(), tab === 'appearance' ? ['家庭名称', '封面标题'].sort() : ['新家庭名称']);
      receipt.familyTabs.push({ round, tab, ...panels });
    }
  }
  close('FamilyEditor');
  tap('家庭');
  evaluate(`function(){const scope=getApp().__keyboardLayoutQA.find('FamilyView').$scope;const member=scope.data.h.find(member=>member.n);scope[member.q]({type:'tap',detail:{},target:{dataset:{}},currentTarget:{dataset:{}}});return true;}`);
  verifyField('昵称');
  close('ProfileEditor');
  tap('点餐');
  const picked = JSON.parse(execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', 'automation_element_action', '--project', project, '--selector', '.pick-button', '--action', 'attribute', '--name', 'aria-pressed'], { encoding: 'utf8' }));
  assert.equal(picked.ok, true);
  if (!picked.result) run('automation_element_action', ['--selector', '.pick-button', '--action', 'tap']);
  tap('查看已选菜品');
  verifyField('点餐备注');
  close('Sheet');
  if (!picked.result) run('automation_element_action', ['--selector', '.pick-button', '--action', 'tap']);
  tap('广场');
  evaluate(`function(){const scope=getApp().__keyboardLayoutQA.find('CommunityView').$scope;const post=scope.data.l.flatMap(lane=>lane.a)[0];if(!post)throw new Error('Need an existing community card');scope[post.j]({type:'tap',detail:{},target:{dataset:{}},currentTarget:{dataset:{}}});return true;}`);
  verifyField('评论内容');
  close('Sheet');
  receipt.ok = true;
} catch (error) {
  receipt.error = error.message;
  throw error;
} finally {
  evaluate(`function(){delete getApp().__keyboardLayoutQA;return true;}`);
  writeFileSync(`${output}/native-layout-regression.json`, JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ ok: receipt.ok, fields: receipt.fields.map(field => field.label), submitted: false }));
