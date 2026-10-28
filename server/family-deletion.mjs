import { snapshotFamilyPublicIdentity, postFamilySnapshot, familySnapshotAssetIds } from '../src/domain/family-public-snapshot.js';

const PRIVATE_COLLECTIONS = ['recipes', 'meal_sets', 'orders', 'inventory', 'purchases', 'invites', 'shares', 'requests'];
const BATCH_SIZE = 25;
const fail = (message, code = 'INVALID') => { throw Object.assign(new Error(message), { code }); };

export function familyDeletionTombstone(family, userId, now) {
  return {
    id: family.id,
    ...(family.publicId ? { publicId: family.publicId } : {}),
    members: [],
    deletedAt: now(),
    revision: family.revision + 1,
    publicIdentity: snapshotFamilyPublicIdentity(family),
    deletion: { version: 1, requestedBy: userId, status: 'pending', phase: 'public', collectionIndex: 0, deletedDocuments: 0 },
  };
}

export function familyDeletionStatus(family) {
  if (!family?.deletedAt || family.deletion?.version !== 1) return null;
  return {
    familyId: family.id,
    status: family.deletion.status,
    phase: family.deletion.phase,
    privateDataCleared: ['media', 'complete'].includes(family.deletion.phase),
    deletedDocuments: family.deletion.deletedDocuments || 0,
    ...(family.deletion.mediaSummary ? { media: family.deletion.mediaSummary } : {}),
  };
}

