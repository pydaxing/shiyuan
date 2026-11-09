import { familyMealAvatar } from './identity-presentation.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { MEAL_SLOTS } from '../src/domain/meal-social.js';
import { activeSpaceId, personalSpaceId, workspaceMembership } from './workspaces.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clean = (value, size) => typeof value === 'string' ? value.trim().slice(0, size) : '';
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value))];
const alive = family => family && !family.deletedAt && family.status !== 'deleted' && family.deletion?.status !== 'pending';
export const mealArchiveDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const automaticMealId = (spaceId, orderId) => `meal-${hash(`automatic-meal-v1:${spaceId}:${orderId}`)}`;
// This is the exact ID used by scripts/backfill-completed-meals.mjs, not an
// inference from a name or timestamp. It also identifies its old tombstones.
export const legacyCompletedMealId = (spaceId, orderId) => `meal-${hash(`legacy-completed:${spaceId}:${orderId}`)}`;
const validDate = value => /^20\d{2}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timerCheckpoint = hash('meal-auto-archive-timer-v1');

// These fields are populated only by the authenticated command transaction.
// Capturing the IDs when an arrangement is made avoids assigning old meals to
// a member who joins after that arrangement. Display names are never identity.
export function captureOrderDiaryParticipants(order, family, capturedAt) {
  return { ...order, diaryParticipantsVersion: 1, diaryParticipantUserIds: family.kind === 'personal' ? [family.ownerId] : unique((family.members || []).map(member => member.id)), diaryParticipantsCapturedAt: capturedAt };
}

async function all(db, collection, where, fields) {
  const rows = [];
  let after = '';
  while (true) {
    const page = await db.list(collection, where, { after, limit: 100, ...(fields ? { fields } : {}) });
    rows.push(...page);
    if (page.length < 100) return rows;
    if (rows.length >= 10000) throw Object.assign(new Error('历史餐食较多，请联系管理员完成归档'), { code: 'CAPACITY' });
    after = page.at(-1)._id;
  }
}

function legacyParticipants(order) {
  return unique([order.memberId, ...(order.selections || []).map(selection => selection.memberId), ...(order.items || []).flatMap(item => (item.chosenBy || []).map(member => member.id))]);
}

function ambiguousOldDeletion(posts, order, knownLegacyIds) {
  if (order.diaryParticipantsVersion === 1) return false;
  return posts.some(post => post.status === 'deleted' && !post.orderId && !knownLegacyIds.has(post.id || post._id) && (!post.kind || post.kind === 'plan')
    && (!Number.isFinite(post.deletedAt) || order.date <= mealArchiveDate(post.deletedAt)));
}

