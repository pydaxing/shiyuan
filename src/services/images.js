import { cloudMode, uploadCloudImage, uploadFamilyCoverDraft, loadImage, peekImage } from './cloud.js';
import { displayImageSettings } from '../domain/image-variants.js';
import { dismissFocusedKeyboard } from './keyboard.js';

let previewSequence = 0;
export async function previewImages(images, current) {
  if (!images.length) return;
  const sequence = ++previewSequence;
  try {
    uni.showLoading?.({ title: '打开大图', mask: false });
    const url = await loadImage(images.includes(current) ? current : images[0], 'original');
    if (sequence !== previewSequence) return;
    if (!url) throw new Error('图片暂时无法预览，请重试');
    uni.hideLoading?.();
    await uni.previewImage({ current: url, urls: [url] });
  } catch (error) { if (sequence === previewSequence) uni.showToast({ title: error.message || '图片加载失败', icon: 'none' }); }
  finally { if (sequence === previewSequence) uni.hideLoading?.(); }
}

export const PHOTO_TARGET_BYTES = 480 * 1024;
export function imageUploadLabel(photo) {
  if (photo?.status === 'done') return '100%';
  if (photo?.status === 'saving') return '99%';
  const progress = photo?.status === 'uploading' ? Number(photo.progress) : 0;
  return `${Number.isFinite(progress) ? Math.max(0, Math.min(99, Math.round(progress))) : 0}%`;
}
const photoPresets = [[1400, 76], [1200, 62], [1000, 50], [800, 40], [640, 30]];
const uploadQueue = [];
let activeUploads = 0;
function scheduleUpload(work) {
  return new Promise((resolve, reject) => {
    uploadQueue.push({ work, resolve, reject });
    drainUploads();
  });
}
function drainUploads() {
  while (activeUploads < 2 && uploadQueue.length) {
    const job = uploadQueue.shift();
    activeUploads += 1;
    Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => { activeUploads -= 1; drainUploads(); });
  }
}

function photoSize(width, height, edge) {
  const ratio = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function discardPhoto(path, original) {
  if (!path || path === original || typeof wx === 'undefined') return;
  try { wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); } catch {}
}

async function photoReady(path, setting) {
  if (!path) return false;
  const file = await uni.getFileInfo({ filePath: path });
  if (!(file.size > 0 && file.size <= setting.maxBytes)) return false;
  const info = await uni.getImageInfo({ src: path });
  return info.width > 0 && info.height > 0 && Math.max(info.width, info.height) <= setting.edge && ['jpg', 'jpeg', 'png'].includes(info.type);
}

async function renderNativePhoto(path, setting, presets) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });
  let photo;
  try {
    photo = canvas.createImage();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('照片读取超时，请重新选择')), 15000);
      photo.onload = () => { clearTimeout(timer); resolve(); };
      photo.onerror = () => { clearTimeout(timer); reject(new Error('无法读取这张照片，请重新选择')); };
      photo.src = path;
    });
    if (!(photo.width > 0 && photo.height > 0)) throw new Error('无法读取照片尺寸，请重新选择');
    for (const [edge, quality] of presets) {
      const { width, height } = photoSize(photo.width, photo.height, edge);
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#faf8f2';
      context.fillRect(0, 0, width, height);
      context.drawImage(photo, 0, 0, width, height);
      let temporary = '';
      try {
        const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, width, height, destWidth: width, destHeight: height, fileType: 'jpg', quality: quality / 100, success: resolve, fail: reject }));
        temporary = result.tempFilePath;
        if (await photoReady(temporary, setting)) { const ready = temporary; temporary = ''; return ready; }
      } finally { discardPhoto(temporary, path); }
    }
    throw new Error('照片处理失败，请重新选择后重试');
  } finally {
    if (photo) { photo.onload = null; photo.onerror = null; }
    canvas.width = 1; canvas.height = 1;
  }
}

