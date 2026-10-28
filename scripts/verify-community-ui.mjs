import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createSeed } from '../src/data/seed.js';

const project = `${process.cwd()}/dist/release`;
const directory = `${process.cwd()}/artifacts/deployment/performance`;
const receipt = { fixtureOnly: true, cloudWrites: false, assertions: [] };
const run = (tool, args = []) => {
  const output = execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', tool, '--project', project, ...args], { encoding: 'utf8', timeout: 90000 });
  const result = JSON.parse(output.slice(output.indexOf('{')));
  assert.equal(result.ok, true, output);
  assert.notEqual(result.result?.success, false, output);
  return result.result?.result?.result ?? result.result;
};
const evaluate = source => run('automation_evaluate', ['--fn-source', source]);
const tap = selector => run('automation_element_action', ['--selector', selector, '--action', 'tap', '--wait-for-selector', selector]);
await mkdir(directory, { recursive: true });
const recipes = createSeed().recipes.slice(0, 3).map(recipe => ({ ...recipe, steps: Array.from({ length: 8 }, (_, index) => ({ title: `视觉验收步骤 ${index + 1}`, text: '测试数据，仅在模拟器内存使用，不写入云端。', images: ['/static/tofu.png', '/static/tomato.png'] })) }));
try {
  const argsPath = `${directory}/community-ui-fixture-args.json`;
  await writeFile(argsPath, JSON.stringify([recipes]));
  run('automation_evaluate', ['--args-file', argsPath, '--fn-source', `function(recipes) {
    const app = getApp(); const cloud = require('services/cloud.js');
    if (app.__communityFixture) throw new Error('已有测试替换，请先恢复');
    const original = cloud.invokeCloud;
    app.__communityFixture = { original: original, calls: [], comments: require('store.js').state.value.comments };
    const posts = Array.from({length:35}, (_, index) => ({ id:'qa-post-'+index, title:index === 0 ? '验收套餐' : '验收菜品 '+index, kind:index === 0 ? 'menu' : 'dish', author:'模拟器测试', importedFamilyCount:12, image:'/static/tofu.png', categories:['素菜'], recipes:index === 0 ? recipes : [recipes[0]] }));
    cloud.invokeCloud = async function(action, query) {
      if (action === 'feed') {
        app.__communityFixture.calls.push({action:action,cursor:query.cursor});
        const offset = Number(query.cursor || 0);
        return { posts:posts.slice(offset,offset+16).map(post => ({...post,recipes:post.recipes.map(recipe => ({id:recipe.id,title:recipe.title,category:recipe.category,image:recipe.image}))})), cursor:offset+16 < posts.length ? String(offset+16) : '', media:{} };
      }
      if (action === 'readPost') return {post:posts.find(post => post.id === query.postId),comments:[],commentCursor:'',media:{}};
      if (action === 'command' || action === 'report') throw new Error('测试夹具禁止云写');
      return original(action,query);
    };
    require('services/community-feed.js').invalidateCommunityFeed();
    return {fixtureReady:true};
  }`]);
  tap('.nav-item[aria-label="广场"]');
  run('simulator_screenshot', ['--path', `${directory}/community-fixture-before-query.png`]);
  const count = () => {
    return evaluate('function(){return getCurrentPages()[0].selectComponent(".r").data.l.reduce((sum,lane)=>sum+lane.a.length,0);}');
  };
  receipt.firstPage = count();
  run('simulator_screenshot', ['--path', `${directory}/community-fixture-cards.png`]);
  evaluate('function(){const component=getCurrentPages()[0].selectComponent(".r");component[component.data.l[0].a[0].j]({type:"tap",target:{dataset:{}},currentTarget:{dataset:{eventsync:true}},detail:{}});return true;}');
  evaluate('function(){const component=getCurrentPages()[0].selectComponent(".r");component[component.data.H[0].g]({type:"tap",target:{dataset:{}},currentTarget:{dataset:{eventsync:true}},detail:{}});return true;}');
  const sheetWxml = await readFile(`${project}/miniprogram/components/Sheet.wxml`, 'utf8');
  const scrollKey = sheetWxml.match(/scroll-top="{{(\w+)}}"/)[1];
  evaluate(`function(){const component=getCurrentPages()[0].selectComponent('.r');const sheet=component.$vm.$children.find(child=>child.$options.__name==='Sheet').$scope;sheet.setData({${scrollKey}:650});return true;}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  receipt.lazy = evaluate(`async function(){const component=getCurrentPages()[0].selectComponent('.r');const output=[];function walk(vm){if(vm.$options.__name==='LazyImage')output.push(vm);(vm.$children||[]).forEach(walk);}walk(component.$vm);return Promise.all(output.slice(-16).map(vm=>new Promise(resolve=>wx.createSelectorQuery().in(vm.$scope).select('.lazy-photo-image').boundingClientRect(rect=>resolve({src:vm.$props.src,loaded:!!rect,rect})).exec())));}`);
  run('simulator_screenshot', ['--path', `${directory}/community-fixture-steps.png`]);
  receipt.steps = evaluate('function(){const component=getCurrentPages()[0].selectComponent(".r");return {expanded:component.data.H[0].h,sheetOpen:Boolean(component.data.w)};}');
  evaluate('function(){const component=getCurrentPages()[0].selectComponent(".r");component[component.data.al]({type:"close",target:{dataset:{}},currentTarget:{dataset:{}},detail:{}});return true;}');
  evaluate('function(){getCurrentPages()[0].onReachBottom();return true;}');
  receipt.secondPage = count();
  evaluate('function(){getCurrentPages()[0].onReachBottom();return true;}');
  receipt.thirdPage = count();
  assert.deepEqual([receipt.firstPage,receipt.secondPage,receipt.thirdPage],[16,32,35]);
  assert.ok(receipt.lazy[0].rect?.height >= 100 && receipt.lazy[0].rect?.width >= 100);
  assert.ok(receipt.lazy.filter(image => image.loaded).length < 16);
  receipt.assertions.push('Visible step images have nonzero size; offscreen images remain deferred');
  receipt.calls = evaluate('function(){return getApp().__communityFixture.calls;}');
  assert.deepEqual(receipt.calls.map(call => call.cursor), ['', '16', '32']);
  receipt.assertions.push('Three bounded feed requests: cursors empty/16/32');
  receipt.ok = true;
} catch (error) { receipt.error = error.message; throw error; }
finally {
  receipt.debugCalls = evaluate('function(){return getApp().__communityFixture?.calls || [];}');
  receipt.restored = evaluate(`function(){const app=getApp(); const component=getCurrentPages()[0].selectComponent('.r');if(component?.data.w)component[component.data.al]({type:'close',target:{dataset:{}},currentTarget:{dataset:{}},detail:{}}); if(app.__communityFixture){require('services/cloud.js').invokeCloud=app.__communityFixture.original;require('store.js').state.value.comments=app.__communityFixture.comments;delete app.__communityFixture;require('services/community-feed.js').invalidateCommunityFeed();} return true;}`);
  await writeFile(`${directory}/community-ui-fixture.json`, JSON.stringify(receipt, null, 2));
}
