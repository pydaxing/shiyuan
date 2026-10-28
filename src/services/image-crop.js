import { compressNativePhoto } from './images.js';
import { cropPixels } from '../domain/image-crop.js';
import { displayImageSettings } from '../domain/image-variants.js';

function readPhoto(createImage, path) {
  return new Promise((resolve, reject) => {
    const image = createImage();
    const timer = setTimeout(() => { image.onload = null; image.onerror = null; reject(new Error('图片读取超时，请重试')); }, 15000);
    image.onload = () => { clearTimeout(timer); image.onload = null; image.onerror = null; resolve(image); };
    image.onerror = () => { clearTimeout(timer); image.onload = null; image.onerror = null; reject(new Error('无法读取这张照片，请重新选择')); };
    image.src = path;
  });
}

export function releaseCropFile(path, original = '') {
  if (!path || path === original || typeof wx === 'undefined' || /^(data:|blob:)/.test(path)) return;
  try { wx.getFileSystemManager().unlink({ filePath: path, fail() {} }); } catch {}
}

export async function prepareCropSource(original) {
  if (typeof document !== 'undefined') {
    const photo = await readPhoto(() => new Image(), original);
    return { original, preview: original, width: photo.naturalWidth, height: photo.naturalHeight };
  }
  const file = await uni.getFileInfo({ filePath: original });
  if (file.size > 30 * 1024 * 1024) throw new Error('单张原图最大支持 30MB，请选择较小的照片');
  const preview = await compressNativePhoto(original);
  try {
    const info = await uni.getImageInfo({ src: preview });
    return { original, preview, width: info.width, height: info.height };
  } catch (error) { releaseCropFile(preview, original); throw error; }
}

export async function renderImageCrop(source, crop) {
  const rectangle = cropPixels(source, crop);
  const browser = typeof document !== 'undefined';
  if (!browser && (typeof wx === 'undefined' || !wx.createOffscreenCanvas || !wx.canvasToTempFilePath)) throw new Error('当前微信版本不支持调整图片，请升级微信后重试');
  const canvas = browser ? document.createElement('canvas') : wx.createOffscreenCanvas({ type: '2d', width: 1, height: 1 });
  const setting = displayImageSettings.detail;
  try {
    const photo = await readPhoto(() => browser ? new Image() : canvas.createImage(), source.preview);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前设备暂时无法处理图片，请重试');
    for (const [edge, quality] of [[setting.edge, setting.quality], [setting.edge, 65], [768, 55], [640, 45]]) {
      const scale = Math.min(1, edge / Math.max(rectangle.width, rectangle.height));
      const width = Math.max(1, Math.round(rectangle.width * scale));
      const height = Math.max(1, Math.round(rectangle.height * scale));
      canvas.width = width; canvas.height = height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(photo, rectangle.x, rectangle.y, rectangle.width, rectangle.height, 0, 0, width, height);
      if (browser) {
        const result = canvas.toDataURL('image/jpeg', quality / 100);
        if (result.startsWith('data:image/jpeg;base64,') && result.length * .75 <= setting.maxBytes) return result;
      } else {
        const result = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, width, height, destWidth: width, destHeight: height, fileType: 'jpg', quality: quality / 100, success: resolve, fail: reject }));
        try {
          const file = await uni.getFileInfo({ filePath: result.tempFilePath });
          if (file.size > 0 && file.size <= setting.maxBytes) return result.tempFilePath;
        } catch (error) { releaseCropFile(result.tempFilePath); throw error; }
        releaseCropFile(result.tempFilePath);
      }
    }
    throw new Error('照片处理失败，请重新调整后重试');
  } finally { canvas.width = 1; canvas.height = 1; }
}
