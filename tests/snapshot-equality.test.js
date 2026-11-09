import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { sameSnapshotField } from '../src/services/snapshot-equality.js';

test('raw snapshot comparison preserves JSON equality for cloud fields', () => {
  const samples = [null, undefined, '', 0, false, [], {}, { name: '小灶', optional: undefined }, [{ id: 'dish', steps: [{ text: '蒸熟' }], tags: ['自建'] }]];
  for (const left of samples) for (const right of samples) {
    const current = left && typeof left === 'object' ? reactive(structuredClone(left)) : left;
    assert.equal(sameSnapshotField(current, right), JSON.stringify(current) === JSON.stringify(right));
  }
});

test('comparison sees in-place optimistic edits and nested list changes without stale signatures', () => {
  const incoming = [{ id: 'dish', name: '青菜', steps: [{ text: '蒸熟' }] }];
  const current = reactive(structuredClone(incoming));
  assert.equal(sameSnapshotField(current, incoming), true);
  current[0].steps[0].text = '炒熟';
  assert.equal(sameSnapshotField(current, incoming), false);
  current[0].steps[0].text = '蒸熟';
  assert.equal(sameSnapshotField(current, incoming), true);
  current.push({ id: 'new' });
  assert.equal(sameSnapshotField(current, incoming), false);
  current.pop();
  delete current[0].name;
  assert.equal(sameSnapshotField(current, incoming), false);
});

test('snapshot equality does not mutate or normalize either payload', () => {
  const incoming = Object.freeze([{ id: 'dish', cover: '', optional: undefined }]);
  const current = reactive(structuredClone(incoming));
  const before = JSON.stringify(current);
  assert.equal(sameSnapshotField(current, incoming), true);
  assert.equal(JSON.stringify(current), before);
  assert.ok(Object.hasOwn(current[0], 'optional'));
});
