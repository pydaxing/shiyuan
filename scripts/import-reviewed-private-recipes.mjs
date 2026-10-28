import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { normalizeCommand } from '../server/validation.mjs';

const root = process.cwd();
const entries = JSON.parse(await readFile(`${root}/artifacts/recipe-sources/private-menu-import.json`, 'utf8'));
const recipes = entries.map(entry => normalizeCommand('saveRecipe', [{ ...entry.recipe, provenance: entry.provenance }])[0]);
assert.equal(recipes.length, 3);
assert.equal(new Set(recipes.map(recipe => recipe.provenance.url)).size, recipes.length);
if (!process.argv.includes('--live')) {
  console.log(`已校验 ${recipes.length} 条私家菜谱；加 --live 才通过当前微信身份保存，不发布广场。`);
} else {
  const receiptPath = `${root}/artifacts/deployment/private-recipe-import-20260909.json`;
  assert.equal(await access(receiptPath).then(() => true, () => false), false, '已有导入回执，请先核对，不重复执行');
  const argsPath = `${root}/artifacts/deployment/private-recipe-import-args.json`;
  await writeFile(argsPath, JSON.stringify([recipes]));
  const evaluate = (source, args = []) => {
    const output = execFileSync('/usr/local/bin/wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', `${root}/dist/release`, '--fn-source', source, ...args], { encoding: 'utf8', timeout: 90000 });
    const result = JSON.parse(output.slice(output.indexOf('{')));
    assert.equal(result.ok, true, output);
    return result.result?.result?.result;
  };
  evaluate(`function(recipes) {
    const app=getApp(); const cloud=require('services/cloud.js'); const state=require('store.js').state;
    if(app.__communityFixture) throw new Error('先恢复测试夹具');
    if(app.__privateRecipeImport) return {started:true};
    const progress={startedAt:new Date().toISOString(),done:false,imported:[],skipped:[],publiclyPublished:false};
    app.__privateRecipeImport=progress;
    void (async function(){
      try {
        if(cloud.cloudStatus.value.busy) throw new Error('正在保存其他操作');
        await cloud.refreshCloud();
        const familyId=cloud.cloudStatus.value.familyId;
        if(!familyId || cloud.cloudStatus.value.phase!=='ready') throw new Error('请先加入家庭');
        progress.familyId=familyId;
        for(const recipe of recipes){
          if(cloud.cloudStatus.value.familyId!==familyId) throw new Error('家庭已变更，停止导入');
          const previous=state.value.recipes.find(entry=>entry.provenance?.url===recipe.provenance.url && entry.title===recipe.title);
          if(previous){progress.skipped.push({id:previous.id,title:previous.title});continue;}
          await cloud.remoteAction('saveRecipe',[recipe]);
          const saved=state.value.recipes.find(entry=>entry.provenance?.url===recipe.provenance.url && entry.title===recipe.title);
          if(!saved || JSON.stringify(saved.provenance)!==JSON.stringify(recipe.provenance) || JSON.stringify(saved.ingredients)!==JSON.stringify(recipe.ingredients)) throw new Error('保存后来源或原料不一致，停止导入');
          progress.imported.push({id:saved.id,title:saved.title,category:saved.category,sourceUrl:saved.provenance.url,revision:cloud.cloudStatus.value.revision});
        }
        const verified=await cloud.invokeCloud('bootstrap',{includeFeed:false});
        if(verified.familyId!==familyId) throw new Error('验收时家庭变更');
        for(const recipe of recipes) if(!verified.snapshot.recipes.some(saved=>saved.title===recipe.title && JSON.stringify(saved.provenance)===JSON.stringify(recipe.provenance) && JSON.stringify(saved.ingredients)===JSON.stringify(recipe.ingredients))) throw new Error('云端回读不一致');
        progress.ok=true;
      } catch(error){progress.error=error.message;progress.code=error.code;}
      finally{progress.done=true;}
    })();
    return {started:true};
  }`, ['--args-file', argsPath]);
  let progress;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    progress = evaluate('function(){return getApp().__privateRecipeImport;}');
    if (progress?.done) break;
  }
  await writeFile(receiptPath, JSON.stringify(progress, null, 2));
  assert.equal(progress?.done, true, '导入未结束，请读取运行中回执，勿重发');
  assert.equal(progress.ok, true, JSON.stringify(progress));
  console.log(JSON.stringify(progress, null, 2));
}
