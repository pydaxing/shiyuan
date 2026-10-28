import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectScope, ref, watch } from 'vue';
import postcss from 'postcss';
import { baseParse } from '@vue/compiler-dom';
import { parse } from '@vue/compiler-sfc';
import { useCommunityNavigation } from '../src/composables/useCommunityNavigation.js';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function fixture(context) {
  const scope = effectScope();
  const locked = ref(false);
  const editing = ref(false);
  const controller = scope.run(() => useCommunityNavigation(locked, editing));
  context.after(() => scope.stop());
  return { ...controller, locked, editing, scope, scroll: top => controller.onScroll({ scrollTop: top }) };
}

test('categories collapse while swiping up and reappear after a deliberate reverse scroll', context => {
  const current = fixture(context);
  assert.equal(current.hidden.value, false);
  for (const top of [0, 12, 28, 48, 55]) { current.scroll(top); assert.equal(current.hidden.value, false); }
  current.scroll(60);
  assert.equal(current.hidden.value, true);
  for (const top of [96, 120, 118, 114, 111]) { current.scroll(top); assert.equal(current.hidden.value, true); }
  current.scroll(110);
  assert.equal(current.hidden.value, false);
  for (const top of [111, 118, 125]) { current.scroll(top); assert.equal(current.hidden.value, false); }
  current.scroll(126);
  assert.equal(current.hidden.value, true);
});

test('small jitters, duplicate positions and horizontal gestures do not flicker navigation', context => {
  const current = fixture(context);
  current.scroll(100);
  const changes = [];
  current.scope.run(() => watch(current.hidden, value => changes.push(value), { flush: 'sync' }));
  for (const top of [100, 99, 100, 99, 98, 99, 100, 97, 100]) current.scroll(top);
  current.onScroll({ detail: { scrollLeft: 140 } });
  assert.deepEqual(changes, []);
  current.scroll(89);
  assert.deepEqual(changes, [false]);
});

test('returning to the page top and pulling past its boundary always shows the categories', context => {
  const current = fixture(context);
  for (const top of [8, 0, -20]) {
    current.scroll(200);
    assert.equal(current.hidden.value, true);
    current.scroll(top);
    assert.equal(current.hidden.value, false);
  }
  for (const top of [0, -5, 0, 5, 12, 4, 0]) current.scroll(top);
  assert.equal(current.hidden.value, false);
});

test('typing reveals navigation and ignores keyboard-induced page movement', context => {
  const current = fixture(context);
  current.scroll(400);
  current.editing.value = true;
  assert.equal(current.hidden.value, false);
  for (const top of [0, 300, 350, 500]) { current.scroll(top); assert.equal(current.hidden.value, false); }
  current.editing.value = false;
  current.scroll(508);
  assert.equal(current.hidden.value, false);
  current.scroll(516);
  assert.equal(current.hidden.value, true);
});

test('detail and share sheets preserve both collapsed and expanded navigation on scroll restore', context => {
  for (const expanded of [false, true]) {
    const current = fixture(context);
    current.scroll(500);
    if (expanded) current.scroll(480);
    const before = current.hidden.value;
    current.locked.value = true;
    current.scroll(0);
    current.scroll(600);
    current.locked.value = false;
    current.scroll(0);
    current.scroll(expanded ? 480 : 500);
    assert.equal(current.hidden.value, before);
    current.scroll(expanded ? 510 : 480);
    assert.equal(current.hidden.value, !before);
  }
});

test('filter reset starts at the first results with navigation visible and a fresh direction', context => {
  const current = fixture(context);
  current.scroll(1000);
  current.reset();
  assert.equal(current.hidden.value, false);
  current.scroll(0);
  current.scroll(40);
  assert.equal(current.hidden.value, false);
  current.scroll(60);
  assert.equal(current.hidden.value, true);
});

test('invalid scroll events and callbacks after unmount do not mutate the header', context => {
  const current = fixture(context);
  for (const event of [null, {}, { scrollTop: NaN }, { scrollTop: Infinity }, { scrollTop: '80' }]) current.onScroll(event);
  assert.equal(current.hidden.value, false);
  current.scope.stop();
  current.scroll(1000);
  assert.equal(current.hidden.value, false);
});

