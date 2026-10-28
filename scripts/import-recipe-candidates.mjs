import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CATEGORIES, UNITS, recipeFieldErrors, validateRecipe } from '../src/domain/kitchen.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(workspace, 'artifacts/recipe-sources');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonicalCategories = ['荤菜', '素菜', '汤羹', '主食', '小食', '饮品', '其他'];
const legacyCategories = ['荤菜', '素菜', '汤羹', '主食', '其他'];
const unitMap = { 克: 'g', 千克: 'kg', 公斤: 'kg', 毫升: 'ml', 升: 'L', g: 'g', kg: 'kg', ml: 'ml', L: 'L', 个: '个', 根: '根', 只: '只', 盒: '盒', 袋: '袋' };
const smallNumbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 半: 0.5 };
const numberToken = '(?:\\d+(?:\\.\\d+)?|[一二两三四五六七八九十半])';
const unitToken = '(?:千克|公斤|毫升|kg|ml|克|升|g|L|个|根|只|盒|袋|瓣|片|粒|颗|棵|条|枚|朵|块|头|把|叶|滴|碗|cm|厘米)';
const quantityPrefix = new RegExp(`^(${numberToken})\\s*(${unitToken})\\s*(?:的)?(.+)$`);
const quantitySuffix = new RegExp(`^(.+?)\\s*(?:=|:|：)?\\s*(${numberToken})\\s*(${unitToken})$`);

function plainText(text) {
  return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '[图片未下载：$1；需人工核对文字完整性]')
    .replace(/<img\b[^>]*>/gi, '[原文图片未下载，需人工核对文字完整性]')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').trim();
}

export function parseQuantityStatement(raw, { allowPerPortion = false } = {}) {
  const text = raw.trim().replace(/^[-*+]\s+/, '');
  const result = { raw, name: null, quantity: null, unit: null, status: 'needs_review', reason: null, basis: null };
  if (/适量|少许|若干|几块|小半|一把|没过|根据|按需/.test(text)) return { ...result, reason: 'unspecified_or_contextual_amount' };
  if (/\d\s*(?:-|–|—|~|～|到|，|±)\s*\d|\d\s*(?:g|ml|克|毫升)\s*[-–~～]\s*\d/.test(text)) return { ...result, reason: 'range_or_tolerance' };
  const withoutNotes = text.replace(/（[^）]*）|\([^)]*\)/g, '').trim();
  if (/约|大概|以上|以下|向上|向下|取整|\//.test(withoutNotes)) return { ...result, reason: 'approximate_formula_or_alternative' };
  let statement = withoutNotes;
  let basis = 'explicit_source_quantity';
  if (/\*\s*份数\s*$/.test(statement)) {
    if (!allowPerPortion) return { ...result, reason: 'portion_basis_not_confirmed' };
    statement = statement.replace(/\*\s*份数\s*$/, '').trim();
    basis = 'one_source_portion_explicit_linear_formula';
  }
  if (/[+*/]|份数|或|或者|or/.test(statement)) return { ...result, reason: 'formula_or_alternative' };
  let match = statement.match(quantitySuffix);
  let name;
  let quantityText;
  let sourceUnit;
  if (match) [, name, quantityText, sourceUnit] = match;
  else {
    match = statement.match(quantityPrefix);
    if (match) [, quantityText, sourceUnit, name] = match;
  }
  if (!match) return { ...result, reason: 'not_an_unambiguous_quantity_statement' };
  name = name.trim().replace(/[=:：]\s*$/, '').trim();
  if (!name || /\d|[,，、]/.test(name)) return { ...result, reason: 'compound_or_unclear_ingredient_name' };
  const quantity = smallNumbers[quantityText] ?? Number(quantityText);
  if (!unitMap[sourceUnit]) return { ...result, name, reason: 'unsupported_unit', sourceUnit };
  if (!Number.isFinite(quantity) || quantity <= 0) return { ...result, name, reason: 'invalid_positive_quantity' };
  return { ...result, name, quantity, unit: unitMap[sourceUnit], status: 'exact', reason: null, basis };
}

