import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import postcss from 'postcss';
import * as Vue from 'vue';
import * as kitchen from '../src/domain/kitchen.js';
import * as presentation from '../src/domain/presentation.js';
import { presentMutation } from '../src/services/mutation-feedback.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const editorSource = read('../src/components/RecipeEditor.vue');
const pickerSource = read('../src/components/StepImagePicker.vue');
const stylesheet = postcss.parse(read('../src/styles.css'));

function templateNodes(source) {
  const nodes = [];
  function walk(node) {
    if (node.type !== 1) return;
    nodes.push(node);
    node.children.forEach(walk);
  }
  baseParse(parse(source).descriptor.template.content).children.forEach(walk);
  return nodes;
}

const editorNodes = templateNodes(editorSource);
const pickerNodes = templateNodes(pickerSource);
const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
const binding = (node, name) => node.props.find(prop => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === name)?.exp?.content;
const hasClass = (node, name) => attribute(node, 'class')?.split(' ').includes(name);
const classNode = (nodes, name) => nodes.find(node => hasClass(node, name));

function declarationsFor(selector) {
  const declarations = new Map();
  stylesheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

function createEditor(props = {}, overrides = {}, name = 'RecipeEditor') {
  let script = compileScript(parse(name === 'RecipeEditor' ? editorSource : read(`../src/components/${name}.vue`)).descriptor, { id: 'recipe-editor-layout' }).content;
  const modules = { ...Vue, ...kitchen, ...presentation, presentMutation, state: Vue.ref({ recipes: [{ id: 'dish-one' }, { id: 'dish-two' }] }), saveRecipe() {}, saveMealSet() {}, notify() {}, ...overrides };
  script = script.replace(/import (\{[^}]+\}|\w+) from '[^']+';/g, (_, imported) => `const ${imported} = ${imported.startsWith('{') ? 'modules' : '{}'};`);
  return new Function('modules', script.replace('export default', 'return'))(modules).setup(props, { expose() {}, emit() {} });
}

test('new recipe and set editors can save without a photo and keep defaults out of persisted image fields', async () => {
  for (const name of ['RecipeEditor', 'SetEditor']) {
    const saves = [];
    const notices = [];
    let resets = 0;
    const editor = createEditor({}, { saveRecipe: value => saves.push(value), saveMealSet: value => saves.push(value), notify: value => notices.push(value) }, name);
    editor.sheet.value = { resetScroll() { resets += 1; } };
    editor.title.value = '测试封面';
    if (name === 'RecipeEditor') { editor.ingredients.value[0].name = '盐'; editor.steps.value[0].title = '拌匀调味'; }
    else editor.selected.value = ['dish-one', 'dish-two'];
    await editor.save();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].image, '');
    assert.deepEqual(notices, []);
    assert.equal(resets, 0);
    assert.equal(editor.saving.value, false);
    editor.image.value = 'cloud://chosen-cover';
    await editor.save();
    assert.equal(saves.length, 2);
    assert.equal(saves[1].image, 'cloud://chosen-cover');
  }
});

test('editing legacy recipes and sets without a photo preserves their empty cover value', async () => {
  const recipe = { id: 'legacy-dish', title: '旧菜品', category: '素菜', image: '', minutes: 10, ingredients: [{ name: '盐', amountText: '适量', quantity: null, unit: '' }], steps: [{ title: '拌匀调味', text: '', images: [] }] };
  const mealSet = { id: 'legacy-set', title: '旧套餐', image: '', recipeIds: ['dish-one', 'dish-two'] };
  for (const [name, props] of [['RecipeEditor', { recipe }], ['SetEditor', { mealSet }]]) {
    const saves = [];
    const editor = createEditor(props, { saveRecipe: value => saves.push(value), saveMealSet: value => saves.push(value) }, name);
    await editor.save();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].image, '');
  }
});

test('recipe editor omits nutrition fields without clearing existing recipe nutrition', async () => {
  assert.doesNotMatch(parse(editorSource).descriptor.template.content, /营养疗效|v-model="nutrition"|介绍营养特点/);
  const recipe = { id: 'legacy-dish', title: '旧菜品', category: '素菜', image: '', minutes: 10, nutrition: '已有营养说明', ingredients: [{ name: '盐', amountText: '适量', quantity: null, unit: '' }], steps: [{ title: '拌匀调味', text: '', images: [] }] };
  const saves = [];
  const editor = createEditor({ recipe }, { saveRecipe: value => saves.push(value) });
  editor.title.value = '调整后的菜名';
  await editor.save();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].title, '调整后的菜名');
  assert.equal(saves[0].nutrition, recipe.nutrition);
  assert.equal(createEditor().draft.value.nutrition, '');
});