test('ordinary scrolling updates Vue only when navigation visibility changes', context => {
  const current = fixture(context);
  let updates = 0;
  current.scope.run(() => watch(current.hidden, () => { updates += 1; }, { flush: 'sync' }));
  for (let top = 0; top <= 500; top += 1) current.scroll(top);
  assert.equal(updates, 1);
  for (let top = 500; top >= 0; top -= 1) current.scroll(top);
  assert.equal(updates, 2);
});

function descendants(node, predicate) {
  return [node, ...(node.children || []).flatMap(child => descendants(child, predicate))].filter(predicate);
}

test('one fixed header owns the single toolbar without duplicating inputs or remounting controls', () => {
  const component = source('src/components/CommunityView.vue');
  const template = baseParse(parse(component).descriptor.template.content);
  const header = descendants(template, node => node.type === 1 && node.tag === 'PageHeader');
  assert.equal(header.length, 1);
  const extension = header[0].children.find(node => node.type === 1 && node.tag === 'template' && node.props.some(prop => prop.name === 'slot' && prop.arg?.content === 'extension'));
  assert.ok(extension);
  assert.equal(descendants(extension, node => node.type === 1 && node.tag === 'FormField').length, 1);
  const strips = descendants(extension, node => node.type === 1 && node.tag === 'scroll-view');
  assert.equal(strips.length, 0);
  const dropdown = descendants(extension, node => node.type === 1 && node.tag === 'SelectField');
  assert.equal(dropdown.length, 1);
  assert.ok(dropdown[0].props.some(prop => prop.name === 'variant' && prop.value.content === 'feed'));
  const toolbar = descendants(extension, node => node.type === 1 && node.props.some(prop => prop.name === 'class' && prop.value?.content.includes('community-single-toolbar')))[0];
  assert.ok(toolbar);
  assert.equal(descendants(toolbar, node => node.type === 1 && node.tag === 'FormField').length, 1);
  assert.ok(!toolbar.props.some(prop => prop.name === 'if' || prop.name === 'show'));
  assert.match(component, /:aria-hidden="navigationHidden"/);
  assert.match(component, /:tabindex="navigationHidden \? -1 : 0"/);
  assert.match(component, /@focus="searchFocused = true"/);
  assert.match(component, /@blur="searchFocused = false; searchFocus = false"/);
  assert.match(component, /searchFocused\.value \|\| categoryOpen\.value/);
  assert.doesNotMatch(extension.loc.source, /community-share|share-feed|\$emit\('share'\)/);
  assert.match(component, /<FoodDetailSheet[^>]*:share-card="friendCard"/);
  assert.doesNotMatch(component.slice(component.indexOf('<template>'), component.indexOf('</PageHeader>')), /name="plus"/);
  assert.match(source('src/components/PageHeader.vue'), /<slot name="extension"\s*\/>/);
  assert.match(source('src/pages/index/index.vue'), /if \(tab\.value === 'community'\) communityView\.value\?\.onScroll\(event\)/);
  assert.match(component, /defineExpose\(\{ onScroll: navigation\.onScroll, loadMore \}\)/);
});

