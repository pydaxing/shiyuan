import { singleFeedImageWidth } from '../src/domain/feed-image-layout.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitCropImage, cropRectangle, cropPixels } from '../src/domain/image-crop.js';

test('discovery takes a centered square from the original short edge without double cropping', () => {
  for (const source of [{width: 1600, height: 900}, {width: 900, height: 1600}, {width: 1200, height: 1200}]) {
    for (const edge of [70, 96, 210]) {
      const frame = {width: edge, height: edge};
      const image = fitCropImage(source, frame);
      const crop = cropPixels(source, cropRectangle(image, frame));
      const short = Math.min(source.width, source.height);
      assert.ok(Math.abs(crop.width - short) < 1e-8);
      assert.ok(Math.abs(crop.height - short) < 1e-8);
      assert.ok(Math.abs(crop.x - (source.width - short) / 2) < 1e-8);
      assert.ok(Math.abs(crop.y - (source.height - short) / 2) < 1e-8);
    }
  }
  const component = readFileSync(new URL('../src/components/MealPostCard.vue', import.meta.url), 'utf8');
  assert.match(component, /<LazyImage :src="item.image"[^>]*:variant="feed \? 'feed' : 'card'"/);
  assert.match(component, /:mode="feed && media.length === 1 \? 'widthFix' : 'aspectFill'"/);
  assert.match(component, /\.in-feed \.meal-post-image \{[^}]*height: 0; padding-bottom: 100%/);
  assert.match(component, /\.in-feed \.meal-post-images.single \.meal-post-image \{[^}]*height: auto; padding-bottom: 0/);
  assert.match(component, /\.in-feed \.meal-post-images.single \.meal-post-image-frame \{[^}]*position: relative; height: auto/);
});


test('single image bounds preserve the whole photo for portrait, landscape and extreme ratios', () => {
  for (const [width, height] of [[1600,900], [900,1600], [1200,1200], [100,4000], [4000,100], [80,60]]) {
    const displayWidth = singleFeedImageWidth(width, height);
    const displayHeight = displayWidth * height / width;
    assert.ok(displayWidth <= 200 && displayHeight <= 240);
    assert.ok(displayWidth <= width);
  }
  assert.equal(singleFeedImageWidth(0, 0), 160);
  assert.equal(singleFeedImageWidth(NaN, 20), 160);
});

test('all multi-image counts share the same three-column square cell geometry', () => {
  const source = readFileSync(new URL('../src/components/MealPostCard.vue', import.meta.url), 'utf8');
  assert.match(source, /\.meal-post-images \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(source, /\.in-feed \.meal-post-images.paired \.meal-post-image:nth-child\(3\) \{ grid-column: 1; \}/);
  assert.doesNotMatch(source, /\.in-feed \.meal-post-images.paired \{[^}]*(?:width|grid-template-columns)/);
});
