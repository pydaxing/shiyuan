export function isTransientMediaError(error) {
  if (['FORBIDDEN', 'UNAUTHENTICATED', 'NO_FAMILY', 'INVALID', 'IMAGE_FORMAT', 'CACHE_IO', 'CACHE_QUOTA'].includes(error?.code)) return false;
  return ['INTERNAL', 'ECONNRESET', 'ETIMEDOUT', 'NETWORK_ERROR', 'IMAGE_URL'].includes(error?.code)
    || /network|timeout|timed out|connection reset|socket hang up|网络|超时/i.test(`${error?.errMsg || ''} ${error?.message || ''}`);
}

export function createMediaBatch(invoke, { schedule = job => setTimeout(job, 12), wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
  let pending = [];
  let scheduled = false;
  async function flush() {
    const batch = pending.splice(0, 6);
    scheduled = false;
    if (pending.length) enqueueFlush();
    try {
      let remaining = batch;
      for (let attempt = 0; remaining.length && attempt < 2; attempt += 1) {
        if (attempt) await wait(350);
        try {
          const result = await invoke('mediaBatch', { images: remaining.map(item => item.request) });
          if (!Array.isArray(result.images) || result.images.length !== remaining.length || result.images.some(image => !image || typeof image.ok !== 'boolean')) throw new Error('图片响应不完整，请重试');
          const retries = [];
          remaining.forEach((item, index) => {
            const image = result.images[index];
            if (image.ok) item.resolve(image.data);
            else if (!attempt && isTransientMediaError(image)) retries.push(item);
            else item.reject(Object.assign(new Error(image.message || '图片加载失败'), { code: image.code }));
          });
          remaining = retries;
        } catch (error) {
          if (!attempt && isTransientMediaError(error)) continue;
          remaining.forEach(item => item.reject(error));
          remaining = [];
        }
      }
    } catch (error) { batch.forEach(item => item.reject(error)); }
  }
  function enqueueFlush() {
    if (scheduled) return;
    scheduled = true;
    schedule(() => { void flush(); });
  }
  return request => new Promise((resolve, reject) => { pending.push({ request, resolve, reject }); enqueueFlush(); });
}
