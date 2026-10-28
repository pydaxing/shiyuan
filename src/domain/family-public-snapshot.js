import { FAMILY_AVATARS, familyAvatar, familyPublicId } from './family.js';
import { isOfficialPost } from './community-policy.js';

const publicName = value => typeof value === 'string' && value.trim().length <= 20 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
const cloudAsset = value => typeof value === 'string' && value.length <= 1000 && /^cloud:\/\/[^\s\u0000-\u001f\u007f]+$/.test(value) ? value : '';
const avatarAsset = value => cloudAsset(value) || (FAMILY_AVATARS.includes(value) ? value : '');

function normalizePublicIdentity(value = {}) {
  return {
    name: publicName(value?.name),
    avatar: avatarAsset(value?.avatar),
    cover: cloudAsset(value?.cover),
    publicId: familyPublicId(value),
  };
}

// Only these four fields become part of a public post. Membership, invite tokens,
// account IDs and the internal family ID must never be copied into this snapshot.
export function snapshotFamilyPublicIdentity(family) {
  const identity = normalizePublicIdentity(family);
  if (!family || typeof family !== 'object') return identity;
  identity.avatar = identity.cover || identity.avatar || (family.id || identity.name ? familyAvatar({ id: family.id, name: identity.name }) : '');
  return identity;
}

export function postFamilySnapshot(post, family) {
  // Imported official posts credit their original authors. The household used to
  // administer an import is not the author's household and must not replace it.
  if (isOfficialPost(post)) return undefined;
  for (const existing of [post?.familySnapshot, post?.card?.familySnapshot]) {
    if (publicName(existing?.name)) return normalizePublicIdentity(existing);
  }
  const identity = snapshotFamilyPublicIdentity(family);
  identity.name = publicName(post?.author) || publicName(post?.familyName) || identity.name;
  return identity.name ? identity : undefined;
}

export function familySnapshotAssetIds(snapshot) {
  return [...new Set([cloudAsset(snapshot?.avatar), cloudAsset(snapshot?.cover)].filter(Boolean))];
}
