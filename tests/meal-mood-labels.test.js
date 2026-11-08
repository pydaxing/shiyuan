import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import postcss from 'postcss';
import { MEAL_MOODS, mealMoodDisplayLabel } from '../src/domain/meal-social.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const styles = component => postcss.parse(parse(read(`../src/components/${component}.vue`)).descriptor.styles.map(style => style.content).join('\n'));
const globalStyles = postcss.parse(read('../src/styles.css'));
function ruleValues(sheet, selector) {
  const result = {};
  sheet.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(declaration => { result[declaration.prop] = declaration.value; });
  });
  return result;
}
function horizontalPadding(value) {
  const parts = value.split(/\s+/).map(Number.parseFloat);
  return parts.length < 4 ? 2 * (parts[1] ?? parts[0]) : parts[1] + parts[3];
}

test('all picker moods have concise display names without rewriting their full labels or historical records', () => {
  const snapshot = structuredClone(MEAL_MOODS);
  const examples = { healed: '美食治愈', 'after-work': '下班快乐', easy: '偶尔偷懒', energy: '元气满满' };
  for (const tag of MEAL_MOODS) {
    assert.match(mealMoodDisplayLabel(tag), /^\p{Script=Han}{4}$/u, tag.id);
    if (examples[tag.id]) assert.equal(mealMoodDisplayLabel(tag), examples[tag.id]);
    assert.ok(tag.emoji);
    // Data loaded from an older API has no client-side alias field.
    assert.equal(mealMoodDisplayLabel(JSON.parse(JSON.stringify(tag))), mealMoodDisplayLabel(tag));
    assert.equal(mealMoodDisplayLabel({ ...tag, label: '云端旧版较长标签文案' }), mealMoodDisplayLabel(tag), 'known IDs always use the canonical four-character display name');
  }
  assert.deepEqual(MEAL_MOODS, snapshot);
  assert.equal(MEAL_MOODS.find(tag => tag.id === 'healed').label, '被这口饭治愈了');
  assert.equal(mealMoodDisplayLabel({ id: 'future-mood', label: '未收录的新标签' }), '未收录的新标签', 'unknown data is preserved rather than silently truncated');
});

test('all 2024 three-mood combinations fit the 320px feed and diary width budget at the standard font size', () => {
  const moodStyles = styles('MealMoodTags');
  const pill = ruleValues(moodStyles, '.meal-mood-pill');
  const emoji = ruleValues(moodStyles, '.meal-mood-emoji');
  const tags = ruleValues(moodStyles, '.meal-mood-tags');
  const tokens = ruleValues(globalStyles, '.app-shell');
  const fontSize = value => Number.parseFloat(tokens[value.match(/var\(([^)]+)\)/)[1]]);
  const textSize = fontSize(pill['font-size']);
  const emojiSize = fontSize(emoji['font-size']);
  const gap = Number.parseFloat(tags.gap.split(/\s+/).at(-1));
  const pillWidth = (tag, pill) => Array.from(mealMoodDisplayLabel(tag)).length * textSize + emojiSize + Number.parseFloat(pill.gap) + horizontalPadding(pill.padding) + 2 * Number.parseFloat(pill.border);
  const feed = ruleValues(styles('MealPostCard'), '.meal-post-card.in-feed');
  const diaryPage = ruleValues(globalStyles, '.sheet.is-meal-diary .sheet-content');
  const diary = styles('MealTimeline');
  const dateColumn = Number.parseFloat(ruleValues(diary, '.meal-history-date').flex.split(/\s+/).at(-1));
  const dateGap = Number.parseFloat(ruleValues(diary, '.meal-history-day').gap);
  const layouts = [
    { pill: { ...pill, ...ruleValues(moodStyles, ".in-feed .meal-mood-pill") }, available: 320 - horizontalPadding(feed.padding) },
    { pill, available: 320 - horizontalPadding(diaryPage.padding) - dateColumn - dateGap },
  ];
  let combinations = 0;
  for (let a = 0; a < MEAL_MOODS.length; a += 1) {
    for (let b = a + 1; b < MEAL_MOODS.length; b += 1) {
      for (let c = b + 1; c < MEAL_MOODS.length; c += 1) {
        const chosen = [MEAL_MOODS[a], MEAL_MOODS[b], MEAL_MOODS[c]];
        for (const { pill: layoutPill, available } of layouts) {
        const width = chosen.reduce((total, tag) => total + pillWidth(tag, layoutPill), 2 * gap);
        assert.ok(width <= available, `${chosen.map(mealMoodDisplayLabel).join(' / ')} needs ${width}px, has ${available}px`);
        }
        combinations += 1;
      }
    }
  }
  assert.equal(combinations, 2024);
  assert.equal(textSize, 12, 'compact labels retain the shared readable caption size');
  assert.equal(tags['flex-wrap'], 'wrap', 'larger user text sizes may wrap whole pills');
  assert.equal(pill.flex, '0 0 auto', 'labels must not squeeze their font or content to force one row');
});
