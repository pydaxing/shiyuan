import assert from 'node:assert/strict';
import { SELECTABLE_UNITS } from '../src/domain/kitchen.js';
import { canonicalAmount, amountNumber } from './ingredient-standardization.mjs';

const presets = ['适量', '少许'];
const unitAliases = { 克: 'g', 公斤: 'kg', 千克: 'kg', 毫升: 'ml', 升: 'L', 公升: 'L', g: 'g', kg: 'kg', ml: 'ml', l: 'L', 匙: '勺', 勺子: '勺', 汤勺: '汤匙', 小勺: '勺', 大勺: '勺', 铲勺: '勺', 小撮: '撮', 大只: '只', 小瓣: '瓣', 小块: '块', 大块: '块', 小把: '把', 小碗: '碗', 大碗: '碗', 小盒: '盒', 小包: '包', 大段: '段', 小段: '段' };
const unitPattern = [...new Set([...SELECTABLE_UNITS, ...Object.keys(unitAliases)])].sort((a, b) => b.length - a.length).join('|');
const numberPattern = '(?:半|[一二两三四五六七八九十]+|(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:\\s*/\\s*\\d+(?:\\.\\d+)?)?)';
const measuredSearch = new RegExp(`(?<![\\w./])(${numberPattern})\\s*(${unitPattern})(半)?`, 'gi');
const rangePattern = new RegExp(`^约?(${numberPattern})\\s*(${unitPattern})?\\s*(?:[-—–~～]+|到|至|或(?:者)?|/|、|一)\\s*(${numberPattern})\\s*(${unitPattern})?`, 'i');
const chineseRangePattern = new RegExp(`^([一二两三四五六七八九])([一二两三四五六七八九])\\s*(${unitPattern})`, 'i');
const lowerBoundPattern = new RegExp(`^(${numberPattern})\\s*(${unitPattern})(?:以上|起|多|余|有余)$`, 'i');
const afterNumberLowerBoundPattern = new RegExp(`^(${numberPattern})(?:余|多)\\s*(${unitPattern})$`, 'i');
const normalizedUnit = unit => unitAliases[String(unit).toLowerCase()] || unitAliases[unit] || unit;
const validQuantity = quantity => typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0.001 && quantity <= 100000;
const cleanText = text => typeof text === 'string' ? text.normalize('NFKC').replace(/⁄/g, '/').trim() : '';

/** The amount contract intentionally uses the 38 selectable units, not UNITS. */
export function assertStrictIngredient(ingredient) {
  assert.ok(ingredient && typeof ingredient.name === 'string' && ingredient.name.trim(), '食材名称不能为空');
  if (Object.hasOwn(ingredient, 'amountText')) {
    assert.ok(presets.includes(ingredient.amountText), `文字用量只能是适量或少许：${ingredient.amountText}`);
    assert.equal(ingredient.quantity, null, '文字用量的quantity必须为null');
    assert.equal(ingredient.unit, '', '文字用量的unit必须为空');
  } else {
    assert.ok(validQuantity(ingredient.quantity), `数字用量必须为0.001～100000内的有限数字：${ingredient.quantity}`);
    assert.ok(SELECTABLE_UNITS.includes(ingredient.unit), `单位不在38项可选单位内：${ingredient.unit}`);
  }
  return ingredient;
}

function withAmount(ingredient, amount) {
  const next = { ...ingredient, ...amount };
  if (!Object.hasOwn(amount, 'amountText')) delete next.amountText;
  if (next.unit) next.unit = normalizedUnit(next.unit);
  return assertStrictIngredient(next);
}

const presetAmount = amountText => ({ quantity: null, unit: '', amountText });
const measured = (quantity, unit) => ({ quantity, unit: normalizedUnit(unit) });
const named = (name, quantity, unit) => ({ name, ...measured(quantity, unit) });
const namedPreset = (name, amountText = '适量') => ({ name, ...presetAmount(amountText) });
function result(ingredient, amounts, reason, kind) {
  const ingredients = amounts.map(amount => withAmount(ingredient, amount));
  return { ingredients, reason, kind };
}

function parseMeasure(text) {
  const amount = canonicalAmount(text);
  if (!amount || Object.hasOwn(amount, 'amountText')) return null;
  const value = measured(amount.quantity, amount.unit);
  return validQuantity(value.quantity) && SELECTABLE_UNITS.includes(value.unit) ? value : null;
}

function parseRange(text) {
  const clean = cleanText(text);
  let match = clean.match(rangePattern);
  if (match && (match[2] || match[4])) {
    const leftUnit = normalizedUnit(match[2] || match[4]);
    const rightUnit = normalizedUnit(match[4] || match[2]);
    const left = amountNumber(match[1]);
    const right = amountNumber(match[3]);
    if (leftUnit === rightUnit && validQuantity(left) && validQuantity(right)) return measured(Math.min(left, right), leftUnit);
  }
  match = clean.match(chineseRangePattern);
  if (match) return measured(Math.min(amountNumber(match[1]), amountNumber(match[2])), match[3]);
  match = clean.match(lowerBoundPattern) || clean.match(afterNumberLowerBoundPattern);
  if (match && validQuantity(amountNumber(match[1]))) return measured(amountNumber(match[1]), match[2]);
  return null;
}

function parseSum(text) {
  const pieces = text.split(/\s*[+➕]\s*/);
  if (pieces.length < 2 || pieces.some(piece => !piece)) return null;
  const final = parseMeasure(pieces.at(-1));
  if (!final) return null;
  const amounts = pieces.map(piece => parseMeasure(piece) || (validQuantity(amountNumber(piece)) ? measured(amountNumber(piece), final.unit) : null));
  if (amounts.some(amount => !amount || amount.unit !== final.unit)) return null;
  const quantity = amounts.reduce((sum, amount) => sum + amount.quantity, 0);
  return validQuantity(quantity) ? measured(quantity, final.unit) : null;
}

function recipeContext(context) {
  const recipe = context.recipe || context;
  return {
    recipe,
    text: [context.title, recipe.title, ...(recipe.steps || context.steps || []).map(step => typeof step === 'string' ? step : step.text || ''), recipe.provenance?.note || ''].join('\n'),
  };
}

