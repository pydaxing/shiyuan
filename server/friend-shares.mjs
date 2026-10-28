import { createHash, randomBytes } from 'node:crypto';
import { makeShare } from '../src/domain/sharing.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { clone } from '../src/domain/kitchen.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'INVALID') => { const error = new Error(message); error.code = code; throw error; };

export function createFriendShares({ repository, membership, familyState, imageReferences, persist, bootstrap, now, throttle }) {
  async function read(db, token) {
    if (!/^[a-f0-9]{48}$/.test(token || '')) fail('分享链接无效');
    const share = await db.get('shares', hash(token));
    if (!share || share.revoked || share.expiresAt <= now()) fail('分享已失效，请让家人重新发送', 'SHARE_EXPIRED');
    const family = await db.get('families', share.familyId);
    const creator = family?.members.find(member => member.id === share.createdBy);
    // Legacy members and their shares both omit membershipId. A fresh join gets
    // a new ID, so leaving and rejoining cannot restore an old private link.
    if (!family || family.deletedAt || !creator || (share.membershipId || '') !== (creator.membershipId || '')) fail('分享已失效', 'SHARE_EXPIRED');
    return share;
  }
  async function handle(action, event, userId) {
    if (action === 'readShare') {
      const share = await read(repository, event.token);
      const { familyId, familyItemId, familyKind, publisherId, publisherType, ...post } = share.post;
      return { post };
    }
    if (action === 'createDishShare') {
      await throttle(userId, 'dishShare', 20);
      return repository.transaction(async db => {
        const { family } = await membership(db, userId);
        if (event.familyId && event.familyId !== family.id) fail('家庭已变更，请重试', 'CONFLICT');
        if (!['dish', 'set'].includes(event.kind)) fail('请选择菜品或套餐');
        const snapshot = await familyState(db, family, userId, false, ['recipes', 'mealSets']);
        const item = (event.kind === 'dish' ? snapshot.recipes : snapshot.mealSets).find(entry => entry.id === event.itemId);
        if (!item) fail('菜品或套餐已移除');
        const post = JSON.parse(makeShare(item, snapshot.recipes, family.name, event.kind));
        Object.assign(post, { familyId: family.id, familyItemId: item.id, familyKind: event.kind, publisherId: userId, publisherType: 'user' });
        const token = randomBytes(24).toString('hex');
        post.id = `friend-${hash(token).slice(0, 32)}`;
        const expiresAt = now() + 30 * 86400000;
        const membershipId = family.members.find(member => member.id === userId).membershipId || '';
        await db.set('shares', hash(token), { post, familyId: family.id, createdBy: userId, membershipId, assetIds: imageReferences(post), expiresAt, createdAt: now() });
        return { token, title: post.title, kind: post.kind, image: post.image || '', expiresAt };
      });
    }
    if (action === 'importShare') {
      await throttle(userId, 'importShare', 20);
      await repository.transaction(async db => {
        const { family } = await membership(db, userId);
        if (event.familyId && family.id !== event.familyId) fail('家庭已变更，请重试', 'CONFLICT');
        const share = await read(db, event.token);
        let snapshot = await familyState(db, family, userId, false, ['recipes', 'mealSets']);
        const before = clone(snapshot);
        const actions = createKitchenActions({ getState: () => snapshot, commit: next => { snapshot = next; }, newId: prefix => `${prefix}-${randomBytes(16).toString('hex')}` });
        actions.addCollection({ ...share.post, familyId: share.familyId, publisherId: share.createdBy, publisherType: 'user' });
        await persist(db, before, snapshot, ['recipes', 'mealSets']);
      });
      return bootstrap(userId, { includeFeed: false });
    }
  }
  return { read, handle };
}
