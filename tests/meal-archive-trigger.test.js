import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMealArchiveTrigger, MEAL_ARCHIVE_TRIGGER } from '../server/meal-archive-trigger.mjs';

const now = Date.parse('2026-11-08T00:00:00+08:00');
const token = 'b'.repeat(64);
const tokenHash = createHash('sha256').update(token).digest('hex');
const event = () => ({ Type: 'Timer', TriggerName: MEAL_ARCHIVE_TRIGGER, Message: token, Time: new Date(now).toISOString() });

test('the dedicated timer accepts only its authenticated platform trigger', async () => {
  let called = 0;
  const trigger = createMealArchiveTrigger({ tokenHash, now: () => now, archive: { runScheduled: async () => { called += 1; return { created: 1 }; } } });
  assert.deepEqual(await trigger(event()), { ok: true, data: { created: 1 } });
  assert.equal(called, 1);
});

test('forged, replayed, client-originated and incorrectly configured timer calls cannot write', async () => {
  let called = 0;
  const archive = { runScheduled: async () => { called += 1; } };
  const trigger = createMealArchiveTrigger({ tokenHash, now: () => now, archive });
  const invalidEvents = [undefined, {}, { ...event(), Type: 'timer' }, { ...event(), TriggerName: 'other' }, { ...event(), action: 'archiveMeals' }, { ...event(), Message: '' }, { ...event(), Message: 'a'.repeat(64) }, { ...event(), Message: tokenHash }, { ...event(), Message: { token } }, { ...event(), Time: 'bad' }, { ...event(), Time: new Date(now - 300001).toISOString() }, { ...event(), Time: new Date(now + 30001).toISOString() }];
  for (const value of invalidEvents) await assert.rejects(trigger(value), { code: 'FORBIDDEN' });
  for (const context of [{ OPENID: 'alice' }, { FROM_OPENID: 'alice' }, { UID: 'anonymous' }, { TCB_UUID: 'web' }, { SOURCE: 'wx_client' }, { SOURCE: 'wx_devtools' }, { SOURCE: 'web' }, { SOURCE: 'http' }, { extendedContext: { userId: 'alice' } }]) await assert.rejects(trigger(event(), context), { code: 'FORBIDDEN' });
  for (const hash of [undefined, '', 'incorrect']) await assert.rejects(createMealArchiveTrigger({ tokenHash: hash, now: () => now, archive })(event()), { code: 'ARCHIVE_CONFIG' });
  assert.equal(called, 0);
});

test('a failed scheduled batch propagates failure so platform retries can resume the checkpoint', async () => {
  const trigger = createMealArchiveTrigger({ tokenHash, now: () => now, archive: { runScheduled: async () => { throw new Error('database unavailable'); } } });
  await assert.rejects(trigger(event()), /database unavailable/);
});
