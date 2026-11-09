import { orderDiaryParticipants } from './meal-auto-archive.mjs';
import { profileWithDefaults } from '../src/domain/default-profile.js';
import { createIdentityPresentation, familyMealAvatar } from './identity-presentation.mjs';
import { createHash } from 'node:crypto';
import { MEAL_REACTIONS, MEAL_SLOTS, MEAL_MOODS } from '../src/domain/meal-social.js';
import { workspaceMembership } from './workspaces.mjs';
import { canReadMealPost, isSharedFamilyMeal } from './meal-access.mjs';
import { readDocuments } from './repository-reads.mjs';
import { stepImages } from '../src/domain/presentation.js';
import { createMealDishOrigins } from './meal-dish-origin.mjs';
import { mealDiaryCapabilities, authoredFamilyMeal, mealDiaryRelationId, hidePersonalMeal, deleteCanonicalMeal } from './meal-diary-management.mjs';

export const MEAL_POST_COLLECTIONS = ['meal_posts', 'meal_reactions'];
export const mealPostActions = ['mealReceivedLikes', 'mealFeed', 'myMealPosts', 'mealDishDetail', 'publishMeal', 'finishMeal', 'setMealLike', 'setMealReaction', 'setMealVisibility', 'deleteMealPost', 'deleteFamilyMealPost'];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'INVALID') => { throw Object.assign(new Error(message), { code }); };
const recordId = (postId, userId) => hash(`${postId}:${userId}`);
const chinaDate = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const refs = value => [...new Set([...(value.images || []), ...(value.dishes || []).map(dish => dish.image), value.author?.avatar].filter(value => typeof value === 'string' && value.startsWith('cloud://')))];
const visible = (value, max) => typeof value === 'string' ? value.slice(0, max).trim() : '';
const visibilityOf = value => { if (!['public', 'private', 'family'].includes(value)) fail('请选择谁可以看'); return value; };
const dateOf = (value, now) => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value || value > chinaDate(now())) fail('请选择今天或过去的日期');
  return value;
};
const postIdOf = value => { if (typeof value !== 'string' || !/^meal-[a-f0-9]{64}$/.test(value)) fail('餐食记录无效'); return value; };
function cursorOf(value) {
  if (!value) return '';
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) fail('分页标识无效');
  return { createdAt: value.createdAt, id: postIdOf(value.id) };
}

// A meal may refer only to its own order snapshot. In particular, an absent
// legacy recipe ID is never resolved by searching another family's recipe name.
async function mealDishSources(db, post) {
  if (post.kind !== 'plan' || !post.orderId || !post.spaceId) return [];
  const row = await db.get('orders', hash(`${post.spaceId}:${post.orderId}`));
  const order = row?.value;
  if (row?.familyId !== post.spaceId || order?.id !== post.orderId || order.date !== post.date || order.meal !== post.meal || !Array.isArray(order.items)) return [];
  const dishes = Array.isArray(post.dishes) ? post.dishes : [];
  const recipes = order.items.slice(0, 50).map(item => item?.recipe);
  const positional = dishes.length === recipes.length && dishes.every((dish, index) => visible(dish.title, 30) === visible(recipes[index]?.title, 30)
    && (!dish.image || dish.image === recipes[index]?.image));
  return dishes.map((dish, index) => {
    if (dish.recipeId) {
      const matches = recipes.filter(recipe => recipe?.id === dish.recipeId);
      return matches.length === 1 ? matches[0] : null;
    }
    return positional && visible(dish.title, 30) ? recipes[index] : null;
  });
}

function mealDishImage(value, post, additionalImages) {
  const path = visible(value, 1000);
  // Restoring a display reference never expands the meal's persisted asset ACL.
  if (/^\/?static\/[a-zA-Z0-9_/-]+\.(?:png|jpg|jpeg|webp)$/.test(path) && !path.includes('..')) return `/${path.replace(/^\//, '')}`;
  if (post.assetIds?.includes(path) || post.images?.includes(path) || post.dishes?.some(dish => dish.image === path) || additionalImages?.has(path)) return path;
  return '';
}

const mealDishSteps = source => (Array.isArray(source.steps) ? source.steps : []).slice(0, 100);
const mealDishStepImages = step => [...new Set(stepImages(step || {}).map(image => visible(image, 1000)).filter(Boolean))].slice(0, 9);