test('recipe field headings reuse the ingredient heading typography without enlarging optional hints or inputs', () => {
  const headings = editorNodes.filter(node => hasClass(node, 'subheading')).map(node => node.children.find(child => child.type === 2)?.content);
  assert.deepEqual(headings, ['菜名', '分类', '耗时 / 分钟', '食材', '做法']);
  assert.equal(declarationsFor('.subheading').get('font-size'), 'var(--type-section)');
  assert.equal(declarationsFor('.subheading').get('font-weight'), '600');
  assert.equal(declarationsFor('.optional-label').get('font-size'), 'var(--type-meta)');
  assert.equal(declarationsFor('.input').get('font-size'), 'var(--type-input)');
  assert.equal(declarationsFor('.textarea').get('font-size'), 'var(--type-input)');
  const columns = classNode(editorNodes, 'form-grid').children.filter(node => node.type === 1);
  assert.ok(columns.every(node => hasClass(node, 'field-label')));
  assert.equal(declarationsFor('.recipe-field-heading').get('align-items'), 'baseline');
});

test('optional recipe hints sit beside their headings with the same typography and spacing', () => {
  const groups = editorNodes.filter(node => hasClass(node, 'recipe-field-heading'));
  const labels = groups.map(group => group.children.filter(node => node.type === 1).map(node => ({
    text: node.children.find(child => child.type === 2)?.content,
    className: attribute(node, 'class'),
  })));
  assert.deepEqual(labels, [
    [{ text: '耗时 / 分钟', className: 'subheading' }, { text: '选填', className: 'optional-label' }],
    [{ text: '做法', className: 'subheading' }, { text: '标题必填，介绍和图片选填', className: 'optional-label' }],
  ]);
  const methodSection = editorNodes.find(node => hasClass(node, 'section-line') && node.children.includes(groups[1]));
  assert.ok(methodSection);
  assert.equal(methodSection.children.filter(node => node.type === 1).length, 1);
  assert.equal(declarationsFor('.recipe-field-heading').get('align-items'), 'baseline');
  assert.equal(declarationsFor('.recipe-field-heading').get('gap'), '2px 6px');
  assert.equal(declarationsFor('.recipe-field-heading .optional-label').get('margin-left'), '0');
  assert.equal(declarationsFor('.optional-label').get('font-size'), 'var(--type-meta)');
  assert.equal(declarationsFor('.optional-label').get('color'), 'var(--muted)');
});

test('set name uses the same heading typography as its recipe selection and recipe editor', () => {
  const nodes = templateNodes(read('../src/components/SetEditor.vue'));
  const headings = nodes.filter(node => hasClass(node, 'subheading')).map(node => node.children.find(child => child.type === 2)?.content);
  assert.deepEqual(headings, ['套餐名称', '搭配菜品']);
  const nameField = classNode(nodes, 'field-label');
  assert.ok(nameField.children.some(node => hasClass(node, 'subheading')));
  const input = nameField.children.find(node => node.tag === 'FormField');
  assert.equal(attribute(input, 'field-class'), 'input');
  assert.equal(attribute(input, 'aria-label'), '套餐名称');
});

test('family appearance field headings reuse the recipe and set heading typography', () => {
  const nodes = templateNodes(read('../src/components/FamilyEditor.vue'));
  const headings = nodes.filter(node => hasClass(node, 'subheading')).map(node => node.children.find(child => child.type === 2)?.content);
  assert.deepEqual(headings, ['家庭封面', '家庭名称', '菜单主标题']);
  assert.equal(declarationsFor('.subheading').get('font-size'), 'var(--type-section)');
  assert.equal(declarationsFor('.subheading').get('font-weight'), '600');
  assert.equal(declarationsFor('.subheading').get('line-height'), '24px');
  const fields = nodes.filter(node => node.tag === 'FormField');
  assert.deepEqual(fields.map(node => attribute(node, 'aria-label')), ['家庭名称', '菜单主标题']);
  assert.ok(fields.every(node => attribute(node, 'field-class') === 'input'));
});

