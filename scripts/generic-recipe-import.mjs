// Source-independent import contract. Adapters normalize data before using this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateRecipe, SELECTABLE_UNITS } from '../src/domain/kitchen.js';
import { assertStrictIngredient } from './strict-ingredient-amounts.mjs';
import { makeShare, parseShare } from '../src/domain/sharing.js';
import { imageReferences } from '../server/application.mjs';
import { OFFICIAL_PUBLISHER_ID, OFFICIAL_PUBLISHER_NAME } from '../src/domain/community-policy.js';
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const isCookingStep = step => !/^(?:菜品介绍|备料说明(?:\s*\d+)?)$/.test(String(step.title || '').trim());

// Adapters keep original text in the private archive. Reference-only lines and
// upstream project contribution prompts do not belong in the cooking UI.
export function publicCookingText(text) {
  return String(text || '').split('\n').filter(line => !(
    /https?:\/\/|\bIssue\b|Pull\s*request/i.test(line) ||
    /^\s*(?:参考(?:资料|来源|视频|链接)|附加参考|关于.*可参考.*教程)/.test(line)
  )).join('\n').trim().replace(/参考用时：(\d+) 秒。/g, (_, raw) => {
    let seconds = Number(raw);
    const parts = [];
    for (const [size, unit] of [[86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']]) {
      const amount = Math.floor(seconds / size);
      if (amount) parts.push(`${amount}${unit}`);
      seconds %= size;
    }
    return `参考用时：${parts.join('') || '0秒'}。`;
  });
}

export function publicRecipe(draft, resolveImage, identity) {
  assert.ok(identity && typeof identity === 'string', '导入需要稳定的记录标识');
  const image = value => {
    if (!value) return '';
    const resolved = resolveImage(value);
    assert.ok(typeof resolved === 'string' && resolved.startsWith('cloud://'), `图片尚未上传：${value}`);
    return resolved;
  };
  const recipe = {
    id: `recipe-import-${digest(identity).slice(0, 32)}`,
    title: draft.title, category: draft.category, minutes: draft.minutes ?? null,
    servings: draft.servings ?? 2, image: image(draft.image), nutrition: draft.nutrition || '',
    ingredients: draft.ingredients.map(({name, quantity, unit, amountText}) => {
      if (amountText) {
        assert.ok(['适量', '少许'].includes(amountText), `${name}：未拆分的用量`);
        assert.ok(quantity == null && !unit, `${name}：定量和模糊量不能并存`);
        return {name, quantity: null, unit: '', amountText};
      }
      assert.ok(Number.isFinite(quantity) && quantity > 0 && SELECTABLE_UNITS.includes(unit), `${name}：缺少数量或支持的单位`);
      return {name, quantity, unit};
    }),
    steps: draft.steps.filter(isCookingStep).map(step => ({title: step.title, text: publicCookingText(step.text), images: (step.images || (step.image ? [step.image] : [])).map(image)})).filter(step => step.text || step.images.length),
  };
  recipe.ingredients.forEach(assertStrictIngredient);
  validateRecipe(recipe, {requireStepTitles: true});
  return recipe; // Explicit allowlist: source metadata never enters public recipes.
}

export function buildGenericPost({draft, resolveImage, identity, familyId, jobId, importedAt, displayAt}) {
  assert.ok(familyId && jobId && Number.isFinite(importedAt));
  const recipe = publicRecipe(draft, resolveImage, identity);
  const id = `post-import-${digest(identity).slice(0,32)}`;
  const publishedAt = new Date(displayAt).toISOString();
  assert.ok(Date.parse(publishedAt) <= importedAt, '展示时间不能晚于导入时间');
  const post = {...parseShare(makeShare(recipe, [recipe], OFFICIAL_PUBLISHER_NAME)),
    id, _id: id, familyId, familyItemId: recipe.id, familyKind: 'dish',
    publisherId: OFFICIAL_PUBLISHER_ID, publisherType: 'official', author: OFFICIAL_PUBLISHER_NAME,
    categories: [recipe.category], publishedAt, createdAt: Date.parse(publishedAt), importedAt,
    status: 'published', importedFamilyCount: 0,
    importAudit: {jobId, identityDigest: digest(identity), displayTimestampPolicy: 'interleaved_with_existing_posts'},
  };
  post.assetIds = imageReferences(post);
  post.search = JSON.stringify([post.title, recipe.ingredients.map(i => i.name), draft.tags || []]).toLowerCase();
  post.card = {id, title: post.title, kind: post.kind, image: post.image, author: post.author,
    categories: post.categories, familyItemId: recipe.id, publisherId: post.publisherId,
    publisherType: post.publisherType, publishedAt, importedFamilyCount: 0, tall: false,
    recipes: [{id: recipe.id, title: recipe.title, category: recipe.category, image: recipe.image, minutes: recipe.minutes}]};
  return post;
}

export function interleavedDates(existing, count) {
  assert.ok(Number.isSafeInteger(count) && count >= 0);
  const times = [...new Set(existing.filter(p => p.status === 'published').map(p => Number.isFinite(p.createdAt) ? p.createdAt : Date.parse(p.publishedAt)).filter(Number.isFinite))].sort((a,b)=>a-b);
  assert.ok(times.length >= 2, '至少需要两个有效旧发布时间才能分散展示');
  return Array.from({length:count}, (_,i) => {
    const position = (i+1) * (times.length-1) / (count+1);
    const slot = Math.floor(position);
    return Math.round(times[slot] + (times[slot+1]-times[slot]) * (position-slot));
  });
}
