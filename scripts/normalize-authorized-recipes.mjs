import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { UNITS, MAX_RECIPE_STEPS, recipeFieldErrors, validateIngredient, validateRecipe } from '../src/domain/kitchen.js';
import { validateImage } from '../src/domain/presentation.js';
import { normalizeImportedRecipe } from '../server/validation.mjs';
import { titleKey, aliasKey, canonicalRecipeUrl } from './recipe-discovery.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const textKey = value => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : value ?? null;
const unitAliases = { 克: 'g', 千克: 'kg', 公斤: 'kg', 毫升: 'ml', 升: 'L', g: 'g', kg: 'kg', ml: 'ml', l: 'L' };
const literalUnits = [...UNITS, ...Object.keys(unitAliases), '勺', '小勺', '大勺', '茶匙', '汤匙', '瓣', '片', '块', '碗', '杯', '滴', '撮', '把', '斤', '两'];
const numericAmountPattern = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:\\s*/\\s*\\d+(?:\\.\\d+)?)?';
const amountPattern = new RegExp(`^(半|[一二两三四五六七八九十]+|${numericAmountPattern})\\s*(${literalUnits.join('|')})$`, 'i');
const chineseDigits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const validAmountSource = value => typeof value === 'string' && Boolean(value.trim()) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const normalizedAmount = value => value.normalize('NFKC').replace(/⁄/g, '/').trim();

function parseQuantity(amount) {
  let quantity;
  if (amount === '半') quantity = 0.5;
  else if (chineseDigits[amount]) quantity = chineseDigits[amount];
  else if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(amount)) {
    const [tens, ones] = amount.split('十');
    quantity = (chineseDigits[tens] || 1) * 10 + (chineseDigits[ones] || 0);
  } else {
    const [numerator, denominator = 1] = amount.split('/').map(part => Number(part.trim()));
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator > Number.MAX_SAFE_INTEGER || denominator > Number.MAX_SAFE_INTEGER || denominator <= 0) return null;
    quantity = numerator / denominator;
  }
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function parseAmount(amountText) {
  if (!validAmountSource(amountText)) return null;
  const match = normalizedAmount(amountText).match(amountPattern);
  if (!match) return null;
  const [, amount, sourceUnit] = match;
  const quantity = parseQuantity(amount);
  return quantity === null ? null : { quantity, unit: unitAliases[sourceUnit.toLowerCase()] || sourceUnit };
}

function validQuantity(quantity) {
  try { validateIngredient({ name: '原料', quantity, unit: 'g' }); return true; }
  catch { return false; }
}

