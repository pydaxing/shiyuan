import { displayImageSettings, imageVersion } from '../domain/image-variants.js';

export function createImageManifests({ now = Date.now, maxEntries = 96 } = {}) {
  const entries = new Map();
  let context = { scope: '' };
  function clear() { entries.clear(); context = { scope: context.scope }; }
  function activate(scope) {
    if (scope === context.scope) return;
    entries.clear(); context = { scope };
  }
  function remember(images, token = context) {
    if (token !== context || !Array.isArray(images)) return;
    for (const image of images) {
      const settings = displayImageSettings[image?.variant];
      if (!settings || typeof image.fileId !== 'string' || !image.fileId.startsWith('cloud://') || image.fileId.length > 1000) continue;
      const version = imageVersion(image.fileId, image.variant);
      if (image.version !== version || !/^https:\/\//.test(image.url || '') || !['image/jpeg', 'image/png', 'image/webp'].includes(image.contentType)
        || !Number.isSafeInteger(image.bytes) || image.bytes <= 0 || image.bytes > settings.maxBytes || !Number.isFinite(image.urlExpiresAt) || image.urlExpiresAt <= now()) continue;
      entries.delete(version);
      entries.set(version, { version, url: image.url, bytes: image.bytes, contentType: image.contentType, urlExpiresAt: Math.min(image.urlExpiresAt, now() + 300000) });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    }
  }
  function get(version) {
    const image = entries.get(version);
    if (!image || image.urlExpiresAt <= now() + 30000) { entries.delete(version); return; }
    entries.delete(version); entries.set(version, image);
    return image;
  }
  return { remember, get, activate, clear, forget: version => entries.delete(version), context: () => context };
}
