import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeArchives } from '../scripts/report-authorized-recipes.mjs';

test('recipe report separates collected pages, verified publishing and actual image content', () => {
  const entries = [{ archiveDirectory: '/first' }, { archiveDirectory: '/second' }, { sourceUrl: 'pending' }];
  const records = [
    { fullContentCollected: true, imageFiles: 2, imageHashes: ['cover', 'step'], steps: 1, publishedPostId: 'published', publicPublishingAllowed: true },
    { fullContentCollected: false, imageFiles: 1, imageHashes: ['cover'], steps: 0, publishedPostId: 'unverified', publicPublishingAllowed: false },
  ];
  assert.deepEqual(summarizeArchives(entries, records), {
    discoveredSourcePages: 3, archivedSourcePages: 2, completeSourcePages: 1, uniqueCompleteSourcePages: 1, incompleteSourcePages: 1,
    pendingSourcePages: 1, imageFiles: 3, uniqueImageContents: 2, sourceSteps: 1, duplicatePages: 0, publishedVerifiedRecipes: 1,
  });
});

test('complete duplicate pages do not inflate the unique collection target', () => {
  const records = [
    { fullContentCollected: true, duplicateOf: null, imageFiles: 1, imageHashes: ['original'], steps: 2 },
    { fullContentCollected: true, duplicateOf: 'original', imageFiles: 1, imageHashes: ['copy'], steps: 2 },
    { fullContentCollected: false, duplicateOf: null, imageFiles: 0, imageHashes: [], steps: 0 },
  ];
  const counts = summarizeArchives(records.map(() => ({ archiveDirectory: '/archived' })), records);
  assert.equal(counts.completeSourcePages, 2);
  assert.equal(counts.uniqueCompleteSourcePages, 1);
  assert.equal(counts.duplicatePages, 1);
});