function parseTextAmount(amountText, parsed) {
  if (!validAmountSource(amountText) || amountText.trim().length > 60) return null;
  const amount = normalizedAmount(amountText);
  if (!/\p{L}/u.test(amount) || /(?:Infinity|NaN|null|undefined)|∞|\d\s*e\s*[+-]?\s*\d/i.test(amount)) return null;
  if (/^[半零〇一二两三四五六七八九十百千万\s]+$/.test(amount) || /^(?:无|暂无|未知|待定|未填写|未提供|未注明|缺失|不详|N\/?A)$/i.test(amount)) return null;
  if (literalUnits.some(unit => unit.toLowerCase() === amount.toLowerCase())) return null;
  const exact = amount.match(amountPattern);
  if (exact && !parsed && !(exact[1].length === 2 && chineseDigits[exact[1][0]] < chineseDigits[exact[1][1]])) return null;
  if (/^(?:约\s*)?[零〇]\s*\p{L}/u.test(amount)) return null;
  if (/[#./\\=^%]/.test(amount.replace(new RegExp(numericAmountPattern, 'g'), ''))) return null;
  if (parsed && !validQuantity(parsed.quantity)) return null;
  let invalidNumber = false;
  const structure = amount.replace(new RegExp(numericAmountPattern, 'g'), value => {
    if (!validQuantity(parseQuantity(value))) invalidNumber = true;
    return '#';
  });
  if (invalidNumber || /#\s*[,，_]?\s*#/.test(structure)) return null;
  if (/[-−–—+*×~]/.test(structure.replace(/#\s*\p{L}*\s*[-−–—+*×~]\s*(?=#)/gu, ''))) return null;
  return amountText.trim();
}

function httpsUrl(value, host) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && (!host || parsed.hostname === host);
  } catch { return false; }
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

async function inspectImage(path) {
  if (!(await stat(path)).isFile()) throw new Error('图片路径不是普通文件');
  const bytes = await readFile(path);
  const image = sharp(bytes, { limitInputPixels: 40000000, failOn: 'warning' });
  const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) throw new Error('不支持的图片格式');
  await image.stats();
  return { sha256: sha256(bytes), width: metadata.width, height: metadata.height, bytes: bytes.length, format: metadata.format };
}

function fingerprints(source) {
  const ingredients = Array.isArray(source.ingredients) ? source.ingredients : [];
  const steps = Array.isArray(source.steps) ? source.steps : [];
  const imageKey = image => ({ url: textKey(image?.url), alt: textKey(image?.alt) });
  const text = {
    description: textKey(source.description), tips: textKey(source.tips),
    minutes: source.minutes ?? null, servings: source.servings ?? null,
    ingredients: ingredients.map(item => ({ name: textKey(item?.name), amountText: textKey(item?.amountText) })),
    steps: steps.map(step => textKey(step?.text)),
  };
  const textFingerprint = sha256(JSON.stringify(text));
  return {
    fingerprintVersion: 1,
    titleKey: titleKey(typeof source.title === 'string' ? source.title : ''),
    aliasKey: aliasKey(typeof source.title === 'string' ? source.title : ''),
    titleFingerprint: sha256(aliasKey(typeof source.title === 'string' ? source.title : '')),
    textFingerprint,
    contentFingerprint: sha256(JSON.stringify({ textFingerprint, cover: imageKey(source.cover), steps: steps.map(step => Array.isArray(step?.images) ? step.images.map(imageKey) : null) })),
    sourceHtmlFingerprint: typeof source.sourceHtml === 'string' ? sha256(source.sourceHtml) : null,
    canonicalSourceUrl: typeof source.sourceUrl === 'string' ? canonicalRecipeUrl(source.sourceUrl) : null,
  };
}

export async function normalizeAuthorizedRecipe(raw, { category, authorizationId, assets, review } = {}) {
  const original = structuredClone(raw);
  const source = isObject(original) ? original : {};
  const sourceHtmlFingerprint = typeof source.sourceHtml === 'string' ? sha256(source.sourceHtml) : null;
  const reviewMatched = isObject(review) && review.approved === true && review.sourceUrl === source.sourceUrl && Boolean(sourceHtmlFingerprint) && review.sourceHtmlFingerprint === sourceHtmlFingerprint && timestamp(review.reviewedAt) && typeof review.notes === 'string';
  const overrides = reviewMatched && isObject(review.importOverrides) ? review.importOverrides : {};
  const issues = [];
  const addIssue = (code, path, message, details) => issues.push({ code, path, message, blocking: true, ...(details === undefined ? {} : { details }) });
  const checkText = (value, path, required = false) => {
    if (typeof value !== 'string' || required && !value.trim()) addIssue('invalid_source_text', path, '原文字段缺失或格式无效，不能推测补全。');
  };
  const checkLimit = (value, limit, path) => {
    if ((typeof value === 'string' || Array.isArray(value)) && value.length > limit) addIssue('schema_limit_exceeded', path, '完整内容超过现有 schema 限制；保留原文，不截断。', { actual: value.length, limit });
  };

  if (!isObject(original)) addIssue('invalid_raw', 'raw', '输入必须是原始菜谱对象。');
  for (const field of ['source', 'sourceUrl', 'title', 'author', 'authorUrl', 'fetchedAt', 'sourceHtml']) checkText(source[field], field, true);
  for (const field of ['description', 'tips']) checkText(source[field], field);
  if (source.source !== '下厨房') addIssue('unsupported_source', 'source', '当前 raw contract 仅支持下厨房来源。');
  if (!httpsUrl(source.sourceUrl, 'www.xiachufang.com') || !canonicalRecipeUrl(source.sourceUrl)) addIssue('invalid_source_url', 'sourceUrl', '需要原始下厨房菜谱的 HTTPS 链接，不改写来源。');
  if (!httpsUrl(source.authorUrl, 'www.xiachufang.com')) addIssue('invalid_author_url', 'authorUrl', '作者链接缺失或不是下厨房 HTTPS 链接。');
  if (!timestamp(source.fetchedAt)) addIssue('invalid_fetched_at', 'fetchedAt', '需要带时区的原始采集时间；不使用当前时间代替。');
  if (typeof authorizationId !== 'string' || !authorizationId.trim()) addIssue('missing_authorization', 'authorizationId', '需要已有用户授权记录的标识。');
  else if (source.authorizationId !== authorizationId) addIssue('authorization_mismatch', 'authorizationId', '授权标识必须与原始采集记录完全一致。');
  if (source.videos !== undefined && (!Array.isArray(source.videos) || source.videos.length && overrides.supplementaryVideo !== true)) addIssue('unsupported_video_content', 'videos', '现有菜谱 schema 不能保留视频做法；仅暂存原文，不能作为完整图文菜谱发布。');
  if (!isObject(assets)) addIssue('missing_assets', 'assets', '缺少 URL 到本地归档图片的映射；本工具不会下载图片。');

  const imageReferences = [];
  const archivePaths = new Map();
  const inspectedFiles = new Map();
  async function mapImage(image, path) {
    if (!isObject(image)) addIssue('invalid_source_image', path, '原始图片必须保留 url 与 alt。');
    checkText(image?.alt, `${path}.alt`);
    const url = image?.url;
    if (!httpsUrl(url)) addIssue('invalid_image_url', `${path}.url`, '原始图片 URL 缺失或不是有效 HTTPS 链接。');
    const asset = isObject(assets) && typeof url === 'string' && Object.hasOwn(assets, url) ? structuredClone(assets[url]) : null;
    const reference = { field: path, source: structuredClone(image ?? null), asset, mapped: false, verified: false };
    imageReferences.push(reference);
    if (!isObject(asset)) {
      addIssue('missing_image_asset', path, '原图未映射到归档文件；保留此图片位置，不过滤或借用其他图片。', { url: url ?? null });
      return null;
    }
    const localPath = typeof asset.path === 'string' && asset.path.trim() && asset.path === asset.path.trim() && !/^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(asset.path) && !/[\u0000-\u001f]/.test(asset.path);
    const validHash = typeof asset.sha256 === 'string' && /^[a-f\d]{64}$/i.test(asset.sha256);
    const validDimensions = Number.isSafeInteger(asset.width) && asset.width > 0 && Number.isSafeInteger(asset.height) && asset.height > 0;
    if (!localPath || !validHash || !validDimensions) addIssue('invalid_image_asset', path, '图片映射必须含本地 path、64 位 sha256 和正整数宽高。');
    reference.mapped = Boolean(localPath && validHash && validDimensions);
    if (reference.mapped) {
      const identity = { sha256: asset.sha256.toLowerCase(), width: asset.width, height: asset.height };
      if (archivePaths.has(asset.path) && !isDeepStrictEqual(archivePaths.get(asset.path), identity)) addIssue('conflicting_image_asset', path, '同一本地路径对应冲突的图片摘要或尺寸，需要核对归档。');
      else archivePaths.set(asset.path, identity);
      try {
        if (!inspectedFiles.has(asset.path)) inspectedFiles.set(asset.path, inspectImage(asset.path));
        reference.actual = await inspectedFiles.get(asset.path);
        const sameHash = reference.actual.sha256 === identity.sha256;
        const sameSize = reference.actual.width === asset.width && reference.actual.height === asset.height;
        if (!sameHash) addIssue('image_hash_mismatch', path, '本地图片内容与归档 sha256 不一致。');
        if (!sameSize) addIssue('image_dimensions_mismatch', path, '本地图片尺寸与归档记录不一致。');
        reference.verified = sameHash && sameSize;
      } catch (error) {
        addIssue(error.code === 'ENOENT' ? 'image_file_missing' : 'invalid_image_file', path, '归档文件不存在或无法完整解码为图片。', { error: error.message });
      }
    }
    if (asset.fileId === undefined || asset.fileId === null || asset.fileId === '') {
      addIssue('image_not_uploaded', path, '归档图片尚无真实 cloud fileId；上传后需带映射重新归一化与校验。');
      return null;
    }
    try {
      validateImage(asset.fileId);
    } catch (error) { addIssue('invalid_image_file_id', path, error.message); }
    return asset.fileId;
  }

  const image = await mapImage(source.cover, 'cover');
  const rawIngredients = Array.isArray(source.ingredients) ? source.ingredients : [];
  const groups = new Set(Array.isArray(overrides.ingredientGroupIndices) ? overrides.ingredientGroupIndices : []);
  const instructions = new Set(Array.isArray(overrides.ingredientInstructionIndices) ? overrides.ingredientInstructionIndices : []);
  const textAmounts = new Set(Array.isArray(overrides.textAmountIndices) ? overrides.textAmountIndices : []);
  for (const index of [...groups, ...instructions, ...textAmounts]) if (!Number.isInteger(index) || index < 0 || index >= rawIngredients.length) addIssue('invalid_review_override', 'review.importOverrides', '复核记录中的原料行索引无效。');
  for (const index of instructions) {
    if (groups.has(index) || typeof rawIngredients[index]?.amountText !== 'string' || rawIngredients[index].amountText.trim()) addIssue('invalid_review_override', `ingredients.${index}`, '补充说明不能与分组重叠，也不能移除有用量的原料。');
    checkLimit(rawIngredients[index]?.name, 1000, `ingredients.${index}.name`);
  }
  if (!Array.isArray(source.ingredients) || !source.ingredients.length) addIssue('missing_ingredients', 'ingredients', '缺少完整原料表，禁止把残缺原文视作完整菜谱。');
  const ingredientAmounts = rawIngredients.map((item, index) => {
    const path = `ingredients.${index}`;
    if (!isObject(item)) addIssue('invalid_source_ingredient', path, '食材条目必须包含原始名称与用量文字。');
    checkText(item?.name, `${path}.name`, true);
    let parsed = parseAmount(item?.amountText);
    let textAmount = parsed && UNITS.includes(parsed.unit) ? null : parseTextAmount(item?.amountText, parsed);
    if (overrides.allowMissingAmounts === true && typeof item?.amountText === 'string' && !item.amountText.trim()) textAmount = '原文未注明';
    if (textAmounts.has(index) && !(parsed && UNITS.includes(parsed.unit) && validQuantity(parsed.quantity)) && validAmountSource(item?.amountText)) {
      textAmount = item.amountText.trim();
      if (/^[\d\s./]+$/.test(textAmount)) textAmount += '（原文未注明单位）';
      parsed = null;
    }
    if (!groups.has(index) && !instructions.has(index) && !parsed && textAmount === null) addIssue('unresolved_amount', `${path}.amountText`, '原文用量缺失或无效，不能推测数量或补为适量；需人工核对原文。');
    return { index, name: item?.name ?? null, amountText: item?.amountText ?? null, parsed, textAmount };
  });
  const ingredients = ingredientAmounts.filter(item => !groups.has(item.index) && !instructions.has(item.index)).map(item => {
    const name = overrides.ingredientNameOverrides?.[item.index] ?? item.name;
    return item.textAmount === null
      ? { name, quantity: item.parsed?.quantity ?? null, unit: item.parsed?.unit ?? null }
      : { name, quantity: null, unit: '', amountText: item.textAmount };
  });

  const rawSteps = Array.isArray(source.steps) ? source.steps : [];
  if (!Array.isArray(source.steps) || !source.steps.length) addIssue('missing_steps', 'steps', '完整采集至少需要一个原始步骤，即使应用 schema 允许空做法也不能放行。');
  const steps = [];
  for (const [index, step] of rawSteps.entries()) {
    const path = `steps.${index}`;
    if (!isObject(step)) addIssue('invalid_source_step', path, '步骤必须保留原文与全部图片。');
    checkText(step?.text, `${path}.text`);
    if (!Array.isArray(step?.images)) addIssue('invalid_step_images', `${path}.images`, '步骤图片字段必须是数组；无图片时应明确提供空数组。');
    const images = [];
    if (Array.isArray(step?.images)) for (const [imageIndex, entry] of step.images.entries()) images.push(await mapImage(entry, `${path}.images.${imageIndex}`));
    if (!(typeof step?.text === 'string' && step.text.trim()) && !images.length) addIssue('empty_step', path, '原始步骤没有文字或图片，可能采集不完整。');
    checkLimit(step?.text, 1000, `${path}.text`);
    checkLimit(images, 9, `${path}.images`);
    steps.push({ title: '', text: step?.text ?? null, images });
  }
  for (const index of [...instructions].sort((first, second) => first - second)) {
    steps.push({ title: '原料表补充说明', text: rawIngredients[index]?.name ?? '', images: [] });
  }

  if (source.minutes !== undefined && source.minutes !== null && typeof source.minutes !== 'number') addIssue('invalid_source_number', 'minutes', '总耗时仅接受原文明确提供的数值；未知使用 null，不从步骤推断。');
  const ingredientText = ingredientAmounts.map(({ name, amountText }) => `${name ?? ''}：${amountText ?? ''}`).join('\n');
  const note = [
    '原文用量未缩放；2人份仅为应用技术字段，不代表原文人数。',
    `授权：${authorizationId ?? ''}`, `采集：${source.fetchedAt ?? ''}`, `作者链接：${source.authorUrl ?? ''}`,
    ...(overrides.displayTitle ? [`原文标题：${source.title}`] : []),
    ...(groups.size ? ['原料分组标题保留于下方原文用量，不计入采购。'] : []),
    ...(instructions.size ? ['原料表中的说明文字全文保留为做法末尾的补充说明，不计入采购。'] : []),
    ...(overrides.supplementaryVideo === true && Array.isArray(source.videos) && source.videos.length ? [`图文做法完整；补充视频见原文：${source.sourceUrl}`] : []),
    ...(source.servings === undefined || source.servings === null ? [] : [`原文人数：${source.servings}`]),
    `介绍：\n${source.description ?? ''}`, `贴士：\n${source.tips ?? ''}`, `原文用量：\n${ingredientText}`,
  ].join('\n');

  const recipe = {
    title: overrides.displayTitle ?? source.title ?? null, category: category ?? null,
    servings: 2, minutes: source.minutes ?? null,
    image, ingredients, steps,
    provenance: {
      source: source.source ?? null, url: source.sourceUrl ?? null,
      license: 'User authorized; not public domain', attribution: source.author ?? null,
      note,
    },
  };

  for (const [path, message] of Object.entries(recipeFieldErrors(recipe))) addIssue('schema_field_invalid', path, message);
  checkLimit(ingredients, 30, 'ingredients');
  checkLimit(steps, MAX_RECIPE_STEPS, 'steps');
  for (const [field, limit] of Object.entries({ source: 120, url: 1500, license: 120, attribution: 300, note: 1500 })) checkLimit(recipe.provenance[field], limit, `provenance.${field}`);

  const validation = { recipe: { valid: false, error: null }, server: { valid: false, error: null, changedFields: [] } };
  try { validateRecipe(recipe); validation.recipe.valid = true; }
  catch (error) {
    validation.recipe.error = error.message;
    if (!issues.length) addIssue('recipe_validation_failed', 'recipe', error.message);
  }
  try {
    const normalized = normalizeImportedRecipe(recipe);
    validation.server.valid = true;
    validation.server.changedFields = [...new Set([...Object.keys(recipe), ...Object.keys(normalized)])].filter(field => !isDeepStrictEqual(recipe[field], normalized[field]));
    if (validation.server.changedFields.length) addIssue('server_normalization_loss', 'recipe', '正常服务端归一化会改写原文数据；不可绕过或默默接受。', { fields: validation.server.changedFields });
  } catch (error) {
    validation.server.error = error.message;
    if (!issues.length) addIssue('server_validation_failed', 'recipe', error.message);
  }

  if (!reviewMatched) addIssue('manual_required', 'review', '需提供绑定同一 sourceUrl 和 sourceHtmlFingerprint 的人工核对记录，含 approved、reviewedAt 与 notes。');
  const ready = issues.length === 0 && validation.recipe.valid && validation.server.valid;
  return {
    version: 1, ready, status: ready ? 'ready' : 'needs_review',
    publicPublishingAllowed: ready && imageReferences.every(reference => typeof reference.asset?.fileId === 'string' && reference.asset.fileId.startsWith('cloud://')),
    requiresApplicationModeration: true, recipe, issues, validation,
    raw: original, authorizationId: authorizationId ?? null, ingredientText, ingredientAmounts, imageReferences,
    sourceReview: { matched: reviewMatched, record: structuredClone(review ?? null) },
    imageSourceUrls: [...new Set(imageReferences.map(reference => reference.source?.url).filter(url => typeof url === 'string'))],
    imageHashes: [...new Set(imageReferences.filter(reference => reference.mapped).map(reference => reference.asset.sha256.toLowerCase()))],
    ...fingerprints(source),
    completeness: {
      sourceVerified: reviewMatched, mainIngredientsVerified: reviewMatched, manualReviewRequired: !reviewMatched,
      ingredientCount: rawIngredients.length, parsedAmountCount: ingredientAmounts.filter(item => item.parsed).length,
      stepCount: rawSteps.length, imageReferenceCount: imageReferences.length,
      mappedImageCount: imageReferences.filter(reference => reference.mapped).length,
      verifiedImageCount: imageReferences.filter(reference => reference.verified).length,
      imageBytesVerified: imageReferences.length > 0 && imageReferences.every(reference => reference.verified),
      preservation: { original: 'raw', sourceHtml: 'raw.sourceHtml', text: 'recipe.provenance.note', amounts: 'ingredientAmounts', imageSourcesAndAssets: 'imageReferences' },
    },
  };
}
