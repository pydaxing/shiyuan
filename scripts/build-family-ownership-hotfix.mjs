import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildFamilyOwnershipHotfix(baseline) {
  assert.ok(!baseline.includes('const ownershipFields ='), '生产代码已包含家庭归属补丁，请重新核对');
  const built = await build({ entryPoints: [path.join(root, 'server/application.mjs')], bundle: true, write: false, platform: 'node', target: 'node18', format: 'cjs' });
  const source = built.outputFiles[0].text;
  const declaration = (code, name, indent = '') => {
    const matches = [...code.matchAll(new RegExp(`^${indent}function ${name}\\([^]*?^${indent}}`, 'gm'))];
    assert.equal(matches.length, 1, `${name} 定义不唯一`);
    return matches[0][0];
  };
  const oneMatch = (code, expression, label) => {
    const matches = [...code.matchAll(expression)];
    assert.equal(matches.length, 1, `${label} 锚点不唯一`);
    return matches[0][0];
  };
  const friendShareBindings = code => {
    const prefix = oneMatch(code, /^\/\/ server\/friend-shares\.mjs\n[^]*?(?=^function createFriendShares\()/gm, '好友分享模块');
    return [
      [/^var (import_node_crypto\d*) = require\("node:crypto"\);$/gm, 'crypto'],
      [/^var (hash\d*) = \(value\) => [^\n]+;$/gm, 'hash'],
      [/^var (fail\d*) = \(message, code = "INVALID"\) => \{$/gm, 'fail'],
    ].map(([expression, label]) => oneMatch(prefix, expression, `好友分享 ${label}`).match(/^var (\w+) =/)[1]);
  };
  const preserveFriendShareBindings = code => {
    const previous = friendShareBindings(baseline);
    const current = friendShareBindings(source);
    for (const [index, binding] of current.entries()) {
      const reference = new RegExp(`\\b${binding}\\b(?=\\s*${index === 0 ? '\\.' : '\\('})`, 'g');
      assert.ok(reference.test(code), `好友分享 ${binding} 缺少预期引用`);
      code = code.replace(reference, previous[index]);
    }
    return code;
  };
  const replacements = [];
  let patched = baseline;
  const replace = (before, after, label) => {
    assert.notEqual(before, after, `${label} 未包含预期修改`);
    assert.equal(patched.split(before).length, 2, `${label} 生产代码锚点不唯一`);
    patched = patched.replace(before, () => after);
    replacements.push({ before, after, label });
  };
  assert.ok(!baseline.includes('function matchesImportedSource('), '生产代码已包含来源家庭匹配，请重新核对');
  replace('function importCollection(', `${declaration(source, 'matchesImportedSource')}\nfunction importCollection(`, '新增来源家庭匹配');
  for (const [name, indent] of [['canDeleteCommunityPost', ''], ['familyPublications', ''], ['recipeFieldErrors', ''], ['validateRecipe', ''], ['createFriendShares', ''], ['importCollection', ''], ['addCollection', '  '], ['deleteCommunityPost', '  '], ['postCard', '  ']]) {
    const before = declaration(baseline, name, indent);
    let after = declaration(source, name, indent);
    if (name === 'createFriendShares') assert.equal(before.split('\n')[0], after.split('\n')[0], '好友分享的依赖标识不一致');
    if (name === 'createFriendShares') after = preserveFriendShareBindings(after);
    replace(before, after, name);
  }
  const scopedRecipeValidation = name => {
    const indent = name === 'saveRecipe' ? '  ' : '';
    const beforeFunction = declaration(baseline, name, indent);
    const afterFunction = declaration(source, name, indent);
    assert.equal(beforeFunction.split('validateRecipe(recipe);').length, 2, `${name} 菜谱校验锚点不唯一`);
    assert.ok(afterFunction.includes('validateRecipe(recipe, { requireStepTitles: true });'), `${name} 缺少步骤标题校验`);
    replace(beforeFunction, beforeFunction.replace('validateRecipe(recipe);', 'validateRecipe(recipe, { requireStepTitles: true });'), `${name} 步骤标题校验`);
  };
  scopedRecipeValidation('saveRecipe');
  scopedRecipeValidation('normalizeCommand');
  const deletionPermission = oneMatch(baseline, /^        if \(name === "deleteCommunityPost" && !canDeleteCommunityPost\(post, userId\)\)\n[^\n]+/gm, '删除权限');
  oneMatch(source, /^        if \(name === "deleteCommunityPost" && !canDeleteCommunityPost\(post, userId, family.id\)\)\n[^\n]+/gm, '删除权限');
  replace(deletionPermission, deletionPermission.replace('canDeleteCommunityPost(post, userId)', 'canDeleteCommunityPost(post, userId, family.id)'), '删除权限');
  const oldDeletion = oneMatch(baseline, /^        if \(post.familyId === family.id\)\n[^]*?^        }/gm, '删除后家庭状态');
  replace(oldDeletion, '        await persist(db, before, snapshot, []);', '删除后家庭状态');
  replace(
    oneMatch(baseline, /^      const result = await readCommunityFeedPage\([^\n]+/gm, '美食列表投影'),
    oneMatch(source, /^      const ownershipFields = [^\n]+\n      const result = await readCommunityFeedPage\([^\n]+/gm, '美食列表投影'),
    '美食列表投影',
  );
  replace(
    '        else if (row.card)\n          posts.push(row.card);',
    oneMatch(source, /^        else if \(row.card\)\n          posts.push\([^\n]+/gm, '历史卡片家庭归属'),
    '历史卡片家庭归属',
  );
  let restored = patched;
  for (const { before, after } of [...replacements].reverse()) {
    assert.equal(restored.split(after).length, 2, '反向还原锚点不唯一');
    restored = restored.replace(after, () => before);
  }
  assert.ok(restored === baseline, '不得修改家庭归属与步骤标题校验以外的线上代码');
  assert.ok(patched.includes('function canDeleteCommunityPost(post, memberId, familyId)'), '缺少家庭归属校验');
  assert.ok(/if \(requireStepTitles\)[^]*?!recipe.steps.length/.test(declaration(patched, 'recipeFieldErrors')), '缺少至少一个步骤的校验');
  return { code: patched, replacements: replacements.map(({ label, before, after }) => ({ label, beforeSha256: sha256(before), afterSha256: sha256(after) })) };
}

async function run() {
  const option = name => {
    const index = process.argv.indexOf(name);
    assert.ok(index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `缺少参数 ${name}`);
    return process.argv[index + 1];
  };
  const baselinePath = path.resolve(option('--baseline'));
  const output = path.resolve(option('--output'));
  const baseline = await readFile(baselinePath, 'utf8');
  assert.equal(sha256(baseline), option('--expected-baseline-sha'), '生产代码摘要不一致');
  const { code, replacements } = await buildFamilyOwnershipHotfix(baseline);
  const directory = path.join(output, 'family-ownership-hotfix/kitchen-v2');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(directory, 'index.js');
  await writeFile(artifactPath, code, { flag: 'wx', mode: 0o600 });
  const receipt = { state: 'prepared_not_deployed', method: 'production_baseline_family_ownership_copy_identity_and_step_titles_only', baselinePath, baselineSha256: sha256(baseline), artifactPath, sha256: sha256(code), replacements };
  await writeFile(path.join(output, 'family-ownership-hotfix-prepared.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ state: receipt.state, artifactPath, sha256: receipt.sha256, replacements: replacements.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().catch(error => { console.error(error.message); process.exitCode = 1; });