async function readableMealDishImages(db, source, dish, post, userId) {
  const candidates = [...new Set([dish.image || source.image, ...mealDishSteps(source).flatMap(mealDishStepImages)]
    .map(image => visible(image, 1000)).filter(image => image.startsWith('cloud://') && !mealDishImage(image, post)))];
  const allowed = new Set();
  if (!candidates.length) return allowed;
  const [media, family] = await Promise.all([
    readDocuments(db, 'media', candidates.map(hash), { fields: ['confirmed', 'mealPhoto'] }),
    workspaceMembership(db, userId).then(result => result.family).catch(error => {
      if (['NO_FAMILY', 'FORBIDDEN'].includes(error.code)) return null;
      throw error;
    }),
  ]);
  // Match readMedia: confirmed recipe assets can come from the active source
  // workspace (including its imported order photos) or a published recipe.
  // Meal photos have a separate privacy gate and cannot use recipe publication.
  const eligible = candidates.filter(fileId => media.get(hash(fileId))?.confirmed && !media.get(hash(fileId)).mealPhoto);
  if (family?.id === post.spaceId) return new Set(eligible);
  const eligibleSet = new Set(eligible);
  // Use the existing status + assetIds index. Reuse each published recipe's
  // authorization within this request, and bound concurrent lookups.
  for (let offset = 0; offset < eligible.length; offset += 6) {
    const pending = eligible.slice(offset, offset + 6).filter(fileId => !allowed.has(fileId));
    const pages = await Promise.all(pending.map(fileId => db.list('posts', { status: 'published', assetIds: { contains: fileId } }, { limit: 1, fields: ['assetIds'] })));
    for (const published of pages.flat()) for (const fileId of published.assetIds || []) if (eligibleSet.has(fileId)) allowed.add(fileId);
  }
  return allowed;
}

function mealDishIngredient(item) {
  const name = visible(item?.name, 100);
  const unit = visible(item?.unit, 30);
  const amountText = visible(item?.amountText, 100);
  if (amountText) return { name, quantity: null, unit: '', amountText };
  const raw = item?.quantity;
  const quantity = typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isFinite(quantity)) return { name, quantity, unit };
  // Preserve old literal amounts rather than turning an unknown value into 0.
  const legacyAmount = visible(item?.amount, 100) || [visible(raw, 70), unit].filter(Boolean).join(' ');
  if (legacyAmount && (visible(item?.amount, 100) || visible(raw, 70))) return { name, quantity: null, unit: '', amountText: legacyAmount };
  return { name, quantity: null, unit };
}

function mealDishRecipe(source, dish, post, additionalImages) {
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    id: visible(source.id || dish.recipeId, 100), title: visible(dish.title || source.title, 100),
    image: mealDishImage(dish.image || source.image, post, additionalImages), category: visible(source.category, 30),
    minutes: number(source.minutes), servings: number(source.servings), nutrition: visible(source.nutrition, 3000),
    ingredients: (Array.isArray(source.ingredients) ? source.ingredients : []).slice(0, 100).map(mealDishIngredient),
    steps: mealDishSteps(source).map(step => ({
      title: visible(step?.title, 100), text: visible(step?.text, 5000),
      images: mealDishStepImages(step).map(image => mealDishImage(image, post, additionalImages)).filter(Boolean),
    })),
  };
}

// Public output is an allowlist; private order notes, member IDs, ingredients,
// request receipts and internal workspace IDs never leave this projection.
export function mealPostView(post, relation, userId) {
  return { id: post.id, kind: post.kind, ...(post.mealSharingVersion === 2 ? { mealSharingVersion: 2, mealContext: post.mealContext, showMealBadge: post.showMealBadge === true } : {}), ...(post.mealStarted ? { mealStarted: true } : {}), date: post.date, meal: post.meal, title: post.title, images: post.images || [], dishes: post.dishes || [], author: post.author, moods: MEAL_MOODS.filter(tag => post.moodIds?.includes(tag.id)), visibility: post.visibility, createdAt: post.createdAt, isOwner: post.authorId === userId, ...(post.authorId === userId && post.orderId ? { sourceOrderId: post.orderId } : {}), likeCount: post.likeCount || 0, liked: Boolean(relation?.liked), reactions: MEAL_REACTIONS.map(tag => ({ ...tag, count: post.reactionCounts?.[tag.id] || 0, selected: Boolean(relation?.tags?.includes(tag.id)) })) };
}

