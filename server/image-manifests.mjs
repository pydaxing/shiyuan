import { displayImageSettings, imageVersion } from '../src/domain/image-variants.js';
import { readDocumentResults } from './repository-reads.mjs';
import { createHash } from 'node:crypto';
import { measure } from './performance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function createImageManifestReader({ repository, readImage, now = Date.now, onError = () => {} }) {
  return async function manifests(candidates, authorize) {
    if (!readImage) return [];
    const distinct = new Map();
    for (const candidate of candidates) {
      if (!candidate || !['card', 'detail'].includes(candidate.variant) || typeof candidate.fileId !== 'string' || !candidate.fileId.startsWith('cloud://') || candidate.fileId.length > 1000) continue;
      const key = imageVersion(candidate.fileId, candidate.variant);
      if (!distinct.has(key)) distinct.set(key, candidate);
      if (distinct.size === 6) break;
    }
    const images = [...distinct.values()];
    if (!images.length) return [];
    let expired = false;
    const completed = new Map();
    const ready = () => images.map(image => completed.get(imageVersion(image.fileId, image.variant))).filter(Boolean);
    const work = async () => {
      const records = await readDocumentResults(repository, 'media', images.map(image => hash(image.fileId)));
      if (expired) return [];
      const results = await Promise.all(images.map(async image => {
        try {
          const result = records.get(hash(image.fileId));
          if (result?.error) throw result.error;
          const record = result?.value;
          if (!record?.confirmed || (record.fileId && record.fileId !== image.fileId) || !authorize(record, image)) return null;
          const variant = record.variants?.[image.variant];
          if (variant?.formatVersion !== 1 || variant.delivery?.version !== 1) return null;
          const response = await readImage(image.fileId, record, image.variant, { transport: 'url', preparedOnly: true });
          if (expired || !response || !/^https:\/\//.test(response.url || '') || !Number.isFinite(response.urlExpiresAt) || response.urlExpiresAt <= now()) return null;
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(response.contentType) || !Number.isFinite(response.bytes) || response.bytes <= 0 || response.bytes > displayImageSettings[image.variant].maxBytes) return null;
          const manifest = { fileId: image.fileId, variant: image.variant, version: imageVersion(image.fileId, image.variant), url: response.url, urlExpiresAt: Math.min(response.urlExpiresAt, now() + 300000), bytes: response.bytes, contentType: response.contentType };
          completed.set(manifest.version, manifest);
          return manifest;
        } catch (error) {
          onError(error, { action: 'imageManifests' });
          return null;
        }
      }));
      return results.filter(Boolean);
    };
    let timer;
    return measure('media.manifests', () => Promise.race([
      work().catch(error => { onError(error, { action: 'imageManifests' }); return ready(); }),
      new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(ready()); }, 250); }),
    ]).finally(() => clearTimeout(timer)));
  };
}
