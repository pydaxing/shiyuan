import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApplication } from '../server/application.mjs';
import { memoryRepository } from './helpers/memory-repository.js';
import { createAccountVisitTracker } from '../src/services/account-visits.js';
const hash = id => createHash('sha256').update(id).digest('hex');
function fixture() {
  const repository = memoryRepository();
  let time = Date.parse('2026-11-09T15:59:00Z');
  const app = createApplication({ repository, now: () => time, signFiles: async () => ({}) });
  const call = async (action, payload = {}, user = 'alice') => { const stored = await repository.get('users', hash(user)); return app({ action, ...(action === 'recordAccountVisit' ? { spaceId: stored?.activeMode === 'personal' ? stored.personalSpaceId : stored?.familyId } : {}), ...payload }, { OPENID: user }); };
  return { repository, call, time: value => { time = Date.parse(value); } };
}
test('first completed visit is 1; legacy bootstrap does not accrue or fabricate past days', async () => {
  const f = fixture();
  assert.equal((await f.call('recordAccountVisit')).code, 'NO_FAMILY');
  assert.equal(await f.repository.get('users', hash('alice')), null);
  await f.call('createFamily', { name: 'Alice', familyName: 'Home' });
  await f.call('bootstrap');
  const before = await f.repository.get('users', hash('alice'));
  assert.equal(before.companionVisit, undefined);
  const visit = (await f.call('recordAccountVisit')).data;
  assert.equal(visit.days, 1); assert.equal(visit.lastDay, '2026-11-09');
  const after = await f.repository.get('users', hash('alice'));
  delete after.companionVisit; delete after.companionFamilyVisits; assert.deepEqual(after, before);
});
test('concurrent devices, reloads and retries count once; server Beijing midnight and skipped dates', async () => {
  const f = fixture(); await f.call('createFamily', { name: 'Alice', familyName: 'Home' });
  const results = await Promise.all(Array.from({ length: 20 }, () => f.call('recordAccountVisit', { days: 999, date: '2030-01-01', userId: hash('bob') })));
  assert.ok(results.every(r => r.ok && r.data.days === 1));
  f.time('2026-11-09T16:00:00Z');
  assert.equal((await f.call('recordAccountVisit')).data.days, 2);
  f.time('2026-11-15T00:00:00Z');
  await f.call('bootstrap');
  assert.equal((await f.repository.get('users', hash('alice'))).companionVisit.days, 2);
  assert.equal((await f.call('recordAccountVisit')).data.days, 3);
  assert.equal(await f.repository.get('users', hash('bob')), null);
  assert.equal((await f.call('recordAccountVisit', {}, '')).code, 'UNAUTHENTICATED');
});
test('personal/family switches keep the same personal count and preserve every account field', async () => {
  const f = fixture(); await f.call('createFamily', { name: 'Alice', familyName: 'Home' });
  await f.call('recordAccountVisit');
  assert.equal((await f.call('switchWorkspace', { mode: 'personal' })).ok, true);
  assert.equal((await f.call('recordAccountVisit')).data.days, 1);
  f.time('2026-11-10T16:00:00Z');
  assert.equal((await f.call('recordAccountVisit')).data.days, 2);
  assert.equal((await f.call('switchWorkspace', { mode: 'family' })).ok, true);
  assert.equal((await f.call('recordAccountVisit')).data.days, 2);
  await f.call('createFamily', { name: 'Bob', familyName: 'Other' }, 'bob');
  assert.equal((await f.call('recordAccountVisit', {}, 'bob')).data.days, 1);
});
function trackerFixture() {
  let time = Date.parse('2026-11-09T10:00:00Z'), calls = 0, shown, handler;
  const cache = new Map();
  const tracker = createAccountVisitTracker({ now: () => time, cache, publish: value => { shown = value; }, invoke: async space => { calls++; return { spaceId: space, ...(handler ? await handler() : { userId: 'alice', days: 1, lastDay: '2026-11-09', serverTime: time }) }; } });
  return { tracker, cache, calls: () => calls, shown: () => shown, advance: ms => { time += ms; }, handle: fn => { handler = fn; } };
}
test('foreground only, waits for onboarding, suppresses same day calls, and restores cached personal value', async () => {
  const f = trackerFixture();
  await f.tracker.identity('alice', 'home', false); await f.tracker.setVisible(true); assert.equal(f.calls(), 0);
  await f.tracker.identity('alice', 'home', true); assert.equal(f.shown(), 1);
  await f.tracker.tick(); await f.tracker.setVisible(false); await f.tracker.setVisible(true);
  await f.tracker.identity('alice', 'home', true); assert.equal(f.calls(), 1);
  await f.tracker.setVisible(false); f.advance(86400000); await f.tracker.tick(); assert.equal(f.calls(), 1);
  f.handle(() => ({ userId: 'alice', days: 2, lastDay: '2026-11-10', serverTime: Date.parse('2026-11-10T10:00:00Z') }));
  await f.tracker.setVisible(true); assert.equal(f.shown(), 2);
});
test('failed writes retry without fabricated count; stale response never contaminates another account', async () => {
  const f = trackerFixture(); f.handle(() => { throw Error('offline'); });
  await f.tracker.identity('alice', 'home', true); await f.tracker.setVisible(true);
  assert.equal(f.shown(), null); await f.tracker.tick(); assert.equal(f.calls(), 1);
  f.advance(31000); let resolve; f.handle(() => new Promise(done => { resolve = done; }));
  const pending = f.tracker.tick(); await Promise.resolve();
  await f.tracker.identity('bob', 'other', false);
  resolve({ userId: 'alice', days: 4, lastDay: '2026-11-09', serverTime: Date.parse('2026-11-09T10:00:00Z') }); await pending;
  assert.equal(f.shown(), null); assert.equal(f.cache.has('bob'), false);
});
test('visible midnight increments and device clock error cannot inflate persisted totals', async () => {
  const f = trackerFixture();
  // Device clock is a day ahead; authoritative server time prevents repeat calls.
  f.advance(86400000);
  f.handle(() => ({ userId: 'alice', days: 7, lastDay: '2026-11-09', serverTime: Date.parse('2026-11-09T15:59:50Z') }));
  await f.tracker.identity('alice', 'home', true); await f.tracker.setVisible(true);
  f.advance(5000); await f.tracker.tick(); assert.equal(f.calls(), 1);
  f.advance(30000); f.handle(() => ({ userId: 'alice', days: 8, lastDay: '2026-11-10', serverTime: Date.parse('2026-11-09T16:00:25Z') }));
  await f.tracker.tick(); assert.equal(f.shown(), 8); assert.equal(f.calls(), 2);
});

