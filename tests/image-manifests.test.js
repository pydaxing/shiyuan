import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageManifests } from '../src/services/image-manifests.js';

const image = (fileId = 'cloud://photo', variant = 'card', expires = 300000) => ({ fileId, variant, version: `${fileId}#display-${variant}-v1`, url: 'https://storage.example.test/signed', bytes: 40000, contentType: 'image/jpeg', urlExpiresAt: expires });

test('manifests are valid only in the current identity, family and share context', () => {
  const manifests = createImageManifests({ now: () => 0 });
  manifests.activate('alice:family-a');
  const previous = manifests.context();
  manifests.remember([image()], previous);
  assert.ok(manifests.get(image().version));
  manifests.activate('bob:family-b');
  assert.equal(manifests.get(image().version), undefined);
  manifests.remember([image()], previous);
  assert.equal(manifests.get(image().version), undefined);
  manifests.activate('alice:family-a');
  manifests.remember([image()], previous);
  assert.equal(manifests.get(image().version), undefined);
});

test('authorization expiry is not prolonged by receiving a manifest repeatedly', () => {
  let clock = 1000;
  const manifests = createImageManifests({ now: () => clock });
  manifests.remember([image()]);
  assert.equal(manifests.get(image().version).urlExpiresAt, 300000);
  clock = 270001;
  manifests.remember([image()]);
  assert.equal(manifests.get(image().version), undefined);
  manifests.remember([image('cloud://next', 'detail', clock + 900000)]);
  assert.equal(manifests.get(image('cloud://next', 'detail').version).urlExpiresAt, clock + 300000);
});

test('manifests never admit originals, unsafe URLs, oversized payloads or invalid versions', () => {
  const manifests = createImageManifests({ now: () => 0 });
  for (const unsafe of [
    { ...image(), variant: 'original' },
    { ...image(), url: 'http://storage.example.test/photo' },
    { ...image(), version: 'cloud://photo' },
    { ...image(), bytes: 80001 },
    { ...image(), contentType: 'text/html' },
    { ...image(), urlExpiresAt: 0 },
    { ...image(), fileId: 'https://unrelated.example.test/photo' },
  ]) {
    manifests.remember([unsafe]);
    assert.equal(manifests.get(image().version), undefined);
  }
  manifests.remember([image()]);
  const context = manifests.context();
  manifests.clear();
  manifests.remember([image()], context);
  assert.equal(manifests.get(image().version), undefined);
});

test('a bounded manifest cache retains recent images and strips extra response fields', () => {
  const manifests = createImageManifests({ now: () => 0, maxEntries: 2 });
  manifests.remember([{ ...image(), base64: 'never-copy', extra: 'never-store' }]);
  manifests.remember([image('cloud://two')]);
  assert.equal(manifests.get(image().version).base64, undefined);
  manifests.remember([image('cloud://three')]);
  assert.equal(manifests.get(image('cloud://two').version), undefined);
  assert.ok(manifests.get(image().version));
  assert.ok(manifests.get(image('cloud://three').version));
});
