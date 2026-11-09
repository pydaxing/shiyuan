import { activeSpaceId, personalSpaceId } from './workspaces.mjs';

const beijingDay = timestamp => new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
const valid = visit => Number.isSafeInteger(visit?.days) && visit.days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(visit.lastDay || '');
const counted = (visit, day) => valid(visit) && visit.lastDay >= day;
const increment = (visit, day) => counted(visit, day) ? visit : { days: valid(visit) ? visit.days + 1 : 1, lastDay: day };
export function createAccountVisits({ repository, now = Date.now }) {
  function summarize(userId, user, timestamp) {
    const spaceId = activeSpaceId(user), personal = user.companionVisit;
    const scoped = personal;
    return { userId, spaceId, days: scoped.days, lastDay: scoped.lastDay, personalSpaceId: personalSpaceId(userId), personalDays: personal.days, personalLastDay: personal.lastDay, serverTime: timestamp };
  }
  function requireSpace(user, expectedSpaceId) {
    const id = activeSpaceId(user);
    if (!id) throw Object.assign(new Error('请先完成首次进入设置'), { code: 'NO_FAMILY' });
    if (expectedSpaceId !== id) throw Object.assign(new Error('使用空间已变更，请重试'), { code: 'CONFLICT' });
    return id;
  }
  function isCurrent(user, timestamp) {
    const day = beijingDay(timestamp);
    return counted(user.companionVisit, day);
  }
  return async function record(userId, expectedSpaceId) {
    // Dates and totals come only from the server. Old clients and background
    // archive/bootstrap calls never write arrival data.
    const user = await repository.get('users', userId);
    requireSpace(user, expectedSpaceId);
    const timestamp = now();
    if (isCurrent(user, timestamp)) return summarize(userId, user, timestamp);
    return repository.transaction(async db => {
      const current = await db.get('users', userId);
      requireSpace(current, expectedSpaceId);
      const timestamp = now(), day = beijingDay(timestamp);
      if (isCurrent(current, timestamp)) return summarize(userId, current, timestamp);
      const updated = { ...current, companionVisit: increment(current.companionVisit, day) };
      await db.set('users', userId, updated);
      return summarize(userId, updated, timestamp);
    });
  };
}