export function createMealAutoArchive({ repository, now = Date.now, clock = Date.now }) {
  async function archiveOrder(spaceId, orderId, requiredMemberId) {
    return repository.transaction(async db => {
      const family = await db.get('families', spaceId);
      if (!alive(family)) return { reason: 'space_unavailable' };
      if (requiredMemberId && !family.members?.some(member => member.id === requiredMemberId)) return { reason: 'membership_changed' };
      const rowKey = hash(`${spaceId}:${orderId}`);
      const row = await db.get('orders', rowKey);
      const order = row?.familyId === spaceId && row.value?.id === orderId ? row.value : null;
      if (!order || !validDate(order.date) || order.date >= mealArchiveDate(now()) || ![...MEAL_SLOTS, '宵夜'].includes(order.meal)) return { reason: 'not_due' };
      if (!['pending', 'accepted', 'completed'].includes(order.status) || !order.items?.some(item => item?.recipe?.title)) return { reason: 'cancelled_or_empty' };
      if (order.diaryDeletedAt || order.deletedAt) return { reason: 'deleted' };
      // A surviving pointer is authoritative even if the referenced post was
      // removed by an old server. Never revive an old user deletion.
      if (order.mealPostId) {
        const linked = await db.get('meal_posts', order.mealPostId);
        return { reason: linked?.status === 'published' ? 'already_linked' : 'deleted', postId: order.mealPostId };
      }
      const id = automaticMealId(spaceId, order.id);
      const previous = await db.get('meal_posts', id);
      if (previous) return { reason: previous.status === 'deleted' ? 'deleted' : 'already_archived', postId: id };
      // Use the existing spaceId index, including deleted posts. A status-only
      // lookup would silently recreate a deleted source meal.
      const posts = await all(db, 'meal_posts', { spaceId }, ['id', 'orderId', 'kind', 'status', 'deletedAt']);
      const existing = posts.filter(post => post.orderId === order.id || (post.id || post._id) === legacyCompletedMealId(spaceId, order.id));
      if (existing.some(post => post.status === 'deleted')) return { reason: 'deleted' };
      if (existing.length) return { reason: 'existing_record' };
      const hasUnboundDeletion = posts.some(post => post.status === 'deleted' && !post.orderId);
      const knownLegacyIds = hasUnboundDeletion ? new Set((await all(db, 'orders', { familyId: spaceId })).map(row => legacyCompletedMealId(spaceId, row.value?.id))) : new Set();
      if (ambiguousOldDeletion(posts, order, knownLegacyIds)) return { reason: 'legacy_history_ambiguous' };
      // The automatic default must not override an explicit older choice,
      // including private personal arrangements that predate meal_posts.
      if (['private', 'family'].includes(order.visibility) || order.public === false) return { reason: 'legacy_private' };
      const personal = family.kind === 'personal';
      if (personal && family.id !== personalSpaceId(family.ownerId)) return { reason: 'invalid_personal_space' };
      const candidates = personal ? [family.ownerId] : order.diaryParticipantsVersion === 1 ? unique(order.diaryParticipantUserIds || []) : legacyParticipants(order);
      const participants = [];
      for (const userId of candidates) if (await db.get('users', userId)) participants.push(userId);
      const authorId = personal ? family.ownerId : participants.includes(order.memberId) ? order.memberId : participants[0];
      if (!authorId || !participants.includes(authorId)) return { reason: 'missing_identity' };
      const user = await db.get('users', authorId);
      const member = family.members?.find(item => item.id === authorId);
      const dishes = order.items.filter(item => clean(item?.recipe?.title, 30)).slice(0, 50).map(({ recipe }) => ({ ...(recipe.id ? { recipeId: clean(recipe.id, 100) } : {}), title: clean(recipe.title, 30), image: clean(recipe.image, 1000) }));
      const author = { name: personal ? clean(user?.name || member?.name || '我', 60) : clean(family.name, 60), avatar: clean(personal ? user?.avatar || member?.avatar : familyMealAvatar(family, user || member, authorId), 1000), mode: personal ? 'personal' : 'family', familyIdentityVersion: 1 };
      const images = dishes.map(dish => dish.image).filter(Boolean).slice(0, 9);
      const post = {
        id, spaceId, authorId, author, kind: 'plan', date: order.date, meal: order.meal,
        title: `${order.meal}这样搭配`, dishes, images, orderId: order.id, moodIds: [],
        visibility: 'public', status: 'published', createdAt: now(),
        likeCount: 0, reactionCounts: {}, mealSharingVersion: 2,
        mealContext: personal ? 'personal' : 'family', showMealBadge: true,
        participantUserIds: participants, autoArchived: true, autoArchiveVersion: 1,
        assetIds: unique([...dishes.map(dish => dish.image), author.avatar].filter(image => image.startsWith('cloud://'))),
      };
      await db.set('meal_posts', id, post);
      // Archiving does not claim that anyone pressed “开饭” or change the old
      // order status: old clients continue to understand the same arrangement.
      await db.set('orders', rowKey, { ...row, value: { ...order, mealPostId: id, autoArchivedAt: now() } });
      await db.set('families', spaceId, { ...family, revision: (family.revision || 0) + 1, socialWriteVersion: (family.socialWriteVersion || 0) + 1, updatedAt: now() });
      return { created: true, postId: id };
    });
  }

  async function archiveSpace(spaceId, userId, deadline) {
    if (clock() >= deadline) return { complete: false, created: 0, skipped: { budget_exceeded: 1 }, suppressedOrderIds: [] };
    const start = await repository.get('families', spaceId);
    if (!alive(start) || !start.members?.some(member => member.id === userId)) return { complete: false, created: 0, skipped: { membership_changed: 1 }, suppressedOrderIds: [] };
    const checkpointId = hash(`meal-auto-space-v1:${spaceId}`);
    const checkpoint = await repository.get('requests', checkpointId);
    const date = mealArchiveDate(now());
    if (checkpoint?.date === date && checkpoint.revision === start.revision) return { complete: true, created: 0, skipped: {}, suppressedOrderIds: checkpoint.suppressedOrderIds || [] };
    const orders = await all(repository, 'orders', { familyId: spaceId });
    const result = { complete: true, created: 0, skipped: {}, suppressedOrderIds: [] };
    for (const row of orders) {
      if (clock() >= deadline) {
        result.complete = false;
        result.skipped.budget_exceeded = 1;
        break;
      }
      if (!validDate(row.value?.date) || row.value.date >= date) continue;
      const outcome = await archiveOrder(spaceId, row.value.id, userId);
      if (outcome.created) result.created += 1;
      else result.skipped[outcome.reason] = (result.skipped[outcome.reason] || 0) + 1;
      if (outcome.reason === 'deleted') result.suppressedOrderIds.push(row.value.id);
      if (['membership_changed', 'space_unavailable', 'legacy_history_ambiguous', 'legacy_private', 'missing_identity'].includes(outcome.reason)) result.complete = false;
    }
    await repository.transaction(async db => {
      const current = await db.get('families', spaceId);
      if (result.complete && alive(current) && current.revision === (start.revision || 0) + result.created && current.members?.some(member => member.id === userId)) await db.set('requests', checkpointId, { kind: 'meal_auto_scan_v1', date, revision: current.revision, suppressedOrderIds: result.suppressedOrderIds });
    });
    return result;
  }

  async function archiveForUser(userId, expectedSpaceId, unified = false) {
    // The entire personal/family reconciliation shares one budget. Remaining
    // meals are picked up by the scheduled worker, never invented by the UI.
    const deadline = clock() + 10000;
    const { user, family } = await workspaceMembership(repository, userId);
    if (expectedSpaceId && expectedSpaceId !== family.id) throw Object.assign(new Error('使用空间已变更，请刷新后重试'), { code: 'CONFLICT' });
    const spaces = new Set([family.id]);
    if (unified && family.kind !== 'personal') {
      const personal = await repository.get('families', personalSpaceId(userId));
      if (alive(personal) && personal.kind === 'personal' && personal.ownerId === userId) spaces.add(personal.id);
    }
    if (unified || family.kind === 'personal') {
      for (const id of unique([user.familyId, ...(user.familyIds || [])]).slice(0, 10)) {
        const source = await repository.get('families', id);
        if (alive(source) && source.kind !== 'personal' && source.members?.some(member => member.id === userId)) spaces.add(id);
      }
    }
    const result = { complete: true, created: 0, skipped: {}, suppressedOrderIds: [] };
    for (const id of spaces) {
      const outcome = await archiveSpace(id, userId, deadline);
      result.complete &&= outcome.complete;
      result.created += outcome.created;
      if (id === family.id) result.suppressedOrderIds = outcome.suppressedOrderIds;
      for (const [reason, count] of Object.entries(outcome.skipped)) result.skipped[reason] = (result.skipped[reason] || 0) + count;
    }
    if (activeSpaceId(await repository.get('users', userId)) !== family.id) throw Object.assign(new Error('使用空间已变更，请刷新后重试'), { code: 'CONFLICT' });
    return result;
  }

  // A bounded global scan uses the existing _id index and resumes at its last
  // committed row. The lease prevents overlapping timer invocations; each meal
  // remains independently idempotent if the invocation ends before checkpoint.
  async function runScheduled({ limit = 100, budgetMs = 40000 } = {}) {
    const token = randomUUID();
    const lease = await repository.transaction(async db => {
      const current = await db.get('requests', timerCheckpoint) || {};
      if (current.leaseUntil > now()) return null;
      await db.set('requests', timerCheckpoint, { ...current, kind: 'meal_auto_timer_v1', leaseToken: token, leaseUntil: now() + 120000 });
      return { after: current.after || '' };
    });
    if (!lease) return { busy: true, created: 0, scanned: 0, complete: false };
    const startTime = clock();
    const count = Math.max(1, Math.min(200, Math.floor(limit)));
    const result = { created: 0, scanned: 0, skipped: {}, complete: false };
    let after = lease.after;
    try {
      const rows = await repository.list('orders', {}, { after, limit: count });
      for (const row of rows) {
        if (clock() - startTime >= budgetMs) break;
        const outcome = row.familyId && row.value?.id ? await archiveOrder(row.familyId, row.value.id) : { reason: 'invalid_order' };
        if (outcome.created) result.created += 1;
        else result.skipped[outcome.reason] = (result.skipped[outcome.reason] || 0) + 1;
        after = row._id;
        result.scanned += 1;
      }
      result.complete = result.scanned === rows.length && rows.length < count;
      if (result.complete) after = '';
      return result;
    } finally {
      await repository.transaction(async db => {
        const current = await db.get('requests', timerCheckpoint);
        if (current?.leaseToken === token) await db.set('requests', timerCheckpoint, { kind: 'meal_auto_timer_v1', after, lastRunAt: now(), ...(result.complete ? { completedDate: mealArchiveDate(now()) } : {}), leaseUntil: 0 });
      });
    }
  }
  return { archiveOrder, archiveForUser, runScheduled };
}