function sectionsOf(markdown) {
  const sections = { introduction: [] };
  let current = 'introduction';
  markdown.split('\n').forEach((raw, index) => {
    const heading = raw.match(/^##\s+(.+)$/);
    if (heading) { current = heading[1].trim(); sections[current] ||= []; }
    else sections[current].push({ line: index + 1, text: raw });
  });
  return sections;
}

export function splitOperationSteps(lines) {
  const steps = [];
  let section = '';
  let current = null;
  function flush() {
    if (!current) return;
    const raw = current.lines.map((line) => line.text).join('\n').trim();
    if (raw) steps.push({ section: current.section, sourceLineStart: current.lines[0].line, sourceLineEnd: current.lines.at(-1).line, raw, text: plainText(raw.replace(/^\d+[.)]\s+/, '')), imageOnlyOrReferenced: /!\[|<img\b|参见图|如图|下图/.test(raw) });
    current = null;
  }
  for (const line of lines) {
    const heading = line.text.match(/^###\s+(.+)$/);
    if (heading) { flush(); section = heading[1]; continue; }
    if (/^\d+[.)]\s+/.test(line.text)) { flush(); current = { section, lines: [line] }; }
    else if (current) current.lines.push(line);
    else if (line.text.trim()) current = { section, lines: [line] };
  }
  flush();
  return steps;
}

function explicitServings(lines) {
  const text = lines.map((line) => line.text).join('\n');
  if (/\d\s*[-~～到]\s*\d\s*(?:个)?人/.test(text)) return { value: null, evidence: null, status: 'range_or_conflicting_servings' };
  for (const line of lines) {
    const match = line.text.match(/(?:一份正好够\s*|如下分量正好够\s*|按照\s*|每份[（(]\s*|^\s*)(\d+)\s*(?:个)?人(?:份|食用|量|吃|喝)/);
    if (match) return { value: Number(match[1]), evidence: line, status: 'explicit_source_servings' };
  }
  return { value: null, evidence: null, status: 'missing_unambiguous_diner_count' };
}

function explicitMinutes(lines) {
  for (const line of lines) {
    if (!/分钟|小时/.test(line.text)) continue;
    if (/\d\s*[-~～到]\s*\d|三五|四到五|以上|另需|不含/.test(line.text)) return { value: null, evidence: line, status: 'range_excludes_waiting_or_lower_bound' };
    const translated = line.text.replace(/一个半小时/g, '1.5 小时').replace(/四十分钟/g, '40 分钟').replace(/三十分钟/g, '30 分钟').replace(/十\s*分钟/g, '10 分钟');
    const match = translated.match(/(\d+(?:\.\d+)?)\s*(分钟|小时)/);
    if (match) return { value: Number(match[1]) * (match[2] === '小时' ? 60 : 1), evidence: line, status: 'source_estimate_not_measured' };
    return { value: null, evidence: line, status: 'unparsed_time_expression' };
  }
  return { value: null, evidence: null, status: 'total_time_missing' };
}

export function verifyCandidate(candidate) {
  assert(candidate.id && candidate.title && canonicalCategories.includes(candidate.category));
  assert.equal(candidate.license.spdxId, 'Unlicense');
  assert(candidate.license.recipePolicyUrl && candidate.attribution && candidate.sourceUrl.startsWith('https://github.com/Anduin2017/HowToCook/blob/'));
  assert(candidate.rawIngredients.length && candidate.rawSteps.length && candidate.steps.length);
  assert(candidate.source.revision.length === 40 && candidate.source.sha256.length === 64);
  assert(candidate.source.accessedAt && candidate.image.status === 'not_downloaded');
  assert.equal(candidate.recipeDraft.image, '');
  assert(candidate.recipeDraft.steps.every((step) => step.image === '' && !/!\[|<img\b/.test(step.text)));
  assert.equal(candidate.importReview.autoImportAllowed, false);
  for (const statement of candidate.ingredientStatements) {
    if (statement.status === 'exact') assert(statement.quantity > 0 && UNITS.includes(statement.unit) && statement.basis);
    else assert.equal(statement.quantity, null);
  }
  return true;
}

export function buildPrivateMenuRecipes(candidates, reviewDocument) {
  const recipes = [];
  for (const review of reviewDocument.reviews) {
    const sourceCandidate = candidates.find((candidate) => candidate.id === review.sourceCandidateId);
    assert(sourceCandidate, `Unknown reviewed source: ${review.sourceCandidateId}`);
    assert.equal(sourceCandidate.source.revision, reviewDocument.sourceRevision);
    assert.equal(sourceCandidate.source.sha256, review.sourceSha256, 'Reviewed source changed; review must be repeated');
    assert.equal(sourceCandidate.license.externalReferenceReviewRequired, false, 'Do not promote external-reference rights holds');
    assert.equal(review.status, 'ready_for_private_menu_text_import');
    assert.equal(review.ingredientEvidence.length, review.recipe.ingredients.length);
    const originalLines = [...sourceCandidate.originalIntroduction, ...sourceCandidate.rawIngredients, ...sourceCandidate.rawCalculations, ...sourceCandidate.rawSteps, ...sourceCandidate.rawAdditionalNotes];
    for (const [index, ingredient] of review.recipe.ingredients.entries()) {
      const evidence = review.ingredientEvidence[index];
      assert.deepEqual({ name: evidence.name, quantity: evidence.quantity, unit: evidence.unit }, ingredient);
      assert(originalLines.some((line) => line.line === evidence.sourceLine && line.text === evidence.sourceText), `Original ingredient evidence missing for ${ingredient.name}`);
      assert(evidence.transformation && Number.isFinite(ingredient.quantity) && ingredient.quantity > 0);
    }
    assert.equal(review.servingsReview.adapted, review.recipe.servings);
    assert.equal(review.minutesReview.adapted, review.recipe.minutes);
    const recipe = {
      ...review.recipe,
      sourceId: sourceCandidate.id,
      sourceUrl: sourceCandidate.sourceUrl,
      sourceRevision: sourceCandidate.source.revision,
      license: 'Unlicense',
      licenseUrl: sourceCandidate.license.licenseUrl,
      licenseScope: 'upstream_recipe_text_declaration_not_a_blanket_rights_warranty',
      attribution: `${sourceCandidate.attribution} 本地私家菜单文字改编版（${reviewDocument.reviewDate}），具体改动与编辑份量/耗时见adaptation。`,
      author: 'HowToCook贡献者 / Codex文字改编',
      source: sourceCandidate.source,
      adaptation: { reviewer: reviewDocument.reviewer, reviewDate: reviewDocument.reviewDate, ingredientEvidence: review.ingredientEvidence, servings: review.servingsReview, minutes: review.minutesReview, omittedIngredients: review.omittedIngredients, changes: review.changes, residualLimits: review.residualLimits, experimentallyCooked: false, professionalFoodSafetyCertification: false },
      importPolicy: { allowedScope: 'private_family_menu_only', publicPublishingAllowed: false, cloudWritePerformed: false, attributionMustBePreserved: true, imagesIncluded: false },
    };
    assert.equal(recipe.image, '');
    assert(recipe.steps.every((step) => step.image === '' && !/!\[|<img\b/.test(step.text)));
    validateRecipe(recipe);
    recipes.push(recipe);
  }
  assert.equal(new Set(recipes.map((recipe) => recipe.id)).size, recipes.length);
  return recipes;
}

export function buildPrivateMenuImportEntries(recipes) {
  return recipes.map((reviewed) => {
    const adaptation = reviewed.adaptation;
    assert.equal(reviewed.importPolicy.allowedScope, 'private_family_menu_only');
    const provenance = {
      source: 'HowToCook / Anduin2017 与贡献者',
      url: reviewed.sourceUrl,
      license: reviewed.license,
      attribution: `原文：HowToCook / Anduin2017 与贡献者；Codex于${adaptation.reviewDate}逐条文本核对并改编，非原作者确认、非真人试做。`,
      note: [
        '仅供私家菜单文字导入，不发布广场；仍须正常saveRecipe字段校验。仓库LICENSE及投稿模板明确覆盖菜谱文字；未逐作者核实历史权属，无图片。',
        `整份原料：${reviewed.ingredients.map((ingredient) => `${ingredient.name}${ingredient.quantity}${ingredient.unit}`).join('、')}；全部有原文明示数量依据，未给适量编造数字。`,
        `原始份量：${adaptation.servings.original}。本版${reviewed.servings}人分餐：${adaptation.servings.meaning}。`,
        '当前界面无几人份且不自动缩放；若保存元数据默认为2，这只是接口默认值，不代表本配方变为2人份，不改变或反推原料与步骤。',
        `原始耗时：${adaptation.minutes.original}；本版${reviewed.minutes}分钟是编辑估计、未实测，按实际熟透状态调整。`,
        ...adaptation.changes,
        ...(adaptation.omittedIngredients.length ? [`明确省略：${adaptation.omittedIngredients.map((ingredient) => ingredient.name).join('、')}，不是把未定量项目换成数字。`] : []),
        '未经试做或专业食品安全认证；私有使用不是版权豁免。完整逐行证据随本地private-menu-reviews.json保留。',
      ].join('\n'),
    };
    assert(Object.values(provenance).every((value) => typeof value === 'string' && value.trim()));
    assert(provenance.note.length <= 1000, 'Keep the import note reviewable without silent truncation');
    const recipe = Object.fromEntries(['title', 'category', 'servings', 'minutes', 'image', 'description', 'nutrition', 'ingredients', 'steps'].map((field) => [field, structuredClone(reviewed[field])]));
    validateRecipe({ ...recipe, provenance });
    return { recipe, provenance };
  });
}

async function generate() {
  const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const source = await readJson('evidence/pinned-source.json');
  const selections = await readJson('selection.json');
  const reviewNotes = await readJson('review-notes.json');
  const access = (await readFile(resolve(root, 'access-log.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const licenseText = await readFile(resolve(root, 'upstream/LICENSE'), 'utf8');
  const recipePolicy = await readFile(resolve(root, 'upstream/.github/pull_request_template.md'), 'utf8');
  assert(recipePolicy.includes('以菜谱的形式') && recipePolicy.includes('商业目的') && recipePolicy.includes('The Unlicense'));
  const pathUrl = (path) => path.split('/').map(encodeURIComponent).join('/');
  const blobBase = `https://github.com/${source.repository}/blob/${source.revision}/`;
  const candidates = [];
  for (const selection of selections) {
    assert(/^dishes\/.+\.md$/.test(selection.path) && !selection.path.split('/').includes('..'));
    const rawRelativePath = `upstream/${selection.path}`;
    const markdown = await readFile(resolve(root, rawRelativePath), 'utf8');
    const expectedRawUrl = `https://raw.githubusercontent.com/${source.repository}/${source.revision}/${pathUrl(selection.path)}`;
    const request = access.findLast((entry) => entry.savedAs === rawRelativePath && entry.url === expectedRawUrl && entry.status === 200 && entry.sha256 === hash(markdown));
    assert(request, `Missing original successful fetch with matching hash: ${selection.path}`);
    const sections = sectionsOf(markdown);
    const title = markdown.match(/^#\s+(.+)$/m)?.[1].replace(/的做法$/, '').trim();
    assert(title && reviewNotes[title], `Missing recipe review notes: ${title}`);
    const rawIngredients = sections['必备原料和工具'] || [];
    const rawCalculations = sections['计算'] || [];
    const rawSteps = sections['操作'] || [];
    const servings = explicitServings(rawCalculations);
    const minutes = explicitMinutes(sections.introduction);
    const calculations = rawCalculations.filter((line) => /^\s*[-*+]\s+/.test(line.text));
    const statements = (calculations.length ? calculations : rawIngredients.filter((line) => /^\s*[-*+]\s+/.test(line.text))).map((line) => ({ ...parseQuantityStatement(line.text, { allowPerPortion: servings.value !== null }), sourceLine: line.line, sourceSection: calculations.length ? '计算' : '必备原料和工具' }));
    const rawImageReferences = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((match) => ({ alt: match[1], reference: match[2], sourceLine: markdown.slice(0, match.index).split('\n').length, downloaded: false, individualLicenseVerified: false }));
    const withoutImages = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    const externalReferences = [...withoutImages.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g)].map((match) => ({ label: match[1], url: match[2], accessed: false, authorizationVerified: false }));
    const steps = splitOperationSteps(rawSteps);
    const legacyCategory = legacyCategories.includes(selection.category) ? selection.category : '其他';
    const id = `howtocook-${hash(selection.path).slice(0, 16)}`;
    const rightsNeedsReview = externalReferences.length > 0;
    const recipeDraft = {
      id, title, category: CATEGORIES.includes(selection.category) ? selection.category : legacyCategory,
      minutes: minutes.value, servings: servings.value, image: '', description: '', nutrition: '',
      author: 'HowToCook contributors',
      ingredients: statements.map((statement) => ({ name: statement.name || plainText(statement.raw.replace(/^\s*[-*+]\s+/, '')), quantity: statement.quantity, unit: statement.unit || '' })),
      steps: steps.map((step) => ({ title: step.section || '', text: step.text, image: '' })),
      sourceUrl: blobBase + pathUrl(selection.path), license: 'Unlicense',
      attribution: `HowToCook / Anduin2017 与贡献者；原文 ${blobBase + pathUrl(selection.path)}；按 Unlicense 声明提供，离线结构转换，未核实逐项权利链。`,
    };
    const schemaErrors = Object.entries(recipeFieldErrors(recipeDraft)).map(([field, message]) => ({ field, message }));
    let validateRecipePass = true;
    try { validateRecipe(recipeDraft); } catch (error) { validateRecipePass = false; if (!schemaErrors.some((entry) => entry.message === error.message)) schemaErrors.push({ field: 'recipe', message: error.message }); }
    if (steps.length > 20) schemaErrors.push({ field: 'steps', message: `原文转换为${steps.length}步；超过20步，不截断` });
    const candidate = {
      schemaVersion: 1, id, title, category: selection.category, legacyCategory,
      categoryReason: selection.categoryReason || '依据实际原料和食用用途人工选类，不盲从上游目录',
      sourceUrl: recipeDraft.sourceUrl,
      license: { spdxId: 'Unlicense', declaredCommercialReuse: true, declaredRedistribution: true, licenseUrl: blobBase + 'LICENSE', licenseFile: 'upstream/LICENSE', licenseSha256: hash(licenseText), recipePolicyUrl: blobBase + '.github/pull_request_template.md', recipePolicyFile: 'upstream/.github/pull_request_template.md', recipePolicySha256: hash(recipePolicy), textCoverage: 'recipe_explicitly_covered_by_repository_submission_policy', ownershipChain: 'contributor_declaration_not_individually_verified', externalReferenceReviewRequired: rightsNeedsReview, imageCoverage: 'no_individual_asset_rights_verification_no_images_included', disclaimer: '仓库许可与投稿声明不是对全部历史贡献、外部参考或网图权利链的担保；不得据此宣称所有图文无条件可商用。' },
      attribution: recipeDraft.attribution,
      source: { repository: source.repository, revision: source.revision, sourcePath: selection.path, rawFile: rawRelativePath, rawUrl: request.url, accessedAt: request.accessedAt, sha256: hash(markdown), historyUrl: `https://github.com/${source.repository}/commits/${source.revision}/${pathUrl(selection.path)}` },
      image: { status: 'not_downloaded', reason: rawImageReferences.length ? '图片逐项权属未核实；仅存原文引用，不下载、不热链、不填入菜谱图片字段' : '原文没有图片引用；不虚构配图', thirdPartyImageAdmitted: markdown.includes('网图'), references: rawImageReferences },
      externalReferences,
      originalIntroduction: sections.introduction,
      rawIngredients, rawCalculations, rawSteps, rawAdditionalNotes: sections['附加内容'] || [],
      ingredientStatements: statements, servingsEvidence: servings, minutesEvidence: minutes, steps,
      recipeDraft,
      validation: { validateRecipePass, schemaErrors, validator: 'src/domain/kitchen.js validateRecipe', validatedCategory: recipeDraft.category, ingredientCoverageVerified: false, cookingSafetyVerified: false },
      importReview: { state: 'needs_human_review', autoImportAllowed: false, offlineReviewAllowed: true, publicPublishingAllowed: false, rightsState: rightsNeedsReview ? 'hold_external_reference_rights_review' : 'repository_recipe_license_evidenced', reasons: [...(rightsNeedsReview ? ['存在第三方参考：未核实其独立表达/再许可范围，暂排除发布'] : []), '必备原料/计算/步骤的配料完整性及一致性需复核', '食品安全、总耗时、过敏原及源文健康宣称需复核', ...reviewNotes[title]] },
    };
    verifyCandidate(candidate);
    candidates.push(candidate);
  }
  assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, candidates.length);
  assert(candidates.length >= 30 && candidates.length <= 50);
  const privateReview = await readJson('private-menu-reviews.json');
  const privateRecipes = buildPrivateMenuRecipes(candidates, privateReview);
  const privateImportEntries = buildPrivateMenuImportEntries(privateRecipes);
  const distribution = Object.fromEntries(canonicalCategories.map((category) => [category, candidates.filter((candidate) => candidate.category === category).length]));
  const legacyDistribution = Object.fromEntries(legacyCategories.map((category) => [category, candidates.filter((candidate) => candidate.legacyCategory === category).length]));
  const summary = {
    generatedAt: new Date().toISOString(), sourceRevision: source.revision,
    validatorSourceSha256: hash(await readFile(resolve(workspace, 'src/domain/kitchen.js'), 'utf8')),
    totalCandidates: candidates.length, verifiedRawSourceHashes: candidates.length,
    candidateIntegrityPass: candidates.length, currentValidatorCategories: CATEGORIES,
    strictSchemaPass: candidates.filter((candidate) => candidate.validation.validateRecipePass).length,
    strictSchemaFail: candidates.filter((candidate) => !candidate.validation.validateRecipePass).length,
    readyForAutomaticImport: 0, humanReviewRequired: candidates.length, downloadedImages: 0,
    readyForPrivateMenuImport: privateRecipes.length,
    reviewedUniqueSourceCount: privateRecipes.length,
    remainingCandidatesWithoutReadyVariant: candidates.length - privateRecipes.length,
    privateMenuVariantIds: privateRecipes.map((recipe) => recipe.id),
    ingredientStatements: candidates.reduce((total, candidate) => total + candidate.ingredientStatements.length, 0),
    exactQuantityStatements: candidates.reduce((total, candidate) => total + candidate.ingredientStatements.filter((statement) => statement.status === 'exact').length, 0),
    unresolvedQuantityStatements: candidates.reduce((total, candidate) => total + candidate.ingredientStatements.filter((statement) => statement.status !== 'exact').length, 0),
    originalImageReferences: candidates.reduce((total, candidate) => total + candidate.image.references.length, 0),
    recipeLicenseEvidencedWithoutExternalReference: candidates.filter((candidate) => !candidate.license.externalReferenceReviewRequired).length,
    externalReferenceRightsHold: candidates.filter((candidate) => candidate.license.externalReferenceReviewRequired).map((candidate) => ({ id: candidate.id, title: candidate.title, references: candidate.externalReferences })),
    admittedThirdPartyImage: candidates.filter((candidate) => candidate.image.thirdPartyImageAdmitted).map((candidate) => candidate.title),
    distribution, legacyDistribution,
    warnings: ['候选结构完整不等于validateRecipe通过；validateRecipe通过也不等于食品安全或版权审查通过。', '缺失、范围、适量、不支持单位及复合公式保留原文/空值，不填默认值。', '原始42条不可盲目导入；ready-for-import.json仅含另行逐条文字复核的私家菜单改编版。没有实做或专业食品安全认证。', '无云端/数据库/广场写入；准备导入文件不等于已导入。'],
    recipes: candidates.map((candidate) => ({ id: candidate.id, title: candidate.title, category: candidate.category, legacyCategory: candidate.legacyCategory, validateRecipePass: candidate.validation.validateRecipePass, issues: candidate.validation.schemaErrors, review: candidate.importReview.reasons, sourceUrl: candidate.sourceUrl })),
  };
  const outputs = { 'candidates.json': candidates, 'validation-report.json': summary, 'ready-for-import.json': privateRecipes, 'private-menu-validation.json': { reviewDate: privateReview.reviewDate, reviewer: privateReview.reviewer, scope: privateReview.scope, count: privateRecipes.length, validateRecipePass: privateRecipes.length, sourceHashAndEvidencePass: privateRecipes.length, publicPublishingAllowed: false, importedToDatabase: false, validatorSourceSha256: summary.validatorSourceSha256, recipes: privateRecipes.map((recipe) => ({ id: recipe.id, title: recipe.title, category: recipe.category, servings: recipe.servings, minutes: recipe.minutes, ingredientCount: recipe.ingredients.length, ingredientEvidenceCount: recipe.adaptation.ingredientEvidence.length, sourceUrl: recipe.sourceUrl, changes: recipe.adaptation.changes })) }, 'schema-pass-review-only.json': candidates.filter((candidate) => candidate.validation.validateRecipePass), 'category-distribution.json': { categories: canonicalCategories, distribution, legacyDistribution, legacyMapping: Object.fromEntries(legacyCategories.map((category) => [category, category])), downgradeMapping: Object.fromEntries(canonicalCategories.map((category) => [category, legacyCategories.includes(category) ? category : '其他'])), sampleSize: candidates.length, sourceRevision: source.revision } };
  outputs['private-menu-import.json'] = privateImportEntries;
  outputs['private-menu-validation.json'].importEntries = privateImportEntries.map((entry, index) => ({
    file: `private-menu-import/${privateRecipes[index].id}.json`,
    title: entry.recipe.title,
    coreValidationWithProvenancePass: true,
    provenanceFieldLengths: Object.fromEntries(Object.entries(entry.provenance).map(([field, value]) => [field, value.length])),
  }));
  outputs['private-menu-validation.json'].saveRecipeCloudReviewPerformed = false;
  for (const [filename, content] of Object.entries(outputs)) await writeFile(resolve(root, filename), `${JSON.stringify(content, null, 2)}\n`);
  await mkdir(resolve(root, 'private-menu-import'), { recursive: true });
  for (const [index, entry] of privateImportEntries.entries()) await writeFile(resolve(root, 'private-menu-import', `${privateRecipes[index].id}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  await mkdir(resolve(root, 'candidates'), { recursive: true });
  for (const candidate of candidates) await writeFile(resolve(root, 'candidates', `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(JSON.stringify({ totalCandidates: summary.totalCandidates, rawHashesVerified: summary.verifiedRawSourceHashes, candidateIntegrityPass: summary.candidateIntegrityPass, strictSchemaPass: summary.strictSchemaPass, strictSchemaFail: summary.strictSchemaFail, originalBatchAutoImportReady: 0, reviewedPrivateMenuReady: privateRecipes.length, imagesDownloaded: 0, distribution, externalReferenceRightsHold: summary.externalReferenceRightsHold.length, output: relative(workspace, root), mode: 'offline_only_no_database_writes' }, null, 2));
  if (process.argv.includes('--require-ready') && !privateRecipes.length) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const unexpected = process.argv.slice(2).filter((argument) => argument !== '--require-ready');
  if (unexpected.length) throw new Error(`Unsupported flags: ${unexpected.join(', ')}. This script only prepares local review artifacts; it has no deployment/import-to-cloud mode.`);
  await generate();
}
