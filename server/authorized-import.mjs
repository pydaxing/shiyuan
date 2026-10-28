import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'FORBIDDEN') => { throw Object.assign(new Error(message), { code }); };

export function createAuthorizedImport({ repository, storeImageBytes, readImportImage, mediaOperations, now = Date.now }) {
  return async function run(event, { userId, family }) {
    if (!/^import-job-[a-f0-9]{32}$/.test(event.jobId || '') || !/^import-task-[a-f0-9]{32}-\d+$/.test(event.taskId || '')) fail('导入任务无效');
    const job = await repository.get('imports', event.jobId);
    if (job?.kind !== 'authorized_import_job_v1' || job.state !== 'active' || job.userId !== userId || job.familyId !== family.id || family.ownerId !== userId || job.expiresAt <= now()) fail('导入授权无效或已到期');
    const token = randomUUID();
    const task = await repository.transaction(async db => {
      const current = await db.get('imports', event.taskId);
      if (current?.kind !== 'authorized_import_task_v1' || current.jobId !== event.jobId || current.expiresAt <= now()) fail('导入任务不属于当前授权');
      if (digest(JSON.stringify(current.payload)) !== current.payloadHash) fail('导入内容摘要不一致');
      if (current.state === 'completed') return current;
      if (current.state === 'running' && current.leaseUntil > now()) fail('导入任务正在执行', 'IMPORT_BUSY');
      const next = { ...current, state: 'running', token, leaseUntil: now() + 120000 };
      await db.set('imports', event.taskId, next);
      return next;
    });
    if (task.state === 'completed') return { completed: true, replay: true };
    const persist = async changes => repository.transaction(async db => {
      const current = await db.get('imports', event.taskId);
      if (current.token !== token || current.payloadHash !== task.payloadHash) fail('导入任务已变更');
      await db.set('imports', event.taskId, { ...current, ...changes });
    });
    try {
      if (task.payload.type === 'images') {
        const assets = task.payload.assets;
        if (!Array.isArray(assets) || !assets.length || assets.length > 8 || new Set(assets.map(asset => asset.uploadHash)).size !== assets.length) fail('图片批次无效', 'INVALID');
        const results = { ...task.results };
        for (let offset = 0; offset < assets.length; offset += 2) {
          const completed = await Promise.allSettled(assets.slice(offset, offset + 2).map(async asset => {
            if (results[asset.uploadHash]) return;
            if (!/^[a-f0-9]{64}$/.test(asset.uploadHash) || asset.rawFileId !== `${job.storageRoot}/${asset.uploadHash}.jpg`) fail('导入图片路径不匹配');
            const bytes = await readImportImage(asset.rawFileId);
            if (digest(bytes) !== asset.uploadHash) fail('导入图片字节不匹配');
            const save = (db, stored) => db.set('media', digest(stored.fileId), { ...stored, userId, familyId: family.id, confirmed: true, createdAt: now(), importJobId: event.jobId, uploadHash: asset.uploadHash });
            const stored = mediaOperations
              ? await mediaOperations.store(userId, family.id, storageTracker => storeImageBytes(bytes, { userId, familyId: family.id, storageTracker }), save)
              : await storeImageBytes(bytes, { userId, familyId: family.id });
            if (!mediaOperations) await save(repository, stored);
            results[asset.uploadHash] = { fileId: stored.fileId, uploadHash: asset.uploadHash, protected: true };
          }));
          await persist({ results, leaseUntil: now() + 120000 });
          const failed = completed.find(result => result.status === 'rejected');
          if (failed) throw failed.reason;
        }
      } else fail('不支持的导入任务', 'INVALID');
      await persist({ state: 'completed', completedAt: now(), leaseUntil: 0, error: null });
      return { completed: true, replay: false };
    } catch (error) {
      await persist({ state: 'failed', leaseUntil: 0, error: { code: error.code || 'INTERNAL', serviceCode: error.errCode || null } });
      throw error;
    }
  };
}
