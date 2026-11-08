import { emptySnapshot } from '../src/domain/empty.js';
import { defaultAvatarIdForUser } from '../src/domain/default-profile.js';

export const activeSpaceId = user => user?.activeMode === 'personal' ? user.personalSpaceId || '' : user?.familyId || '';
export const personalSpaceId = userId => `personal-${userId}`;
const fail = (message, code = 'NO_FAMILY') => { throw Object.assign(new Error(message), { code }); };

export async function workspaceMembership(db, userId, knownUser) {
  const user = knownUser || await db.get('users', userId);
  const id = activeSpaceId(user);
  if (!id) fail('请先选择个人使用或创建家庭');
  const family = await db.get('families', id);
  if (!family || family.deletedAt || !family.members?.some(member => member.id === userId)) fail('使用空间已变更，请刷新后重试');
  if (family.kind === 'personal' && (family.ownerId !== userId || id !== personalSpaceId(userId) || user.activeMode !== 'personal')) fail('无权访问个人空间', 'FORBIDDEN');
  if (user.activeMode === 'personal' && family.kind !== 'personal') fail('个人空间无效', 'FORBIDDEN');
  return { user, family };
}

// Family memberships stay in familyId/familyIds. The personal workspace is never
// inserted into that list and never shares the family's recipes or orders.
export async function switchWorkspace({ repository, userId, event, now }) {
  if (!['personal', 'family'].includes(event.mode)) fail('请选择使用方式', 'INVALID');
  return repository.transaction(async db => {
    const user = await db.get('users', userId);
    if (event.expectedSpaceId !== undefined && event.expectedSpaceId !== activeSpaceId(user)) fail('使用空间已变更，请刷新后重试', 'CONFLICT');
    if (event.mode === 'family') {
      const family = user?.familyId ? await db.get('families', user.familyId) : null;
      if (!family || family.kind === 'personal' || family.deletedAt || !family.members.some(member => member.id === userId)) fail('请先创建或加入家庭', 'FAMILY_REQUIRED');
      await db.set('users', userId, { ...user, activeMode: 'family' });
      return;
    }
    const id = personalSpaceId(userId);
    const defaults = { defaultAvatarId: user?.avatar ? '' : defaultAvatarIdForUser(userId, user?.defaultAvatarId) };
    const existing = await db.get('families', id);
    if (!existing) {
      if (!user?.name?.trim()) fail('请先填写昵称', 'INVALID');
      await db.set('families', id, { ...emptySnapshot().family, id, kind: 'personal', name: '我的餐桌', coverTitle: '今天，想吃点什么', coverSubtitle: '', ownerId: userId, members: [{ id: userId, membershipId: id, name: user.name, avatar: user.avatar || '', ...defaults, isChef: false, role: '我' }], revision: 0, createdAt: now() });
    } else if (existing.ownerId !== userId || existing.kind !== 'personal' || existing.deletedAt) fail('个人空间无效', 'FORBIDDEN');
    await db.set('users', userId, { ...user, ...defaults, activeMode: 'personal', personalSpaceId: id });
  });
}
