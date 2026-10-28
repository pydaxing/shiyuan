import { createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const forbidden = () => { throw Object.assign(new Error('图片维护授权无效或已过期'), { code: 'FORBIDDEN' }); };

export function createImageMaintenance({ repository, prepare, now = Date.now }) {
  return async (event, context = {}) => {
    if (context.OPENID || !/^image-job-[a-f0-9]{32}$/.test(event.jobId || '') || !/^[a-f0-9]{64}$/.test(event.token || '')) forbidden();
    const job = await repository.get('imports', event.jobId);
    if (job?.kind !== 'image_delivery_job_v1' || job.state !== 'active' || !Number.isFinite(job.expiresAt) || job.expiresAt <= now() || !Array.isArray(job.fileIds)
      || !/^[a-f0-9]{64}$/.test(job.tokenHash || '') || !timingSafeEqual(Buffer.from(hash(event.token), 'hex'), Buffer.from(job.tokenHash, 'hex'))) forbidden();
    const fileIds = event.fileIds;
    if (!Array.isArray(fileIds) || !fileIds.length || fileIds.length > 3 || new Set(fileIds).size !== fileIds.length
      || fileIds.some(fileId => typeof fileId !== 'string' || !job.fileIds?.includes(fileId))) forbidden();
    const records = await Promise.all(fileIds.map(async fileId => {
      try { return { fileId, record: await repository.get('media', hash(fileId)) }; }
      catch (error) { return { fileId, error }; }
    }));
    async function processImage({ fileId, record, error }) {
      try {
        if (error) throw error;
        if (!record?.confirmed || record.fileId !== fileId || !record.encryptionKey) throw Object.assign(new Error('图片不存在或需要重新上传'), { code: 'IMAGE_REUPLOAD' });
        for (const variant of ['card', 'detail']) await prepare(fileId, record, variant);
        return { fileId };
      } catch (error) { return { fileId, code: error.code || 'INTERNAL' }; }
    }
    const bounded = records.every(({ record }) => record?.variants?.card?.formatVersion === 1 && record?.variants?.detail?.formatVersion === 1);
    const results = [];
    if (bounded) results.push(...await Promise.all(records.map(processImage)));
    else for (const entry of records) results.push(await processImage(entry));
    return { completed: results.filter(result => !result.code).map(result => result.fileId), failures: results.filter(result => result.code) };
  };
}
