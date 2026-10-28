import test from 'node:test';
import assert from 'node:assert/strict';
import { SELECTABLE_UNITS, UNITS } from '../src/domain/kitchen.js';
import { strictIngredient, assertStrictIngredient } from '../scripts/strict-ingredient-amounts.mjs';

const text = (amountText, name = '盐') => ({ name, quantity: null, unit: '', amountText });
const measure = (quantity, unit = '勺', name = '盐') => ({ name, quantity, unit });
const converted = (amountText, name = '盐', context = {}) => strictIngredient(text(amountText, name), context).ingredients;

test('strict contract accepts exactly two text presets and the 38 selectable units', () => {
  assert.equal(SELECTABLE_UNITS.length, 38);
  for (const unit of SELECTABLE_UNITS) assertStrictIngredient(measure(1, unit));
  for (const unit of UNITS.filter(unit => !SELECTABLE_UNITS.includes(unit))) assert.throws(() => assertStrictIngredient(measure(1, unit)), /38项/);
  for (const value of ['适量', '少许']) assertStrictIngredient(text(value));
  for (const value of ['原文未注明', '1勺', ' 适量', '少许 ', undefined, null]) assert.throws(() => assertStrictIngredient(text(value)), /适量或少许/);
  assert.throws(() => assertStrictIngredient({ ...text('适量'), quantity: 1 }), /null/);
  assert.throws(() => assertStrictIngredient({ ...text('适量'), unit: 'g' }), /为空/);
  for (const value of [0, -1, NaN, Infinity, '1', 0.0001, 100001]) assert.throws(() => assertStrictIngredient(measure(value)), /有限数字/);
});

test('explicit measures keep counts, fractions and units without assuming utensil volumes', () => {
  for (const [raw, quantity, unit] of [['半勺', 0.5, '勺'], ['一勺半', 1.5, '勺'], ['１／２ 茶匙', 0.5, '茶匙'], ['十二克', 12, 'g'], ['1KG', 1, 'kg'], ['0.5升', 0.5, 'L'], ['一小勺', 1, '勺'], ['两大勺', 2, '勺'], ['1铲勺', 1, '勺'], ['3小勺', 3, '勺'], ['1小勺TSP', 1, '茶匙'], ['半小勺TSP', 0.5, '茶匙'], ['1大勺TBSP', 1, '汤匙']]) {
    assert.deepEqual(converted(raw), [measure(quantity, unit)], raw);
  }
  for (const unit of ['小勺', '大勺', '铲勺']) assert.deepEqual(strictIngredient(measure(3, unit)).ingredients, [measure(3)]);
});

test('range defaults use the original lower endpoint and remain explicitly labeled as defaults', () => {
  for (const [raw, quantity, unit] of [['2-3个', 2, '个'], ['3～4勺', 3, '勺'], ['220～230克', 220, 'g'], ['1.5或2个', 1.5, '个'], ['3~5克', 3, 'g'], ['3-5片切丝', 3, '片'], ['半个或者一个看个头大小', 0.5, '个'], ['30g～40g', 30, 'g'], ['6–8根', 6, '根'], ['半条/1条', 0.5, '条'], ['1、2根', 1, '根'], ['两三瓣', 2, '瓣'], ['五六颗', 5, '颗'], ['25一30克', 25, 'g'], ['一到两勺', 1, '勺'], ['1个/2个', 1, '个'], ['无或三四根', 3, '根'], ['335～340克（夏天335克冬天340克）', 335, 'g'], ['2斤以上', 2, '斤'], ['20余粒', 20, '粒']]) {
    const result = strictIngredient(text(raw));
    assert.deepEqual(result.ingredients, [measure(quantity, unit)], raw);
    assert.equal(result.kind, 'range_lower_bound');
    assert.match(result.reason, /默认量/);
  }
  assert.deepEqual(converted('各1、2个', '八角 山奈'), [measure(1, '个', '八角'), measure(1, '个', '山奈')]);
  assert.deepEqual(converted('3-4', '番茄'), [text('适量', '番茄')]);
});

test('additional small amounts stay separate and same-unit sums preserve all numeric portions', () => {
  assert.deepEqual(converted('1.5勺➕少许'), [measure(1.5), text('少许')]);
  assert.deepEqual(converted('1.5小勺 + 少许'), [measure(1.5), text('少许')]);
  assert.deepEqual(converted('500+500毫升', '水'), [measure(1000, 'ml', '水')]);
  assert.deepEqual(converted('1勺+2勺'), [measure(3)]);
  assert.deepEqual(strictIngredient({ name: '温水2份各', quantity: 50, unit: 'g' }).ingredients, [measure(100, 'g', '温水')]);
  assert.deepEqual(converted('1勺', '猪油2份各'), [measure(2, '勺', '猪油')]);
  assert.deepEqual(strictIngredient({ name: '鸡蛋2份各', quantity: 1, unit: '个' }).ingredients, [measure(2, '个', '鸡蛋')]);
  assert.deepEqual(strictIngredient({ name: '面粉2份各', quantity: 250, unit: 'g' }).ingredients, [measure(500, 'g', '面粉')]);
});

