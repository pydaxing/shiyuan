import test from 'node:test';
import assert from 'node:assert/strict';
import { ref, watchEffect, nextTick } from 'vue';
import { createMediaCache } from '../src/services/media-cache.js';

test('one image arriving does not rerender every other card', async () => {
  const cache = fixture();
  const runs = new Array(60).fill(0);
  const stops = runs.map((_, index) => watchEffect(() => { void cache.urls.value[`photo-${index}`]; runs[index] += 1; }));
  try {
    await cache.load('photo-15');
    await nextTick();
    assert.equal(runs[15], 2);
    assert.equal(runs.reduce((total, count) => total + count, 0), 61);
  } finally { stops.forEach(stop => stop()); }
});

test('a restored native cache verifies only requested files without scanning all 400 images', async () => {
  const checked = [];
  const cache = fixture({
    now: () => 100,
    maxEntries: 400,
    readEntries: () => Array.from({ length: 400 }, (_, index) => ({ fileId: `photo-${index}`, path: `/cache/${index}.jpg`, bytes: 5, expiresAt: 300000 })),
    checkImage: async path => { checked.push(path); return true; },
    fetchImage: () => assert.fail('fresh verified disk image does not need network'),
    writeImage: () => assert.fail('restoring an existing image does not need a copy'),
  });
  cache.activate('alice:family');
  assert.deepEqual(checked, []);
  assert.equal(cache.peek('photo-15'), '');
  assert.equal(await cache.load('photo-15'), '/cache/15.jpg');
  assert.equal(cache.resolve('photo-15'), '/cache/15.jpg');
  assert.equal(await cache.load('photo-15'), '/cache/15.jpg');
  assert.deepEqual(checked, ['/cache/15.jpg', '/cache/15.jpg']);
  assert.equal(cache.peek('photo-399'), '');
});

test('unverified, missing or corrupt native cache files are not displayed or sent as known versions', async () => {
  const versions = [];
  const cache = fixture({
    now: () => 100,
    readEntries: () => [{ fileId: 'photo', path: '/missing.jpg', bytes: 5, expiresAt: 300000 }],
    checkImage: async () => false,
    fetchImage: async (fileId, knownVersion) => { versions.push(knownVersion); return fileId; },
  });
  cache.activate('alice:family');
  assert.equal(cache.peek('photo'), '');
  assert.equal(await cache.load('photo'), '/cache/1.jpg');
  assert.deepEqual(versions, ['']);
  assert.equal(cache.peek('photo'), '/cache/1.jpg');
});

test('changing family during an asynchronous disk check cannot display the old family image', async () => {
  let completeCheck;
  const checked = new Promise(resolve => { completeCheck = resolve; });
  const cache = fixture({
    now: () => 100,
    readEntries: scope => scope === 'alice:family' ? [{ fileId: 'photo', path: '/old.jpg', bytes: 5, expiresAt: 300000 }] : [],
    checkImage: () => checked,
    fetchImage: () => assert.fail('superseded image must not fetch'),
  });
  cache.activate('alice:family');
  const loaded = cache.load('photo');
  await Promise.resolve();
  cache.activate('bob:family');
  completeCheck(true);
  assert.equal(await loaded, '');
  assert.deepEqual(cache.urls.value, {});
});

test('a slow image download cannot block another completed download from reaching the screen', async () => {
  let finishSlow;
  const slow = new Promise(resolve => { finishSlow = resolve; });
  const cache = fixture({ concurrency: 2, prepareImage: async image => image === 'slow' ? slow : image });
  const first = cache.load('slow');
  const fast = await cache.load('fast');
  assert.ok(fast);
  assert.equal(cache.peek('slow'), '');
  finishSlow('slow');
  await first;
});

test('scrolled-away queued thumbnails do not delay newly visible details with obsolete requests', async () => {
  let finishFirst;
  const firstDownload = new Promise(resolve => { finishFirst = resolve; });
  const requests = [];
  let visible = true;
  const cache = fixture({ concurrency: 1, fetchImage: async fileId => { requests.push(fileId); return fileId; }, prepareImage: image => image === 'first' ? firstDownload : image });
  const first = cache.load('first');
  const offscreen = Array.from({ length: 40 }, (_, index) => cache.load(`offscreen-${index}`, { isNeeded: () => visible }));
  const detail = cache.load('visible-detail');
  await Promise.resolve();
  visible = false;
  finishFirst('first');
  await first;
  assert.ok(await detail);
  assert.deepEqual(await Promise.all(offscreen), new Array(40).fill(''));
  assert.deepEqual(requests, ['first', 'visible-detail']);
  assert.deepEqual(cache.errors, []);
});