test('every mode uses the personal union and another member cannot accrue this user visits', async () => {
  const f = fixture();
  const created = await f.call('createFamily', { name: 'Alice', familyName: 'Home' });
  const familyId = created.data.familyId;
  await f.call('switchWorkspace', { mode: 'personal' });
  assert.equal((await f.call('recordAccountVisit')).data.days, 1);
  let user = await f.repository.get('users', hash('alice'));
  assert.equal(user.companionFamilyVisits, undefined);
  f.time('2026-11-10T10:00:00Z');
  assert.equal((await f.call('recordAccountVisit')).data.days, 2);
  await f.call('switchWorkspace', { mode: 'family' });
  let result = (await f.call('recordAccountVisit')).data;
  assert.equal(result.days, 2); assert.equal(result.personalDays, 2);
  await f.call('switchWorkspace', { mode: 'personal' });
  assert.equal((await f.call('recordAccountVisit')).data.days, 2);
  // Stale requests for a previously active family must not mark the new mode.
  assert.equal((await f.call('recordAccountVisit', { spaceId: familyId })).code, 'CONFLICT');
  await f.call('switchWorkspace', { mode: 'family' });
  const invite = (await f.call('prepareInvite')).data;
  await f.call('joinFamily', { name: 'Bob', token: invite.token }, 'bob');
  assert.equal((await f.call('recordAccountVisit', {}, 'bob')).data.days, 1);
  f.time('2026-11-11T10:00:00Z');
  result = (await f.call('recordAccountVisit')).data;
  assert.equal(result.days, 3); assert.equal(result.personalDays, 3);
  assert.equal((await f.repository.get('users', hash('bob'))).companionVisit.days, 1);
  // Different family entered by this account has its own first day.
  const other = await f.call('createFamily', { name: 'Alice', familyName: 'Second', requestId: 'second-family-visit-test' });
  assert.equal(other.ok, true);
  result = (await f.call('recordAccountVisit')).data;
  assert.equal(result.days, 3); assert.equal(result.personalDays, 3);
  user = await f.repository.get('users', hash('alice'));
  assert.equal(user.companionFamilyVisits, undefined);
});
test('mode switches instantly reuse the one per-user count without a duplicate visit request', async () => {
  const f = trackerFixture();
  f.handle(() => ({ userId: 'alice', days: 7, lastDay: '2026-11-09', personalDays: 7, personalLastDay: '2026-11-09', personalSpaceId: 'personal', serverTime: Date.parse('2026-11-09T10:00:00Z') }));
  await f.tracker.identity('alice', 'home', true); await f.tracker.setVisible(true);
  assert.equal(f.shown(), 7);
  await f.tracker.identity('alice', 'personal', true);
  assert.equal(f.shown(), 7); assert.equal(f.calls(), 1);
  await f.tracker.identity('alice', 'home', true);
  assert.equal(f.shown(), 7); assert.equal(f.calls(), 1);
  await f.tracker.identity('alice', 'second', true); assert.equal(f.calls(), 1);
});
