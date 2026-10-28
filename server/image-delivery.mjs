export function imageContentType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brands = [bytes.toString('ascii', 8, 12)];
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, bytes.readUInt32BE(0), 128); offset += 4) brands.push(bytes.toString('ascii', offset, offset + 4));
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'image/heic';
  }
  return '';
}

export function createImageSigner(sign, schedule = callback => setTimeout(callback, 0)) {
  let queue = [];
  let scheduled = false;
  const pending = new Map();
  async function flush() {
    scheduled = false;
    const batch = queue.splice(0, 50);
    if (queue.length) enqueue();
    try {
      const results = await sign(batch.map(item => ({ fileID: item.fileId, maxAge: 300 })));
      const indexed = new Map(results.map(result => [result.fileID, result]));
      batch.forEach(item => item.resolve(indexed.get(item.fileId)));
    } catch (error) { batch.forEach(item => item.reject(error)); }
  }
  function enqueue() { if (!scheduled) { scheduled = true; schedule(() => { void flush(); }); } }
  return fileId => {
    if (!pending.has(fileId)) {
      const request = new Promise((resolve, reject) => { queue.push({ fileId, resolve, reject }); enqueue(); }).finally(() => pending.delete(fileId));
      pending.set(fileId, request);
    }
    return pending.get(fileId);
  };
}

export function createImageDelivery({ source, read, upload, commit, remove, sign, withUpload, now = Date.now }) {
  const pending = new Map();
  async function prepare(fileId, record, variant) {
    const image = await source(fileId, record, variant);
    if (image.delivery?.version === 1) return image.delivery;
    const key = `${fileId}:${variant}`;
    if (!pending.has(key)) {
      const execute = async ticket => {
        const bytes = await read(image.fileId, image);
        const candidate = await upload(bytes, ticket);
        let selected;
        try {
          selected = await commit(fileId, variant, image, candidate);
          if (selected?.fileId === candidate.fileId) await ticket.storageTracker?.discard([candidate.fileId]);
          return selected;
        } finally {
          if (selected?.fileId !== candidate.fileId) await remove(candidate.fileId, ticket).catch(() => {});
        }
      };
      const work = Promise.resolve().then(() => withUpload ? withUpload(fileId, record, execute) : execute(record)).finally(() => pending.delete(key));
      pending.set(key, work);
    }
    return pending.get(key);
  }
  async function manifest(fileId, record, variant) {
    const image = await prepare(fileId, record, variant);
    const result = await sign(image.fileId, 300);
    if (!result || result.status !== 0 || !/^https:\/\//.test(result.tempFileURL || '')) {
      throw Object.assign(new Error('图片下载地址暂不可用，请重试'), { code: 'IMAGE_URL' });
    }
    return { url: result.tempFileURL, urlExpiresAt: now() + Math.min(result.maxAge || 300, 300) * 1000, bytes: image.bytes, contentType: image.contentType };
  }
  return { prepare, manifest };
}