test('one offscreen consumer cannot cancel another visible consumer of the same image', async () => {
  let finishFirst;
  const firstDownload = new Promise(resolve => { finishFirst = resolve; });
  const requests = [];
  const cache = fixture({ concurrency: 1, fetchImage: async fileId => { requests.push(fileId); return fileId; }, prepareImage: image => image === 'first' ? firstDownload : image });
  const first = cache.load('first');
  const leaving = cache.load('shared', { isNeeded: () => false });
  const arriving = cache.load('shared', { isNeeded: () => true });
  assert.equal(leaving, arriving);
  finishFirst('first');
  await first;
  assert.ok(await arriving);
  assert.deepEqual(requests, ['first', 'shared']);
});

test('a completed authorization does not start a download after every consumer has left', async () => {
  let finishAuthorization;
  const authorization = new Promise(resolve => { finishAuthorization = resolve; });
  let visible = true;
  const cache = fixture({ fetchImage: () => authorization, prepareImage: () => assert.fail('obsolete image must not consume download bandwidth') });
  const loaded = cache.load('photo', { isNeeded: () => visible });
  await Promise.resolve();
  visible = false;
  finishAuthorization('photo');
  assert.equal(await loaded, '');
  assert.deepEqual(cache.urls.value, {});
});

test('inline manifests do not extend image authorization beyond their original deadline', async () => {
  let clock = 1000;
  const cache = fixture({ now: () => clock, fetchImage: async (fileId, knownVersion) => knownVersion ? { unchanged: true, version: fileId, urlExpiresAt: 9000 } : { urlExpiresAt: 4000 } });
  await cache.load('photo');
  clock = 4001;
  assert.equal(cache.peek('photo'), '');
  await cache.load('photo');
  clock = 9001;
  assert.equal(cache.peek('photo'), '');
});

test('clearing a full image cache saves the empty index only once', async () => {
  let saves = 0;
  const cache = fixture({ maxEntries: 400, readEntries: () => Array.from({ length: 400 }, (_, index) => ({ fileId: `photo-${index}`, path: `/cache/${index}.jpg`, bytes: 5, expiresAt: 300000 })), saveEntries: () => { saves += 1; } });
  cache.activate('alice:family');
  saves = 0;
  cache.clear();
  assert.equal(saves, 1);
  assert.equal(cache.removed.length, 400);
  assert.deepEqual(cache.urls.value, {});
});

test('an expired signed URL is reauthorized once and retried without a thirty-second blank', async () => {
  let fetches = 0;
  const cache = fixture({
    fetchImage: async () => ({ attempt: ++fetches }),
    prepareImage: async image => { if (image.attempt === 1) throw Object.assign(new Error('expired'), { code: 'IMAGE_URL' }); return image; },
  });
  assert.ok(await cache.load('photo'));
  assert.equal(fetches, 2);
  assert.deepEqual(cache.errors, []);
});

function fixture(options = {}) {
  const urls = ref({});
  const removed = [];
  const errors = [];
  let writes = 0;
  const cache = createMediaCache({ urls, fetchImage: async fileId => fileId, writeImage: async () => `/cache/${++writes}.jpg`, removeImage: path => removed.push(path), onError: error => errors.push(error), ...options });
  return { ...cache, urls, removed, errors };
}

test('expired immutable photo reauthorizes without downloading or rewriting identical bytes', async () => {
  let time = 0;
  let reject = false;
  const versions = [];
  const cache = fixture({ now: () => time, fetchImage: async (fileId, knownVersion) => {
    versions.push(knownVersion);
    if (reject) throw new Error('revoked');
    return knownVersion ? { unchanged: true, version: fileId } : 'photo';
  } });
  const path = await cache.load('photo');
  time = 300001;
  assert.equal(await cache.load('photo'), path);
  assert.deepEqual(versions, ['', 'photo']);
  assert.deepEqual(cache.removed, []);
  time = 600002; reject = true;
  await assert.rejects(cache.load('photo'), /revoked/);
  assert.deepEqual(cache.urls.value, {});
  assert.deepEqual(cache.removed, [path]);
});

test('first asynchronous image resolution updates Vue rendering and deduplicates requests', async () => {
  let fetches = 0;
  const cache = fixture({ fetchImage: async () => { fetches += 1; return 'photo'; } });
  let rendered;
  const stop = watchEffect(() => { rendered = cache.resolve('image'); });
  assert.equal(rendered, '');
  const path = await cache.load('image');
  await nextTick();
  assert.equal(rendered, path);
  assert.equal(fetches, 1);
  stop();
});

