import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import sharp from 'sharp';

const styles = postcss.parse(readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));
function declarationsFor(selector, source = styles) {
  const declarations = new Map();
  source.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    rule.walkDecls((declaration) => declarations.set(declaration.prop, declaration.value));
  });
  return declarations;
}

test('home categories use a white rail with one softly highlighted row and separated group headings', () => {
  const component = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
  const menuStyles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.equal(declarationsFor('.home-menu-layout::before', menuStyles).size, 0);
  assert.equal(declarationsFor('.home-menu-rail', menuStyles).get('background'), 'var(--white)');
  assert.equal(declarationsFor('.home-menu-rail', menuStyles).get('position'), undefined);
  assert.equal(declarationsFor('.home-menu-rail', menuStyles).get('top'), undefined);
  assert.equal(declarationsFor('.home-menu-rail', menuStyles).get('height'), 'var(--home-menu-rail-height)');
  assert.equal(declarationsFor('.home-menu-category', menuStyles).get('min-height'), '48px');
  assert.equal(declarationsFor('.home-menu-category', menuStyles).get('border-radius'), 'var(--radius-control)');
  const active = declarationsFor('.home-menu-category.active', menuStyles);
  assert.equal(active.get('color'), 'var(--green)');
  assert.equal(active.get('background'), 'var(--green-light)');
  assert.equal(active.get('font-weight'), '600');
  assert.equal(active.get('box-shadow'), undefined);
  assert.equal(active.get('border'), undefined);
  assert.equal(declarationsFor('.home-menu-group-heading', menuStyles).get('font-size'), 'var(--type-control)');
  assert.equal(declarationsFor('.home-menu-group + .home-menu-group', menuStyles).get('margin-top'), '4px');
  assert.equal(declarationsFor('.home-menu-group-heading', menuStyles).get('padding'), '2px 0 8px');
  assert.equal(declarationsFor('.home-menu-group-heading', menuStyles).get('line-height'), '20px');
  const row = readFileSync(new URL('../src/components/MenuSwipeRow.vue', import.meta.url), 'utf8');
  const rowStyles = postcss.parse(row.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.equal(declarationsFor('.menu-swipe', rowStyles).get('border-bottom'), undefined);
  assert.equal(declarationsFor('.menu-swipe', rowStyles).get('overflow'), 'hidden');
  assert.equal(declarationsFor('.home-menu-photo', rowStyles).get('border-radius'), 'var(--food-photo-radius)');
});

test('last-category whitespace stays inside the bounded right scroller', () => {
  const component = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
  const menuStyles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  const lastGroup = declarationsFor('.home-menu:not(.is-searching) .home-menu-group:last-child', menuStyles);
  assert.equal(lastGroup.get('min-height'), 'var(--home-menu-viewport-height)');
  assert.equal(lastGroup.get('height'), undefined);
  assert.equal(declarationsFor('.home-menu-sections', menuStyles).get('overflow'), undefined);
  assert.equal(declarationsFor('.home-menu-sections', menuStyles).get('height'), '100%');
  assert.equal(declarationsFor('.home-menu-list', menuStyles).get('height'), '100%');
  assert.match(component, /'is-searching': Boolean\(query\)/);
  assert.match(component, /if \(scrollTop === undefined && !position\)/);
});

test('independent pages remove old sticky tabs while the menu keeps two bounded native scrollers', () => {
  const component = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
  const menuStyles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  const toolbar = declarationsFor('.menu-toolbar');
  assert.equal(toolbar.size, 0);
  assert.equal(declarationsFor('.home-menu-panel.is-orders .menu-toolbar').size, 0);
  assert.equal(declarationsFor('.menu-toolbar.is-pinned::before').size, 0);
  assert.equal(declarationsFor('.home-menu-panel').get('min-height'), undefined);
  assert.equal(declarationsFor('.home-menu-panel.is-orders').size, 0);
  assert.equal(declarationsFor('.home-menu-layout', menuStyles).get('height'), 'var(--home-menu-viewport-height)');
  assert.equal(declarationsFor('.home-menu-layout', menuStyles).get('min-height'), undefined);
  assert.equal(declarationsFor('.home-menu.is-empty .home-menu-layout', menuStyles).size, 0);
  const search = declarationsFor('.home-menu-tools', menuStyles);
  assert.equal(search.get('position'), 'relative');
  assert.equal(search.get('top'), undefined);
  assert.equal(search.get('z-index'), '11');
  assert.equal(declarationsFor('.home-menu-rail-scroll', menuStyles).get('height'), '100%');
  assert.equal(declarationsFor('.home-menu-rail-scroll :deep(.uni-scroll-view)', menuStyles).get('overscroll-behavior-y'), 'contain');
  assert.match(declarationsFor('.app-shell.menu-page.has-selection').get('--home-menu-bottom-inset'), /var\(--selection-height\)/);
  assert.equal((component.match(/<scroll-view[^>]+:scroll-y="scrollEnabled"[^>]+enhanced[^>]+:bounces="false"/g) || []).length, 2);
  assert.equal((component.match(/<scroll-view\b/g) || []).length, 2);
});

test('menu categories fill their bounded viewport and stop native touch scrolling at both ends', () => {
  const component = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
  const menuStyles = postcss.parse(component.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  const rail = declarationsFor('.home-menu-rail-scroll', menuStyles);
  assert.equal(rail.get('height'), '100%');
  assert.equal(rail.get('max-height'), undefined);
  assert.equal(declarationsFor('.home-menu', menuStyles).get('--home-menu-rail-height'), 'max(48px, min(var(--home-menu-rail-content-height), calc(100vh - var(--home-menu-list-top) - var(--home-menu-bottom-inset))))');
  assert.equal(declarationsFor('.home-menu', menuStyles).get('--home-menu-viewport-height'), 'max(var(--home-menu-rail-height), calc(100vh - var(--home-menu-origin-top, 100vh) - var(--home-menu-bottom-inset)))');
  assert.equal(rail.get('overscroll-behavior-y'), 'contain');
  assert.match(component, /<view class="home-menu-rail"[^>]* @touchstart="railGesture\.start" @touchmove="railGesture\.contain">/);
  assert.match(component, /@scroll="railGesture\.scroll"/);
  assert.match(component, /:scroll-into-view="railTarget"/);
  assert.equal(declarationsFor('.home-menu.is-empty .home-menu-rail-scroll', menuStyles).size, 0);
  assert.equal(declarationsFor('.app-shell.menu-page').get('--home-menu-bottom-inset'), 'calc(var(--nav-height) + env(safe-area-inset-bottom) + 26px)');
  assert.equal(declarationsFor('.app-shell.menu-page.has-selection').get('--home-menu-bottom-inset'), declarationsFor('.app-shell.has-selection .content').get('padding-bottom'));
});

test('food navigation has three compact modes and preserves full touch heights', () => {
  const source = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /class="content-types"/);
  assert.equal((source.match(/class="community-order-button"/g) || []).length, 2);
  assert.match(source, /variant="feed"/);
  assert.equal(declarationsFor('.community-single-toolbar').get('gap'), '4px');
  assert.equal(declarationsFor('.community-single-toolbar').get('flex-wrap'), 'nowrap');
  assert.equal(declarationsFor('.community-order-button').get('height'), '44px');
  assert.equal(declarationsFor('.community-order-button').get('min-width'), '44px');
  assert.equal(declarationsFor('.community-share').size, 0);
  assert.equal(declarationsFor('.community-toolbar .community-search').get('flex'), '1');
});

test('food keeps shared search dimensions with a compact variant and no publishing shortcut', () => {
  for (const [home, food] of [['.home-menu-tools', '.community-toolbar'], ['.home-menu .home-menu-search', '.community-toolbar .community-search']]) assert.deepEqual(declarationsFor(home), declarationsFor(food));
  const add = declarationsFor('.home-menu-add');
  assert.equal(add.get('background'), 'none');
  assert.equal(add.get('border-radius'), '50%');
  assert.equal(add.get('justify-content'), 'center');
  assert.equal(add.get('width'), '44px');
  assert.equal(add.get('height'), '44px');
  assert.equal(add.get('border'), '0');
  const search = declarationsFor('.community-toolbar .community-search');
  assert.equal(search.get('background'), 'none');
  assert.equal(search.get('border'), '0');
  assert.equal(search.get('border-radius'), 'var(--search-radius)');
  assert.equal(search.get('height'), '44px');
  assert.equal(declarationsFor('page').get('--search-radius'), '999px');
  assert.equal(declarationsFor('page').get('--search-surface-inset'), '4px');
  assert.deepEqual(declarationsFor('.home-menu .home-menu-search::before'), declarationsFor('.community-toolbar .community-search::before'));
  const searchSurface = declarationsFor('.home-menu .home-menu-search::before');
  assert.equal(searchSurface.get('background'), 'var(--paper)');
  assert.equal(searchSurface.get('border'), '1px solid var(--line)');
  assert.equal(searchSurface.get('top'), 'var(--search-surface-inset)');
  assert.equal(searchSurface.get('bottom'), 'var(--search-surface-inset)');
  assert.equal(searchSurface.get('pointer-events'), 'none');
  assert.equal(declarationsFor('.home-menu-add::before').get('background'), searchSurface.get('background'));
  assert.equal(declarationsFor('.home-menu-add::before').get('inset'), 'var(--search-surface-inset)');
  assert.equal(declarationsFor('.home-menu-add::before').get('pointer-events'), 'none');
  assert.equal(declarationsFor('.home-menu .home-menu-search:focus-within::before').get('border-color'), 'var(--border-strong)');
  assert.deepEqual(declarationsFor('.home-menu .home-menu-search:focus-within'), declarationsFor('.community-toolbar .community-search:focus-within'));
  const home = readFileSync(new URL('../src/components/HomeMenu.vue', import.meta.url), 'utf8');
  assert.match(home, /<AppIcon name="plus" :size="22" active/);
  assert.match(home, /<AppIcon name="search" :size="16"/);
  assert.match(home, /<AppIcon name="close" :size="16"/);
  const community = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');
  assert.doesNotMatch(community, /community-share|name="share-feed"/);
  assert.match(community, /name="search" :size="16"/);
  assert.match(community, /<AppIcon name="close" :size="16"/);
  assert.match(community, /<FoodDetailSheet[^>]*:share-card="friendCard"/);
  assert.equal(declarationsFor('.community-share').size, 0);
});

test('sharing is a floating detail control, not a feed toolbar button or its leftover hover surface', () => {
  const button = declarationsFor('.detail-toolbar-button');
  assert.equal(button.get('width'), '44px');
  assert.equal(button.get('height'), '44px');
  assert.equal(button.get('border-radius'), '50%');
  assert.equal(declarationsFor('.detail-tool-surface').get('background'), 'rgba(255, 255, 255, .9)');
  assert.equal(declarationsFor('.detail-tool-surface').get('width'), 'var(--detail-tool-size)');
  assert.equal(declarationsFor('page').get('--detail-tool-size'), '34px');
  const stylesheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(stylesheet, /community-share/);
});

test('shared form controls use the step-card outline with a pale surface and preserve semantic states', () => {
  assert.equal(declarationsFor('page').get('--control-surface'), '#f8fafb');
  for (const selector of ['.input', '.textarea', '.input.choice-trigger', '.step-photo-add', '.step-add-button', '.image-upload', '.checkout-note .textarea', '.choice-options button']) {
    assert.equal(declarationsFor(selector).get('background'), 'var(--control-surface)', selector);
  }
  for (const selector of ['.input', '.textarea', '.input.choice-trigger', '.step-add-button', '.choice-options button']) assert.equal(declarationsFor(selector).get('border-color'), 'var(--line)');
  const stepBorder = declarationsFor('.step-editor').get('border');
  for (const selector of ['.input', '.textarea', '.search-wrap', '.step-photo-add', '.secondary-button']) assert.equal(declarationsFor(selector).get('border'), stepBorder, selector);
  assert.equal(declarationsFor('.choice-options button.selected').get('background'), 'var(--control-accent)');
  assert.equal(declarationsFor('.choice-options button.selected').get('border-color'), 'var(--border-strong)');
  assert.equal(declarationsFor('.choice-options button.selected').get('font-weight'), '600');
  assert.equal(declarationsFor('.form-field:focus-within .input').get('border-color'), 'var(--border-strong)');
  assert.equal(declarationsFor('.form-field.field-invalid .input').get('border-color'), 'var(--danger)');
  assert.equal(declarationsFor('.form-field.field-invalid .textarea').get('background'), 'var(--danger-light)');
  const selector = readFileSync(new URL('../src/components/SelectField.vue', import.meta.url), 'utf8');
  assert.match(selector, /<Sheet v-if="open && variant !== 'feed'"/);
  assert.match(selector, /<AppIcon v-if="modelValue === option" name="check" active/);
  assert.match(selector, /<AppIcon v-if="active && modelValue === option" name="check" :size="11" active/);
  assert.equal(declarationsFor('.step-entry-fields .textarea').get('height'), '120px');
  assert.equal(declarationsFor('.step-entry-fields').get('background'), 'var(--white)');
});

test('step inputs share one outlined surface without individual field or icon outlines', () => {
  assert.equal(declarationsFor('.step-entry-fields').get('border'), '1px solid var(--line)');
  assert.equal(declarationsFor('.step-entry-fields .input').get('border'), '0');
  assert.equal(declarationsFor('.step-entry-fields .textarea').get('border'), '0');
  assert.equal(declarationsFor('.step-entry-fields .step-title-input').get('border-bottom'), '1px solid var(--line)');
  assert.equal(declarationsFor('button').get('border'), '0');
  assert.equal(declarationsFor('button::after').get('border'), '0');
  assert.equal(declarationsFor('.primary-button').get('background'), 'var(--green)');
  assert.equal(declarationsFor('.primary-button').get('border'), undefined);
  assert.equal(declarationsFor('.text-button').get('border'), undefined);
  assert.equal(declarationsFor('.step-tools button').get('border'), undefined);
  assert.equal(declarationsFor('.icon-button.sheet-close').get('background'), 'transparent');
  assert.equal(declarationsFor('.input').get('height'), '44px');
  assert.equal(declarationsFor('.input.choice-trigger').get('height'), '44px');
  assert.equal(declarationsFor('.search-wrap').get('height'), '44px');
});

test('cover placeholders and photos share borderless translucent controls without suppressing keyboard focus', () => {
  const source = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
  const pickerStyles = postcss.parse(source.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  assert.equal(declarationsFor('.cover-image-picker .image-upload', pickerStyles).get('border'), '0');
  assert.equal(declarationsFor('.cover-image-picker .image-upload', pickerStyles).get('outline'), undefined);
  assert.equal(declarationsFor('.cover-image-picker .image-upload.filled', pickerStyles).get('outline'), undefined);
  assert.match(declarationsFor('.upload-caption').get('background'), /radial-gradient\(circle, var\(--photo-action-surface\) 0 16px, transparent 16\.5px\)/);
  assert.equal(declarationsFor('.upload-caption').get('color'), 'var(--white)');
  assert.equal(declarationsFor('.upload-caption').get('border'), '0');
  assert.equal(declarationsFor('.cover-image-picker .upload-caption', pickerStyles).size, 0);
  assert.equal(declarationsFor('.cover-image-picker .upload-placeholder', pickerStyles).get('pointer-events'), 'none');
  assert.equal(declarationsFor('button:focus-visible').get('outline'), '2px solid var(--green)');
});

test('home and compact photo controls keep small white icons and full touch targets without backdrop effects', () => {
  const surface = declarationsFor('.app-shell').get('--photo-action-surface');
  const [red, green, blue, alpha] = surface.match(/[\d.]+/g).map(Number);
  assert.ok(alpha > 0 && alpha < 1);
  const channels = [red, green, blue].map(channel => (channel * alpha + 255 * (1 - alpha)) / 255);
  const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  const luminance = .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
  assert.ok(1.05 / (luminance + .05) >= 4.5);
  for (const selector of ['.hero-edit', '.upload-caption']) {
    const control = declarationsFor(selector);
    assert.match(control.get('background'), /var\(--photo-action-surface\) 0 16px/);
    assert.equal(control.get('border'), '0');
    assert.equal(control.get('width'), '44px');
    assert.equal(control.get('height'), '44px');
    assert.equal(control.get('bottom'), '6px');
    assert.equal(control.get('right'), '6px');
    assert.equal(control.get('backdrop-filter'), undefined);
    assert.equal(declarationsFor(`${selector} .app-icon`).get('width'), '16px');
    assert.equal(declarationsFor(`${selector} .app-icon`).get('height'), '16px');
  }
  assert.equal(declarationsFor('.app-shell.menu-page .hero-edit').get('background'), undefined);
  const picker = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
  assert.match(picker, /<view v-if="!busy" class="upload-caption" aria-hidden="true">\s*<AppIcon name="camera-inverse" :size="compact \? 14 : 16"\s*\/>\s*<text v-if="!compact" class="upload-caption-label">拍照\/相册<\/text>\s*<\/view>/);
  assert.match(picker, /<ImageUploadProgress v-if="busy" :value="progress" :compact="compact"\s*\/>/);
  assert.doesNotMatch(picker, /photo-count|image-picker-actions|调整展示位置|移除图片/);
});

test('upload percentages sit inside large images at bottom-right and in the center of small images', () => {
  const source = readFileSync(new URL('../src/components/ImageUploadProgress.vue', import.meta.url), 'utf8');
  const progressStyles = postcss.parse(source.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  const frame = declarationsFor('.image-upload-progress', progressStyles);
  assert.equal(frame.get('position'), 'absolute');
  assert.equal(frame.get('inset'), '0');
  assert.equal(frame.get('align-items'), 'flex-end');
  assert.equal(frame.get('justify-content'), 'flex-end');
  assert.equal(frame.get('pointer-events'), 'none');
  const compact = declarationsFor('.image-upload-progress.is-compact', progressStyles);
  assert.equal(compact.get('align-items'), 'center');
  assert.equal(compact.get('justify-content'), 'center');
  const percent = declarationsFor('.image-upload-percent', progressStyles);
  assert.equal(percent.get('background'), 'var(--photo-action-surface)');
  assert.equal(percent.get('color'), 'var(--white)');
  assert.equal(percent.get('font-variant-numeric'), 'tabular-nums');
});

test('full-size cover pickers center the labeled action and tint only the default illustration', () => {
  const source = readFileSync(new URL('../src/components/ImagePicker.vue', import.meta.url), 'utf8');
  const pickerStyles = postcss.parse(source.match(/<style scoped>([\s\S]*?)<\/style>/)[1]);
  const action = declarationsFor('.cover-image-picker:not(.compact-image-picker) .upload-caption', pickerStyles);
  assert.equal(action.get('top'), '50%');
  assert.equal(action.get('left'), '50%');
  assert.equal(action.get('right'), 'auto');
  assert.equal(action.get('bottom'), 'auto');
  assert.equal(action.get('transform'), 'translate(-50%, -50%)');
  assert.equal(action.get('height'), '44px');
  assert.equal(action.get('min-width'), '128px');
  assert.equal(action.get('border-radius'), '999px');
  assert.equal(action.get('background'), 'var(--photo-action-surface)');
  assert.equal(declarationsFor('.upload-caption-label', pickerStyles).get('white-space'), 'nowrap');
  const tint = declarationsFor('.upload-default-tint', pickerStyles);
  assert.equal(tint.get('position'), 'absolute');
  assert.equal(tint.get('inset'), '0');
  assert.equal(tint.get('background'), 'var(--paper)');
  assert.equal(tint.get('opacity'), '.42');
  assert.equal(tint.get('pointer-events'), 'none');
  assert.match(source, /v-if="defaultCover" class="upload-default-tint" aria-hidden="true"/);
  assert.doesNotMatch(source, /<style scoped>[\s\S]*\.hero-edit/);
  assert.doesNotMatch(readFileSync(new URL('../src/pages/index/index.vue', import.meta.url), 'utf8'), /upload-default-tint|upload-caption-label/);
});

test('decorative upload background is packaged, golden-ratio and small enough for immediate display', async () => {
  const photo = readFileSync(new URL('../src/static/cover-upload-background.jpg', import.meta.url));
  const metadata = await sharp(photo).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(Math.abs(metadata.width / metadata.height - (1 + Math.sqrt(5)) / 2) < .002);
  assert.ok(photo.byteLength < 40 * 1024);
});

test('the family default artwork is distinct, golden-ratio and bundled for offline rendering', async () => {
  const familyPhoto = readFileSync(new URL('../src/static/family-home-default.jpg', import.meta.url));
  const placeholder = readFileSync(new URL('../src/static/cover-upload-background.jpg', import.meta.url));
  const metadata = await sharp(familyPhoto).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.ok(Math.abs(metadata.width / metadata.height - (1 + Math.sqrt(5)) / 2) < .002);
  assert.ok(familyPhoto.byteLength < 80 * 1024);
  assert.equal(familyPhoto.equals(placeholder), false);
});

test('photo control icons use white pixels in both native PNG variants', async () => {
  for (const name of ['camera', 'trash', 'close']) {
    for (const suffix of ['', '-active']) {
      const icon = fileURLToPath(new URL(`../src/static/icon-${name}-inverse${suffix}.png`, import.meta.url));
      const { data, info } = await sharp(icon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 96);
      assert.equal(info.height, 96);
      let opaquePixels = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        if (data[offset + 3] !== 255) continue;
        assert.deepEqual([...data.subarray(offset, offset + 3)], [255, 255, 255]);
        opaquePixels += 1;
      }
      assert.ok(opaquePixels > 100);
    }
  }
});

test('destructive step icons use the real danger color in both native PNG variants', async () => {
  const expected = declarationsFor('.app-shell').get('--danger').slice(1).match(/../g).map(channel => parseInt(channel, 16));
  for (const suffix of ['', '-active']) {
    const icon = fileURLToPath(new URL(`../src/static/icon-trash-danger${suffix}.png`, import.meta.url));
    const { data, info } = await sharp(icon).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 96);
    assert.equal(info.height, 96);
    let opaquePixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (data[offset + 3] !== 255) continue;
      assert.deepEqual([...data.subarray(offset, offset + 3)], expected);
      opaquePixels += 1;
    }
    assert.ok(opaquePixels > 100);
  }
});

