import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRecipe, publicCookingText, buildGenericPost, interleavedDates} from '../scripts/generic-recipe-import.mjs';
const draft = {title:'测试菜',category:'素菜',minutes:10,servings:2,image:'cover',ingredients:[{name:'盐',quantity:1,unit:'g'}],steps:[{title:'拌匀',text:'搅拌均匀',images:['step']}],provenance:{source:'任意来源'},sourceMetadata:{secret:'archive'},tags:['快手']};
const resolve = value => `cloud://test.env/${value}`;
test('菜品介绍与所有分段备料说明不能作为烹饪步骤发布',()=>{
 const input={...draft,steps:[{title:'菜品介绍',text:'介绍'},{title:'备料说明',text:'备料'},{title:'备料说明 2',text:'更多备料'},...draft.steps]};
 const recipe=publicRecipe(input,resolve,'source:with-intro');
 assert.deepEqual(recipe.steps.map(step=>step.title),['拌匀']);
 assert.deepEqual(recipe.ingredients,draft.ingredients);
 assert.equal(input.steps.length,4);
});
test('正文中的外部引用和贡献提示不进入烹饪界面',()=>{
 assert.equal(publicCookingText('翻炒2分钟。\n参考资料：任意网站\n参考视频：https://example.org/video\n欢迎提出 Issue 或 Pull request\n提示：洋葱是香味的来源'), '翻炒2分钟。\n提示：洋葱是香味的来源');
});
test('步骤用时保持原数值并用可读时间表达',()=>{
 assert.equal(publicCookingText('参考用时：3600 秒。\n参考用时：90 秒。'), '参考用时：1小时。\n参考用时：1分钟30秒。');
});
test('任意来源使用同一契约，来源资料不进入公开菜谱',()=>{
 const recipe=publicRecipe(draft,resolve,'new-provider:abc');
 assert.equal(recipe.provenance,undefined);assert.equal(recipe.sourceMetadata,undefined);
 assert.equal(recipe.steps[0].images[0],resolve('step'));
 assert.equal(recipe.id,publicRecipe(draft,resolve,'new-provider:abc').id);
 assert.notEqual(recipe.id,publicRecipe(draft,resolve,'another-provider:abc').id);
});
test('拒绝原始文字用量、混合用量及未上传图片',()=>{
 for(const ingredient of [{name:'盐',amountText:'2杯'},{name:'盐',quantity:2,unit:'桶'},{name:'盐',quantity:2,unit:'g',amountText:'适量'}])assert.throws(()=>publicRecipe({...draft,ingredients:[ingredient]},resolve,'id'));
 for(const amountText of ['适量','少许']) assert.doesNotThrow(()=>publicRecipe({...draft,ingredients:[{name:'盐',amountText}]},resolve,'id'));
 assert.throws(()=>publicRecipe(draft,x=>x,'id'));
});
test('保留真实导入时间，展示时间夹在旧记录之间',()=>{
 const previous=[{status:'published',publishedAt:'2026-09-01'},{status:'published',publishedAt:'2026-10-01'}];
 const dates=interleavedDates(previous,363);assert.equal(dates.length,363);
 assert.ok(dates[0]>Date.parse(previous[0].publishedAt));assert.ok(dates.at(-1)<Date.parse(previous[1].publishedAt));
 const importedAt=Date.parse('2026-10-28');const post=buildGenericPost({draft,resolveImage:resolve,identity:'test:abc',familyId:'family',jobId:'batch',importedAt,displayAt:dates[0]});
 assert.equal(post.author,'食愿小灶');assert.equal(post.createdAt,dates[0]);assert.equal(post.importedAt,importedAt);assert.equal(post.recipes[0].provenance,undefined);assert.equal(post.assetIds.length,2);
});