// Exact-name and amount combinations independently reviewed against the fresh
// 2026-10-27 backup; unknown totals are not allocated across mixed ingredients.
const reviewedNames = [
  {"match":{"name":"带皮五花肉1.5斤","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"带皮五花肉","quantity":1.5,"unit":"斤"}],"reason":"名称明确写出1.5斤，不降级为适量。"},
  {"match":{"name":"土豆一个切块","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"土豆","quantity":1,"unit":"个"}],"reason":"一个为数量，切块为处理方式。"},
  {"match":{"name":"冰糖6个","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"冰糖","quantity":6,"unit":"个"}],"reason":"名称明确数字与支持单位。"},
  {"match":{"name":"适量葱姜蒜、八角两个、香叶两片、桂皮一小块","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"葱","quantity":null,"unit":"","amountText":"适量"},{"name":"姜","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜","quantity":null,"unit":"","amountText":"适量"},{"name":"八角","quantity":2,"unit":"个"},{"name":"香叶","quantity":2,"unit":"片"},{"name":"桂皮","quantity":1,"unit":"块"}],"reason":"前三项各适量，后三项名称内有明确用量；小块保留1块不作质量换算。"},
  {"match":{"name":"（孩子吃饭用的小勺）老抽一勺、生抽两勺","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"老抽","quantity":1,"unit":"勺"},{"name":"生抽","quantity":2,"unit":"勺"}],"reason":"括号限定量具；按已确认规则统一勺，保持1与2，不换算容量。"},
  {"match":{"name":"盐/胡椒粉/淀粉/食用油","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":null,"unit":"","amountText":"适量"},{"name":"胡椒粉","quantity":null,"unit":"","amountText":"适量"},{"name":"淀粉","quantity":null,"unit":"","amountText":"适量"},{"name":"食用油","quantity":null,"unit":"","amountText":"适量"}],"reason":"酸菜鱼步骤列举腌制需要的四项，斜线在此是并列，不是替代。"},
  {"match":{"name":"葱/姜/蒜/酸菜","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"葱","quantity":null,"unit":"","amountText":"适量"},{"name":"姜","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜","quantity":null,"unit":"","amountText":"适量"}],"reason":"该唯一原记录已另有独立酸菜适量行；拆葱姜蒜，保留原独立酸菜行避免重复。"},
  {"match":{"name":"干辣椒/花椒/白芝麻","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"干辣椒","quantity":null,"unit":"","amountText":"适量"},{"name":"花椒","quantity":null,"unit":"","amountText":"适量"},{"name":"白芝麻","quantity":null,"unit":"","amountText":"适量"}],"reason":"酸菜鱼末尾香料并列，数量未明，各适量。"},
  {"match":{"name":"牛肉1斤","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"牛肉","quantity":1,"unit":"斤"}],"reason":"原名称与荷兰豆炒牛肉步骤均明确1斤。"},
  {"match":{"name":"胡萝卜，荷兰豆","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"胡萝卜","quantity":null,"unit":"","amountText":"适量"},{"name":"荷兰豆","quantity":null,"unit":"","amountText":"适量"}],"reason":"并列蔬菜，均未给数量。"},
  {"match":{"name":"盐，生抽，蚝油","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":null,"unit":"","amountText":"适量"},{"name":"生抽（腌制）","quantity":2,"unit":"勺"},{"name":"生抽（炒菜）","quantity":1,"unit":"汤匙"},{"name":"蚝油","quantity":1,"unit":"勺"}],"reason":"荷兰豆炒牛肉步骤1明确生抽2勺/蚝油1勺；步骤11另淋1汤勺生抽。保留不同用法和单位，不把勺与汤匙做容量换算。"},
  {"match":{"name":"蒜头，地瓜粉，食用油","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"蒜头","quantity":4,"unit":"瓣"},{"name":"地瓜粉","quantity":null,"unit":"","amountText":"适量"},{"name":"食用油","quantity":2,"unit":"汤匙"}],"reason":"荷兰豆炒牛肉步骤1蒜头4瓣，步骤4两汤勺食用油；地瓜粉无量。"},
  {"match":{"name":"八角，桂皮，花椒，草果，干椒","amountText":"你们看着办，多一点少一点不是问题","amountTextPresent":true},"ingredients":[{"name":"八角","quantity":null,"unit":"","amountText":"适量"},{"name":"桂皮","quantity":null,"unit":"","amountText":"适量"},{"name":"花椒","quantity":null,"unit":"","amountText":"适量"},{"name":"草果","quantity":null,"unit":"","amountText":"适量"},{"name":"干椒","quantity":null,"unit":"","amountText":"适量"}],"reason":"明确并列香料；原文主观用量统一适量。"},
  {"match":{"name":"糖，醋，盐，酱油，料酒","amountText":"醋一勺，酱油三勺，料酒一勺","amountTextPresent":true},"ingredients":[{"name":"糖","quantity":null,"unit":"","amountText":"适量"},{"name":"醋","quantity":1,"unit":"勺"},{"name":"盐","quantity":null,"unit":"","amountText":"适量"},{"name":"酱油","quantity":3,"unit":"勺"},{"name":"料酒","quantity":1,"unit":"勺"}],"reason":"amountText逐项给出醋/酱油/料酒，糖盐未给数量。"},
  {"match":{"name":"姜+葱","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"姜","quantity":null,"unit":"","amountText":"适量"},{"name":"葱","quantity":null,"unit":"","amountText":"适量"}],"reason":"加号为两种食材并列。"},
  {"match":{"name":"小苏打和清水","amountText":"1克和10克","amountTextPresent":true},"ingredients":[{"name":"小苏打","quantity":1,"unit":"g"},{"name":"清水","quantity":10,"unit":"g"}],"reason":"两种食材与两个克数按原顺序逐一对应。"},
  {"match":{"name":"黑胡椒粉0.6克，糖4克，生抽10克，玉米淀粉6克，","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"黑胡椒粉","quantity":0.6,"unit":"g"},{"name":"糖","quantity":4,"unit":"g"},{"name":"生抽","quantity":10,"unit":"g"},{"name":"玉米淀粉","quantity":6,"unit":"g"}],"reason":"四个明确名称内克数覆盖兜底适量，末尾逗号不生成空项。"},
  {"match":{"name":"食用油16克","amountText":null,"amountTextPresent":false,"quantity":16,"unit":"g"},"ingredients":[{"name":"食用油","quantity":16,"unit":"g"}],"reason":"已独立存有16g，只移除名称重复用量，不再乘加。"},
  {"match":{"name":"鸡蛋清一个","amountText":null,"amountTextPresent":false,"quantity":36.5,"unit":"g"},"ingredients":[{"name":"鸡蛋清","quantity":36.5,"unit":"g"}],"reason":"现有明确称量36.5g优先；名称一个是重复说明，不覆盖成1个或加一次。"},
  {"match":{"name":"黑椒碎黑椒粉","amountText":"各一勺","amountTextPresent":true},"ingredients":[{"name":"黑椒碎","quantity":1,"unit":"勺"},{"name":"黑椒粉","quantity":1,"unit":"勺"}],"reason":"各一勺明确分别适用；照烧鸡腿饭步骤也同时使用。"},
  {"match":{"name":"盐小半勺","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":null,"unit":"","amountText":"少许"}],"reason":"小半勺不是精确0.5勺；保守保留小量含义，不臆造精确数字。"},
  {"match":{"name":"西蓝花胡萝卜少许","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"西蓝花","quantity":null,"unit":"","amountText":"少许"},{"name":"胡萝卜","quantity":null,"unit":"","amountText":"少许"}],"reason":"明确两种蔬菜及少许。"},
  {"match":{"name":"大蒜生姜几片","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"大蒜","quantity":null,"unit":"","amountText":"适量"},{"name":"生姜","quantity":null,"unit":"","amountText":"适量"}],"reason":"几片没有确定数量；两种食材分别适量。"},
  {"match":{"name":"蒜末、葱花","amountText":"少许","amountTextPresent":true},"ingredients":[{"name":"蒜末","quantity":null,"unit":"","amountText":"少许"},{"name":"葱花","quantity":null,"unit":"","amountText":"少许"}],"reason":"少许适用于并列两项。"},
  {"match":{"name":"线椒4个，小米辣3个，蒜5瓣，姜适量","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"线椒","quantity":4,"unit":"个"},{"name":"小米辣","quantity":3,"unit":"个"},{"name":"蒜","quantity":5,"unit":"瓣"},{"name":"姜","quantity":null,"unit":"","amountText":"适量"}],"reason":"逐项提取名称内4个/3个/5瓣/适量。"},
  {"match":{"name":"盐，鸡精，生抽，老抽，料酒，蚝油，白胡椒粉，淀粉","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":null,"unit":"","amountText":"适量"},{"name":"鸡精","quantity":1,"unit":"勺"},{"name":"生抽","quantity":2,"unit":"勺"},{"name":"老抽","quantity":0.5,"unit":"勺"},{"name":"料酒","quantity":2,"unit":"勺"},{"name":"蚝油","quantity":2,"unit":"勺"},{"name":"白胡椒粉","quantity":2,"unit":"勺"},{"name":"淀粉","quantity":1,"unit":"勺"}],"reason":"香辣小炒鸡步骤0和1明确上述用量；盐未给量；小勺统一勺且不作容量换算。"},
  {"match":{"name":"生姜5片、小葱5根切末","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"生姜","quantity":5,"unit":"片"},{"name":"小葱","quantity":5,"unit":"根"}],"reason":"名称内明确两项数量，切末仅是处理方式。"},
  {"match":{"name":"蚝油，一品鲜","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"蚝油","quantity":null,"unit":"","amountText":"适量"},{"name":"一品鲜","quantity":null,"unit":"","amountText":"适量"}],"reason":"两种调料并列，未给确定量。"},
  {"match":{"name":"辣椒面，白芝麻，葱末，蒜末","amountText":"各1勺","amountTextPresent":true},"ingredients":[{"name":"辣椒面","quantity":1,"unit":"勺"},{"name":"白芝麻","quantity":1,"unit":"勺"},{"name":"葱末","quantity":1,"unit":"勺"},{"name":"蒜末","quantity":1,"unit":"勺"}],"reason":"各1勺分别对应四项，柠檬凉拌鸡丝步骤1吻合。"},
  {"match":{"name":"生抽，香醋","amountText":"各2勺","amountTextPresent":true},"ingredients":[{"name":"生抽","quantity":2,"unit":"勺"},{"name":"香醋","quantity":2,"unit":"勺"}],"reason":"各2勺分别适用，步骤1吻合。"},
  {"match":{"name":"食盐，白糖","amountText":"1小勺","amountTextPresent":true},"ingredients":[{"name":"食盐","quantity":null,"unit":"","amountText":"少许"},{"name":"白糖","quantity":null,"unit":"","amountText":"少许"}],"reason":"原列表未说明1小勺如何分配；柠檬凉拌鸡丝步骤1明确少许盐和糖，不能各给1勺。"},
  {"match":{"name":"鸡肉：1000克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"鸡肉","quantity":1000,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"干香菇：50克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"干香菇","quantity":50,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"八角：3克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"八角","quantity":3,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"干红辣椒：6个","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"干红辣椒","quantity":6,"unit":"个"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"大葱：20克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"大葱","quantity":20,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"生姜：20克(分两次用)","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"生姜","quantity":20,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"盐：13克左右","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":13,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"生抽：20克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"生抽","quantity":20,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"老抽：5克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"老抽","quantity":5,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"耗油：10克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"蚝油","quantity":10,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"料酒：20克(分两次用)","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"料酒","quantity":20,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"白糖：17克","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"白糖","quantity":17,"unit":"g"}],"reason":"香菇炖鸡名称给出明确数量；克归g，分两次用是总量分配不翻倍，左右取名义值；耗油按调料名称纠为蚝油。"},
  {"match":{"name":"食用油：适量","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"食用油","quantity":null,"unit":"","amountText":"适量"}],"reason":"名称已有适量，只移出名称并覆盖原文未注明。"},
  {"match":{"name":"糖、盐","amountText":"少量","amountTextPresent":true},"ingredients":[{"name":"糖","quantity":null,"unit":"","amountText":"少许"},{"name":"盐","quantity":null,"unit":"","amountText":"少许"}],"reason":"少量保守映射少许，两项分别记录。"},
  {"match":{"name":"口蘑、山药、羊肚菌、玉米、豌豆","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"口蘑","quantity":null,"unit":"","amountText":"适量"},{"name":"山药","quantity":null,"unit":"","amountText":"适量"},{"name":"羊肚菌","quantity":null,"unit":"","amountText":"适量"},{"name":"玉米","quantity":null,"unit":"","amountText":"适量"},{"name":"豌豆","quantity":null,"unit":"","amountText":"适量"}],"reason":"五种汤料并列且原文无确定量。"},
  {"match":{"name":"莴笋1根","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"莴笋","quantity":1,"unit":"根"}],"reason":"名称明确1根。"},
  {"match":{"name":"蒜片一小把","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"蒜片","quantity":1,"unit":"把"}],"reason":"小把归支持单位把，保持1，不作重量换算。"},
  {"match":{"name":"小米辣两个(不吃辣的不放）","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"小米辣（不吃辣可不放）","quantity":2,"unit":"个"}],"reason":"两个是确定量；是否放为可选条件保留在名称，不把2误删为不确定。"},
  {"match":{"name":"温水2份各","amountText":null,"amountTextPresent":false,"quantity":50,"unit":"g"},"ingredients":[{"name":"温水","quantity":100,"unit":"g"}],"reason":"香脆猫耳朵步骤2–7确认两个面团各一份，按各份×2合并为整份配方总量。"},
  {"match":{"name":"鸡蛋2份各","amountText":null,"amountTextPresent":false,"quantity":1,"unit":"个"},"ingredients":[{"name":"鸡蛋","quantity":2,"unit":"个"}],"reason":"香脆猫耳朵步骤2–7确认两个面团各一份，按各份×2合并为整份配方总量。"},
  {"match":{"name":"面粉2份各","amountText":null,"amountTextPresent":false,"quantity":250,"unit":"g"},"ingredients":[{"name":"面粉","quantity":500,"unit":"g"}],"reason":"香脆猫耳朵步骤2–7确认两个面团各一份，按各份×2合并为整份配方总量。"},
  {"match":{"name":"猪油2份各","amountText":"1勺","amountTextPresent":true},"ingredients":[{"name":"猪油","quantity":2,"unit":"勺"}],"reason":"香脆猫耳朵步骤4确认猪油准备2份；每份1勺合计2勺。"},
  {"match":{"name":"姜蒜葱","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"姜","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜","quantity":null,"unit":"","amountText":"适量"},{"name":"葱","quantity":null,"unit":"","amountText":"适量"}],"reason":"并列三种调味食材。"},
  {"match":{"name":"葱姜蒜","amountText":"少许","amountTextPresent":true},"ingredients":[{"name":"葱","quantity":null,"unit":"","amountText":"少许"},{"name":"姜","quantity":null,"unit":"","amountText":"少许"},{"name":"蒜","quantity":null,"unit":"","amountText":"少许"}],"reason":"并列三种调味食材，沿用确定的两类文字量。"},
  {"match":{"name":"葱姜蒜","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"葱","quantity":null,"unit":"","amountText":"适量"},{"name":"姜","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜","quantity":null,"unit":"","amountText":"适量"}],"reason":"并列三种调味食材，沿用确定的两类文字量。"},
  {"match":{"name":"花椒大料","amountText":"少许","amountTextPresent":true},"ingredients":[{"name":"花椒","quantity":null,"unit":"","amountText":"少许"},{"name":"大料","quantity":null,"unit":"","amountText":"少许"}],"reason":"两种香料并列；一点即可归少许，不推测克数。"},
  {"match":{"name":"花椒大料","amountText":"一点即可","amountTextPresent":true},"ingredients":[{"name":"花椒","quantity":null,"unit":"","amountText":"少许"},{"name":"大料","quantity":null,"unit":"","amountText":"少许"}],"reason":"两种香料并列；一点即可归少许，不推测克数。"},
  {"match":{"name":"腌牛肉调料：生抽蚝油淀粉油","amountText":"3（原文未注明单位）","amountTextPresent":true},"ingredients":[{"name":"生抽（腌制）","quantity":null,"unit":"","amountText":"适量"},{"name":"蚝油（腌制）","quantity":null,"unit":"","amountText":"适量"},{"name":"淀粉（腌制）","quantity":null,"unit":"","amountText":"适量"},{"name":"食用油（腌制）","quantity":null,"unit":"","amountText":"适量"}],"reason":"3缺少单位且未指明逐项分配，不能套成每项3勺；只确定四种食材。 原分组明确腌制阶段，保留阶段标签，避免与炒菜配料蚝油混并。"},
  {"match":{"name":"炒菜配料：小米辣蒜末姜丝泡椒香菜 →盐鸡精蚝油老抽","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"小米辣","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜末","quantity":null,"unit":"","amountText":"适量"},{"name":"姜丝","quantity":null,"unit":"","amountText":"适量"},{"name":"泡椒","quantity":null,"unit":"","amountText":"适量"},{"name":"香菜","quantity":null,"unit":"","amountText":"适量"},{"name":"盐","quantity":null,"unit":"","amountText":"适量"},{"name":"鸡精","quantity":null,"unit":"","amountText":"适量"},{"name":"蚝油","quantity":null,"unit":"","amountText":"适量"},{"name":"老抽","quantity":null,"unit":"","amountText":"适量"}],"reason":"箭头是加入顺序，明确九种食材；无确定数量。"},
  {"match":{"name":"葱姜蒜末","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"葱末","quantity":null,"unit":"","amountText":"适量"},{"name":"姜末","quantity":null,"unit":"","amountText":"适量"},{"name":"蒜末","quantity":null,"unit":"","amountText":"适量"}],"reason":"三种切末调料。"},
  {"match":{"name":"姜丝姜片适量","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"生姜","quantity":null,"unit":"","amountText":"适量"}],"reason":"同一生姜的两种切法，合并一项适量，避免重复。"},
  {"match":{"name":"盐适量","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"盐","quantity":null,"unit":"","amountText":"适量"}],"reason":"用量移出名称。"},
  {"match":{"name":"油适量","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"食用油","quantity":null,"unit":"","amountText":"适量"}],"reason":"用量移出名称，油明确为烹调用油。"},
  {"match":{"name":"胡椒粉少许","amountText":"原文未注明","amountTextPresent":true},"ingredients":[{"name":"胡椒粉","quantity":null,"unit":"","amountText":"少许"}],"reason":"用量移出名称。"},
  {"match":{"name":"青豆玉米彩椒","amountText":"适量","amountTextPresent":true},"ingredients":[{"name":"青豆","quantity":null,"unit":"","amountText":"适量"},{"name":"玉米","quantity":null,"unit":"","amountText":"适量"},{"name":"彩椒","quantity":null,"unit":"","amountText":"适量"}],"reason":"三种并列蔬菜。"}
];

/** Pure conversion; context may be a recipe, or { recipe, title, steps }. */
export function strictIngredient(ingredient, context = {}) {
  assert.ok(ingredient && typeof ingredient.name === 'string' && ingredient.name.trim(), '食材名称不能为空');
  const original = { ...ingredient, name: ingredient.name.trim() };
  const raw = original.amountText;
  const text = cleanText(raw);
  const normalizedName = cleanText(original.name);
  const nameReview = reviewedNames.find(entry => cleanText(entry.match.name) === normalizedName && (entry.match.amountTextPresent ? raw === entry.match.amountText : raw === undefined && original.quantity === entry.match.quantity && original.unit === entry.match.unit));
  if (nameReview) {
    const ingredients = [...nameReview.ingredients];
    if (normalizedName === '葱/姜/蒜/酸菜' && !recipeContext(context).recipe.ingredients?.some(item => item.name === '酸菜')) {
      ingredients.push(namedPreset('酸菜'));
      return result(original, ingredients, '原文并列葱姜蒜酸菜，拆为独立适量；没有既存独立酸菜行时保留酸菜。', 'reviewed_name');
    }
    return result(original, ingredients, nameReview.reason, 'reviewed_name');
  }

  const reviewedContext = reviewedContexts.find(entry => entry.name === original.name && entry.amountText === raw && (entry.originalQuantity === undefined || entry.originalQuantity === original.quantity));
  if (reviewedContext) return result(original, reviewedContext.ingredients, reviewedContext.reason, 'reviewed_context');

  const perPortion = normalizedName.match(/^(.+?)(\d+)份各$/);
  if (perPortion) {
    const amount = raw === undefined ? measured(Number(original.quantity), original.unit) : parseMeasure(text);
    const total = amount && amount.quantity * Number(perPortion[2]);
    if (amount && validQuantity(total) && SELECTABLE_UNITS.includes(amount.unit)) return result(original, [{ name: perPortion[1], ...measured(total, amount.unit) }], `原文${perPortion[2]}份各${amount.quantity}${amount.unit}，总用量为${total}${amount.unit}，分次使用说明保留原文。`, 'summed_portions');
  }

  if (original.name === '食盐，白糖' && text === '1小勺') {
    return result(original, [namedPreset('食盐', '少许'), namedPreset('白糖', '少许')], '该配方步骤明确少许盐和糖，原表合写一小勺不能解读为各一小勺，依据步骤拆为各少许。', 'reviewed_context');
  }

  if (text === '一条三花趾两勺,一条五花趾三勺,以此类推') {
    return result(original, [presetAmount('适量')], '盐量取决于牛腱部位：每条三花趾2勺、五花趾3勺。原文允许替换，不能唯一确定部位；保留适量和完整条件原文。', 'conditional_unknown');
  }
  if (original.name === '冰糖' && text === '1只鸡至多50g冰糖') {
    const { recipe, text: source } = recipeContext(context);
    const chicken = recipe.ingredients?.find(item => item.name === '鸡' && item.quantity === 1 && item.unit === '只');
    if (chicken || /一只的糖大概是50克左右/.test(source)) return result(original, [measured(50, 'g')], '本配方为一只鸡，末尾说明明确糖大概50克；采用该原文参考量，至多及酌减条件保留原文。', 'contextual_measure');
    return result(original, [presetAmount('适量')], '原文50克为每只鸡的上限，缺少本配方鸡只数或参考量依据，不能直接当成唯一用量。', 'conditional_unknown');
  }
  if (original.name === '彩椒' && text === '两个半只(想要两种颜色') {
    return result(original, [measured(1, '个')], '原文两个半只并注明两种颜色，按两个各半只合计1个记录，不误读成两个半即2.5个；颜色说明保留原文。', 'reviewed_measure');
  }

  const plusPreset = text.match(/^(.+?)\s*[+➕]\s*(适量|少许)$/);
  if (plusPreset) {
    const amount = parseMeasure(plusPreset[1]);
    if (amount) return result(original, [amount, presetAmount(plusPreset[2])], '原文明确数字用量并另加少量，拆为同食材的数字行和固定文字行，完整保留两部分而不臆造总量。', 'measured_plus_preset');
  }

  const sum = parseSum(text);
  if (sum) return result(original, [sum], '原文明示同一食材、同一单位的多份数字用量，按加法合计；分次使用方法保留原文。', 'summed_measure');

  if (raw === undefined) {
    const amount = measured(Number(original.quantity), original.unit);
    if (validQuantity(amount.quantity) && SELECTABLE_UNITS.includes(amount.unit)) {
      return result(original, [amount], amount.unit === original.unit ? '已有数字用量和38项内单位保持不变。' : '保留已有数字；小勺、大勺、铲勺归通用勺，不假定器皿容量或换算毫升。', amount.unit === original.unit && typeof original.quantity === 'number' ? 'measured' : 'normalized_measure');
    }
    return result(original, [presetAmount('适量')], '原数字用量缺失、无效或单位不在38项内且不能确定别名，使用固定适量选项。', 'unknown');
  }

  const amount = parseMeasure(text);
  if (amount) return result(original, [amount], /小勺|大勺|铲勺/.test(text) ? '保留原文明示数量，三种额外勺单位归通用勺，不假定器皿容量。' : '原文明示单一数值与单位，拆分为数字quantity及可选unit。', 'parsed_measure');

  const eachRange = /^各/.test(text) ? parseRange(text.slice(1)) : null;
  if (eachRange) {
    const names = original.name.split(/[、,，\s]+/).filter(Boolean);
    if (names.length > 1) return result(original, names.map(name => ({ name, ...eachRange })), `原文各${text.slice(1)}，逐项拆分并按统一规则取区间下限${eachRange.quantity}${eachRange.unit}作为可编辑默认量，完整范围保留原文。`, 'range_lower_bound');
  }
  const range = parseRange(text.replace(/^无或/, ''));
  if (range) return result(original, [range], `原文用量${raw}；按用户统一规则取原文下限${range.quantity}${range.unit}作为可编辑默认量，此值不是原文唯一精确值，完整范围和条件保留于备份及变更清单。`, 'range_lower_bound');

  const reviewed = reviewedAmounts.find(entry => entry.from === raw || cleanText(entry.from) === text);
  if (reviewed) {
    const value = typeof reviewed.to === 'string' ? parseMeasure(reviewed.to) : reviewed.to;
    assert.ok(value, `复核映射不符合严格数量要求：${raw}`);
    return result(original, [value], reviewed.reason, 'reviewed_measure');
  }

  // A single explicit measure survives surrounding optional/specification text.
  // Multiple measures need a reviewed rule, so dimensions, alternatives and
  // per-item weights cannot accidentally be added or chosen as a total.
  const occurrences = [...text.matchAll(measuredSearch)];
  const uncertain = /(?:未注明|以上|至多|至少|不超过|小半|大半|半.+多|若干|几|各|\+|➕|或|或者|到|至|[-—–~～])/.test(text);
  if (occurrences.length === 1 && !uncertain) {
    const found = parseMeasure(occurrences[0][0]);
    if (found) return result(original, [found], '原文只有一个明确的数字及单位，去除大小、切法或参考说明；不换算器皿容量。', 'embedded_text_measure');
  }

  const amountText = /^(?:少许|少量|一点|一丢丢|几滴|小半勺)/.test(text) ? '少许' : presets.includes(text) ? text : '适量';
  return result(original, [presetAmount(amountText)], presets.includes(text) ? '保留现有固定用量选项。' : '原文没有可唯一提取的数量与38项内单位，未知或未注明描述归适量；明确少量语义归少许。', presets.includes(text) ? 'preset' : 'unknown');
}

// Reviewed source-specific meanings from the 2026-10-20 audit. Range and
// unknown-text decisions are deliberately handled below under the stricter policy.
const reviewedAmounts = [
  {
    "from": "1大勺TBSP",
    "to": "1汤匙",
    "reason": "原文明确标注TBSP，统一到汤匙，不换算毫升。"
  },
  {
    "from": "1小勺TSP",
    "to": "1茶匙",
    "reason": "原文明确标注TSP，统一到茶匙，不换算毫升。"
  },
  {
    "from": "半小勺TSP",
    "to": "半茶匙",
    "reason": "原文明确标注TSP和半份，保持半茶匙用量。"
  },
  {
    "from": "2g左右",
    "to": "2g",
    "reason": "使用原文明示的2克参考量，不另行估算。"
  },
  {
    "from": "两条三花趾（五花趾）",
    "to": "2条",
    "reason": "牛腱原文明示两条，括号是部位选择而非另一数量。"
  },
  {
    "from": "适量(1勺)",
    "to": "1勺",
    "reason": "括号给出了可用的一勺参考量，采用原文数量。"
  },
  {
    "from": "适量(3勺)",
    "to": "3勺",
    "reason": "括号给出了可用的三勺参考量，采用原文数量。"
  },
  {
    "from": "适量(2勺)",
    "to": "2勺",
    "reason": "括号给出了可用的两勺参考量，采用原文数量。"
  },
  {
    "from": "180g（一袋）",
    "to": "180g",
    "reason": "原文明示一袋共180克，保留明确净重量。"
  },
  {
    "from": "1杯（100克）",
    "to": "100g",
    "reason": "原文明示本配方一杯面粉为100克，不泛化杯容量。"
  },
  {
    "from": "2杯（250克）",
    "to": "250g",
    "reason": "原文明示本配方两杯清水合计250克，保留原值。"
  },
  {
    "from": "1勺（4cm",
    "to": "1勺",
    "reason": "原文数量是一勺，残缺括号是勺尺寸而非数量。"
  },
  {
    "from": "一勺（口径4cm",
    "to": "1勺",
    "reason": "原文数量是一勺，口径描述不用于换算容积。"
  },
  {
    "from": "一斤左右",
    "to": "1斤",
    "reason": "沿用原文明示的一斤参考量，不改为推测重量。"
  },
  {
    "from": "400克（2块）",
    "to": "400g",
    "reason": "原文明示两块鸡胸肉合计400克，保留总重。"
  },
  {
    "from": "10个左右",
    "to": "10个",
    "reason": "沿用原文约十个的参考数值，不改动单位。"
  },
  {
    "from": "2个（约400克）",
    "to": "2个",
    "reason": "保留原文明示的两个鸡腿，不以估重替换计数。"
  },
  {
    "from": "半勺（没有可不放）",
    "to": "半勺",
    "reason": "原文明示半勺；可选说明仍保留于来源原文。"
  },
  {
    "from": "1个（大的）",
    "to": "1个",
    "reason": "原文明示一个，大小说明不换算成估计克数。"
  },
  {
    "from": "1条(650克)",
    "to": "1条",
    "reason": "保留原文一条鱼的计数，重量说明保留原文。"
  },
  {
    "from": "约1克",
    "to": "1g",
    "reason": "原文明示约一克参考值，不增加推测数值。"
  },
  {
    "from": "15克左右",
    "to": "15g",
    "reason": "原文明示十五克参考值，统一克的单位写法。"
  },
  {
    "from": "3勺子🥄",
    "to": "3勺",
    "reason": "去除勺子后面的装饰符号，保留三勺原量。"
  },
  {
    "from": "1根(小火腿肠)",
    "to": "1根",
    "reason": "原文明示一根，括号描述规格而非另一用量。"
  },
  {
    "from": "500+500毫升",
    "to": "1000ml",
    "reason": "原文明示两份各500毫升，标准食材总量合计1000毫升，分次做法不变。"
  },
  {
    "from": "275克（大鸡蛋5个小鸡蛋6个）",
    "to": "275g",
    "reason": "主用量为275克蛋液，按原文重量而非猜测鸡蛋数量。"
  },
  {
    "from": "8个（每个约55克）蛋白270克，蛋黄136克",
    "to": "8个",
    "reason": "原文整体食材是八个鸡蛋，蛋白蛋黄说明不重复相加。"
  },
  {
    "from": "八只只",
    "to": "8只",
    "reason": "原文重复写了只字，保留明确的八只数量。"
  },
  {
    "from": "一小勺（约1.5克）",
    "to": "1.5g",
    "reason": "原文明示本配方小苏打约1.5克，不自行换算小勺。"
  },
  {
    "from": "一勺（喝汤勺）",
    "to": "1汤匙",
    "reason": "原文明示一只喝汤用匙，统一为汤匙，未换算容量。"
  },
  {
    "from": "一勺半（辣味的）",
    "to": "1.5勺",
    "reason": "原文明示一勺半，口味括号不改变数量。"
  },
  {
    "from": "100克左右",
    "to": "100g",
    "reason": "保留原文明示100克参考量，不将水换算为毫升。"
  },
  {
    "from": "1条(约400克)",
    "to": "1条",
    "reason": "保留原文明示的一条鱼，不以估重替换计数。"
  },
  {
    "from": "一小块(约100克)",
    "to": "100g",
    "reason": "原文明示豆腐约100克，使用该配方给出的参考重量。"
  },
  {
    "from": "8粒左右",
    "to": "8粒",
    "reason": "保留原文明示八粒参考量，去除模糊尾词。"
  },
  {
    "from": "一个薄片",
    "to": "1片",
    "reason": "原文是一个薄片，统一为一片而非一个整块。"
  },
  {
    "from": "2LB（908克）",
    "to": "908g",
    "reason": "直接采用原文明示的908克，不另行换算磅。"
  },
  {
    "from": "1个约62克",
    "to": "1个",
    "reason": "原文明示一个鸡蛋，不以约重替换计数。"
  },
  {
    "from": "1/3根约90克",
    "to": "1/3根",
    "reason": "保留原文明示三分之一根，约重保留在原文中。"
  },
  {
    "from": "1根（约200g）",
    "to": "1根",
    "reason": "保留原文明示一根大葱，不假设每根固定重量。"
  },
  {
    "from": "1条约600g",
    "to": "1条",
    "reason": "保留原文明示一条鱼，不以估重替换计数。"
  },
  {
    "from": "10g左右（可用黄豆酱代替）",
    "to": "10g",
    "reason": "原文明示10克参考量，可替代说明保留来源原文。"
  },
  {
    "from": "5g左右",
    "to": "5g",
    "reason": "沿用原文五克参考值，去除描述尾词。"
  },
  {
    "from": "3g左右",
    "to": "3g",
    "reason": "沿用原文三克参考值，去除描述尾词。"
  },
  {
    "from": "2个（去皮）",
    "to": "2个",
    "reason": "数量为两个，去皮要求保留原文和做法。"
  },
  {
    "from": "40克（微甜）",
    "to": "40g",
    "reason": "原文明示40克，微甜描述不是另一用量。"
  },
  {
    "from": "300克（3-4个）",
    "to": "300g",
    "reason": "优先使用原文明示300克总重，不猜测区间内个数。"
  },
  {
    "from": "我用了大概200克",
    "to": "200g",
    "reason": "原文作者明确给出约200克实际参考量。"
  },
  {
    "from": "满杯",
    "to": "1杯",
    "reason": "满杯表示一杯份量，保留杯单位，不臆测容积。"
  },
  {
    "from": "一把ok的量",
    "to": "1把",
    "reason": "原文明示一把，去除无关口语，不换算重量。"
  },
  {
    "from": "一盘（不要怕多，香菜一熟就会缩得很少）",
    "to": "1盘",
    "reason": "原文明示一盘香菜，保留盘作为非定容计数单位。"
  },
  {
    "from": "一把（具体用量看辣椒辣度）",
    "to": "1把",
    "reason": "原文明示一把参考量，辣度条件保留在来源原文。"
  },
  {
    "from": "半勺左右（调颜色用）",
    "to": "半勺",
    "reason": "原文明示半勺参考量，用途说明不改变数值。"
  },
  {
    "from": "有就放，2颗",
    "to": "2颗",
    "reason": "原文明示可选食材两颗，保留原文数量。"
  },
  {
    "from": "2个 55-60克左右的大小",
    "to": "2个",
    "reason": "原文明示两个鸡蛋，重量范围是单个规格，不改变数量。"
  },
  {
    "from": "45克 常温",
    "to": "45g",
    "reason": "原文明示45克牛奶，温度不是用量字段。"
  },
  {
    "from": "1个（约200克）",
    "to": "1个",
    "reason": "原文明示一个洋葱，大小约重保留原文。"
  },
  {
    "from": "1个（可选）",
    "to": "1个",
    "reason": "原文给出可选食材一个的参考量。"
  },
  {
    "from": "10克（颜色红亮的）",
    "to": "10g",
    "reason": "原文明示10克，颜色说明不属于用量。"
  },
  {
    "from": "6克（三四瓣用刀剁碎）",
    "to": "6g",
    "reason": "原文明示6克重量，瓣数范围和处理方法不覆盖克数。"
  },
  {
    "from": "4克（一小块切越细越好）",
    "to": "4g",
    "reason": "原文明示4克重量，切法保留原文。"
  },
  {
    "from": "8克（葱白葱叶一起切）",
    "to": "8g",
    "reason": "原文明示8克重量，处理方法不改变用量。"
  },
  {
    "from": "8克（四个切成圈）",
    "to": "8g",
    "reason": "原文明示8克重量，数量说明保留原文。"
  },
  {
    "from": "3克（生的）",
    "to": "3g",
    "reason": "原文明示3克重量，生熟说明不改变用量。"
  },
  {
    "from": "30克（大约三汤匙）",
    "to": "30g",
    "reason": "原文明示30克重量，不从约三汤匙另行换算。"
  },
  {
    "from": "5瓣（根据自己喜好）",
    "to": "5瓣",
    "reason": "原文明示五瓣参考量，喜好说明保留原文。"
  },
  {
    "from": "8片1cm厚",
    "to": "8片",
    "reason": "原文明示八片，厚度说明不是数量单位。"
  }
];
const reviewedContexts = [
  {
    "name": "五花肉末",
    "amountText": "200颗",
    "reason": "该菜做法第一步及第三步均明确写五花肉200克，原料单位颗是错字，依据步骤改为200克。",
    "ingredients": [
      {
        "name": "五花肉末",
        "quantity": 200,
        "unit": "g"
      }
    ]
  },
  {
    "name": "米饭",
    "amountText": "1杯米（300g熟饭）",
    "reason": "食材名称是熟米饭，原文明示熟饭300克；不把一杯生米当作一杯熟饭。",
    "ingredients": [
      {
        "name": "米饭",
        "quantity": 300,
        "unit": "g"
      }
    ]
  },
  {
    "name": "葱花蒜末",
    "amountText": "各1勺",
    "reason": "原文明示两种食材各一勺，拆为独立行，避免误认为合计一勺。",
    "ingredients": [
      {
        "name": "葱花",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "蒜末",
        "quantity": 1,
        "unit": "勺"
      }
    ]
  },
  {
    "name": "辣椒面，白芝麻，葱末，蒜末",
    "amountText": "各1勺",
    "reason": "原文明示四种食材各一勺，拆为独立行以保留每种用量。",
    "ingredients": [
      {
        "name": "辣椒面",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "白芝麻",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "葱末",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "蒜末",
        "quantity": 1,
        "unit": "勺"
      }
    ]
  },
  {
    "name": "青红辣",
    "amountText": "各2根",
    "reason": "原文明示青红两类辣椒各两根，分开存储，避免合计数歧义。",
    "ingredients": [
      {
        "name": "青辣椒",
        "quantity": 2,
        "unit": "根"
      },
      {
        "name": "红辣椒",
        "quantity": 2,
        "unit": "根"
      }
    ]
  },
  {
    "name": "青红椒",
    "amountText": "各1个",
    "reason": "原文明示青椒红椒各一个，分开存储保留各自数量。",
    "ingredients": [
      {
        "name": "青椒",
        "quantity": 1,
        "unit": "个"
      },
      {
        "name": "红椒",
        "quantity": 1,
        "unit": "个"
      }
    ]
  },
  {
    "name": "青红椒",
    "amountText": "各一个",
    "reason": "原文明示青椒红椒各一个，分开存储保留各自数量。",
    "ingredients": [
      {
        "name": "青椒",
        "quantity": 1,
        "unit": "个"
      },
      {
        "name": "红椒",
        "quantity": 1,
        "unit": "个"
      }
    ]
  },
  {
    "name": "青红辣椒",
    "amountText": "各2个",
    "reason": "原文明示青红辣椒各两个，拆分后数量不会误记为两种合计两个。",
    "ingredients": [
      {
        "name": "青辣椒",
        "quantity": 2,
        "unit": "个"
      },
      {
        "name": "红辣椒",
        "quantity": 2,
        "unit": "个"
      }
    ]
  },
  {
    "name": "黑椒碎黑椒粉",
    "amountText": "各一勺",
    "reason": "原文两种形态的黑椒各一勺，拆分而不合并成一勺。",
    "ingredients": [
      {
        "name": "黑椒碎",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "黑椒粉",
        "quantity": 1,
        "unit": "勺"
      }
    ]
  },
  {
    "name": "生抽，香醋",
    "amountText": "各2勺",
    "reason": "原文明示生抽和香醋分别两勺，独立存储各自用量。",
    "ingredients": [
      {
        "name": "生抽",
        "quantity": 2,
        "unit": "勺"
      },
      {
        "name": "香醋",
        "quantity": 2,
        "unit": "勺"
      }
    ]
  },
  {
    "name": "辣椒",
    "amountText": "绿的两根红的一大根",
    "reason": "原文明示青辣椒两根、红辣椒一根，拆分计数而不推测重量。",
    "ingredients": [
      {
        "name": "青辣椒",
        "quantity": 2,
        "unit": "根"
      },
      {
        "name": "红辣椒",
        "quantity": 1,
        "unit": "根"
      }
    ]
  },
  {
    "name": "糖，醋，盐，酱油，料酒",
    "amountText": "醋一勺，酱油三勺，料酒一勺",
    "reason": "原文明确三种调味料数量，糖盐未提供数值；拆分并仅对未给出用量的项使用适量。",
    "ingredients": [
      {
        "name": "糖",
        "quantity": null,
        "unit": "",
        "amountText": "适量"
      },
      {
        "name": "醋",
        "quantity": 1,
        "unit": "勺"
      },
      {
        "name": "盐",
        "quantity": null,
        "unit": "",
        "amountText": "适量"
      },
      {
        "name": "酱油",
        "quantity": 3,
        "unit": "勺"
      },
      {
        "name": "料酒",
        "quantity": 1,
        "unit": "勺"
      }
    ]
  },
  {
    "name": "小苏打和清水",
    "amountText": "1克和10克",
    "reason": "配料及做法第一步一致，分别为小苏打1克和清水10克，不将两种食材合并相加。",
    "ingredients": [
      {
        "name": "小苏打",
        "quantity": 1,
        "unit": "g"
      },
      {
        "name": "清水",
        "quantity": 10,
        "unit": "g"
      }
    ]
  },
  {
    "name": "黑胡椒粉0.6克，糖4克，生抽10克，玉米淀粉6克，",
    "amountText": "适量",
    "reason": "配料名称及做法第二步明确给出四种用量，拆开恢复明确数字，而不是把这些已知用量保留为适量。",
    "ingredients": [
      {
        "name": "黑胡椒粉",
        "quantity": 0.6,
        "unit": "g"
      },
      {
        "name": "糖",
        "quantity": 4,
        "unit": "g"
      },
      {
        "name": "生抽",
        "quantity": 10,
        "unit": "g"
      },
      {
        "name": "玉米淀粉",
        "quantity": 6,
        "unit": "g"
      }
    ]
  },
  {
    "name": "食用油16克",
    "originalQuantity": 16,
    "reason": "名称与数量字段重复且做法第三步确认16克，清理名称中的数量重复，保留原数值。",
    "ingredients": [
      {
        "name": "食用油",
        "quantity": 16,
        "unit": "g"
      }
    ]
  }
];