test('recipe, set and family cover pickers retain accessible camera or album labels', () => {
  for (const component of ['RecipeEditor', 'SetEditor', 'FamilyEditor']) {
    const source = read(`../src/components/${component}.vue`);
    const picker = templateNodes(source).find(node => node.tag === 'ImagePicker');
    assert.equal(attribute(picker, 'label'), '拍照/相册', component);
    if (component === 'FamilyEditor') assert.equal(attribute(picker, 'frame'), 'family');
  }
});

test('step cards use one text surface and preserve the keyboard-aware field boundaries', () => {
  const card = classNode(editorNodes, 'step-editor');
  const fields = classNode(editorNodes, 'step-entry-fields').children.filter(node => node.type === 1);
  assert.equal(binding(card, 'key'), 'step.id');
  assert.equal(attribute(card, 'role'), 'group');
  assert.deepEqual(fields.map(node => node.tag), ['FormField', 'FormField']);
  assert.equal(attribute(fields[0], 'maxlength'), '40');
  assert.equal(attribute(fields[1], 'maxlength'), '1000');
  assert.ok(fields[1].props.some(prop => prop.name === 'multiline'));
  assert.doesNotMatch(editorSource, /<(?:input|textarea|label)\b/);
  const cardStyles = declarationsFor('.step-editor');
  assert.equal(cardStyles.get('--step-card-surface'), '#f8fafb');
  assert.equal(cardStyles.get('background'), 'var(--step-card-surface)');
  assert.equal(cardStyles.get('border'), '1px solid var(--line)');
  assert.equal(cardStyles.get('border-radius'), 'var(--radius-card)');
  assert.equal(cardStyles.get('padding'), '14px');
  assert.equal(cardStyles.get('margin'), '16px 0 20px');
  assert.equal(cardStyles.get('overflow'), undefined);
  assert.ok(card.children.some(node => node.tag === 'StepImagePicker'));
  assert.equal(declarationsFor('.step-entry-fields').get('background'), 'var(--white)');
  assert.equal(declarationsFor('.step-entry-fields').get('border'), '1px solid var(--line)');
  assert.equal(declarationsFor('.step-entry-fields').get('border-radius'), 'var(--radius-control)');
  assert.equal(declarationsFor('.step-entry-fields .input').get('background'), 'transparent');
  assert.equal(declarationsFor('.step-entry-fields .textarea').get('height'), '120px');
  assert.equal(declarationsFor('.step-entry-fields .textarea').get('min-height'), '120px');
  assert.equal(declarationsFor('.step-entry-fields').get('overflow'), undefined);
  assert.equal(declarationsFor('.step-entry-fields:focus-within').get('border-color'), 'var(--border-strong)');
});

test('recipe and meal preparation share the deletion icon with separate row-count limits', () => {
  const preparationNodes = templateNodes(read('../src/components/DishPreparationEditor.vue'));
  const remove = editorNodes.find(node => node.tag === 'button' && node.loc.source.includes('@click="removeIngredient(index)"'));
  assert.ok(hasClass(remove, 'icon-button'));
  assert.equal(binding(remove, 'aria-label'), '`删除食材${index + 1}`');
  const trash = remove.children.find(node => node.tag === 'AppIcon');
  assert.equal(attribute(trash, 'name'), 'trash-danger');
  assert.equal(binding(trash, 'size'), '16');
  assert.equal(binding(remove, 'disabled'), 'ingredients.length === 1');
  assert.equal(preparationNodes.some(node => node.loc.source.includes('@click="removeIngredient(index)"')), false);
  const preparationRemove = preparationNodes.find(node => node.tag === 'button' && node.loc.source.includes('@click="removeIngredient(ingredient)"'));
  assert.ok(hasClass(preparationRemove, 'icon-button'));
  assert.equal(attribute(preparationRemove, 'role'), 'button');
  assert.equal(binding(preparationRemove, 'disabled'), 'Boolean(unavailable)');
  assert.match(binding(preparationRemove, 'aria-label'), /删除本餐食材/);
  const preparationTrash = preparationRemove.children.find(node => node.tag === 'AppIcon');
  assert.equal(attribute(preparationTrash, 'name'), attribute(trash, 'name'));
  assert.equal(binding(preparationTrash, 'size'), binding(trash, 'size'));
  assert.equal(preparationNodes.some(node => attribute(node, 'role') === 'switch'), false);
  for (const nodes of [editorNodes, preparationNodes]) {
    const add = nodes.find(node => node.tag === 'button' && node.loc.source.includes('@click="addIngredient"'));
    assert.ok(hasClass(add, 'text-button'));
    if (nodes === preparationNodes) {
      assert.match(add.loc.source, /aria-label="添加食材或配料"/);
      assert.match(add.loc.source, /<AppIcon name="plus" active :size="16" \/><text>添加食材\/配料<\/text>/);
    } else assert.match(add.loc.source, /<AppIcon name="plus"(?: :size="16")? \/><text>添加食材 \/ 配料<\/text>/);
    assert.match(binding(add, 'disabled'), /ingredients.length >= 30/);
  }
});

