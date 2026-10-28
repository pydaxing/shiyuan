export const DEFAULT_FAMILY_COVER = '/static/family-home-default.jpg';
export const FAMILY_APPEARANCE_DEFAULTS = Object.freeze({ name: '我们的小家', cover: '', coverTitle: '都是我喜欢的味道！', coverSubtitle: '一日三餐四季，都要好好吃饭' });

export const isFamilyPublicId = value => typeof value === 'string' && /^sy-[a-z0-9]{6}$/.test(value);

export function familyPublicId(family) {
  if (isFamilyPublicId(family?.publicId)) return family.publicId;
  return isFamilyPublicId(family?.id) ? family.id : '';
}

export function profileNameError(name) {
  return typeof name !== 'string' || !name.trim() || name.trim().length > 16 ? '昵称需要 1～16 个字' : '';
}

export function familyAppearanceFieldErrors(family) {
  const errors = {};
  if (typeof family?.name !== 'string' || !family.name.trim() || family.name.trim().length > 20) errors.name = '家庭名称需要 1～20 个字';
  if (family?.coverTitle !== undefined && (typeof family.coverTitle !== 'string' || family.coverTitle.trim().length > 30)) errors.coverTitle = '菜单主标题最多 30 个字';
  return errors;
}

export function familyAppearance(family = {}) {
  return {
    name: family.name?.trim() || FAMILY_APPEARANCE_DEFAULTS.name,
    cover: family.cover || FAMILY_APPEARANCE_DEFAULTS.cover,
    coverTitle: family.coverTitle?.trim() || FAMILY_APPEARANCE_DEFAULTS.coverTitle,
    coverSubtitle: family.coverSubtitle?.trim() || FAMILY_APPEARANCE_DEFAULTS.coverSubtitle,
  };
}

export const FAMILY_AVATARS = ['garden', 'sunrise', 'table', 'orchard', 'moon', 'tea'].map(name => `/static/family-${name}.png`);

export function familyAvatar(family) {
  if (family?.cover) return family.cover;
  if (FAMILY_AVATARS.includes(family?.avatar)) return family.avatar;
  const identity = family?.id || family?.name || '';
  const index = Array.from(identity).reduce((sum, character) => sum + character.codePointAt(0), 0) % FAMILY_AVATARS.length;
  return FAMILY_AVATARS[index];
}

export function familyMemberRole(family, memberId) {
  return family?.ownerId === memberId ? '管理员' : '家人';
}