test('the entire toolbar animates beneath the title without leaving a fixed blank strip', () => {
  const css = postcss.parse(source('src/styles.css'));
  const rules = [];
  css.walkRules(rule => rules.push(rule));
  const declarations = selector => {
    const result = new Map();
    for (const rule of rules) if (rule.selectors.includes(selector)) rule.walkDecls(value => result.set(value.prop, value.value));
    return result;
  };
  const surface = rules.find(rule => rule.selectors.includes('.community-navigation-surface'));
  const transition = surface.nodes.find(node => node.prop === 'transition').value;
  assert.match(transition, /transform 220ms cubic-bezier/);
  assert.doesNotMatch(transition, /\ball\b|opacity|height|margin|padding|top/);
  assert.equal(declarations('.community-navigation-surface').get('will-change'), 'transform');
  assert.equal(declarations('.community-navigation-surface.is-hidden').get('transform'), 'translate3d(0, -100%, 0)');
  assert.equal(declarations('.community-navigation-surface.is-hidden').get('opacity'), undefined);
  assert.equal(declarations('.community-navigation-surface.is-hidden').get('transition-duration'), '260ms');
  assert.equal(declarations('.community-navigation-surface.is-hidden').get('transition-timing-function'), 'cubic-bezier(.4, 0, .2, 1)');
  assert.equal(declarations('.community-navigation-surface.is-hidden').get('pointer-events'), 'none');
  assert.equal(declarations('.community-navigation-clip').get('position'), 'absolute');
  assert.equal(declarations('.community-navigation-clip').get('overflow'), 'hidden');
  assert.equal(declarations('.community-navigation-clip').get('pointer-events'), 'none');
  assert.equal(declarations('.community-sticky-controls').get('height'), '0');
  assert.equal(declarations('.community-navigation-clip').get('top'), 'calc(0px - var(--community-navigation-overlap))');
  assert.equal(declarations('.community-view').get('--community-navigation-overlap'), '1px');
  assert.equal(declarations('.community-navigation-surface').get('padding-top'), 'var(--community-navigation-overlap)');
  for (const selector of ['.community-navigation-clip', '.community-navigation-surface']) {
    assert.equal(declarations(selector).get('height'), 'calc(var(--community-toolbar-height) + var(--community-navigation-overlap))');
    assert.equal(declarations(selector).get('border'), '0');
    assert.equal(declarations(selector).get('box-shadow'), 'none');
  }
  assert.equal(declarations('.community-view').get('--page-header-extension-height'), '0px');
  assert.equal(declarations('.community-feed-content').get('padding-top'), 'var(--community-toolbar-height)');
  assert.equal(declarations('.page-header-space').get('height'), 'calc(var(--page-header-height) + var(--page-header-extension-height, 0px))');
  assert.ok(rules.some(rule => rule.selectors.includes('.community-navigation-surface') && rule.parent.params === '(prefers-reduced-motion: reduce)' && rule.nodes.some(node => node.prop === 'transition' && node.value === 'none')));
  assert.ok(rules.some(rule => rule.selectors.includes('.community-navigation-surface.is-hidden') && rule.parent.params === '(prefers-reduced-motion: reduce)' && rule.nodes.some(node => node.prop === 'transition' && node.value === 'none')));
  assert.equal(declarations('.community-sticky-frame').get('padding-left'), 'var(--page-gutter)');
  assert.equal(declarations('.community-sticky-frame').get('padding-right'), 'var(--page-gutter)');
  assert.equal(declarations('.community-sticky-frame').get('max-width'), 'var(--content-width)');
});

test('single toolbar starts at the shared header boundary without shrinking inputs or leaving stale space', () => {
  const css = postcss.parse(source('src/styles.css'));
  for (const mobile of [false, true]) {
    const declarations = selector => {
      const result = new Map();
      css.walkRules(rule => {
        if (rule.parent.type === 'atrule') {
          if (rule.parent.name !== 'media') return;
          if (rule.parent.params === '(max-width: 760px)' && !mobile) return;
          if (rule.parent.params === '(min-width: 761px)' && mobile) return;
          if (!['(max-width: 760px)', '(min-width: 761px)'].includes(rule.parent.params)) return;
        }
        if (rule.selectors.includes(selector)) rule.walkDecls(value => result.set(value.prop, value.value));
      });
      return result;
    };
    const toolbar = declarations('.community-sticky-controls .community-toolbar');
    assert.equal(declarations('.community-view').get('--community-toolbar-height'), '50px');
    assert.equal(toolbar.get('min-height'), 'var(--community-toolbar-height)');
    assert.equal(toolbar.get('padding-top'), '0');
    assert.equal(declarations('.community-toolbar .community-search').get('height'), '44px');
    assert.equal(declarations('.community-share').size, 0);
    assert.equal(toolbar.get('padding-bottom'), '6px');
    assert.equal(declarations('.community-toolbar').get('padding'), mobile ? '4px 0 6px' : '6px 0 10px');
    assert.equal(44 + 6, Number.parseFloat(declarations('.community-view').get('--community-toolbar-height')));
  }
});