export function compressNativePhoto(path, variant) {
  const setting = displayImageSettings[variant] || { edge: 1400, maxBytes: PHOTO_TARGET_BYTES };
  const presets = variant ? [[setting.edge, setting.quality], [setting.edge, 60], [Math.round(setting.edge * .8), 50], [Math.round(setting.edge * .6), 40], [Math.round(setting.edge * .5), 30]] : photoPresets;
  return compressPreparedNativePhoto(path, setting, presets);
}

async function compressPreparedNativePhoto(path, setting, presets) {
  let info;
  try { info = await uni.getImageInfo({ src: path }); }
  catch { throw new Error('无法读取这张照片，请重新选择'); }
  if (!(info.width > 0 && info.height > 0)) throw new Error('无法读取照片尺寸，请重新选择');
  for (let index = 0; index < presets.length; index += 1) {
    const [edge, quality] = presets[index];
    let temporary = '';
    try {
      const { width, height } = photoSize(info.width, info.height, edge);
      const result = await uni.compressImage({ src: path, quality, compressedWidth: width, compressedHeight: height });
      temporary = result.tempFilePath;
      if (await photoReady(temporary, setting)) { const ready = temporary; temporary = ''; return ready; }
    } catch {}
    finally { discardPhoto(temporary, path); }
    if (index === 0 && typeof wx !== 'undefined' && wx.createOffscreenCanvas && wx.canvasToTempFilePath) {
      try { return await renderNativePhoto(path, setting, presets); } catch {}
    }
  }
  throw new Error('照片处理失败，请重新选择后重试');
}

export async function chooseLocalImage(sourceType = ['album', 'camera'], onProgress, prepare, familyDraftRequest = '') {
  if (!prepare && !familyDraftRequest) return (await chooseLocalImages(1, sourceType, onProgress))[0] || '';
  const paths = await selectImagePaths(1, sourceType);
  if (!paths.length) return '';
  const preview = prepare ? await prepare(paths[0]) : undefined;
  if (prepare && !preview) return '';
  return (await persistSelectedImages(paths, onProgress, [preview], familyDraftRequest))[0] || '';
}

export async function chooseLocalImages(count = 9, sourceType = ['album', 'camera'], onProgress = () => {}) {
  return persistSelectedImages(await selectImagePaths(count, sourceType), onProgress);
}

export async function selectImagePaths(count = 1, sourceType = ['album', 'camera']) {
  const limit = Math.min(9, Math.max(0, Math.floor(Number(count) || 0)));
  if (!limit) return [];
  const sources = ['camera', 'album'].filter(source => sourceType.includes(source));
  if (!sources.length) throw new Error('请选择拍照或从相册选图');
  let source = sources[0];
  dismissFocusedKeyboard();
  try {
    if (sources.length > 1) {
      const choice = await uni.showActionSheet({ itemList: sources.map(item => item === 'camera' ? '拍照' : '从相册选择') });
      source = sources[choice.tapIndex];
      if (!source) return [];
    }
  } catch (error) {
    if (/cancel/i.test(error?.errMsg || error?.message || '')) return [];
    throw new Error('无法打开图片选择菜单，请重试');
  }
  const requestedCount = source === 'camera' ? 1 : limit;
  try {
    // Use the native image-only media picker on WeChat. Keep chooseImage for
    // other platforms and older clients that do not expose chooseMedia.
    const nativeMedia = typeof wx !== 'undefined' && typeof wx.chooseMedia === 'function';
    const selected = nativeMedia
      ? await new Promise((resolve, reject) => wx.chooseMedia({
        count: requestedCount, mediaType: ['image'], sizeType: ['original'],
        sourceType: [source], success: resolve, fail: reject,
      }))
      : await uni.chooseImage({ count: requestedCount, sizeType: ['original'], sourceType: [source] });
    const paths = nativeMedia ? selected.tempFiles?.map(file => file.tempFilePath) : selected.tempFilePaths;
    return (paths || []).filter(Boolean).slice(0, requestedCount);
  } catch (error) {
    const reason = error?.errMsg || error?.message || String(error);
    if (/cancel/i.test(reason)) return [];
    let message;
    if (/privacy|隐私/i.test(reason)) {
      message = '图片选择未获隐私授权，请检查小程序隐私声明并完成授权';
    } else if (/auth deny|authorize.*fail|permission|denied/i.test(reason)) {
      message = source === 'camera' ? '无法打开相机，请检查微信和系统的相机权限后重试' : '无法打开相册，请检查照片访问权限后重试';
    } else {
      message = source === 'camera' ? '无法打开相机，请重试' : '无法打开相册，请重试';
    }
    // Preserve provider diagnostics instead of labelling every failure as denial.
    throw new Error(`${message}（${reason}）`, { cause: error });
  }
}

