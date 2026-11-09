import { randomUUID } from 'node:crypto';
import { retryTransaction } from './transaction-retry.mjs';
import { activeSpaceId, personalSpaceId } from './workspaces.mjs';

const unavailable = () => Object.assign(new Error('家庭已变更，请重新上传'), { code: 'NO_FAMILY' });

// The family write serializes uploads with deletion, including the time spent
// outside the database while storage creates the encrypted image variants.
export function createFamilyMediaOperations({ repository, now = Date.now }) {
  // Retry only database work, never the storage upload itself. Concurrent photos
  // share the family deletion fence; stagger exhausted SDK transaction retries.
  const transaction = callback => retryTransaction(() => repository.transaction(callback), {
    attempts: 4,
    wait: delay => new Promise(resolve => setTimeout(resolve, delay * 3)),
  });
  async function fence(db, userId, familyId) {
    const [family, user] = await Promise.all([db.get('families', familyId), db.get('users', userId)]);
    if (!family || family.deletedAt || activeSpaceId(user) !== familyId || (family.kind === 'personal' && (family.ownerId !== userId || familyId !== personalSpaceId(userId))) || !family.members.some(member => member.id === userId)) throw unavailable();
    await db.set('families', familyId, { ...family, mediaWriteVersion: (family.mediaWriteVersion || 0) + 1 });
    return family;
  }
  const write = (userId, familyId, callback) => transaction(async db => {
    await fence(db, userId, familyId);
    return callback(db);
  });
  async function store(userId, familyId, produce, commit) {
    const id = `upload-operation-${randomUUID()}`;
    // This lease exceeds kitchen-v2's configured 60-second invocation timeout.
    const operation = { familyId, userId, confirmed: false, uploadFiles: [], uploadInFlightUntil: now() + 90000 };
    await write(userId, familyId, db => db.set('media', id, operation));
    const storageTracker = {
      record: ({ path, fileId }) => transaction(async db => {
        const current = await db.get('media', id);
        if (!current || current.familyDeletionMedia || current.uploadInFlightUntil <= now()) throw unavailable();
        if (typeof path !== 'string' || !path || (fileId !== undefined && (typeof fileId !== 'string' || !fileId.startsWith('cloud://')))) throw new Error('上传追踪信息无效');
        const uploads = [...(current.uploadFiles || [])];
        const index = uploads.findIndex(item => item.path === path);
        // Check membership before beginning each physical upload. Its returned
        // file ID must still be recorded if deletion happened during that I/O.
        if (!fileId) await fence(db, userId, familyId);
        else if (index === -1) throw new Error('上传路径尚未登记');
        const entry = { ...(uploads[index] || {}), path, ...(fileId ? { fileId } : {}) };
        if (index === -1) uploads.push(entry); else uploads[index] = entry;
        await db.set('media', id, { ...current, uploadFiles: uploads, uploadInFlightUntil: now() + 90000 });
      }),
      discard: fileIds => transaction(async db => {
        const current = await db.get('media', id);
        if (!current || current.familyDeletionMedia) return;
        const removed = new Set(fileIds);
        await db.set('media', id, { ...current, uploadFiles: (current.uploadFiles || []).filter(item => !removed.has(item.fileId)) });
      }),
    };
    let stored;
    try {
      stored = await produce(storageTracker);
      await transaction(async db => {
        const current = await db.get('media', id);
        if (!current || current.familyDeletionMedia) throw unavailable();
        await db.set('media', id, { ...current, ...(typeof stored === 'string' ? { fileId: stored } : stored), confirmed: false });
      });
      await transaction(async db => {
        await fence(db, userId, familyId);
        await commit(db, stored);
        await db.remove('media', id);
      });
      return stored;
    } catch (error) {
      // Failure can happen after storage accepted a file, before its response,
      // or while committing metadata. Never drop the durable upload intents.
      try {
        await transaction(async db => {
          const current = await db.get('media', id);
          if (!current || current.familyDeletionMedia) return;
          if (!current.uploadFiles?.length && !stored) await db.remove('media', id);
          else await db.set('media', id, { ...current, ...(typeof stored === 'string' ? { fileId: stored } : stored), confirmed: false, uploadInFlightUntil: 0, abandonedUpload: true });
        });
      } catch {
        // A database outage keeps the original marker and lease recoverable.
      }
      throw error;
    }
  }
  return { write, store };
}
