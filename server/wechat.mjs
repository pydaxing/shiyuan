import cloud from 'wx-server-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { createApplication } from './application.mjs';
import { encryptImage, decryptImage } from './media-encryption.mjs';
import { diagnose, measure } from './performance.mjs';
import { createDisplayImage } from './image-processing.mjs';
import { createImageDelivery, createImageSigner, imageContentType } from './image-delivery.mjs';
import { createImageMaintenance } from './image-maintenance.mjs';
import { createWechatRepository } from './wechat-repository.mjs';
import { createFamilyDeletionMedia } from './family-deletion-media.mjs';
import { uploadTrackedFile, removeTrackedFiles } from './media-upload-tracking.mjs';
import { createMediaDerivationOperations } from './media-derivation-operations.mjs';

process.env.TZ = 'Asia/Shanghai';
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const database = cloud.database();
const privateDeliveryEnabled = process.env.IMAGE_DELIVERY_PRIVATE === '1';

const adapter = handle => createWechatRepository(database, handle);
const deriveMedia = createMediaDerivationOperations({ repository: adapter(database) });
const withMediaUpload = (fileId, record, callback) => deriveMedia(createHash('sha256').update(fileId).digest('hex'), record, storageTracker => callback({ ...record, storageTracker }));

async function signFiles(ids) {
  return Object.fromEntries(ids.map(fileID => [fileID, { protected: true }]));
}

async function readUpload(fileID) {
  const downloaded = await measure('storage.download', () => cloud.downloadFile({ fileID }));
  const record = await adapter(database).get('media', createHash('sha256').update(fileID).digest('hex'));
  const fileContent = record?.encryptionKey ? decryptImage(downloaded.fileContent, record.encryptionKey) : downloaded.fileContent;
  validateImageBytes(fileContent);
  return fileContent;
}

function validateImageBytes(fileContent) {
  if (fileContent.length > 30 * 1024 * 1024) { const error = new Error('单张原图最大支持 30MB，请选择较小的照片'); error.code = 'IMAGE_SIZE'; throw error; }
  if (!imageContentType(fileContent)) { const error = new Error('请选择 JPG、PNG、WebP 或 iPhone HEIC 照片'); error.code = 'IMAGE_FORMAT'; throw error; }
}

async function saveEncryptedImage(fileContent, ticket) {
  const encrypted = encryptImage(fileContent);
  const saved = await uploadTrackedFile(options => measure('storage.upload', () => cloud.uploadFile(options)), { cloudPath: `approved/${ticket.familyId}/${randomUUID()}.bin`, fileContent: encrypted.bytes }, ticket);
  return { fileId: saved.fileID, encryptionKey: encrypted.key };
}

async function storeImage(fileID, ticket, previewFileID) {
  const [fileContent, preview] = await Promise.all([readUpload(fileID), previewFileID ? readUpload(previewFileID) : undefined]);
  if (preview && (preview.length > 480 * 1024 || imageContentType(preview) === 'image/heic')) throw Object.assign(new Error('预览图片无效，请重新选择照片'), { code: 'IMAGE_FORMAT' });
  const saved = await saveImageWithVariants(fileContent, ticket, preview);
  await removeTrackedFiles(options => measure('storage.delete', () => cloud.deleteFile(options)), [fileID, previewFileID], ticket);
  return saved;
}

async function storeImageBytes(fileContent, ticket) {
  validateImageBytes(fileContent);
  return saveImageWithVariants(fileContent, ticket);
}

async function saveVariant(bytes, variant, ticket) {
  const display = await measure(`image.resize.${variant}`, () => createDisplayImage(bytes, variant));
  const saved = await saveEncryptedImage(display.bytes, ticket);
  try {
    const delivery = privateDeliveryEnabled ? await saveDelivery(display.bytes, ticket) : undefined;
    return { ...saved, ...(delivery ? { delivery } : {}), width: display.width, height: display.height, bytes: display.size, formatVersion: 1 };
  } catch (error) {
    await removeTrackedFiles(options => cloud.deleteFile(options), [saved.fileId], ticket);
    throw error;
  }
}