test('cover geometry is owned by the shared frame rather than competing fixed CSS heights', () => {
  for (const selector of ['.detail-cover', '.image-upload', '.image-upload.filled', '.set-detail-cover']) {
    assert.equal(declarationsFor(selector).get('height'), undefined, selector);
    assert.equal(declarationsFor(selector).get('min-height'), undefined, selector);
  }
  for (const [file, expression] of [['ImagePicker', 'coverFrameStyle(frameKind)'], ['ImageCropper', 'coverFrameStyle(frame)'], ['RecipeCover', "coverFrameStyle('recipe')"]]) {
    assert.ok(readFileSync(new URL(`../src/components/${file}.vue`, import.meta.url), 'utf8').includes(`:style="${expression}"`));
  }
  assert.match(readFileSync(new URL('../src/components/SetSheet.vue', import.meta.url), 'utf8'), /<FoodDetailSheet[^>]*:image="mealSet.image"[^>]*kind="set"/);
});

test('bottom navigation keeps full-width equal touch cells and no selected background', () => {
  assert.equal(declarationsFor('.nav-item').get('flex'), '1 1 0');
  assert.equal(declarationsFor('.nav-item').get('width'), '0');
  assert.equal(declarationsFor('.nav-item').get('height'), '100%');
  assert.equal(declarationsFor('.nav-list').get('gap'), '0');
  assert.equal(declarationsFor('.nav-item.active').get('background'), 'none');
  assert.equal(declarationsFor('.nav-item.active .nav-icon-wrap').get('background'), 'none');
});