export async function persistSelectedImages(paths, onProgress = () => {}, previews = [], familyDraftRequest = '') {
  const images = new Array(paths.length);
  let completed = 0;
  let failure;
  const items = paths.map(path => ({ path, preview: '', status: 'waiting', image: '', error: '' }));
  const progress = () => onProgress({ completed, total: paths.length, items: items.map(item => ({ ...item })) });
  progress();
  await Promise.all(paths.map((path, index) => scheduleUpload(async () => {
      items[index].status = 'processing';
      progress();
      try {
        images[index] = await persistImage(path, update => { Object.assign(items[index], update); progress(); }, previews[index], familyDraftRequest);
        items[index] = { ...items[index], preview: peekImage(images[index]) || '', status: 'done', image: images[index], error: '' };
        completed += 1;
      }
      catch (error) { failure ||= error; items[index] = { ...items[index], preview: '', status: 'failed', image: '', error: error.message }; }
      progress();
  })));
  if (failure) { failure.images = images.filter(Boolean); failure.failedPaths = items.filter(item => item.status === 'failed').map(item => item.path); throw failure; }
  return images;
}

async function persistImage(path, onStage = () => {}, prepared = {}, familyDraftRequest = '') {
  if (typeof document !== 'undefined') return persistBrowserImage(prepared.previewPath || path);
  if (cloudMode) {
    const file = await uni.getFileInfo({ filePath: path });
    if (file.size > 30 * 1024 * 1024) throw new Error('单张原图最大支持 30MB，请选择较小的照片');
    let previewPath;
    let cardPath;
    try {
      previewPath = await compressNativePhoto(prepared.previewPath || path, 'detail');
      cardPath = await compressNativePhoto(previewPath, 'card');
      onStage({ preview: cardPath, status: 'uploading', progress: 0 });
      return familyDraftRequest
        ? await uploadFamilyCoverDraft(path, familyDraftRequest, { previewPath, cardPath, onStage })
        : await uploadCloudImage(path, { previewPath, cardPath, onStage });
    } finally {
      discardPhoto(cardPath, path);
      if (previewPath !== cardPath) discardPhoto(previewPath, path);
    }
  }
  try {
    const compressed = await compressNativePhoto(prepared.previewPath || path);
    const saved = await uni.saveFile({ tempFilePath: compressed });
    return saved.savedFilePath;
  } catch (error) {
    throw new Error('照片保存失败，请检查本机空间后重试');
  }
}

async function persistBrowserImage(path) {
  const photo = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('无法读取这张图片，请选择 JPG、PNG 或 WebP'));
    image.src = path;
  });
  const canvas = document.createElement('canvas');
  if (!(photo.naturalWidth > 0 && photo.naturalHeight > 0)) throw new Error('无法读取照片尺寸，请重新选择');
  try {
    for (const [edge, quality] of photoPresets) {
      const { width, height } = photoSize(photo.naturalWidth, photo.naturalHeight, edge);
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('当前浏览器不支持图片处理');
      context.fillStyle = '#faf8f2';
      context.fillRect(0, 0, width, height);
      context.drawImage(photo, 0, 0, width, height);
      const result = canvas.toDataURL('image/jpeg', quality / 100);
      if (result.startsWith('data:image/jpeg;base64,') && result.length <= 480000) return result;
    }
    throw new Error('照片处理失败，请重新选择后重试');
  } finally {
    canvas.width = 1; canvas.height = 1;
  }
}
