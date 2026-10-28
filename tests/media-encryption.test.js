import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptImage, decryptImage } from '../server/media-encryption.mjs';

test('approved images are randomized authenticated ciphertext, not directly viewable photos', () => {
  const original = Buffer.from('private-family-photo');
  const first = encryptImage(original);
  const second = encryptImage(original);
  assert.equal(first.bytes.subarray(0, 8).toString(), 'SHIYUAN1');
  assert.equal(first.bytes.includes(original), false);
  assert.notDeepEqual(first.bytes, second.bytes);
  assert.notEqual(first.key, second.key);
  assert.deepEqual(decryptImage(first.bytes, first.key), original);
  assert.throws(() => decryptImage(first.bytes, second.key));
  for (const offset of [0, 8, 20, 36]) {
    const modified = Buffer.from(first.bytes);
    modified[offset] ^= 1;
    assert.throws(() => decryptImage(modified, first.key));
  }
  assert.throws(() => decryptImage(original, first.key));
});