// The family document is both the write fence and the durable cleanup cursor.
// Every bounded batch reads it transactionally, so competing continuations do
// not double-decrement counters or skip records after a failed write.
export function createFamilyDeletion({ repository, now = Date.now, cleanupMedia, maxBatches = 30, maxDurationMs = 8000 }) {
  const authorized = (family, userId) => {
    if (!family?.deletedAt || family.deletion?.version !== 1 || family.deletion.requestedBy !== userId) fail('无权清理这个家庭', 'FORBIDDEN');
  };

  async function publicBatch(db, family) {
    const state = { ...family.deletion };
    const rows = await db.list('posts', { familyId: family.id, status: 'published' }, { limit: BATCH_SIZE, after: state.after || '' });
    for (const post of rows) {
      const familySnapshot = postFamilySnapshot(post, family.publicIdentity);
      if (!familySnapshot) continue;
      state.publicIdentityUsed = true;
      await db.set('posts', post._id, { ...post, familySnapshot, assetIds: [...new Set([...(post.assetIds || []), ...familySnapshotAssetIds(familySnapshot)])], ...(post.card ? { card: { ...post.card, familySnapshot } } : {}) });
    }
    state.after = rows.at(-1)?._id || state.after || '';
    if (rows.length < BATCH_SIZE) { state.phase = 'private'; delete state.after; }
    return state;
  }

  async function privateBatch(db, family) {
    const state = { ...family.deletion };
    const collection = PRIVATE_COLLECTIONS[state.collectionIndex];
    if (!collection) return { ...state, phase: 'imports', after: '' };
    const rows = await db.list(collection, { familyId: family.id }, { limit: BATCH_SIZE });
    for (const row of rows) {
      if (collection === 'requests') {
        // Keep only an opaque anti-replay marker. Removing the creation receipt
        // would allow a delayed, previously accepted create request to make a
        // new family after the original family was deleted.
        await db.set('requests', row._id, { kind: 'retired_family_request_v1' });
      } else await db.remove(collection, row._id);
    }
    state.deletedDocuments += rows.length;
    if (rows.length < BATCH_SIZE) state.collectionIndex += 1;
    return state;
  }

  async function importBatch(db, family) {
    const state = { ...family.deletion };
    const rows = await db.list('imports', { familyId: family.id }, { limit: BATCH_SIZE, after: state.after || '' });
    for (const row of rows) {
      if (row.kind) continue; // Global source/review jobs are public provenance.
      if (typeof row.postId !== 'string' || !row.postId) fail('家庭收藏记录格式异常，请联系管理员', 'CLEANUP_DATA_INVALID');
      const post = await db.get('posts', row.postId);
      if (post) {
        const importedFamilyCount = Math.max(0, (Number.isSafeInteger(post.importedFamilyCount) ? post.importedFamilyCount : 0) - 1);
        await db.set('posts', row.postId, { ...post, importedFamilyCount, ...(post.card ? { card: { ...post.card, importedFamilyCount } } : {}) });
      }
      await db.remove('imports', row._id);
      state.deletedDocuments += 1;
    }
    state.after = rows.at(-1)?._id || state.after || '';
    if (rows.length < BATCH_SIZE) { state.phase = 'posts'; delete state.after; }
    return state;
  }

  async function postBatch(db, family) {
    const state = { ...family.deletion };
    const post = state.postId ? await db.get('posts', state.postId) : (await db.list('posts', { familyId: family.id, status: 'deleted' }, { limit: 1 }))[0];
    if (!post) {
      if (state.postId) { delete state.postId; delete state.postCollection; return state; }
      state.phase = 'media'; return state;
    }
    if (post.familyId !== family.id || post.status !== 'deleted') fail('帖子归属已变化，请联系管理员', 'CLEANUP_DATA_INVALID');
    state.postId = post._id;
    state.postCollection ||= 'comments';
    const rows = await db.list(state.postCollection, { postId: post.id || post._id }, { limit: BATCH_SIZE });
    for (const row of rows) await db.remove(state.postCollection, row._id);
    state.deletedDocuments += rows.length;
    if (rows.length < BATCH_SIZE) {
      if (state.postCollection === 'comments') state.postCollection = 'reports';
      else {
        await db.remove('posts', post._id);
        state.deletedDocuments += 1;
        delete state.postId; delete state.postCollection;
      }
    }
    return state;
  }

  async function complete(familyId, userId, media) {
    return repository.transaction(async db => {
      const family = await db.get('families', familyId);
      authorized(family, userId);
      if (family.deletion.status === 'complete') return familyDeletionStatus(family);
      if (family.deletion.phase !== 'media') fail('家庭数据尚未清理完成', 'CLEANUP_PENDING');
      const account = await db.get('users', userId);
      if (account) await db.set('users', userId, { ...account, pendingFamilyDeletions: (account.pendingFamilyDeletions || []).filter(id => id !== familyId) });
      const mediaSummary = Object.fromEntries(['deletedRecords', 'deletedFiles', 'retainedRecords'].map(key => [key, Number.isSafeInteger(media?.[key]) ? media[key] : 0]));
      const next = { ...family, deletion: { version: 1, requestedBy: userId, status: 'complete', phase: 'complete', deletedDocuments: family.deletion.deletedDocuments || 0, mediaSummary, completedAt: now() } };
      await db.set('families', familyId, next);
      return familyDeletionStatus(next);
    });
  }

  return async function continueDeletion(familyId, userId) {
    if (typeof familyId !== 'string' || !familyId || familyId.length > 200) fail('请选择要清理的家庭');
    const deadline = Date.now() + maxDurationMs;
    for (let batch = 0; batch < maxBatches && Date.now() < deadline; batch += 1) {
      const status = await repository.transaction(async db => {
        const family = await db.get('families', familyId);
        authorized(family, userId);
        if (family.deletion.status === 'complete' || family.deletion.phase === 'media') return familyDeletionStatus(family);
        let deletion;
        if (family.deletion.phase === 'public') deletion = await publicBatch(db, family);
        else if (family.deletion.phase === 'private') deletion = await privateBatch(db, family);
        else if (family.deletion.phase === 'imports') deletion = await importBatch(db, family);
        else if (family.deletion.phase === 'posts') deletion = await postBatch(db, family);
        else fail('家庭清理进度异常，请联系管理员', 'CLEANUP_DATA_INVALID');
        const next = { ...family, deletion };
        if (family.deletion.phase === 'public' && deletion.phase === 'private' && !deletion.publicIdentityUsed) delete next.publicIdentity;
        await db.set('families', familyId, next);
        return familyDeletionStatus(next);
      });
      if (status.status === 'complete') return status;
      if (status.phase === 'media') {
        if (!cleanupMedia || Date.now() >= deadline) return status;
        const media = await cleanupMedia(familyId, { deadline });
        return media?.complete === true ? complete(familyId, userId, media) : { ...status, ...(media?.reason ? { reason: media.reason, retryRequired: media.reason !== 'UPLOAD_IN_FLIGHT' } : {}) };
      }
    }
    const family = await repository.get('families', familyId);
    authorized(family, userId);
    return familyDeletionStatus(family);
  };
}