test('step controls keep 44px targets and guard image uploads, ordering boundaries and the step limit', () => {
  const controls = classNode(editorNodes, 'step-tools').children.filter(node => node.tag === 'button');
  assert.deepEqual(controls.map(node => binding(node, 'disabled')), ['index === 0 || busyImages > 0', 'index === steps.length - 1 || busyImages > 0', 'busyImages > 0']);
  assert.ok(controls.every(node => binding(node, 'aria-label')));
  const remove = controls.find(node => hasClass(node, 'step-remove'));
  assert.equal(remove.children.filter(node => node.type === 2 && node.content.trim()).length, 0);
  const trash = remove.children.find(node => node.tag === 'AppIcon');
  assert.equal(attribute(trash, 'name'), 'trash-danger');
  assert.equal(binding(trash, 'size'), '20');
  assert.equal(declarationsFor('.step-tools button').get('min-width'), '44px');
  assert.equal(declarationsFor('.step-tools button').get('height'), '44px');
  assert.equal(declarationsFor('.step-tools button[disabled]').get('background'), 'transparent');
  const add = editorNodes.find(node => node.tag === 'button' && node.loc.source.includes('steps.push(newStep())'));
  assert.equal(binding(add, 'disabled'), 'steps.length >= MAX_RECIPE_STEPS || busyImages > 0');
  assert.match(editorSource, /@busy="busyImages \+= \$event \? 1 : -1"/);
});

