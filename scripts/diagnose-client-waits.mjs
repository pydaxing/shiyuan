import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { ref } from 'vue';
import { createCommunityFeed } from '../src/services/community-feed.js';
import { createPreferenceUpdates } from '../src/services/preference-updates.js';

const directory = `${process.cwd()}/artifacts/deployment/performance`;
const receipt = `${directory}/diagnosis-client-waits.json`;
assert.equal(await access(receipt).then(() => true, () => false), false, '已有回执，请勿覆盖');
await mkdir(directory, { recursive: true });
const all = { type: '全部', category: '全部', search: '' };
const findings = {};
const cache = new Map();
const requests = [];
const controller = createCommunityFeed({ cache, request: async query => { requests.push(query); return { posts: [], cursor: '' }; } });
await controller.select(all, 'family');
await controller.select({ ...all, type: '菜品' }, 'family');
await controller.select({ ...all, type: '菜品', category: '荤菜' }, 'family');
findings.emptyFilters = { requestCount: requests.length, cacheEntries: cache.size, queries: requests };

let finishRequest;
let count = 0;
const pendingCache = new Map();
const first = createCommunityFeed({ cache: pendingCache, request: () => { count += 1; return new Promise(resolve => { finishRequest = resolve; }); } });
const waiting = first.select(all, 'family');
first.dispose();
finishRequest({ posts: [], cursor: '' });
await waiting;
const entriesAfterSuccess = pendingCache.size;
const next = createCommunityFeed({ cache: pendingCache, request: async () => { count += 1; return { posts: [], cursor: '' }; } });
await next.select(all, 'family');
findings.leaveBeforeResponse = { successfulResponseCached: entriesAfterSuccess > 0, requestsAfterReturn: count };

let clock = 0;
let refreshCalls = 0;
let finishRefresh;
const expiring = createCommunityFeed({ cache: new Map(), now: () => clock, request: () => {
  refreshCalls += 1;
  return refreshCalls === 1 ? Promise.resolve({ posts: [], cursor: '' }) : new Promise(resolve => { finishRefresh = resolve; });
} });
await expiring.select(all, 'family');
clock = 31000;
const refreshing = expiring.select(all, 'family');
findings.expiredEmpty = { ...expiring.state.value, refreshCalls, showsSkeleton: expiring.state.value.loading && !expiring.state.value.ready, showsEmpty: expiring.state.value.ready && !expiring.state.value.loading && !expiring.state.value.error };
finishRefresh({ posts: [], cursor: '' });
await refreshing;

const busy = ref(false);
const saves = [];
const preferences = createPreferenceUpdates({ getScope: () => 'family:me', isBusy: () => busy.value, send: key => {
  busy.value = true;
  return new Promise(resolve => { saves.push({ key, finish: () => { busy.value = false; resolve(); } }); });
} });
const operations = ['chef', 'fridge', 'shopping'].map(key => preferences.update(key, true));
const sentBeforeResponse = saves.length;
for (let index = 0; index < operations.length; index += 1) {
  saves[index].finish();
  await operations[index];
}
findings.multiplePreferences = { queued: operations.length, sentBeforeResponse, totalRequests: saves.length, order: saves.map(save => save.key) };
findings.environment = 'Local execution of actual service modules with controlled fake network responses; no cloud writes';
await writeFile(receipt, JSON.stringify(findings, null, 2));
console.log(JSON.stringify(findings, null, 2));