test('image loading limits concurrency to three', async () => {
  let active = 0;
  let maximum = 0;
  const cache = fixture({ fetchImage: async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return 'photo';
  } });
  await Promise.all(Array.from({ length: 9 }, (_, index) => cache.load(`image-${index}`)));
  assert.equal(maximum, 3);
});

test('revoked family cannot repopulate images from queued or in-flight requests', async () => {
  let finish;
  const cache = fixture({ writeImage: () => new Promise(resolve => { finish = resolve; }) });
  const loading = cache.load('image');
  await new Promise(resolve => setImmediate(resolve));
  cache.clear();
  finish('/stale.jpg');
  assert.equal(await loading, '');
  assert.deepEqual(cache.urls.value, {});
  assert.deepEqual(cache.removed, ['/stale.jpg']);
});

test('cache refreshes authorization, evicts least recently used files, and clears local photos', async () => {
  let time = 0;
  const cache = fixture({ now: () => time, maxEntries: 2 });
  const first = await cache.load('first');
  await cache.load('second');
  cache.resolve('first');
  await cache.load('third');
  assert.equal(cache.urls.value.second, undefined);
  assert.equal(cache.urls.value.first, first);
  time = 300001;
  assert.equal(cache.resolve('first'), '');
  assert.notEqual(await cache.load('first'), first);
  assert.ok(cache.removed.includes(first));
  cache.clear();
  assert.deepEqual(cache.urls.value, {});
});

test('failed image requests do not retry on every render', async () => {
  let time = 0;
  let fetches = 0;
  const cache = fixture({ now: () => time, fetchImage: async () => { fetches += 1; throw new Error('denied'); } });
  await assert.rejects(cache.load('image'), /denied/);
  for (let index = 0; index < 10; index += 1) cache.resolve('image');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);
  time = 30001;
  cache.resolve('image');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 2);
});

test('priming approved local photos avoids download but still revalidates when the cache expires', async () => {
  let time = 0;
  let fetches = 0;
  const cache = fixture({ now: () => time, fetchImage: async () => { fetches += 1; return 'cloud photo'; }, writeImage: async image => image.localPath ? '/private-copy.jpg' : '/downloaded.jpg' });
  await cache.prime('image', '/selected.jpg');
  assert.equal(cache.resolve('image'), '/private-copy.jpg');
  assert.equal(fetches, 0);
  time = 300001;
  await cache.load('image');
  assert.equal(fetches, 1);
  assert.equal(cache.resolve('image'), '/downloaded.jpg');
  assert.deepEqual(cache.removed, ['/private-copy.jpg']);
});

test('clearing the family while priming cannot restore an old local photo', async () => {
  let finish;
  const cache = fixture({ fetchImage: async () => { throw new Error('no fetch expected'); }, writeImage: () => new Promise(resolve => { finish = resolve; }) });
  const copying = cache.prime('image', '/selected.jpg');
  await new Promise(resolve => setImmediate(resolve));
  cache.clear();
  finish('/private-copy.jpg');
  assert.equal(await copying, '');
  assert.deepEqual(cache.urls.value, {});
  assert.deepEqual(cache.removed, ['/private-copy.jpg']);
});