async function saveDelivery(bytes, ticket) {
  if (!privateDeliveryEnabled) throw Object.assign(new Error('须先验证私有存储权限才能启用图片直传'), { code: 'IMAGE_DELIVERY_CONFIG' });
  const contentType = imageContentType(bytes);
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }[contentType];
  if (!extension) throw Object.assign(new Error('图片格式无效'), { code: 'IMAGE_FORMAT' });
  const saved = await uploadTrackedFile(options => measure('storage.delivery.upload', () => cloud.uploadFile(options)), { cloudPath: `delivery/${ticket.familyId}/${randomUUID()}.${extension}`, fileContent: bytes }, ticket);
  return { fileId: saved.fileID, bytes: bytes.length, contentType, version: 1 };
}

async function saveImageWithVariants(bytes, ticket, preview) {
  if (imageContentType(bytes) === 'image/heic' && !preview) throw Object.assign(new Error('请更新小程序后重新选择这张 iPhone 照片'), { code: 'IMAGE_FORMAT' });
  const saved = await saveEncryptedImage(bytes, ticket);
  const variants = {};
  try {
    for (const variant of ['card', 'detail']) variants[variant] = await saveVariant(preview || bytes, variant, ticket);
    return { ...saved, variants, contentType: imageContentType(bytes), bytes: bytes.length };
  } catch (error) {
    await removeTrackedFiles(options => cloud.deleteFile(options), [saved.fileId, ...Object.values(variants).flatMap(item => [item.fileId, item.delivery?.fileId])], ticket);
    throw error;
  }
}

async function imageBytes(fileId, record) {
  if (!record.encryptionKey) { const error = new Error('这张旧图片需要重新上传'); error.code = 'IMAGE_REUPLOAD'; throw error; }
  const downloaded = await measure('storage.download', () => cloud.downloadFile({ fileID: fileId }));
  return decryptImage(downloaded.fileContent, record.encryptionKey);
}

const pendingVariants = new Map();
async function ensureVariant(fileId, record, variant) {
  if (record.variants?.[variant]?.formatVersion === 1) return record.variants[variant];
  const key = `${fileId}:${variant}`;
  if (!pendingVariants.has(key)) {
    const promise = withMediaUpload(fileId, record, async ticket => {
      const candidate = await saveVariant(await imageBytes(fileId, record), variant, ticket);
      let selected;
      try {
        selected = await adapter(database).transaction(async db => {
          const id = createHash('sha256').update(fileId).digest('hex');
          const current = await db.get('media', id);
          if (!current?.confirmed || current.encryptionKey !== record.encryptionKey) throw new Error('图片已更新，请重试');
          if (current.variants?.[variant]?.formatVersion === 1) return current.variants[variant];
          await db.set('media', id, { ...current, variants: { ...current.variants, [variant]: candidate } });
          return candidate;
        });
        if (selected?.fileId === candidate.fileId) await ticket.storageTracker.discard([candidate.fileId, candidate.delivery?.fileId].filter(Boolean));
        return selected;
      } finally {
        if (selected?.fileId !== candidate.fileId) await removeTrackedFiles(options => cloud.deleteFile(options), [candidate.fileId, candidate.delivery?.fileId], ticket);
      }
    }).finally(() => pendingVariants.delete(key));
    pendingVariants.set(key, promise);
  }
  return pendingVariants.get(key);
}

