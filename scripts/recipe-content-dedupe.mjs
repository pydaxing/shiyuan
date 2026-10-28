import { createHash } from 'node:crypto';
import { canonicalRecipeUrl } from './recipe-discovery.mjs';

export const RECIPE_CONTENT_DEDUPE_VERSION = 'recipe-content-v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const widthNormalized = value => value.normalize('NFC').replace(/[\u3000\uFF01-\uFFEF]+/gu, part => part.normalize('NFKC')).normalize('NFC');
const isNumber = value => /\p{N}/u.test(value || '');

export function normalizeRecipeText(value) {
  const compact = widthNormalized(value).replace(/\s+/gu, (space, offset, text) => isNumber(text[offset - 1]) && isNumber(text[offset + space.length]) ? ' ' : '');
  return compact.replace(/[.,:;!?、。]/gu, (mark, offset, text) => isNumber(text[offset + 1]) && (isNumber(text[offset - 1]) || mark === '.') ? mark : '');
}

function chineseOrdinal(number) {
  const digits = '零一二三四五六七八九';
  if (number < 10) return digits[number];
  if (number < 100) return `${number < 20 ? '' : digits[Math.floor(number / 10)]}十${number % 10 ? digits[number % 10] : ''}`;
  return String(number);
}

function normalizeStep(text, index) {
  let value = widthNormalized(text).trim();
  const ordinal = index + 1;
  const number = `(?:${ordinal}|${chineseOrdinal(ordinal)})`;
  const labeled = new RegExp(`^(?:第\\s*${number}\\s*步|步骤\\s*${number}(?![0-9])|step\\s*${ordinal}(?![0-9]))\\s*(?:\\.(?!\\s*[0-9])|[:、)])?\\s*`, 'iu');
  const bracketed = new RegExp(`^\\(\\s*${number}\\s*\\)\\s*`, 'u');
  const enumerated = new RegExp(`^${number}\\s*[.、):]\\s*(?=[^0-9\\s])`, 'u');
  if (labeled.test(value)) value = value.replace(labeled, '');
  else if (bracketed.test(value)) value = value.replace(bracketed, '');
  else if (ordinal <= 20 && value.startsWith(String.fromCodePoint(0x245f + ordinal))) value = value.slice(1);
  else value = value.replace(enumerated, '');
  return normalizeRecipeText(value);
}

function normalizeValue(value) {
  if (typeof value === 'string') return normalizeRecipeText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeValue(value[key])]));
  return value;
}

export function normalizeRecipeContent(raw) {
  if (!Array.isArray(raw?.ingredients) || !raw.ingredients.length || !Array.isArray(raw?.steps) || !raw.steps.length) return null;
  if (!raw.ingredients.every(item => item && typeof item.name === 'string' && normalizeRecipeText(item.name) && typeof item.amountText === 'string')) return null;
  if (!raw.steps.every(step => step && typeof step.text === 'string')) return null;
  const steps = raw.steps.map((step, index) => normalizeStep(step.text, index));
  if (steps.some(step => !step)) return null;
  return { ingredients: raw.ingredients.map(normalizeValue), steps };
}

function fingerprintsFor(content) {
  const lengths = content?.steps.map(step => [...step.matchAll(/[\p{L}\p{N}]/gu)].length) || [];
  const textFingerprint = content ? digest([RECIPE_CONTENT_DEDUPE_VERSION, content]) : null;
  return {
    dedupeVersion: RECIPE_CONTENT_DEDUPE_VERSION,
    contentFingerprint: textFingerprint,
    textFingerprint,
    stepsFingerprint: content ? digest([RECIPE_CONTENT_DEDUPE_VERSION, content.steps]) : null,
    strongSteps: lengths.length >= 3 && lengths.every(length => length >= 15) && lengths.reduce((sum, length) => sum + length, 0) >= 100 && new Set(content.steps).size >= 3,
  };
}

export function recipeContentFingerprints(raw) {
  return fingerprintsFor(normalizeRecipeContent(raw));
}

const seasonings = new Set(['盐', '食盐', '细盐', '糖', '白糖', '白砂糖', '生抽', '老抽', '酱油', '蚝油', '醋', '陈醋', '米醋', '料酒', '胡椒粉', '白胡椒粉', '黑胡椒粉', '鸡精', '味精']);

