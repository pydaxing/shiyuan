import { createPersistentCache } from './persistent-cache.js';

function storageError(failure) {
  const detail = failure?.errMsg || failure?.message || String(failure);
  const quota = /maximum size|storage limit|quota|no space|ENOSPC/i.test(detail);
  const error = new Error(quota ? '图片缓存空间不足，请稍后重试' : '图片缓存暂不可用，请重试');
  error.code = quota ? 'CACHE_QUOTA' : 'CACHE_IO';
  error.detail = detail;
  return error;
}

export function createImageStorage(platform) {
  let sequence = 0;
  let initialized;
  let pendingIndex;
  let indexTimer;
  const index = createPersistentCache('shiyuan-image-index-v1', { platform, maxEntries: 1, maxChars: 250000 });
  function ownedPath(path) {
    const root = platform().env.USER_DATA_PATH;
    return typeof path === 'string' && path.startsWith(`${root}/`) && /^shiyuan-cache-photo-[\d-]+\.(jpg|png|webp|heic)$/.test(path.slice(root.length + 1));
  }
  function flushCache() {
    clearTimeout(indexTimer);
    if (!pendingIndex) return;
    index.set('current', pendingIndex);
    pendingIndex = undefined;
  }
  function saveEntries(scope, entries) {
    pendingIndex = { scope, entries };
    clearTimeout(indexTimer);
    indexTimer = setTimeout(flushCache, 200);
  }
  function readEntries(scope) {
    const saved = pendingIndex || index.get('current');
    if (saved?.scope !== scope || !Array.isArray(saved.entries) || !saved.entries.length) return [];
    return saved.entries.filter(entry => {
      if (!entry || !ownedPath(entry.path) || typeof entry.fileId !== 'string' || !Number.isFinite(entry.expiresAt) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) return false;
      return true;
    });
  }
  function removeImage(path) {
    return new Promise((resolve, reject) => platform().getFileSystemManager().unlink({
      filePath: path,
      success: resolve,
      fail: failure => /no such file|not exist|ENOENT/i.test(failure.errMsg || '') ? resolve() : reject(storageError(failure)),
    }));
  }
  function checkImage(path, bytes) {
    if (!ownedPath(path)) return Promise.resolve(false);
    return new Promise(resolve => platform().getFileSystemManager().stat({
      path,
      success: result => resolve(result.stats?.size === bytes),
      fail: () => resolve(false),
    }));
  }
  function initialize() {
    if (!initialized) {
      initialized = (async () => {
        const native = platform();
        const files = native.getFileSystemManager();
        const root = native.env.USER_DATA_PATH;
        const saved = (pendingIndex || index.get('current'))?.entries;
        const retained = new Set(Array.isArray(saved) ? saved.filter(entry => ownedPath(entry?.path)).map(entry => entry.path) : []);
        for (const name of files.readdirSync(root)) {
          if (/^shiyuan-photo-[\d-]+\.jpg$/.test(name) || (/^shiyuan-cache-photo-[\d-]+\.(jpg|png|webp|heic)$/.test(name) && !retained.has(`${root}/${name}`))) await removeImage(`${root}/${name}`);
        }
      })().catch(error => { initialized = undefined; throw error; });
    }
    return initialized;
  }
  function imageSize(image) {
    if (image.localPath) {
      return new Promise((resolve, reject) => platform().getFileSystemManager().stat({
        path: image.localPath,
        success: result => resolve(result.stats.size),
        fail: failure => reject(storageError(failure)),
      }));
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.contentType) || typeof image.base64 !== 'string' || !image.base64.length || image.base64.length > 1400000) throw new Error('图片格式无效');
    return Math.floor(image.base64.length * 3 / 4) - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0);
  }
  async function prepareImage(image) {
    if (!image.url) return image;
    if (!/^https:\/\//.test(image.url) || !['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(image.contentType)
      || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > 30 * 1024 * 1024
      || !Number.isFinite(image.urlExpiresAt) || image.urlExpiresAt <= Date.now()) {
      throw Object.assign(new Error('图片下载地址已过期，请重试'), { code: 'IMAGE_URL' });
    }
    const native = platform();
    const result = await new Promise((resolve, reject) => native.downloadFile({
      url: image.url, timeout: 30000,
      success: resolve,
      fail: cause => reject(Object.assign(new Error('图片下载失败，请检查网络后重试'), { code: 'NETWORK_ERROR', cause })),
    }));
    const localPath = result.tempFilePath;
    try {
      if (result.statusCode !== 200 || !localPath) throw Object.assign(new Error('图片下载失败，请重试'), { code: result.statusCode === 403 ? 'IMAGE_URL' : 'NETWORK_ERROR' });
      const downloaded = { ...image, localPath };
      if (await imageSize(downloaded) !== image.bytes) throw Object.assign(new Error('图片下载不完整，请重试'), { code: 'NETWORK_ERROR' });
      return { ...downloaded, temporary: true };
    } catch (error) {
      if (localPath) await removeImage(localPath).catch(() => {});
      throw error;
    }
  }
  async function releaseImage(image) {
    if (image?.temporary && image.localPath) await removeImage(image.localPath).catch(() => {});
  }
  async function writeImage(image) {
    await imageSize(image);
    await initialize();
    const native = platform();
    const files = native.getFileSystemManager();
    const extension = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[image.contentType] || 'jpg';
    const filePath = `${native.env.USER_DATA_PATH}/shiyuan-cache-photo-${Date.now()}-${++sequence}.${extension}`;
    try {
      await new Promise((resolve, reject) => {
        const callbacks = { success: resolve, fail: failure => reject(storageError(failure)) };
        if (image.localPath) files.copyFile({ srcPath: image.localPath, destPath: filePath, ...callbacks });
        else files.writeFile({ filePath, data: image.base64, encoding: 'base64', ...callbacks });
      });
      return filePath;
    } catch (error) {
      await removeImage(filePath).catch(() => {});
      throw error;
    }
  }
  return { writeImage, removeImage, checkImage, imageSize, prepareImage, releaseImage, readEntries, saveEntries, flushCache };
}
