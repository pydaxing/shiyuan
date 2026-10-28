import { randomUUID } from 'node:crypto';

const unavailable = () => Object.assign(new Error('图片已更新，请重试'), { code: 'FORBIDDEN' });
const leaseEnd = leases => Math.max(0, ...Object.values(leases));

// Lazy variants share their source media document with the deletion worker.
// Starting an upload changes its fingerprint; marking it unconfirmed prevents
// any subsequent upload from starting while its files are being reclaimed.
export function createMediaDerivationOperations({ repository, now = Date.now }) {
  return async function derive(id, source, callback) {
    const operationId = randomUUID();
    const valid = current => current?.confirmed && !current.familyDeletionMedia && current.encryptionKey === source.encryptionKey;
    await repository.transaction(async db => {
      const current = await db.get('media', id);
      if (!valid(current)) throw unavailable();
      const uploadLeases = { ...current.uploadLeases, [operationId]: now() + 90000 };
      await db.set('media', id, { ...current, uploadLeases, uploadInFlightUntil: leaseEnd(uploadLeases) });
    });
    const storageTracker = {
      record: ({ path, fileId }) => repository.transaction(async db => {
        const current = await db.get('media', id);
        if (!valid(current) || !(current.uploadLeases?.[operationId] > now())) throw unavailable();
        if (typeof path !== 'string' || !path || (fileId !== undefined && (typeof fileId !== 'string' || !fileId.startsWith('cloud://')))) throw new Error('上传追踪信息无效');
        const uploadFiles = [...(current.uploadFiles || [])];
        const index = uploadFiles.findIndex(item => item.operationId === operationId && item.path === path);
        if (fileId && index === -1) throw new Error('上传路径尚未登记');
        const entry = { ...(uploadFiles[index] || {}), operationId, path, ...(fileId ? { fileId } : {}) };
        if (index === -1) uploadFiles.push(entry); else uploadFiles[index] = entry;
        const uploadLeases = { ...current.uploadLeases, [operationId]: now() + 90000 };
        await db.set('media', id, { ...current, uploadFiles, uploadLeases, uploadInFlightUntil: leaseEnd(uploadLeases) });
      }),
      discard: fileIds => repository.transaction(async db => {
        const current = await db.get('media', id);
        if (!current || current.familyDeletionMedia) return;
        const removed = new Set(fileIds);
        await db.set('media', id, { ...current, uploadFiles: (current.uploadFiles || []).filter(item => item.operationId !== operationId || !removed.has(item.fileId)) });
      }),
    };
    try { return await callback(storageTracker); }
    finally {
      try {
        await repository.transaction(async db => {
          const current = await db.get('media', id);
          if (!current || current.familyDeletionMedia) return;
          const uploadLeases = { ...current.uploadLeases };
          delete uploadLeases[operationId];
          await db.set('media', id, { ...current, uploadLeases, uploadInFlightUntil: leaseEnd(uploadLeases) });
        });
      } catch { /* The persisted lease expires; known file references remain. */ }
    }
  };
}
