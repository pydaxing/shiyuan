import test from 'node:test';
import assert from 'node:assert/strict';
import { ref, nextTick } from 'vue';
import { createPreparedInvitation, familyInvitationContext } from '../src/services/prepared-invitation.js';

const moment = Date.parse('2026-09-11T08:00:00Z');
const invite = (token = 'a') => ({ token: token.repeat(48), expiresAt: moment + 86400000 });
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(context, request) {
  const snapshot = ref({ family: { ownerId: 'alice', members: [{ id: 'alice' }, { id: 'bob' }] } });
  const session = ref({ phase: 'ready', userId: 'alice', familyId: 'home' });
  const timers = new Map();
  let clock = moment;
  let sequence = 0;
  const cache = createPreparedInvitation({
    getContext: () => familyInvitationContext(snapshot.value, session.value), request,
    now: () => clock,
    schedule: (callback, delay) => { const key = ++sequence; timers.set(key, { callback, delay }); return key; },
    cancel: key => timers.delete(key),
  });
  context.after(cache.dispose);
  return { cache, snapshot, session, timers, advance: duration => { clock += duration; } };
}

test('app prewarm and both invitation entries share one request; remount is synchronous', async context => {
  let finish;
  let calls = 0;
  const { cache } = fixture(context, payload => { calls += 1; assert.deepEqual(payload, { familyId: 'home' }); return new Promise(resolve => { finish = resolve; }); });
  const first = cache.resume();
  assert.equal(cache.resume(), first);
  assert.equal(cache.ensure(), first);
  await nextTick();
  assert.equal(cache.busy.value, true);
  finish(invite()); await first;
  const warm = cache.resume();
  assert.equal(cache.prepared.value.token, invite().token);
  assert.equal(cache.busy.value, false);
  await warm;
  assert.equal(calls, 1);
});

test('account, household, ownership and membership changes invalidate cards and stale responses', async context => {
  for (const change of [
    fixture => { fixture.session.value.userId = 'bob'; },
    fixture => { fixture.session.value.familyId = 'parents'; },
    fixture => { fixture.snapshot.value.family.ownerId = 'bob'; },
    fixture => { fixture.snapshot.value.family.members.pop(); },
    fixture => { fixture.session.value.phase = 'onboarding'; },
  ]) {
    const requests = [];
    const current = fixture(context, () => new Promise(resolve => requests.push(resolve)));
    const old = current.cache.resume();
    const rejected = assert.rejects(old, /家庭已变更/);
    await nextTick(); change(current);
    assert.equal(current.cache.prepared.value, null);
    await nextTick(); requests[0](invite());
    await rejected;
    assert.equal(current.cache.prepared.value, null);
    if (requests[1]) { requests[1](invite('b')); await settle(); assert.equal(current.cache.prepared.value.token, invite('b').token); }
    else assert.equal(current.cache.busy.value, false);
  }
});

test('unrelated edits and member sorting do not refetch an invitation', async context => {
  let calls = 0;
  const { cache, snapshot } = fixture(context, async () => { calls += 1; return invite(); });
  await cache.resume();
  snapshot.value.family.name = '新的家名';
  snapshot.value.family.members[0].isChef = true;
  snapshot.value.family.members.reverse();
  await settle();
  assert.equal(calls, 1);
  assert.ok(cache.prepared.value);
});

test('failed and malformed invitations remain retryable without an invalid share token', async context => {
  for (const result of [null, { ...invite(), token: '' }, { ...invite(), expiresAt: moment + 30000 }, new Error('网络不可用')]) {
    let calls = 0;
    const { cache } = fixture(context, async () => {
      if (++calls > 1) return invite();
      if (result instanceof Error) throw result;
      return result;
    });
    await assert.rejects(cache.resume());
    assert.equal(cache.prepared.value, null);
    assert.equal(cache.busy.value, false);
    assert.ok(cache.error.value);
    await cache.ensure();
    assert.equal(cache.error.value, '');
    assert.equal(cache.prepared.value.token, invite().token);
  }
});

test('foreground reuse respects expiry and backgrounding stops renewal timers', async context => {
  let calls = 0;
  const { cache, timers, advance } = fixture(context, async () => { calls += 1; return invite(); });
  await cache.resume();
  assert.equal(timers.size, 1);
  cache.pause();
  assert.equal(timers.size, 0);
  await cache.resume(); assert.equal(calls, 1);
  cache.pause(); advance(16 * 60000);
  await cache.resume(); assert.equal(calls, 2);
  const renewal = [...timers.values()][0];
  advance(renewal.delay); renewal.callback(); await settle();
  assert.equal(calls, 3);
  cache.dispose();
  assert.equal(timers.size, 0);
  assert.equal(cache.prepared.value, null);
});

test('signing out clears a prepared invitation before the next render', async context => {
  const { cache, session } = fixture(context, async () => invite());
  await cache.resume();
  session.value = { phase: 'onboarding', userId: '', familyId: '' };
  assert.equal(cache.prepared.value, null);
  await nextTick();
  assert.equal(cache.busy.value, false);
});