test('numbers in names are recovered before unknown amounts become presets', () => {
  assert.deepEqual(converted('原文未注明', '带皮五花肉1.5斤'), [measure(1.5, '斤', '带皮五花肉')]);
  assert.deepEqual(converted('原文未注明', '土豆一个切块'), [measure(1, '个', '土豆')]);
  assert.deepEqual(converted('原文未注明', '线椒4个，小米辣3个，蒜5瓣，姜适量'), [measure(4, '个', '线椒'), measure(3, '个', '小米辣'), measure(5, '瓣', '蒜'), text('适量', '姜')]);
  assert.deepEqual(converted('适量', '生姜5片、小葱5根切末'), [measure(5, '片', '生姜'), measure(5, '根', '小葱')]);
  assert.deepEqual(converted('原文未注明', '生姜：20克(分两次用)'), [measure(20, 'g', '生姜')]);
  assert.deepEqual(converted('原文未注明', '盐：13克左右'), [measure(13, 'g', '盐')]);
  assert.deepEqual(converted('原文未注明', '（孩子吃饭用的小勺）老抽一勺、生抽两勺'), [measure(1, '勺', '老抽'), measure(2, '勺', '生抽')]);
  assert.deepEqual(converted('适量', '黑胡椒粉0.6克，糖4克，生抽10克，玉米淀粉6克，'), [measure(0.6, 'g', '黑胡椒粉'), measure(4, 'g', '糖'), measure(10, 'g', '生抽'), measure(6, 'g', '玉米淀粉')]);
});

test('multiple ingredients and each-amount clauses retain separate amounts', () => {
  assert.deepEqual(converted('各1勺', '葱花蒜末'), [measure(1, '勺', '葱花'), measure(1, '勺', '蒜末')]);
  assert.deepEqual(converted('各2勺', '生抽，香醋'), [measure(2, '勺', '生抽'), measure(2, '勺', '香醋')]);
  assert.deepEqual(converted('1克和10克', '小苏打和清水'), [measure(1, 'g', '小苏打'), measure(10, 'g', '清水')]);
  assert.deepEqual(converted('1小勺', '食盐，白糖'), [text('少许', '食盐'), text('少许', '白糖')]);
  assert.deepEqual(converted('各一勺', '黑椒碎黑椒粉'), [measure(1, '勺', '黑椒碎'), measure(1, '勺', '黑椒粉')]);
});

test('conditions distinguish source-specific reference amounts from unresolved alternatives', () => {
  assert.deepEqual(converted('两条三花趾（五花趾）', '牛腱'), [measure(2, '条', '牛腱')]);
  const conditional = strictIngredient(text('一条三花趾两勺，一条五花趾三勺，以此类推'), { ingredients: [measure(2, '条', '牛腱')] });
  assert.deepEqual(conditional.ingredients, [text('适量')]);
  assert.equal(conditional.kind, 'conditional_unknown');
  assert.deepEqual(converted('1只鸡至多50g冰糖', '冰糖'), [text('适量', '冰糖')]);
  assert.deepEqual(converted('1只鸡至多50g冰糖', '冰糖', { recipe: { ingredients: [measure(1, '只', '鸡')], steps: [{ text: '一只的糖大概是50克左右' }] } }), [measure(50, 'g', '冰糖')]);
  assert.deepEqual(converted('两个半只（想要两种颜色', '彩椒'), [measure(1, '个', '彩椒')]);
});

test('specifications do not multiply totals and missing units are never invented', () => {
  assert.deepEqual(converted('1杯（100克）', '面粉'), [measure(100, 'g', '面粉')]);
  assert.deepEqual(converted('8个（每个约55克）蛋白270克，蛋黄136克', '鸡蛋'), [measure(8, '个', '鸡蛋')]);
  assert.deepEqual(converted('2个 55-60克左右的大小', '鸡蛋'), [measure(2, '个', '鸡蛋')]);
  assert.deepEqual(converted('一小勺（约1.5克）', '小苏打'), [measure(1.5, 'g', '小苏打')]);
  for (const raw of ['原文未注明', '未知', '1（原文未注明单位）', '350（原文未注明单位）', '四分之一', '10元', '大半勺', '1e3g', '-1g', '1/0g', '0g', '100001g']) assert.deepEqual(converted(raw), [text('适量')], raw);
  for (const raw of ['少量', '几滴', '小半勺', '少许（可忽略）']) assert.deepEqual(converted(raw), [text('少许')], raw);
});

test('conversion is pure and its outputs are idempotent', () => {
  const samples = [text('1.5勺➕少许'), text('1小勺'), text('2-3个'), text('原文未注明', '带皮五花肉1.5斤'), text('各1勺', '葱花蒜末'), text('未知'), measure(3, '铲勺')];
  const before = structuredClone(samples);
  for (const source of samples) {
    for (const ingredient of strictIngredient(source).ingredients) {
      assertStrictIngredient(ingredient);
      assert.deepEqual(strictIngredient(ingredient).ingredients, [ingredient]);
    }
  }
  assert.deepEqual(samples, before);
});
