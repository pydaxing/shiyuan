import { displayImageSettings as settings } from '../src/domain/image-variants.js';
let processor;
let imageWork = Promise.resolve();
async function imageProcessor() {
  processor ||= import('sharp').then(module => {
    module.default.cache(false);
    module.default.concurrency(1);
    return module.default;
  }).catch(cause => {
    const error = new Error('图片处理组件暂不可用，请稍后重试');
    error.code = 'IMAGE_RUNTIME';
    error.imageDiagnostic = String(cause.message).slice(0, 1600);
    throw error;
  });
  return processor;
}

export function createDisplayImage(bytes, variant) {
  const work = imageWork.then(() => renderDisplayImage(bytes, variant));
  imageWork = work.catch(() => {});
  return work;
}

async function renderDisplayImage(bytes, variant) {
  const setting = settings[variant];
  if (!setting) throw new Error('不支持的图片尺寸');
  const sharp = await imageProcessor();
  const source = sharp(bytes, { limitInputPixels: 64000000, sequentialRead: true, failOn: 'error' });
  const metadata = await source.metadata();
  for (const [edge, quality] of [[setting.edge, setting.quality], [setting.edge, 60], [Math.round(setting.edge * 0.8), 50], [Math.min(setting.edge, 640), 45], [Math.min(setting.edge, 480), 35]]) {
    const { data, info } = await source.clone().rotate().resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const unchanged = metadata.format === 'jpeg' && !metadata.exif && !metadata.xmp && !metadata.iptc && !metadata.icc && metadata.width === info.width && metadata.height === info.height && bytes.length < data.length;
    const output = unchanged ? bytes : data;
    if (output.length <= setting.maxBytes) return { bytes: output, width: info.width, height: info.height, size: output.length, contentType: 'image/jpeg' };
  }
  throw new Error('图片预览压缩失败，请使用较小尺寸的照片');
}