export function createMealPostService({ repository, now, throttle, archiveForUser }) {
  async function view(db, post, userId, identity = createIdentityPresentation(db), options = {}, dishOrigin = createMealDishOrigins(db)) {
    // Independent read-only projections run together. No cache survives this request,
    // so a refresh still rechecks current identity, likes and recipe provenance.
    const [relation, author, likeUsers, dishes] = await Promise.all([
      db.get('meal_reactions', recordId(post.id, userId)),
      identity.meal(post, { currentUserId: userId, ...options }),
      options.mealLikesVersion === 1 ? (async () => {
      const likes = [];
      let after = '';
      // Reuse the existing postId/_id index, including legacy reactions.
      // Bound the public name list; counts still cover all endorsements.
      if (post.likeCount > 0) for (let page = 0; page < 10 && likes.length < 100; page += 1) {
        const rows = await db.list('meal_reactions', { postId: post.id }, { after, limit: 100 });
        likes.push(...rows.filter(row => row.liked === true));
        if (rows.length < 100) break;
        after = rows.at(-1)._id || rows.at(-1).id;
      }
      return Promise.all(likes.slice(0, 100).map(async row => {
        const profile = await db.get('users', row.userId);
        return { key: recordId(post.id, row.userId), self: row.userId === userId,
          name: profile && !profile.deletedAt ? profileWithDefaults(profile, row.userId).name : '微信用户' };
      }));
      })() : undefined,
      post.kind === 'plan' && post.dishes?.length ? (async () => {
      const sources = await mealDishSources(db, post);
      return Promise.all(post.dishes.map(async (dish, index) => {
        const origin = await dishOrigin(sources[index], post, dish.recipeId);
        const { sourceKind: previousSourceKind, ...displayDish } = dish;
        return { ...displayDish,
          ...(sources[index]?.id && !dish.recipeId ? { recipeId: visible(sources[index].id, 100) } : {}),
          ...(!dish.image && sources[index] ? { image: mealDishImage(sources[index].image, post) } : {}),
          ...(origin.kind ? { sourceKind: origin.kind } : {}),
          ...(origin.kind === 'community' ? { communityPostId: await dishOrigin.communityPostId(sources[index], post) } : {}),
        };
      }));
      })() : undefined,
    ]);
    const result = mealPostView({ ...post, author }, relation, userId);
    if (options.mealLikesVersion === 1) Object.assign(result, { likeUsers, mealLikesVersion: 1 });
    if (dishes) {
      result.dishes = dishes;
      const restoredImages = dishes.map(dish => dish.image).filter(Boolean).slice(0, 9);
      if (restoredImages.some(image => !(post.images || []).includes(image))) result.images = restoredImages;
    }
    if (options.currentSpaceId && options.currentSpaceId !== post.spaceId) delete result.sourceOrderId;
    if ((isSharedFamilyMeal(post) || options.diaryReference) && post.orderId && options.currentSpaceId === post.spaceId && await canReadMealPost(db, post, userId)) result.sourceOrderId = post.orderId;
    if (options.diaryManagementVersion === 1 && options.currentFamily) Object.assign(result, await mealDiaryCapabilities(db, post, userId, options.currentFamily));
    return result;
  }
  async function feed(event, userId, own) {
    const { family } = await workspaceMembership(repository, userId);
    if (event.spaceId !== family.id) fail('使用空间已变更，请刷新后重试', 'CONFLICT');
    const modern = event.mealSharingVersion === 2;
    const managed = own && modern && event.diaryManagementVersion === 1;
    const unified = modern && event.userSummaryVersion === 1;
    // Only opted-in diary clients trigger the compatibility backfill. Read it
    // before querying posts, so old arrangements and their deletion markers
    // are resolved once and the UI need not synthesize local diary entries.
    const archive = managed && archiveForUser ? await archiveForUser(userId, family.id, unified) : null;
    // Each union branch uses the same stable cursor. Fetching 21 per branch is
    // enough for the first 20 unique rows; dedupe before cutting the page.
    const filters = !own ? [{ visibility: 'public' }]
      : !modern ? [{ authorId: userId, spaceId: family.id }]
      : (unified || family.kind === 'personal')
        ? [{ authorId: userId }, { mealSharingVersion: 2, participantUserIds: { contains: userId }, visibility: 'public' }, { mealSharingVersion: 2, participantUserIds: { contains: userId }, visibility: 'family' }]
        : [{ spaceId: family.id, visibility: 'public' }, { spaceId: family.id, mealSharingVersion: 2, visibility: 'family' }, { spaceId: family.id, authorId: userId, visibility: 'private' }];
    const rows = [];
    let after = cursorOf(event.cursor), more = false;
    // Personal deletion removes this user's reference only. Filter it before
    // cutting a page, then advance past hidden rows so they cannot starve the
    // remainder of the diary or cause duplicates between pages.
    for (let round = 0; round < 10; round += 1) {
      const branches = await Promise.all(filters.map(filter => repository.list('meal_posts', { status: 'published', ...filter }, { order: 'published', after, limit: 21 })));
      const merged = [...new Map(branches.flat().map(post => [post.id || post._id, post])).values()].sort((a, b) => b.createdAt - a.createdAt || (b.id || b._id).localeCompare(a.id || a._id));
      const batch = merged.slice(0, 21);
      more = merged.length > 21 || branches.some(branch => branch.length === 21);
      if (!batch.length) { more = false; break; }
      const hidden = own
        ? await readDocuments(repository, 'meal_reactions', batch.map(post => mealDiaryRelationId(post.id, userId)), { fields: ['diaryHiddenAt'] }) : new Map();
      rows.push(...batch.filter(post => !hidden.get(mealDiaryRelationId(post.id, userId))?.diaryHiddenAt));
      after = { id: batch.at(-1).id || batch.at(-1)._id, createdAt: batch.at(-1).createdAt };
      if (rows.length > 20 || !more) break;
    }
    const page = rows.slice(0, 20);
    const identity = createIdentityPresentation(repository);
    const dishOrigin = createMealDishOrigins(repository);
    const posts = await Promise.all(page.map(post => view(repository, post, userId, identity, { currentSpaceId: family.id, currentFamily: family, diaryReference: own && modern, ...(managed ? { diaryManagementVersion: 1 } : {}), mealLikesVersion: event.mealLikesVersion, liveImages: event.identityPresentationVersion === 1, defaultProfileVersion: event.defaultProfileVersion }, dishOrigin)));
    return { mealSharingVersion: 2, ...(managed ? { diaryManagementVersion: 1, diaryArchiveComplete: archive?.complete === true, suppressedOrderIds: archive?.suppressedOrderIds || [], ...(archive?.complete ? { diaryArchiveVersion: 1 } : {}) } : {}), posts, ...(event.identityPresentationVersion === 1 ? { identityPresentationVersion: 1, media: Object.fromEntries(posts.filter(post => post.author?.avatar?.startsWith("cloud://")).map(post => [post.author.avatar, { postId: post.id }])) } : {}), cursor: rows.length > 20 ? { id: page.at(-1).id || page.at(-1)._id, createdAt: page.at(-1).createdAt } : more ? after : null };
  }
  async function publish(event, userId, finish = false) {
    if (typeof event.requestId !== 'string' || !/^[\w-]{12,100}$/.test(event.requestId)) fail('请求标识无效');
    if (!['plan', 'actual'].includes(event.kind)) fail('请选择餐食类型');
    const visibility = visibilityOf(event.visibility);
    const modern = event.mealSharingVersion === 2;
    if (event.mealSharingVersion !== undefined && !modern) fail('餐食共享版本不兼容，请更新后重试');
    if (!modern && visibility === 'family') fail('请更新后使用家庭日记');
    if (modern && event.showMealBadge !== undefined && typeof event.showMealBadge !== 'boolean') fail('请选择是否展示餐食标识');
    if (finish && !event.orderId) fail('请从当天的安排记录餐食');
    if ((event.kind === 'plan' || event.orderId !== undefined) && (typeof event.orderId !== 'string' || !event.orderId || event.orderId.length > 100)) fail('请选择餐食安排');
    if (event.kind === 'actual' && (!Array.isArray(event.images) || !event.images.length || event.images.length > 9 || event.images.some(image => typeof image !== 'string' || !image.startsWith('cloud://') || image.length > 1000))) fail('请上传 1～9 张实际餐食照片');
    if (event.moodIds !== undefined && (!Array.isArray(event.moodIds) || event.moodIds.length > 3 || event.moodIds.some(id => !MEAL_MOODS.some(tag => tag.id === id)))) fail('请选择最多三个心情标签');
    const moodIds = [...new Set(event.moodIds || [])].sort();
    const input = { kind: event.kind, visibility, moodIds, ...(event.kind === 'plan' ? { orderId: event.orderId } : { date: dateOf(event.date, now), meal: event.meal, images: [...new Set(event.images)], ...(event.orderId ? { orderId: event.orderId } : {}) }) };
    if (finish) input.finish = true;
    if (modern) Object.assign(input, { mealSharingVersion: 2, showMealBadge: event.showMealBadge !== false });
    if (input.kind === 'actual' && !MEAL_SLOTS.includes(input.meal)) fail('请选择餐次');
    const fingerprint = hash(JSON.stringify(input));
    const committed = await repository.transaction(async db => {
      const { user, family } = await workspaceMembership(db, userId);
      if (event.spaceId !== family.id) fail('使用空间已变更，请重新打开发布', 'CONFLICT');
      if (modern && (family.kind === 'personal' ? visibility === 'family' : visibility === 'private')) fail('请选择当前空间的可见范围');
      const receiptId = hash(`meal:${family.id}:${userId}:${event.requestId}`);
      const receipt = await db.get('requests', receiptId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('这次请求已处理，请刷新后重试', 'CONFLICT');
        const post = await db.get('meal_posts', receipt.postId);
        if (!post || post.status !== 'published') fail('这条餐食已删除', 'NOT_FOUND');
        return { post, currentSpaceId: family.id, replay: true };
      }
      const id = `meal-${hash(`${family.id}:${userId}:${input.kind}:${event.requestId}`)}`;
      // Older clients could publish an arrangement without completing it. The
      // order's transactional status, not that old post, guards completion.
      const previous = !finish && input.kind === 'plan' ? (await db.list('meal_posts', { spaceId: family.id, authorId: userId, orderId: input.orderId, status: 'published' }, { limit: 1 }))[0] : await db.get('meal_posts', id);
      if (previous?.status === 'published') fail('这餐已经记录过，可以在我的中查看', 'ALREADY_PUBLISHED');
      let content;
      let sourceOrder;
      let matchedOrderId = input.orderId;
      if (!matchedOrderId && input.kind === 'actual') {
        const rows = await db.list('orders', { familyId: family.id, 'value.date': input.date, 'value.meal': input.meal });
        const matches = rows.map(row => row.value).filter(order => order && order.date === input.date && order.meal === input.meal && order.items?.length && (['pending', 'accepted'].includes(order.status) || order.status === 'completed' && order.diaryDeletedAt));
        // Never guess between inconsistent duplicate slots.
        if (matches.length === 1) matchedOrderId = matches[0].id;
      }
      if (matchedOrderId) {
        const row = await db.get('orders', hash(`${family.id}:${matchedOrderId}`));
        sourceOrder = row?.familyId === family.id ? row.value : null;
        if (!sourceOrder || sourceOrder.status === 'cancelled' || !sourceOrder.items?.length) fail('餐食已取消或没有菜品，请重新选择');
        if (finish) {
          if (!['pending', 'accepted'].includes(sourceOrder.status) && !(sourceOrder.status === 'completed' && sourceOrder.diaryDeletedAt)) fail('这一餐已结束，请查看原安排', 'ALREADY_FINISHED');
          if (sourceOrder.date !== chinaDate(now()) && !(sourceOrder.diaryDeletedAt && sourceOrder.date < chinaDate(now()))) fail('只能在安排当天记录餐食', 'MEAL_DATE');
          if (input.kind === 'actual' && (input.date !== sourceOrder.date || input.meal !== sourceOrder.meal)) fail('照片须记录到当前餐次');
        }
      }
      const dishes = sourceOrder ? sourceOrder.items.slice(0, 50).map(item => ({ ...(item.recipe.id ? { recipeId: item.recipe.id } : {}), title: visible(item.recipe.title, 30), image: visible(item.recipe.image, 1000) })) : [];
      if (input.kind === 'plan') {
        content = { date: sourceOrder.date, meal: sourceOrder.meal, title: `${sourceOrder.meal}这样搭配`, dishes, images: dishes.map(dish => dish.image).filter(Boolean).slice(0, 9), orderId: sourceOrder.id };
      } else {
        for (const fileId of input.images) {
          const media = await db.get('media', hash(fileId));
          if (!media?.confirmed || !media.mealPhoto || media.profile || media.familyDraftRequest || media.userId !== userId || media.familyId !== family.id || (media.mealPostId && media.mealPostId !== id)) fail('请重新上传属于这次记录的照片', 'FORBIDDEN');
          // A post photo has its own visibility, even inside a shared family.
          await db.set('media', hash(fileId), { ...media, mealPostId: id, mealPostOwnerId: userId });
        }
        content = { date: input.date, meal: input.meal, title: `${input.meal}好好吃饭`, images: input.images, dishes, ...(sourceOrder ? { orderId: sourceOrder.id } : {}) };
      }
      const member = family.members.find(member => member.id === userId);
      const author = { name: family.kind === 'personal' ? (user.name || member.name || '我') : family.name, avatar: family.kind === 'personal' ? (user.avatar || '') : familyMealAvatar(family, user, userId), mode: family.kind === 'personal' ? 'personal' : 'family', familyIdentityVersion: 1 };
      const post = { id, spaceId: family.id, authorId: userId, author, kind: input.kind, ...content, moodIds, visibility, status: 'published', createdAt: now(), likeCount: 0, reactionCounts: {} };
      if (modern) Object.assign(post, { mealSharingVersion: 2, mealContext: family.kind === 'personal' ? 'personal' : 'family', showMealBadge: input.showMealBadge, participantUserIds: sourceOrder ? orderDiaryParticipants(sourceOrder, family) : family.kind === 'personal' ? [userId] : [...new Set(family.members.map(member => member.id))] });
      const completesOrder = Boolean(sourceOrder && (finish || !input.orderId));
      if (completesOrder) post.mealStarted = true;
      post.assetIds = refs(post);
      if (completesOrder) {
        const { diaryDeletedAt, ...recordedOrder } = sourceOrder;
        await db.set('orders', hash(`${family.id}:${sourceOrder.id}`), { familyId: family.id, value: { ...recordedOrder, status: 'completed', completedAt: new Date(now()).toISOString(), mealPostId: id } });
      }
      await db.set('families', family.id, { ...family, socialWriteVersion: (family.socialWriteVersion || 0) + 1, ...(completesOrder ? { revision: (family.revision || 0) + 1, updatedAt: now() } : {}) });
      await db.set('meal_posts', id, post);
      await db.set('requests', receiptId, { kind: 'meal_post_v1', postId: id, fingerprint, createdAt: now() });
      return { post, currentSpaceId: family.id };
    });
    // Presentation queries must not expand or roll back the write transaction.
    // A committed receipt is sufficient to acknowledge the exact saved draft;
    // the normal diary refresh can retry optional display enrichment.
    try {
      return { post: await view(repository, committed.post, userId, createIdentityPresentation(repository), { currentSpaceId: committed.currentSpaceId, mealLikesVersion: event.mealLikesVersion, liveImages: event.identityPresentationVersion === 1, defaultProfileVersion: event.defaultProfileVersion }), ...(committed.replay ? { replay: true } : {}) };
    } catch {
      return { post: mealPostView(committed.post, null, userId), presentationPending: true, ...(committed.replay ? { replay: true } : {}) };
    }
  }
  return async (action, event, userId) => {
    if (action === 'mealReceivedLikes') {
      const { family } = await workspaceMembership(repository, userId);
      if (event.spaceId !== family.id) fail('使用空间已变更，请刷新后重试', 'CONFLICT');
      await throttle(userId, 'mealReceivedLikes', 120);
      const unified = event.userSummaryVersion === 1;
      // Personal totals use the same deduplicated, visible diary union.
      // Only scalar fields and hidden-reference markers are read.
      const personalMeals = unified || family.kind === 'personal' ? (async () => {
        const filters = [{ authorId: userId },
          { mealSharingVersion: 2, participantUserIds: { contains: userId }, visibility: 'public' },
          { mealSharingVersion: 2, participantUserIds: { contains: userId }, visibility: 'family' }];
        const branches = await Promise.all(filters.map(async filter => {
          const posts = []; let cursor;
          while (true) {
            const rows = await repository.list('meal_posts', { status: 'published', ...filter }, { order: 'published', after: cursor, limit: 100, fields: ['_id', 'id', 'createdAt', 'likeCount'] });
            posts.push(...rows);
            if (rows.length < 100) return posts;
            const last = rows.at(-1); cursor = { id: last._id || last.id, createdAt: last.createdAt };
          }
        }));
        const posts = new Map(branches.flat().map(post => [post.id || post._id, post]));
        const ids = [...posts.keys()];
        const hidden = await readDocuments(repository, 'meal_reactions', ids.map(id => mealDiaryRelationId(id, userId)), { fields: ['diaryHiddenAt'] });
        return ids.reduce((totals, id) => {
          if (!hidden.get(mealDiaryRelationId(id, userId))?.diaryHiddenAt) {
            totals.mealCount += 1;
            totals.receivedLikes += Math.max(0, Math.floor(Number(posts.get(id).likeCount) || 0));
          }
          return totals;
        }, { mealCount: 0, receivedLikes: 0 });
      })() : Promise.resolve(null);
      const ownStats = unified || family.kind === 'personal' ? Promise.resolve(null) : (async () => {
      let after, count = 0, mealCount = 0;
      // Canonical posts only: diary participant references are not extra likes.
      // Stable ID pagination includes legacy posts without creation timestamps.
      while (true) {
        const rows = await repository.list('meal_posts', { status: 'published', spaceId: family.id }, { after, limit: 100, fields: ['_id', 'id', 'mealContext', 'author', 'authorId', 'visibility', 'likeCount'] });
        for (const post of rows) {
          const familyMeal = post.mealContext ? post.mealContext === 'family' : post.author?.mode === 'family';
          const belongs = family.kind === 'personal' ? !familyMeal && post.authorId === userId
            : familyMeal && ['public', 'family'].includes(post.visibility);
          if (belongs) {
            mealCount += 1;
            count += Math.max(0, Math.floor(Number(post.likeCount) || 0));
          }
        }
        if (rows.length < 100) break;
        after = rows.at(-1)._id || rows.at(-1).id;
      }
      return { receivedLikes: count, mealCount };
      })();
      const [totals, personalTotals] = await Promise.all([ownStats, personalMeals]);
      return { spaceId: family.id, ...(personalTotals ?? totals) };
    }
    if (action === 'mealFeed' || action === 'myMealPosts') return feed(event, userId, action === 'myMealPosts');
    if (action === 'mealDishDetail') {
      const postId = postIdOf(event.postId);
      if (!Number.isInteger(event.dishIndex) || event.dishIndex < 0 || event.dishIndex >= 50) fail('请选择这餐中的菜品');
      await throttle(userId, 'mealDishDetail', 120);
      const post = await repository.get('meal_posts', postId);
      if (!await canReadMealPost(repository, post, userId)) fail('这条餐食已不可见', 'NOT_FOUND');
      if (post.kind !== 'plan' || !post.dishes?.[event.dishIndex]) fail('这道菜的详情已不可用', 'NOT_FOUND');
      const sources = await mealDishSources(repository, post);
      const source = sources[event.dishIndex];
      if (!source) fail('这道菜的详情已不可用', 'NOT_FOUND');
      const dish = post.dishes[event.dishIndex];
      const [additionalImages, origin] = await Promise.all([
        readableMealDishImages(repository, source, dish, post, userId),
        createMealDishOrigins(repository)(source, post),
      ]);
      return { communityPostId: origin.kind === 'community' ? await createMealDishOrigins(repository).communityPostId(source, post) : '', recipe: { ...mealDishRecipe(source, dish, post, additionalImages), ...(origin.label ? { sourceLabel: origin.label } : {}) } };
    }
    const publishing = action === 'publishMeal' || action === 'finishMeal';
    await throttle(userId, publishing ? 'mealPublish' : 'mealReaction', publishing ? 20 : 120);
    if (publishing) return publish(event, userId, action === 'finishMeal');
    const postId = postIdOf(event.postId);
    return repository.transaction(async db => {
      const { family } = await workspaceMembership(db, userId);
      if (event.spaceId !== family.id) fail('使用空间已变更，请刷新后重试', 'CONFLICT');
      const post = await db.get('meal_posts', postId);
      const owns = post?.authorId === userId;
      const managed = event.diaryManagementVersion === 1;
      if (event.diaryManagementVersion !== undefined && !managed) fail('日记操作版本不兼容，请更新后重试');
      if (action === 'deleteFamilyMealPost') {
        if (!managed || !authoredFamilyMeal(post, userId)) fail('只有发布人可以删除家庭餐食', 'FORBIDDEN');
        if (post.status === 'deleted') return { deletedId: postId, deleteScope: 'shared', ...(post.spaceId === family.id && post.orderId ? { suppressedOrderIds: [post.orderId] } : {}) };
        if (!await canReadMealPost(db, post, userId, family)) fail('这条餐食已不可见', 'NOT_FOUND');
        const result = await deleteCanonicalMeal(db, { ...post, mealContext: 'family' }, userId, now, 'shared');
        if (post.spaceId !== family.id) delete result.suppressedOrderIds;
        return result;
      }
      if (action === 'deleteMealPost' && post?.status === 'deleted') {
        const canReplay = owns || managed && (family.id === post.spaceId || family.kind === 'personal' && post.participantUserIds?.includes(userId));
        if (canReplay) return { deletedId: postId, ...(managed ? { deleteScope: family.kind === 'personal' && post.spaceId !== family.id ? 'personal' : family.kind === 'personal' ? 'own' : 'shared' } : {}), ...(post.spaceId === family.id && post.orderId ? { suppressedOrderIds: [post.orderId] } : {}) };
      }
      if (!await canReadMealPost(db, post, userId, family)) fail('这条餐食已不可见', 'NOT_FOUND');
      if (action === 'setMealVisibility' || action === 'deleteMealPost') {
        const capabilities = managed ? await mealDiaryCapabilities(db, post, userId, family) : null;
        if (managed ? !capabilities[action === 'deleteMealPost' ? 'canDelete' : 'canChangeVisibility'] : !owns) fail('当前没有权限修改这条餐食', 'FORBIDDEN');
        if (action === 'deleteMealPost') {
          if (capabilities?.deleteScope === 'personal' || post.mealContext === 'family' || post.author?.mode === 'family') return hidePersonalMeal(db, post, userId, now);
          const result = await deleteCanonicalMeal(db, post, userId, now, capabilities?.deleteScope);
          if (post.spaceId !== family.id) delete result.suppressedOrderIds;
          return result;
        }
        const nextVisibility = visibilityOf(event.visibility);
        if (nextVisibility === 'family' && !isSharedFamilyMeal(post)) fail('旧记录不能自动转为家庭共享，请重新记录');
        if (managed && isSharedFamilyMeal(post) && nextVisibility === 'private') fail('家庭餐食请选择家庭可见或公开');
        post.visibility = nextVisibility;
      } else {
        if (post.visibility !== 'public') fail('非公开记录不开放互动', 'FORBIDDEN');
        if (typeof event.selected !== 'boolean') fail('互动状态无效');
        const id = recordId(postId, userId);
        const relation = await db.get('meal_reactions', id) || { postId, userId, liked: false, tags: [] };
        if (action === 'setMealLike') {
          const delta = Number(event.selected) - Number(Boolean(relation.liked));
          post.likeCount = Math.max(0, (post.likeCount || 0) + delta);
          relation.liked = event.selected;
        } else if (action === 'setMealReaction') {
          if (!MEAL_REACTIONS.some(tag => tag.id === event.tagId)) fail('请选择已有标签');
          const tags = new Set(relation.tags || []);
          const delta = Number(event.selected) - Number(tags.has(event.tagId));
          if (event.selected) tags.add(event.tagId); else tags.delete(event.tagId);
          relation.tags = [...tags];
          post.reactionCounts = { ...post.reactionCounts, [event.tagId]: Math.max(0, (post.reactionCounts?.[event.tagId] || 0) + delta) };
        } else fail('不支持的餐食操作');
        await db.set('meal_reactions', id, relation);
      }
      await db.set('meal_posts', postId, post);
      // A like acknowledgement must not depend on recipe/media/profile reads.
      // Resolve the transaction before returning this minimal, confirmed state.
      if (action === 'setMealLike' && event.mealReactionVersion === 1) {
        return { reaction: { id: postId, liked: event.selected, likeCount: post.likeCount }, mealReactionVersion: 1 };
      }
      return { post: await view(db, post, userId, createIdentityPresentation(db), { currentSpaceId: family.id, currentFamily: family, ...(managed ? { diaryManagementVersion: 1 } : {}), mealLikesVersion: event.mealLikesVersion, liveImages: event.identityPresentationVersion === 1, defaultProfileVersion: event.defaultProfileVersion }) };
    });
  };
}