function smallSeasoningDifference(first, second) {
  if (first.length !== second.length) return false;
  let differences = 0;
  for (let index = 0; index < first.length; index += 1) {
    const { amountText: firstAmount, ...firstRest } = first[index];
    const { amountText: secondAmount, ...secondRest } = second[index];
    if (JSON.stringify(firstRest) !== JSON.stringify(secondRest)) return false;
    if (firstAmount === secondAmount) continue;
    if (!seasonings.has(first[index].name) || ++differences > 2) return false;
    const amountPattern = /^(\d+(?:\.\d+)?)(克|g|毫升|ml|小勺|茶匙)$/u;
    const firstMatch = firstAmount.match(amountPattern);
    const secondMatch = secondAmount.match(amountPattern);
    if (!firstMatch || !secondMatch || firstMatch[2] !== secondMatch[2]) return false;
    const firstQuantity = Number(firstMatch[1]);
    const secondQuantity = Number(secondMatch[1]);
    const difference = Math.abs(firstQuantity - secondQuantity);
    const limit = ['小勺', '茶匙'].includes(firstMatch[2]) ? 0.25 : 2;
    if (!Number.isFinite(firstQuantity) || !Number.isFinite(secondQuantity) || Math.min(firstQuantity, secondQuantity) <= 0 || difference > limit || difference / Math.min(firstQuantity, secondQuantity) > 0.25) return false;
  }
  return differences > 0;
}

function canonicalOrder(first, second) {
  return Number(Boolean(second.record.publishedPostId)) - Number(Boolean(first.record.publishedPostId))
    || Number(Boolean(second.record.fullContentCollected)) - Number(Boolean(first.record.fullContentCollected))
    || String(first.record.archivedAt || '\uffff').localeCompare(String(second.record.archivedAt || '\uffff'))
    || first.sourceUrl.localeCompare(second.sourceUrl)
    || first.index - second.index;
}

export function indexRecipeContent(records) {
  const items = records.map((record, index) => {
    const sourceUrl = canonicalRecipeUrl(record.sourceUrl);
    if (!sourceUrl) throw new Error(`不支持的菜谱来源: ${record.sourceUrl}`);
    const content = normalizeRecipeContent(record.raw);
    return { record, index, sourceUrl, content, fingerprints: fingerprintsFor(content) };
  });
  const byUrl = new Map();
  const byContent = new Map();
  const bySteps = new Map();
  const results = new Array(items.length);
  for (const item of [...items].sort(canonicalOrder)) {
    const urlMatch = byUrl.get(item.sourceUrl);
    const contentMatch = item.fingerprints.textFingerprint && byContent.get(item.fingerprints.textFingerprint);
    const canonical = urlMatch || contentMatch;
    const result = {
      ...item.fingerprints,
      duplicateOf: canonical?.sourceUrl || null,
      duplicateReason: urlMatch ? 'same_source_url' : contentMatch ? 'normalized_ingredients_and_steps_equal' : null,
      suspectedDuplicateOf: null,
      suspectedDuplicateReason: null,
      requiresDuplicateReview: false,
      candidateEligible: !canonical && !item.record.publishedPostId,
    };
    results[item.index] = result;
    if (canonical) { byUrl.set(item.sourceUrl, canonical); continue; }
    byUrl.set(item.sourceUrl, item);
    if (!item.content) continue;
    byContent.set(item.fingerprints.textFingerprint, item);
    if (!item.fingerprints.strongSteps) continue;
    const stepMatches = bySteps.get(item.fingerprints.stepsFingerprint) || [];
    const suspected = stepMatches.find(previous => smallSeasoningDifference(previous.content.ingredients, item.content.ingredients));
    if (suspected) Object.assign(result, { suspectedDuplicateOf: suspected.sourceUrl, suspectedDuplicateReason: 'identical_long_steps_with_small_seasoning_quantity_difference', requiresDuplicateReview: true });
    stepMatches.push(item);
    bySteps.set(item.fingerprints.stepsFingerprint, stepMatches);
  }
  return results;
}
