import { createHash, randomBytes } from 'node:crypto';
import { emptySnapshot } from '../src/domain/empty.js';
import { FAMILY_AVATARS, familyAvatar, familyAppearance } from '../src/domain/family.js';
import { readDocuments } from './repository-reads.mjs';
import { reserveFamilyPublicId, retryFamilyPublicIdAllocation, newFamilyPublicId } from './family-public-id.mjs';
import { createFamilyDeletion, familyDeletionStatus, familyDeletionTombstone } from './family-deletion.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'INVALID') => { const error = new Error(message); error.code = code; throw error; };
const text = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label}需要 1～${max} 个字`); return value.trim(); };
export const userFamilyIds = user => [...new Set([...(user?.familyIds || []), user?.familyId].filter(Boolean))];
export const userProfile = user => ({ name: user?.name || '', avatar: user?.avatar || '' });
export const familyActions = ['createFamily', 'createFamilyWithAppearance', 'createFamilyWithSubtitle', 'joinFamily', 'prepareInvite', 'readInvite', 'listFamilies', 'switchFamily', 'leaveFamily', 'leaveFamilyWithCleanup', 'removeMember', 'deleteFamily', 'deleteFamilyWithCleanup', 'continueFamilyDeletion', 'updateProfile', 'setFamilyHead', 'transferFamilyOwner'];

export async function readFamilyInvitation(db, token, now) {
  if (!/^[a-f0-9]{48}$/.test(token || '')) fail('邀请链接无效', 'INVITE_INVALID');
  const invite = await db.get('invites', hash(token));
  if (!invite || invite.revoked || invite.expiresAt <= now()) fail('邀请已过期，请让家人重新发送', 'INVITE_EXPIRED');
  const family = await db.get('families', invite.familyId);
  if (!family || family.deletedAt || family.ownerId !== invite.createdBy) fail('这个家庭的邀请已失效', 'INVITE_INVALID');
  return { invite, family };
}

export function createFamilyService({ repository, membership, bootstrap, throttle, now, newPublicId = newFamilyPublicId, cleanupMedia }) {
  const continueDeletion = createFamilyDeletion({ repository, now, cleanupMedia });
  async function pendingDeletions(userId, user) {
    const ids = [...new Set(user?.pendingFamilyDeletions || [])];
    const records = await readDocuments(repository, 'families', ids);
    return ids.map(id => records.get(id)).filter(family => family?.deletion?.requestedBy === userId && family.deletion.status === 'pending').map(familyDeletionStatus);
  }
  async function finishDeletion(familyId, userId) {
    let deletion;
    try { deletion = await continueDeletion(familyId, userId); }
    catch (error) {
      if (error.code === 'FORBIDDEN' || error.code === 'INVALID') throw error;
      deletion = familyDeletionStatus(await repository.get('families', familyId));
      if (!deletion || deletion.status === 'complete') throw error;
      deletion = { ...deletion, retryRequired: true };
    }
    return { ...await bootstrap(userId, { includeFeed: false }), deletion };
  }
  async function revokeInvites(db, family) {
    for (const inviteId of [family.inviteId, family.friendInviteToken && hash(family.friendInviteToken)].filter(Boolean)) {
      const invite = await db.get('invites', inviteId);
      if (invite) await db.set('invites', inviteId, { ...invite, revoked: true });
    }
  }
  async function validFamilies(db, userId, user, batch = false) {
    const families = [];
    const ids = userFamilyIds(user);
    const records = batch ? await readDocuments(db, 'families', ids) : null;
    for (const familyId of ids) {
      const family = batch ? records.get(familyId) : await db.get('families', familyId);
      if (family && !family.deletedAt && family.members.some(member => member.id === userId)) families.push(family);
    }
    return families;
  }
  async function removeMembership(db, userId, familyId) {
    const account = await db.get('users', userId);
    const remaining = (await validFamilies(db, userId, account)).filter(family => family.id !== familyId).map(family => family.id);
    await db.set('users', userId, { ...account, familyIds: remaining, familyId: remaining.includes(account?.familyId) ? account.familyId : remaining[0] || '' });
  }
  async function readInvite(db, token) {
    return readFamilyInvitation(db, token, now);
  }
  async function validateAvatar(db, userId, avatar) {
    if (!avatar) return '';
    if (typeof avatar !== 'string' || !avatar.startsWith('cloud://')) fail('请重新选择头像');
    const media = await db.get('media', hash(avatar));
    if (!media?.confirmed || media.userId !== userId || !media.profile) fail('头像不属于当前账号', 'FORBIDDEN');
    return avatar;
  }
  return async function handle(action, event, userId) {
    if (action === 'leaveFamilyWithCleanup') action = 'leaveFamily';
    if (action === 'deleteFamilyWithCleanup') action = 'deleteFamily';
    if (['createFamilyWithAppearance', 'createFamilyWithSubtitle'].includes(action)) {
      if (typeof event.requestId !== 'string' || !/^[\w-]{12,100}$/.test(event.requestId)) fail('请求标识无效');
      action = 'createFamily';
    }
    if (action === 'listFamilies') {
      const user = await repository.get('users', userId);
      const families = await validFamilies(repository, userId, user, true);
      return { profile: userProfile(user), families: families.map(family => ({ id: family.id, publicId: family.publicId || '', name: family.name, cover: family.cover || '', avatar: familyAvatar(family), memberCount: family.members.length, owner: family.ownerId === userId, current: family.id === user?.familyId })), pendingDeletions: await pendingDeletions(userId, user) };
    }
    if (action === 'continueFamilyDeletion') return finishDeletion(event.familyId, userId);
    if (action === 'readInvite') {
      await throttle(userId, 'readInvite', 30);
      const { family } = await readInvite(repository, event.token);
      return { familyName: family.name, familyCover: family.cover || '', memberCount: family.members.length, joined: family.members.some(member => member.id === userId), familyId: family.id };
    }
    if (action === 'prepareInvite') {
      return repository.transaction(async db => {
        const { family } = await membership(db, userId);
        if (family.ownerId !== userId) fail('只有管理员可以邀请家人', 'FORBIDDEN');
        if (event.familyId && family.id !== event.familyId) fail('当前家庭已变更，请重试', 'CONFLICT');
        if (family.friendInviteToken) {
          const previous = await db.get('invites', hash(family.friendInviteToken));
          if (previous && !previous.revoked && previous.expiresAt > now() + 60000 && previous.remaining > 0) return { token: family.friendInviteToken, familyName: family.name, expiresAt: previous.expiresAt };
        }
        const token = randomBytes(24).toString('hex');
        const expiresAt = now() + 86400000;
        if (family.friendInviteToken) {
          const old = await db.get('invites', hash(family.friendInviteToken));
          if (old) await db.set('invites', hash(family.friendInviteToken), { ...old, revoked: true });
        }
        await db.set('invites', hash(token), { familyId: family.id, createdBy: userId, remaining: 19, expiresAt, revoked: false });
        await db.set('families', family.id, { ...family, friendInviteToken: token });
        return { token, familyName: family.name, expiresAt };
      });
    }
    await throttle(userId, 'familyManagement', 20);
    const transact = () => repository.transaction(async db => {
      const user = await db.get('users', userId);
      if (['leaveFamily', 'deleteFamily'].includes(action) && event.familyId) {
        const previous = await db.get('families', event.familyId);
        if (previous?.deletedAt && previous.deletion?.requestedBy === userId) return { deletionFamilyId: previous.id };
      }
      if (action === 'createFamily' || action === 'joinFamily') {
        const families = await validFamilies(db, userId, user);
        if (action === 'createFamily' && !event.requestId && families.some(family => family.id === user?.familyId)) return;
        const name = text(event.name || user?.name || '家人', 16, '昵称');
        const avatar = await validateAvatar(db, userId, event.avatar ?? user?.avatar ?? '');
        let family;
        let invite;
        let inviteKey;
        if (action === 'joinFamily') {
          if (event.token) { ({ family, invite } = await readInvite(db, event.token)); inviteKey = hash(event.token); }
          else {
            if (!/^[A-F0-9]{12}$/.test(event.code || '')) fail('请打开家人发来的邀请卡片');
            inviteKey = hash(event.code);
            invite = await db.get('invites', inviteKey);
            if (!invite || invite.revoked || invite.expiresAt <= now()) fail('邀请码无效或已过期');
            family = await db.get('families', invite.familyId);
            if (!family || family.deletedAt || family.ownerId !== invite.createdBy) fail('邀请码已失效');
          }
          if (family.members.some(member => member.id === userId)) {
            await db.set('users', userId, { ...user, familyId: family.id, familyIds: [...new Set([...families.map(item => item.id), family.id])] });
            return;
          }
          if (family.members.length >= 20 || invite.remaining <= 0) fail('家庭成员已满，请联系管理员');
        } else {
          if (event.requestId && !/^[\w-]{12,100}$/.test(event.requestId)) fail('请求标识无效');
          const cover = event.cover ?? '';
          if (typeof cover !== 'string' || cover.length > 1000 || (cover && !cover.startsWith('cloud://'))) fail('请重新选择家庭封面');
          if (event.coverTitle !== undefined && (typeof event.coverTitle !== 'string' || event.coverTitle.length > 30)) fail('菜单主标题最多 30 个字');
          if (event.coverSubtitle !== undefined && (typeof event.coverSubtitle !== 'string' || event.coverSubtitle.length > 50)) fail('菜单副标题最多 50 个字');
          const { coverTitle, coverSubtitle } = familyAppearance(event);
          const receiptId = event.requestId ? hash(`${userId}:createFamily:${event.requestId}`) : '';
          const receipt = receiptId ? await db.get('requests', receiptId) : null;
          if (receipt) {
            if (receipt.kind === 'retired_family_request_v1') fail('请求已处理，请重新创建家庭', 'CONFLICT');
            const previousAppearance = familyAppearance(receipt);
            if (receipt.name !== event.familyName || (receipt.cover || '') !== cover || previousAppearance.coverTitle !== coverTitle || previousAppearance.coverSubtitle !== coverSubtitle || !families.some(item => item.id === receipt.familyId)) fail('请求已处理，请刷新后重试', 'CONFLICT');
            await db.set('users', userId, { ...user, familyId: receipt.familyId });
            return;
          }
          if (event.familyAvatar !== undefined && !FAMILY_AVATARS.includes(event.familyAvatar)) fail('请选择一个家庭头像');
          family = { ...emptySnapshot().family, id: `family-${now()}-${randomBytes(12).toString('hex')}`, name: text(event.familyName, 20, '家庭名称'), cover, coverTitle, coverSubtitle, avatar: event.familyAvatar || FAMILY_AVATARS[randomBytes(1)[0] % FAMILY_AVATARS.length], ownerId: userId, headMemberId: '', members: [], revision: 0, createdAt: now() };
          family.publicId = await reserveFamilyPublicId(db, family, { now, newId: newPublicId });
          if (cover) {
            const media = await db.get('media', hash(cover));
            if (!event.requestId || !media?.confirmed || media.userId !== userId || media.familyDraftRequest !== event.requestId || media.familyId !== `family-draft-${userId}-${event.requestId}`) fail('封面不属于本次新建家庭，请重新上传', 'FORBIDDEN');
            const { familyDraftRequest, ...image } = media;
            await db.set('media', hash(cover), { ...image, familyId: family.id });
          }
          if (receiptId) await db.set('requests', receiptId, { familyId: family.id, name: event.familyName, cover, coverTitle, coverSubtitle, createdAt: now() });
        }
        if (families.length >= 10) fail('最多加入或创建 10 个家庭');
        family.members.push({ id: userId, membershipId: randomBytes(16).toString('hex'), name, avatar, isChef: false, role: family.ownerId === userId ? '家庭管理员' : '家庭成员' });
        family.revision += 1;
        await db.set('families', family.id, family);
        if (invite) await db.set('invites', inviteKey, { ...invite, remaining: invite.remaining - 1 });
        await db.set('users', userId, { ...user, familyId: family.id, familyIds: [...families.map(item => item.id), family.id], name, avatar, createdAt: user?.createdAt || now() });
        return;
      }
      if (action === 'updateProfile') {
        const name = text(event.name, 16, '昵称');
        const avatar = await validateAvatar(db, userId, event.avatar ?? user?.avatar ?? '');
        const families = await validFamilies(db, userId, user);
        for (const family of families) await db.set('families', family.id, { ...family, members: family.members.map(member => member.id === userId ? { ...member, name, avatar } : member), revision: family.revision + 1 });
        await db.set('users', userId, { ...user, name, avatar, familyIds: families.map(item => item.id), createdAt: user?.createdAt || now() });
        return;
      }
      if (action === 'switchFamily') {
        const target = await db.get('families', event.familyId);
        if (!target || target.deletedAt || !target.members.some(member => member.id === userId)) fail('你不是这个家庭的成员', 'FORBIDDEN');
        await db.set('users', userId, { ...user, familyId: target.id, familyIds: [...new Set([...userFamilyIds(user), target.id])] });
        return;
      }
      let { family } = await membership(db, userId);
      if (event.expectedCurrentFamilyId !== undefined) {
        if (!['leaveFamily', 'deleteFamily'].includes(action)) fail('此操作不支持管理其他家庭');
        if (typeof event.familyId !== 'string' || !event.familyId.trim() || typeof event.expectedCurrentFamilyId !== 'string' || !event.expectedCurrentFamilyId.trim()) fail('请选择要管理的家庭');
        if (family.id !== event.expectedCurrentFamilyId) fail('当前家庭已变更，请重试', 'CONFLICT');
        if (family.id !== event.familyId) {
          family = await db.get('families', event.familyId);
          if (!family || family.deletedAt || !family.members.some(member => member.id === userId)) fail('你已不在这个家庭中', 'FORBIDDEN');
        }
      } else if (event.familyId && family.id !== event.familyId) fail('当前家庭已变更，请重试', 'CONFLICT');
      if (action === 'setFamilyHead') {
        if (family.ownerId !== userId) fail('只有管理员可以设置一家之主', 'FORBIDDEN');
        if (typeof event.memberId !== 'string' || (event.memberId && !family.members.some(member => member.id === event.memberId))) fail('请选择家庭中的成员');
        await db.set('families', family.id, { ...family, headMemberId: event.memberId, revision: family.revision + 1 });
        return;
      }
      const lastMemberLeaving = action === 'leaveFamily' && family.members.length === 1;
      if (action === 'transferFamilyOwner' || (action === 'leaveFamily' && family.ownerId === userId && !lastMemberLeaving)) {
        if (family.ownerId !== userId) fail('只有管理员可以转交管理权', 'FORBIDDEN');
        const autoTransfer = action === 'leaveFamily' && event.successorId === undefined;
        const successor = family.members.find(member => member.id !== userId && (autoTransfer || member.id === event.successorId));
        if (!successor) fail('请选择家庭中的其他成员接任管理员');
        if ((action === 'transferFamilyOwner' || event.expectedOwnerId !== undefined) && event.expectedOwnerId !== userId) fail('管理员信息已变更，请刷新后重试', 'CONFLICT');
        family.ownerId = successor.id;
        family.members = family.members.map(member => ({ ...member, role: member.id === successor.id ? '家庭管理员' : '家庭成员' }));
        await revokeInvites(db, family);
        family.friendInviteToken = ''; family.inviteId = '';
        if (action === 'transferFamilyOwner') {
          await db.set('families', family.id, { ...family, revision: family.revision + 1 });
          return;
        }
      }
      if (action === 'deleteFamily' || lastMemberLeaving) {
        if (action === 'deleteFamily') {
          if (family.ownerId !== userId) fail('只有管理员可以删除家庭', 'FORBIDDEN');
          if (event.confirmName !== family.name) fail('请输入完整家庭名称确认删除');
        }
        for (const member of family.members) {
          await removeMembership(db, member.id, family.id);
        }
        const account = await db.get('users', userId);
        await db.set('users', userId, { ...account, pendingFamilyDeletions: [...new Set([...(account?.pendingFamilyDeletions || []), family.id])] });
        await db.set('families', family.id, familyDeletionTombstone(family, userId, now));
        return { deletionFamilyId: family.id };
      }
      const memberId = action === 'leaveFamily' ? userId : event.memberId;
      if (memberId === family.ownerId) fail('不能移除当前管理员，请先转交管理权');
      if (action === 'removeMember' && family.ownerId !== userId) fail('只有管理员可以移除成员', 'FORBIDDEN');
      if (!family.members.some(member => member.id === memberId)) fail('成员已不在家庭中');
      await removeMembership(db, memberId, family.id);
      await revokeInvites(db, family);
      await db.set('families', family.id, { ...family, headMemberId: family.headMemberId === memberId ? '' : family.headMemberId || '', friendInviteToken: '', inviteId: '', members: family.members.filter(item => item.id !== memberId), revision: family.revision + 1 });
    });
    const result = action === 'createFamily' ? await retryFamilyPublicIdAllocation(repository, transact) : await transact();
    if (result?.deletionFamilyId) return finishDeletion(result.deletionFamilyId, userId);
    return bootstrap(userId, { includeFeed: false });
  };
}