export async function canReadMealImage(repository, fileId, userId, media) {
  if (media?.mealPostId) {
    const post = await repository.get('meal_posts', media.mealPostId);
    return await canReadMealPost(repository, post, userId) && post.assetIds?.includes(fileId);
  }
  const publicRows = await repository.list('meal_posts', { status: 'published', visibility: 'public', assetIds: { contains: fileId } }, { limit: 1 });
  if (publicRows.length) return true;
  const ownRows = await repository.list('meal_posts', { status: 'published', authorId: userId, assetIds: { contains: fileId } }, { limit: 1 });
  if (ownRows.length) return true;
  // Query one array index (assetIds), then apply the same canonical permission
  // check as a bound photo. Two array fields cannot share a compound index.
  // Scan beyond an inaccessible first match: a later record may grant access.
  let after = '';
  const familyCache = new Map();
  const accessDb = { get: (collection, id) => {
    if (collection !== 'families') return repository.get(collection, id);
    if (!familyCache.has(id)) familyCache.set(id, repository.get(collection, id));
    return familyCache.get(id);
  } };
  while (true) {
    const rows = await repository.list('meal_posts', { status: 'published', mealSharingVersion: 2, visibility: 'family', assetIds: { contains: fileId } }, { after, limit: 100 });
    for (const post of rows) if (await canReadMealPost(accessDb, post, userId)) return true;
    if (rows.length < 100) return false;
    after = rows.at(-1).id || rows.at(-1)._id;
  }
}
