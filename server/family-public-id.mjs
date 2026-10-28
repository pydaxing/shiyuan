import { randomInt } from 'node:crypto';
import { isFamilyPublicId } from '../src/domain/family.js';

export const FAMILY_PUBLIC_IDS = 'family_public_ids';
const attemptsLimit = 8;
const exhausted = cause => Object.assign(new Error('家庭编号暂时分配失败，请重试', { cause }), { code: 'CAPACITY' });

export const newFamilyPublicId = () => `sy-${randomInt(36 ** 6).toString(36).padStart(6, '0')}`;

export async function reserveFamilyPublicId(db, family, { now = Date.now, newId = newFamilyPublicId, attempts = attemptsLimit } = {}) {
  if (isFamilyPublicId(family.publicId)) return family.publicId;
  if (family.publicId) throw Object.assign(new Error('家庭编号无效，请联系管理员'), { code: 'INVALID' });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const publicId = newId();
    if (!isFamilyPublicId(publicId)) throw new Error('Invalid generated family public ID');
    if (await db.get(FAMILY_PUBLIC_IDS, publicId, { direct: true })) continue;
    try {
      await db.insert(FAMILY_PUBLIC_IDS, publicId, { familyId: family.id, createdAt: now() });
      return publicId;
    } catch (error) {
      if (error.code !== 'DOCUMENT_ALREADY_EXISTS') throw error;
      // A failed insert aborts its transaction; generate again only after that rollback.
      throw Object.assign(new Error('Family public ID was reserved concurrently', { cause: error }), { code: 'FAMILY_PUBLIC_ID_COLLISION', publicId });
    }
  }
  throw exhausted();
}

export async function retryFamilyPublicIdAllocation(repository, work, { attempts = attemptsLimit } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await work(); }
    catch (error) {
      if (error.code !== 'FAMILY_PUBLIC_ID_COLLISION') throw error;
      // Verify the candidate key after rollback: a different unique index is not a code collision.
      if (!await repository.get(FAMILY_PUBLIC_IDS, error.publicId, { direct: true })) throw error.cause;
      if (attempt + 1 === attempts) throw exhausted(error);
    }
  }
  throw exhausted();
}