test('tapped originals have a reserved slot and do not wait behind the thumbnail queue', async () => {
  const started = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const cache = fixture({ concurrency: 2, priority: key => key === 'original', fetchImage: async key => { started.push(key); await blocked; return 'photo'; } });
  const reads = ['card-1', 'card-2', 'card-3'].map(key => cache.load(key));
  reads.push(cache.load('original'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['card-1', 'card-2', 'original']);
  release();
  await Promise.all(reads);
});

test('byte budget evicts and awaits deletion before writing, even with concurrent downloads', async () => {
  const disk = new Map();
  let sequence = 0;
  let peak = 0;
  const cache = fixture({ maxBytes: 10, maxEntries: 10, concurrency: 6,
    imageSize: () => 4,
    writeImage: async () => {
      const bytes = [...disk.values()].reduce((total, size) => total + size, 0);
      assert.ok(bytes + 4 <= 10);
      const path = `/photo-${++sequence}`;
      disk.set(path, 4);
      peak = Math.max(peak, bytes + 4);
      return path;
    },
    removeImage: async path => { await new Promise(resolve => setTimeout(resolve, 1)); disk.delete(path); },
  });
  await Promise.all(Array.from({ length: 30 }, (_, index) => cache.load(`photo-${index}`)));
  assert.equal(peak, 8);
  assert.equal(disk.size, 2);
  assert.equal(Object.keys(cache.urls.value).length, 2);
  assert.equal(cache.errors.length, 0);
});

test('entry limit makes room before the next write rather than after filling the disk', async () => {
  const disk = new Set();
  let sequence = 0;
  const cache = fixture({ maxEntries: 2, writeImage: async () => {
    assert.ok(disk.size < 2);
    const path = `/photo-${++sequence}`;
    disk.add(path);
    return path;
  }, removeImage: async path => { await new Promise(resolve => setImmediate(resolve)); disk.delete(path); } });
  await Promise.all(['first', 'second', 'third', 'fourth'].map(key => cache.load(key)));
  assert.equal(disk.size, 2);
});

test('unexpected native quota recovers by evicting owned cache without downloading again', async () => {
  const disk = new Set();
  let fetches = 0;
  let attempts = 0;
  const cache = fixture({ imageSize: () => 4, fetchImage: async key => { fetches += 1; return key; }, writeImage: async key => {
    attempts += 1;
    if (disk.size >= 2) throw Object.assign(new Error('quota'), { code: 'CACHE_QUOTA' });
    disk.add(key);
    return key;
  }, removeImage: async path => { await new Promise(resolve => setImmediate(resolve)); disk.delete(path); } });
  await cache.load('first');
  await cache.load('second');
  assert.equal(await cache.load('third'), 'third');
  assert.equal(fetches, 3);
  assert.equal(attempts, 4);
  assert.deepEqual([...disk], ['second', 'third']);
  assert.equal(cache.errors.length, 0);
});

test('persistent quota failures are bounded and other write errors do not evict unrelated photos', async () => {
  let failure;
  let attempts = 0;
  const cache = fixture({ imageSize: () => 1, writeImage: async image => { attempts += 1; if (failure) throw failure; return image; } });
  await cache.load('first');
  await cache.load('second');
  failure = Object.assign(new Error('permission'), { code: 'CACHE_IO' });
  await assert.rejects(cache.load('third'), /permission/);
  assert.equal(cache.removed.length, 0);
  failure = Object.assign(new Error('quota'), { code: 'CACHE_QUOTA' });
  await assert.rejects(cache.load('fourth'), /quota/);
  assert.equal(attempts, 6);
  assert.equal(cache.removed.length, 2);
});

test('force retry replaces a missing or corrupt cached file instead of returning the broken path', async () => {
  const known = [];
  const cache = fixture({ fetchImage: async (key, version) => { known.push(version); return key; } });
  const first = await cache.load('image');
  const second = await cache.load('image', { force: true });
  assert.notEqual(first, second);
  assert.deepEqual(known, ['', '']);
  assert.deepEqual(cache.removed, [first]);
});

test('family clear during quota recovery cannot publish a stale photo or deadlock later writes', async () => {
  let release;
  let writing = 0;
  const cache = fixture({ maxEntries: 1, writeImage: async image => { writing += 1; return image; },
    removeImage: () => new Promise(resolve => { release = resolve; }),
  });
  await cache.load('first');
  const stale = cache.load('second');
  await new Promise(resolve => setImmediate(resolve));
  cache.clear();
  release();
  assert.equal(await stale, '');
  assert.equal(writing, 1);
  assert.equal(await cache.load('new-family'), 'new-family');
});

test('fresh disk images restore without download or rewrite and expired ones only reauthorize', async () => {
  let clock = 10;
  let stored = { scope: 'alice:family', entries: [{ fileId: 'photo', path: '/saved.jpg', bytes: 5, expiresAt: 300000 }] };
  const versions = [];
  const cache = fixture({ now: () => clock, readEntries: scope => stored.scope === scope ? stored.entries : [], saveEntries: (scope, entries) => { stored = { scope, entries }; }, fetchImage: async (fileId, knownVersion) => { versions.push(knownVersion); return { unchanged: true, version: fileId }; }, writeImage: () => assert.fail('should reuse saved file') });
  cache.activate('alice:family');
  assert.equal(cache.peek('photo'), '/saved.jpg');
  assert.equal(await cache.load('photo'), '/saved.jpg');
  assert.deepEqual(versions, []);
  clock = 300001;
  assert.equal(cache.peek('photo'), '');
  assert.equal(await cache.load('photo'), '/saved.jpg');
  assert.deepEqual(versions, ['photo']);
  cache.activate('bob:family');
  assert.deepEqual(cache.urls.value, {});
  assert.deepEqual(stored.entries, []);
  assert.deepEqual(cache.removed, ['/saved.jpg']);
});

test('restored images respect file and byte limits and clear removes durable metadata before authentication', () => {
  let stored = [{ fileId: 'first', path: '/first.jpg', bytes: 5, expiresAt: 10 }, { fileId: 'second', path: '/second.jpg', bytes: 5, expiresAt: 10 }, null];
  const cache = fixture({ maxBytes: 6, readEntries: () => stored, saveEntries: (scope, entries) => { stored = entries; } });
  cache.activate('scope');
  assert.deepEqual(Object.keys(cache.urls.value), ['first']);
  cache.clear();
  assert.deepEqual(stored, []);
  let cleared = false;
  fixture({ saveEntries: (scope, entries) => { cleared = scope === '' && entries.length === 0; } }).clear();
  assert.equal(cleared, true);
});

test('reauthorization refetches bytes when the cached file was evicted while its request was in flight', async () => {
  let time = 0;
  let finish;
  const requests = [];
  const cache = fixture({ maxEntries: 1, now: () => time, fetchImage: async (fileId, knownVersion) => {
    requests.push([fileId, knownVersion]);
    if (knownVersion) return new Promise(resolve => { finish = () => resolve({ unchanged: true, version: fileId }); });
    return { base64: 'cGhvdG8=' };
  }, imageSize: image => { assert.ok(image.base64, 'unchanged response is not image data'); return 5; } });
  await cache.load('first');
  time = 300001;
  const reauthorizing = cache.load('first');
  await new Promise(resolve => setImmediate(resolve));
  await cache.load('second');
  finish();
  assert.ok(await reauthorizing);
  assert.deepEqual(requests, [['first', ''], ['first', 'first'], ['second', ''], ['first', '']]);
});

test('transient reauthorization failures keep disk bytes for retry without extending expired access', async () => {
  let time = 0;
  let failure;
  const requests = [];
  const cache = fixture({ now: () => time, fetchImage: async (fileId, knownVersion) => {
    requests.push(knownVersion);
    if (failure) throw failure;
    return knownVersion ? { unchanged: true, version: fileId } : 'photo';
  } });
  const saved = await cache.load('photo');
  time = 300001;
  failure = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  await assert.rejects(cache.load('photo'));
  assert.deepEqual(cache.removed, []);
  assert.equal(cache.peek('photo'), '');
  failure = undefined;
  assert.equal(await cache.load('photo'), saved);
  assert.deepEqual(requests, ['', 'photo', 'photo']);
});

test('missing cached files are downloaded rather than accepted as unchanged', async () => {
  let exists = true;
  const requests = [];
  const cache = fixture({ hasImage: () => exists, fetchImage: async (fileId, knownVersion) => { requests.push(knownVersion); return 'photo'; } });
  const first = await cache.load('photo');
  exists = false;
  assert.notEqual(await cache.load('photo'), first);
  assert.deepEqual(requests, ['', '']);
});

test('warm reads and authorization refresh protect recently used photos from capacity eviction', async () => {
  let clock = 0;
  const cache = fixture({ maxEntries: 2, now: () => clock, fetchImage: async (fileId, knownVersion) => knownVersion ? { unchanged: true, version: fileId } : 'photo' });
  const first = await cache.load('first');
  await cache.load('second');
  await cache.load('first');
  await cache.load('third');
  assert.equal(cache.peek('first'), first);
  assert.equal(cache.peek('second'), '');
  clock = 300001;
  await cache.load('first');
  await cache.load('fourth');
  assert.equal(cache.peek('first'), first);
  assert.equal(cache.peek('third'), '');
});

test('background flush persists read recency so restart does not evict the last viewed photo first', async () => {
  let stored;
  const cache = fixture({ maxEntries: 2, imageSize: () => 5, saveEntries: (scope, entries) => { stored = entries; } });
  cache.activate('family');
  await cache.load('first');
  await cache.load('second');
  cache.resolve('first');
  cache.flush();
  assert.deepEqual(stored.map(entry => entry.fileId), ['second', 'first']);
  const restarted = fixture({ maxEntries: 2, readEntries: () => stored });
  restarted.activate('family');
  await restarted.load('third');
  assert.equal(restarted.peek('first'), cache.peek('first'));
  assert.equal(restarted.peek('second'), '');
});