const signImage = createImageSigner(async fileList => (await measure('storage.sign', () => cloud.getTempFileURL({ fileList }))).fileList);
const delivery = createImageDelivery({
  source: (fileId, record, variant) => variant === 'original' ? { ...record, fileId } : ensureVariant(fileId, record, variant),
  read: imageBytes,
  upload: saveDelivery,
  remove: (fileId, ticket) => removeTrackedFiles(options => cloud.deleteFile(options), [fileId], ticket),
  withUpload: withMediaUpload,
  sign: signImage,
  commit: (fileId, variant, source, candidate) => adapter(database).transaction(async db => {
    const id = createHash('sha256').update(fileId).digest('hex');
    const current = await db.get('media', id);
    const image = variant === 'original' ? current : current?.variants?.[variant];
    if (!current?.confirmed || image?.encryptionKey !== source.encryptionKey) throw Object.assign(new Error('图片已更新，请重试'), { code: 'FORBIDDEN' });
    if (image.delivery?.version === 1) return image.delivery;
    await db.set('media', id, variant === 'original' ? { ...current, delivery: candidate } : { ...current, variants: { ...current.variants, [variant]: { ...image, delivery: candidate } } });
    return candidate;
  }),
});

async function readImage(fileId, record, variant = 'original', { transport, preparedOnly = false } = {}) {
  if (preparedOnly) {
    if (!privateDeliveryEnabled || transport !== 'url' || !['card', 'detail'].includes(variant) || record.variants?.[variant]?.formatVersion !== 1 || record.variants[variant].delivery?.version !== 1) return null;
    return delivery.manifest(fileId, record, variant);
  }
  if (transport === 'url' && privateDeliveryEnabled) return delivery.manifest(fileId, record, variant);
  const source = variant === 'original' ? { ...record, fileId } : await ensureVariant(fileId, record, variant);
  const bytes = await imageBytes(source.fileId, source);
  if (bytes.length > 1024 * 1024 || imageContentType(bytes) === 'image/heic') {
    const preview = await ensureVariant(fileId, record, 'detail');
    return { base64: (await imageBytes(preview.fileId, preview)).toString('base64'), contentType: 'image/jpeg', legacyPreview: true };
  }
  return { base64: bytes.toString('base64'), contentType: imageContentType(bytes) };
}

function onError(error, context) {
  console.error('cloud_operation_failed', JSON.stringify({ action: context.action, code: error.code, errCode: error.errCode, name: error.name, imageDiagnostic: error.imageDiagnostic }));
}

const readImportImage = async fileID => (await cloud.downloadFile({ fileID })).fileContent;
let storageMetadata;
async function resolveStoragePath(cloudPath) {
  // The supported metadata API resolves the real storage bucket/file ID without
  // creating a file. Never infer a bucket name from the environment ID.
  if (!storageMetadata) {
    const { default: cloudbase } = await import('@cloudbase/node-sdk');
    storageMetadata = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
  }
  const result = await storageMetadata.getUploadMetadata({ cloudPath });
  const fileId = result?.data?.fileId;
  if (typeof fileId !== 'string' || !fileId.startsWith('cloud://') || !fileId.endsWith(`/${cloudPath}`)) throw new Error('云文件路径解析失败');
  return fileId;
}
const cleanupMedia = createFamilyDeletionMedia({ repository: adapter(database), removeFiles: fileList => cloud.deleteFile({ fileList }), resolveStoragePath });
const application = createApplication({ repository: adapter(database), signFiles, storeImage, storeImageBytes, readImage, readImportImage, cleanupMedia, onError });
const maintainImages = createImageMaintenance({ repository: adapter(database), prepare: delivery.prepare });
let firstInvocation = true;
export async function main(event) {
  if (event?.action === 'prepareImageDelivery') {
    try { return { ok: true, data: await maintainImages(event, cloud.getWXContext()) }; }
    catch (error) { return { ok: false, code: error.code || 'INTERNAL', message: error.code ? error.message : '图片维护暂不可用' }; }
  }
  const first = firstInvocation;
  firstInvocation = false;
  const invoke = () => application(event, cloud.getWXContext());
  return event?.diagnostics === true ? diagnose(invoke, first) : invoke();
}