test('step attachment thumbnails and the add control share compact square geometry without cropping stored photos', () => {
  const grid = classNode(pickerNodes, 'step-photo-grid');
  assert.equal(binding(grid, 'class'), undefined);
  assert.equal(declarationsFor('.step-photo-grid').get('display'), 'flex');
  assert.equal(declarationsFor('.step-photo-grid').get('flex-wrap'), 'wrap');
  assert.equal(declarationsFor('.step-photo-grid').get('flex-direction'), undefined);
  assert.equal(declarationsFor('.step-photo-grid').get('grid-template-columns'), undefined);
  assert.equal(declarationsFor('.step-photo-picker').get('--step-photo-size'), '96px');
  for (const selector of ['.step-photo-tile', '.step-photo-add']) {
    const tile = declarationsFor(selector);
    assert.equal(tile.get('width'), 'var(--step-photo-size)');
    assert.equal(tile.get('height'), 'var(--step-photo-size)');
    assert.equal(tile.get('flex'), '0 0 var(--step-photo-size)');
    assert.equal(tile.get('border-radius'), 'var(--radius-control)');
  }
  const image = pickerNodes.find(node => node.tag === 'LazyImage');
  assert.equal(attribute(image, 'mode'), 'aspectFill');
  assert.equal(attribute(image, 'variant'), 'card');
  assert.equal(declarationsFor('.step-photo-add').get('flex-direction'), 'column');
  assert.equal(declarationsFor('.step-photo-add').get('border'), '1px solid var(--line)');
  assert.equal(declarationsFor('.step-photo-preview').get('height'), '100%');
  assert.equal(declarationsFor('.step-photo-tile .card-remove').get('min-height'), '44px');
  assert.match(pickerSource, /chooseLocalImages\(9 - props.modelValue.length/);
  assert.match(pickerSource, /await persistSelectedImages\(failedPaths.value, report\)/);
  assert.match(pickerSource, /@click="preview\(image\)"/);
  assert.match(pickerSource, /previewImages\(props.modelValue, image\)/);
  assert.match(pickerSource, /v-if="modelValue.length \+ pendingPhotos.length < 9"/);
  assert.match(pickerSource, /<ImageUploadProgress v-if="photo.status !== 'failed'" :value="imageUploadLabel\(photo\)" compact/);
  assert.doesNotMatch(pickerSource, /photo-count|photo-processing-grid/);
  assert.doesNotMatch(pickerSource, /ImageCropper|requestCrop|coverFrameStyle/);
  assert.match(pickerSource, /v-if="failedPaths.length && !busy"/);
  assert.match(pickerSource, /useSheetContentResize\(\)/);
});

test('reordering steps preserves stable identities, text, images and valid boundaries', () => {
  const editor = createEditor();
  const first = editor.steps.value[0];
  Object.assign(first, { title: '准备食材', text: '洗净切块', images: ['local-photo-one'] });
  editor.steps.value.push({ ...editor.newStep(), title: '小火慢炖', text: '炖煮二十分钟', images: ['local-photo-two'] });
  const second = editor.steps.value[1];
  editor.moveStep(0, -1);
  editor.moveStep(1, 1);
  assert.deepEqual(editor.steps.value.map(step => step.id), [first.id, second.id]);
  editor.moveStep(1, -1);
  assert.equal(editor.steps.value[0], second);
  assert.equal(editor.steps.value[1], first);
  assert.deepEqual(editor.draft.value.steps.map(step => ({ title: step.title, text: step.text, images: step.images })), [
    { title: '小火慢炖', text: '炖煮二十分钟', images: ['local-photo-two'] },
    { title: '准备食材', text: '洗净切块', images: ['local-photo-one'] },
  ]);
  editor.moveStep(0, 1);
  assert.equal(editor.steps.value[0], first);
});

test('repeated swaps preserve contents and upload-in-progress blocks reordering', () => {
  const editor = createEditor();
  editor.steps.value.push(editor.newStep(), editor.newStep());
  const original = [...editor.steps.value];
  for (let cycle = 0; cycle < 8; cycle++) {
    editor.moveStep(0, 1);
    editor.moveStep(1, 1);
    editor.moveStep(2, -1);
    editor.moveStep(1, -1);
    assert.deepEqual(editor.steps.value, original);
  }
  editor.busyImages.value = 1;
  editor.moveStep(0, 1);
  assert.deepEqual(editor.steps.value, original);
});

test('step removal and addition retain optional content without reusing field identities', () => {
  const editor = createEditor();
  const initialId = editor.steps.value[0].id;
  assert.deepEqual(editor.draft.value.steps, []);
  editor.steps.value.splice(0, 1);
  assert.deepEqual(editor.draft.value.steps, []);
  editor.steps.value.push(editor.newStep());
  assert.notEqual(editor.steps.value[0].id, initialId);
  editor.steps.value[0].text = '只填写做法也能保留';
  assert.equal(editor.draft.value.steps[0].text, '只填写做法也能保留');
  editor.steps.value[0].text = '';
  editor.steps.value[0].images.push('local-photo-only');
  assert.deepEqual(editor.draft.value.steps[0].images, ['local-photo-only']);
});


test('saving requires at least one titled step, reveals missing titles, and accepts an empty optional body', async () => {
  const saves = [];
  const editor = createEditor({}, { saveRecipe: value => saves.push(value) });
  editor.title.value = '凉拌菜';
  editor.ingredients.value[0].name = '盐';
  await editor.save();
  assert.equal(saves.length, 0);
  assert.match(editor.fieldErrors.value['steps.0.title'], /标题/);
  editor.steps.value[0].text = '只填正文也需要标题';
  await editor.save();
  assert.equal(saves.length, 0);
  editor.steps.value[0].title = '拌匀调味';
  editor.steps.value[0].text = '';
  await editor.save();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].steps[0].title, '拌匀调味');
  assert.equal(saves[0].steps[0].text, '');
  editor.steps.value = [];
  await editor.save();
  assert.equal(saves.length, 1);
  assert.match(editor.fieldErrors.value.steps, /至少/);
});
