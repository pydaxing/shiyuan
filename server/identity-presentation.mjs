import { canReadMealPost } from './meal-access.mjs';
import { isOfficialPost } from '../src/domain/community-policy.js';
import { DEFAULT_PROFILE_VERSION, profileWithDefaults, defaultAvatarForUser } from '../src/domain/default-profile.js';

// Request-local cache only. Never persist current profile data over meal/recipe history.
export function createIdentityPresentation(db) {
  const pending = new Map();
  const get = (collection, id) => {
    if (typeof id !== 'string' || !id || id.length > 200 || /[/.]/.test(id)) return Promise.resolve(null);
    const key = `${collection}:${id}`;
    if (!pending.has(key)) pending.set(key, db.get(collection, id));
    return pending.get(key);
  };
  const family = async id => {
    const value = await get('families', id);
    return value && value.id === id && !value.deletedAt && value.status !== 'deleted' ? value : null;
  };
  const name = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 60) : fallback;
  async function meal(post, { currentUserId, currentSpaceId, liveImages = false, defaultProfileVersion } = {}) {
    const saved = post.author || {};
    const defaultsEnabled = defaultProfileVersion === DEFAULT_PROFILE_VERSION;
    // A departed/deleted account may have no saved image. A bundled default
    // can be derived from its original ID without reading future private data.
    const historicalDefault = defaultsEnabled ? defaultAvatarForUser(post.authorId) : '';
    const savedIdentity = liveImages && defaultsEnabled && !saved.avatar ? { ...saved, avatar: historicalDefault } : saved;
    const personal = saved.mode === 'personal';
    const source = personal ? await get('users', post.authorId) : await family(post.spaceId);
    if (!source || source.deletedAt || (!personal && (source.kind === 'personal' || (post.mealSharingVersion !== 2 && !source.members?.some(member => member.id === post.authorId))))) return savedIdentity;
    // A family without a custom cover still uses its publisher's current avatar.
    // Resolve only a current member; leaving a family must not expose future profile images.
    const member = !personal && source.members?.find(member => member.id === post.authorId);
    const publisher = liveImages && !personal && !source.cover && member ? await get('users', post.authorId) : null;
    const profile = personal ? source : (publisher && !publisher.deletedAt ? publisher : member);
    const fallback = defaultsEnabled && (personal || member) ? defaultAvatarForUser(post.authorId, profile?.defaultAvatarId) : '';
    const avatar = personal ? source.avatar || fallback : (source.cover || (member ? profile?.avatar || fallback : defaultsEnabled ? saved.avatar || historicalDefault : ''));
    const displayName = defaultsEnabled && personal ? profileWithDefaults(source, post.authorId).name : source.name;
    return { ...saved, name: name(displayName, saved.name), ...(liveImages ? { avatar: avatar || '', currentSpace: post.spaceId === currentSpaceId, currentUser: post.authorId === currentUserId } : {}) };
  }
  async function community(post) {
    if (isOfficialPost(post) || !post.familyId) return post;
    const source = await family(post.familyId);
    if (!source) return post;
    const user = source.kind === 'personal' ? await get('users', source.ownerId) : null;
    const author = source.kind === 'personal'
      ? (user && !user.deletedAt ? name(user.name, post.author) : post.author)
      : name(source.name, post.author);
    // Preserve published media/provenance; only the current display name changes.
    return { ...post, author, ...(post.familySnapshot ? { familySnapshot: { ...post.familySnapshot, name: author } } : {}) };
  }
  async function comment(row) {
    const user = await get('users', row.memberId);
    const presented = user && !user.deletedAt ? { ...row, author: name(user.name, row.author) } : row;
    const target = row.replyToId ? await get('comments', row.replyToId) : null;
    if (!target || target.postId !== row.postId) return presented;
    const recipient = await get('users', target.memberId);
    return recipient && !recipient.deletedAt ? { ...presented, replyToAuthor: name(recipient.name, row.replyToAuthor) } : presented;
  }
  return { meal, community, comment };
}

// An identity hint never grants access by itself: re-read the post and its current
// visibility, then match only that author's current display image, not all media.
export async function canReadCurrentIdentityImage(db, { postId, fileId, userId, variant }) {
  if (typeof postId !== 'string' || !/^[\w-]{1,200}$/.test(postId) || !['avatar', 'card', 'detail', 'cover'].includes(variant)) return false;
  const post = await db.get('meal_posts', postId);
  if (!await canReadMealPost(db, post, userId)) return false;
  const author = await createIdentityPresentation(db).meal(post, { liveImages: true });
  return Boolean(author.avatar && author.avatar === fileId);
}