test('all procurement surfaces share cart icons with a handle and two wheels in both states', async () => {
  const generator = readFileSync(new URL('../scripts/build-ui-art.mjs', import.meta.url), 'utf8');
  const paths = generator.match(/shopping: '([^']+)'/)[1];
  assert.match(paths, /<path d="M3 5h4l4 16h14l3-11H8.25"\/>/);
  assert.equal((paths.match(/<circle\b/g) || []).length, 2);
  for (const active of [false, true]) {
    const color = declarationsFor('.app-shell').get(active ? '--green' : '--muted');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 32 32"><g stroke="${color}" fill="none" stroke-width="${active ? 2.2 : 1.8}" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
    const expected = await sharp(Buffer.from(svg)).png().toBuffer();
    const actual = readFileSync(new URL(`../src/static/icon-shopping${active ? '-active' : ''}.png`, import.meta.url));
    assert.deepEqual(actual, expected, 'packaged procurement icon must match the shared cart drawing');
  }
  for (const path of ['components/MealPreparationSheet.vue', 'components/IngredientsView.vue', 'components/ShoppingView.vue']) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
    assert.match(source, /<AppIcon (?:name="shopping"|:name="inCart\(dish\) \? 'shopping' : 'shopping-inverse'")/);
  }
});

test('all five navigation icons match label colors and use a stronger selected stroke', async () => {
  for (const name of ['menu', 'community', 'inventory', 'shopping', 'family']) {
    const coverage = [];
    for (const active of [false, true]) {
      const token = active ? '--green' : '--muted';
      assert.equal(declarationsFor(active ? '.nav-item.active' : '.nav-item').get('color'), `var(${token})`);
      const color = declarationsFor('.app-shell').get(token);
      assert.equal(color, active ? '#304d60' : '#69777a');
      const expected = color.slice(1).match(/../g).map((channel) => parseInt(channel, 16));
      const iconPath = fileURLToPath(new URL(`../src/static/icon-${name}${active ? '-active' : ''}.png`, import.meta.url));
      const { data, info } = await sharp(iconPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(info.width, 96);
      assert.equal(info.height, 96);
      let opaquePixels = 0;
      for (let offset = 0; offset < data.length; offset += info.channels) {
        if (data[offset + 3] !== 255) continue;
        assert.deepEqual([...data.subarray(offset, offset + 3)], expected);
        opaquePixels += 1;
      }
      assert.ok(opaquePixels > 100);
      coverage.push(opaquePixels);
    }
    assert.ok(coverage[1] > coverage[0], `${name} selected stroke should be stronger`);
  }
});
