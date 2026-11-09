import { assertMealBeforeCutoff } from '../src/domain/meal-cutoff.js';
import { preserveMealRecipes } from './meal-dish-snapshots.mjs';
import { withOrderRecordStates } from './order-record-state.mjs';
import { createAccountVisits } from './account-visits.mjs';
import { createAccountAccess, accountAccessSummary } from './account-access.mjs';
import { createIdentityPresentation, canReadCurrentIdentityImage } from './identity-presentation.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { createKitchenActions, actionNames } from '../src/domain/actions.js';
import { canonicalRecipeId } from '../src/domain/recipe-identity.js';
import { emptySnapshot } from '../src/domain/empty.js';
import { clone, normalizeSnapshot, validateReservation } from '../src/domain/kitchen.js';
import { normalizeCommand, validateEnvelope } from './validation.mjs';
import { imageVersion, displayVariants } from '../src/domain/image-variants.js';
import { createAuthorizedImport } from './authorized-import.mjs';
import { canDeleteCommunityPost, communityPublisherName } from '../src/domain/community-policy.js';
import { createFamilyService, familyActions, userProfile, readFamilyInvitation } from './families.mjs';
import { createFamilyMediaOperations } from './family-media-operations.mjs';
import { familyDeletionStatus } from './family-deletion.mjs';
import { postFamilySnapshot, familySnapshotAssetIds } from '../src/domain/family-public-snapshot.js';
import { createFriendShares } from './friend-shares.mjs';
import { readDocuments, readDocumentResults } from './repository-reads.mjs';
import { measure } from './performance.mjs';
import { createImageManifestReader } from './image-manifests.mjs';
import { restoreIngredientCommand, legacyIngredientAmounts } from '../src/domain/ingredient-units.js';
import { readCommunityFeedPage } from './community-feed.mjs';
import { FAMILY_PUBLIC_IDS } from './family-public-id.mjs';
import { activeSpaceId, workspaceMembership, switchWorkspace } from './workspaces.mjs';
import { MEAL_POST_COLLECTIONS, mealPostActions, createMealPostService, canReadMealImage } from './meal-posts.mjs';
import { DEFAULT_PROFILE_VERSION } from '../src/domain/default-profile.js';
import { createMealAutoArchive, captureOrderDiaryParticipants } from './meal-auto-archive.mjs';

const familyLists = { recipes: 'recipes', mealSets: 'meal_sets', orders: 'orders', inventory: 'inventory', purchases: 'purchases' };
const commandLists = {
  setChef: [], setFeature: [], setPreferences: [], customizeFamily: [],
  saveRecipe: ['recipes', 'mealSets'], saveMealSet: ['recipes', 'mealSets'],
  addOrderDishes: ['recipes', 'mealSets', 'orders'],
  removeOrderDish: ['orders', 'purchases'],
  setDishPrepared: ['orders'], saveDishPreparation: ['orders'], updateOrder: ['orders', 'purchases'], removeOrder: ['orders', 'purchases'],
  saveShoppingDraft: ['orders'], removeShoppingDraft: ['orders'],
  addStock: ['inventory'], removeStock: ['inventory'], changeStockImage: ['inventory'],
  removeFamilyEntry: ['recipes', 'mealSets'], addCollection: ['recipes', 'mealSets'],
  publishToCommunity: ['recipes', 'mealSets'],
  addComment: [], toggleCommentLike: [], deleteCommunityPost: [],
};
export const collections = ['users', 'families', ...MEAL_POST_COLLECTIONS, FAMILY_PUBLIC_IDS, ...Object.values(familyLists), 'posts', 'comments', 'invites', 'shares', 'requests', 'media', 'imports', 'reports', 'rate_limits'];
const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = prefix => `${prefix}-${Date.now()}-${randomBytes(12).toString('hex')}`;
const documentId = (familyId, itemId) => hash(`${familyId}:${itemId}`);
const fail = (message, code = 'INVALID') => { const error = new Error(message); error.code = code; throw error; };
const text = (value, max, name) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${name}需要 1～${max} 个字`); return value.trim(); };
const todayInChina = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
export function imageReferences(value) {
  const result = new Set();
  function walk(item) {
    if (typeof item === 'string' && item.startsWith('cloud://')) result.add(item);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') Object.values(item).forEach(walk);
  }
  walk(value);
  return [...result];
}
async function all(repository, collection, where, options = {}) {
  const rows = [];
  let after = '';
  while (true) {
    const page = await repository.list(collection, where, { ...options, after, limit: 100 });
    rows.push(...page);
    if (rows.length > 10000) fail('记录较多，请先联系管理员归档历史数据', 'CAPACITY');
    if (page.length < 100) return rows;
    after = page.at(-1)._id;
  }
}

export function createApplication({ repository, signFiles, storeImage, storeImageBytes, readImage, readImportImage, cleanupMedia, exchangePhone, appId, onError = () => {}, now = Date.now }) {
  const recordAccountVisit = createAccountVisits({ repository, now });
  const accountAccess = createAccountAccess({ repository, exchangePhone, appId, now });
  const mediaOperations = createFamilyMediaOperations({ repository, now });
  const authorizedImport = createAuthorizedImport({ repository, storeImageBytes, readImportImage, mediaOperations, now });
  const loadImageManifests = createImageManifestReader({ repository, readImage, onError, now });
  const imageCandidate = (fileId, variant = 'card') => ({ fileId, variant });
  async function familyImageManifests(userId, family, profile, snapshot) {
    const members = family?.members || [];
    const self = members.find(member => member.id === userId);
    const candidates = [imageCandidate(family?.cover, 'detail'), imageCandidate(self?.avatar || profile?.avatar, 'avatar'), ...(snapshot?.recipes || []).slice(0, 4).map(recipe => imageCandidate(recipe.image)), ...members.map(member => imageCandidate(member.avatar, 'avatar'))];
    const allowed = new Set(imageReferences({ family, recipes: snapshot?.recipes || [] }));
    return loadImageManifests(candidates, (record, image) => allowed.has(image.fileId) || (record.profile && record.userId === userId && profile?.avatar === image.fileId));
  }
  async function postImageManifests(posts, authorizations, detail = false) {
    const candidates = [];
    for (const post of posts) {
      candidates.push(imageCandidate(post.image, detail ? 'detail' : 'card'));
      if (detail) {
        for (const recipe of post.recipes || []) candidates.push(imageCandidate(recipe.image));
        for (const recipe of post.recipes || []) for (const step of recipe.steps || []) {
          const images = Array.isArray(step.images) && step.images.length ? step.images : [step.image];
          candidates.push(...images.map(fileId => imageCandidate(fileId, 'detail')));
        }
      }
      if (candidates.length >= 18) break;
    }
    const allowed = new Set(authorizations.filter(post => post?.status === 'published').flatMap(post => post.assetIds || []));
    return loadImageManifests(candidates, (record, image) => allowed.has(image.fileId));
  }
  const membership = workspaceMembership;
  async function optionalFamily(userId) {
    try { return (await membership(repository, userId)).family; }
    catch (error) { if (['NO_FAMILY', 'FORBIDDEN'].includes(error.code)) return undefined; throw error; }
  }
  async function familyState(db, family, userId, parallel = false, fields = Object.keys(familyLists)) {
    const snapshot = { ...emptySnapshot(), family: clone(family), activeMemberId: userId };
    delete snapshot.family._id;
    delete snapshot.family.friendInviteToken;
    delete snapshot.family.inviteId;
    const readList = async ([field, collection]) => { snapshot[field] = (await all(db, collection, { familyId: family.id })).map(row => row.value); };
    const entries = fields.map(field => [field, familyLists[field]]);
    if (parallel) await Promise.all(entries.map(readList));
    else for (const entry of entries) await readList(entry);
    return measure('snapshot.normalize', () => normalizeSnapshot(snapshot));
  }
  async function sign(value) {
    const ids = imageReferences(value);
    return ids.length ? signFiles(ids) : {};
  }
  async function signPosts(posts) {
    const media = await sign(posts);
    for (const post of posts) for (const fileId of imageReferences(post)) {
      if (media[fileId] && typeof media[fileId] === 'object') media[fileId] = { ...media[fileId], postId: post.id };
    }
    return media;
  }
  async function bootstrap(userId, known = {}) {
    const user = await repository.get('users', userId);
    if (known.accountLoginVersion === 1 && !accountAccessSummary(user).phoneBound) fail('请先完成手机号登录', 'PHONE_REQUIRED');
    const profile = userProfile(user, userId, known.defaultProfileVersion);
    const profileCompatibility = known.defaultProfileVersion === DEFAULT_PROFILE_VERSION ? { defaultProfileVersion: DEFAULT_PROFILE_VERSION, profileBaseline: userProfile(user) } : {};
    const deletionIds = [...new Set(user?.pendingFamilyDeletions || [])];
    const deletionRecords = deletionIds.length ? await readDocuments(repository, 'families', deletionIds) : new Map();
    const pendingDeletions = deletionIds.map(id => deletionRecords.get(id)).filter(family => family?.deletion?.requestedBy === userId && family.deletion.status === 'pending').map(familyDeletionStatus);
    if (!activeSpaceId(user)) {
      return { mealSharingVersion: 2, needsFamily: true, userId, profile, ...profileCompatibility, pendingDeletions, ...(known.includeImageManifests === true ? { imageManifests: await familyImageManifests(userId, undefined, profile) } : {}) };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { family } = await membership(repository, userId, attempt === 0 ? user : undefined);
      if (!known.includeSharedItems && known.knownFamilyId === family.id && Number.isSafeInteger(known.knownRevision) && known.knownRevision === family.revision) {
        return { mealSharingVersion: 2, unchanged: true, revision: family.revision, userId, familyId: family.id, profile, ...profileCompatibility, pendingDeletions, ...(known.includeImageManifests === true ? { imageManifests: await familyImageManifests(userId, family, profile) } : {}) };
      }
      const [snapshot, posts, sharedItems] = await Promise.all([
        familyState(repository, family, userId, true),
        known.includeFeed === false ? [] : repository.list('posts', { status: 'published' }, { limit: 30 }),
        all(repository, 'posts', { familyId: family.id, status: 'published' }, { fields: ['id', 'familyItemId', 'familyKind', 'kind'] }),
      ]);
      const presentedOrders = await withOrderRecordStates(repository, family.id, snapshot.orders, todayInChina(now()));
      const orderRecordStates = Object.fromEntries(presentedOrders.filter(order => order.recordState).map(order => [order.id, order.recordState]));
      const [currentUser, current] = await Promise.all([repository.get('users', userId), repository.get('families', family.id)]);
      if (!activeSpaceId(currentUser)) fail('请先创建或加入家庭', 'NO_FAMILY');
      if (activeSpaceId(currentUser) !== family.id) continue;
      if (current?.deletedAt || !current?.members.some(member => member.id === userId)) fail('你已不在这个家庭中', 'NO_FAMILY');
      if (current.revision !== family.revision) continue;
      const identity = createIdentityPresentation(repository);
      snapshot.posts = await Promise.all(posts.map(post => identity.community(publicPost(post))));
      snapshot.sharedItems = sharedItems.filter(post => post.familyItemId).map(post => ({ kind: post.familyKind || (post.kind === 'menu' ? 'set' : 'dish'), itemId: post.familyItemId, postId: post.id || post._id }));
      return { mealSharingVersion: 2, orderRecordStates, snapshot, revision: family.revision, userId, familyId: family.id, profile, ...profileCompatibility, pendingDeletions, media: await sign(snapshot), ...(known.includeImageManifests === true ? { imageManifests: await familyImageManifests(userId, family, profile, snapshot) } : {}) };
    }
    fail('家人正在更新数据，请稍后刷新', 'SYNC_BUSY');
  }
  function publicPost(post) { const { _id, assetIds, card, ...safe } = post; return { ...safe, sourceKind: 'community', author: communityPublisherName(post) }; }
  function postCard(post) {
    return { id: post.id, title: post.title, kind: post.kind, sourceKind: 'community', image: post.image, author: communityPublisherName(post), categories: post.categories, familyId: post.familyId, familyItemId: post.familyItemId, familyKind: post.familyKind, publisherId: post.publisherId, publisherType: post.publisherType || 'user', ...(post.familySnapshot ? { familySnapshot: post.familySnapshot } : {}), importedFamilyCount: post.importedFamilyCount || 0, tall: Boolean(post.tall), recipes: post.recipes.map(recipe => ({ id: recipe.id, ...(recipe.identityVersion === 2 ? { identityVersion: 2, canonicalRecipeId: canonicalRecipeId(recipe), recipeOrigin: 'community' } : {}), title: recipe.title, category: recipe.category, image: recipe.image, minutes: recipe.minutes })) };
  }
  async function recipeIdentityPosts(db, familyId, recipe) {
    if (!recipe || recipe.identityVersion === 2) return [];
    const found = new Map();
    const remember = post => { if (post && ['published', 'deleted'].includes(post.status)) found.set(post.id || post._id, publicPost(post)); };
    if (recipe.sourcePostId && !recipe.sourcePostId.startsWith('friend-')) remember(await db.get('posts', recipe.sourcePostId));
    const queries = [{ familyId, familyItemId: recipe.id }];
    for (const id of new Set([recipe.id, canonicalRecipeId(recipe)].filter(Boolean))) queries.push({ familyId, 'recipes.id': id });
    if (!recipe.sourcePostId && recipe.sourceFamilyId && recipe.sourceId) queries.push({ familyId: recipe.sourceFamilyId, 'recipes.id': recipe.sourceId });
    for (const where of queries) for (const status of ['published', 'deleted']) {
      for (const post of await all(db, 'posts', { ...where, status })) remember(post);
    }
    return [...found.values()];
  }
  async function commentPage(postId, cursor = '') {
    const rows = await repository.list('comments', { postId }, { after: cursor, limit: 21 });
    const identity = createIdentityPresentation(repository);
    return { comments: await Promise.all(rows.slice(0, 20).map(({ _id, ...item }) => identity.comment(item))), commentCursor: rows.length > 20 ? rows[19]._id : '' };
  }
  async function persist(db, before, after, fields) {
    for (const field of fields) {
      const collection = familyLists[field];
      const previous = new Map(before[field].map(item => [item.id, item]));
      for (const item of after[field]) {
        if (JSON.stringify(item) !== JSON.stringify(previous.get(item.id))) {
          if (field === 'orders' && previous.has(item.id) && ['items', 'date', 'meal'].some(key => JSON.stringify(item[key]) !== JSON.stringify(previous.get(item.id)[key]))) await preserveMealRecipes(db, after.family.id, previous.get(item.id));
          if (Buffer.byteLength(JSON.stringify(item)) > 700000) fail('内容过大，请减少菜品或步骤', 'CAPACITY');
          await db.set(collection, documentId(after.family.id, item.id), { familyId: after.family.id, value: item });
        }
        previous.delete(item.id);
      }
      for (const [itemId, item] of previous) {
        if (field === 'orders') await preserveMealRecipes(db, after.family.id, item);
        await db.remove(collection, documentId(after.family.id, itemId));
      }
    }
    const { _id, ...family } = after.family;
    after.family = { ...family, revision: before.family.revision + 1, updatedAt: now() };
    const currentFamily = await db.get('families', family.id);
    await db.set('families', family.id, { ...currentFamily, ...after.family });
  }
  async function allowedImages(db, args, snapshot) {
    const existing = new Set(imageReferences({ family: snapshot.family, recipes: snapshot.recipes, mealSets: snapshot.mealSets, inventory: snapshot.inventory }));
    for (const fileId of imageReferences(args)) {
      const media = await db.get('media', hash(fileId));
      if (media?.mealPhoto) fail('餐食记录照片不能用于家庭菜谱，请重新选择图片', 'FORBIDDEN');
      if (existing.has(fileId)) continue;
      if (!media?.confirmed) fail('图片不属于当前家庭，请重新上传', 'FORBIDDEN');
      if (media.familyId !== snapshot.family.id) {
        let referenced = false;
        for (const field of ['recipes', 'mealSets', 'inventory']) {
          if (imageReferences(await all(db, familyLists[field], { familyId: snapshot.family.id })).includes(fileId)) { referenced = true; break; }
        }
        if (!referenced) fail('图片不属于当前家庭，请重新上传', 'FORBIDDEN');
      }
    }
    const serialized = JSON.stringify(args);
    if (/data:image\/|wxfile:\/\/|https?:\/\/(usr|store)\//.test(serialized)) fail('请重新上传图片到云端后保存');
  }
  async function throttleWithin(db, userId, action, limit) {
    const bucket = Math.floor(now() / 60000);
      const key = hash(`${userId}:${action}:${bucket}`);
      const record = await db.get('rate_limits', key);
      if ((record?.count || 0) >= limit) fail('操作太频繁，请稍后重试', 'RATE_LIMIT');
      await db.set('rate_limits', key, { count: (record?.count || 0) + 1, expiresAt: now() + 120000 });
  }
  async function throttle(userId, action, limit) {
    await repository.transaction(db => throttleWithin(db, userId, action, limit));
  }
  async function command(userId, event) {
    const { requestId, revision } = event;
    const name = event.name === 'customizeFamilyWithSubtitle' ? 'customizeFamily' : event.name;
    if (!actionNames.includes(name) || ['switchMember', 'renameFamily'].includes(name)) fail('不支持的操作');
    if (!Array.isArray(event.args) || event.args.length > (['setDishPrepared', 'saveDishPreparation', 'saveShoppingDraft'].includes(name) ? 4 : 3) || !/^[\w-]{12,100}$/.test(requestId || '')) fail('请求格式无效');
    const requestKey = hash(`${userId}:${requestId}`);
    const fingerprint = hash(JSON.stringify({ name: event.name, args: event.args }));
    const committed = await repository.transaction(async db => {
      const { family } = await membership(db, userId);
      if (event.familyId && event.familyId !== family.id) fail('家庭已切换，请重新操作', 'CONFLICT');
      const receipt = await db.get('requests', requestKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint || receipt.familyId !== family.id) fail('请求标识已被使用', 'CONFLICT');
        const commentChanges = event.commentMode === 'patch' && receipt.commentIds ? (await Promise.all(receipt.commentIds.map(id => db.get('comments', id)))).filter(Boolean).map(({ _id, ...item }) => item) : undefined;
        return { value: receipt.value, replay: true, ...(commentChanges ? { commentChanges } : {}) };
      }
      // A saved legacy request must still replay after validation rules become
      // stricter (for example, mandatory covers). Validate only new writes.
      const cleanArgs = normalizeCommand(name, event.args, todayInChina(now()));
      await throttleWithin(db, userId, 'command', 60);
      const social = ['addComment', 'toggleCommentLike', 'deleteCommunityPost'].includes(name);
      if (!social && !['submitOrder', 'addOrderDishes'].includes(name) && revision !== family.revision) fail('家人更新了数据，已刷新，请确认后重试', 'CONFLICT');
      const fields = commandLists[name] || Object.keys(familyLists);
      let snapshot = await familyState(db, family, userId, false, fields);
      const before = clone(snapshot);
      const args = clone(cleanArgs);
      // Portions are no longer editable. Retain the stored legacy value so an
      // unchanged three-person recipe is not turned into a two-person fork.
      if (name === 'saveRecipe' && args[1]) args[0].servings = snapshot.recipes.find(recipe => recipe.id === args[1])?.servings || 2;
      let post;
      if (name === 'addCollection') {
        post = await db.get('posts', args[0]?.id);
        if (!post || post.status !== 'published') fail('这条分享已不存在');
        args[0] = publicPost(post);
      } else await allowedImages(db, args, snapshot);
      if (name === 'submitOrder') { validateReservation(args[1], todayInChina(now())); assertMealBeforeCutoff(args[1], now()); }
      if (name === 'addOrderDishes') assertMealBeforeCutoff(snapshot.orders.find(order => order.id === args[0]), now());
      if (name === 'updateOrder') {
        const order = snapshot.orders.find(item => item.id === args[0]);
        if (order?.status === 'cancelled' && args[1] === 'accepted') { validateReservation(order, todayInChina(now())); assertMealBeforeCutoff(order, now()); }
      }
      if (name === 'deleteCommunityPost' || name === 'addComment') {
        post = await db.get('posts', args[0]);
        if (!post) fail('这条分享已不存在');
        if (name === 'deleteCommunityPost' && !canDeleteCommunityPost(post, userId, family.id)) fail('只能删除当前家庭中自己发布的内容', 'FORBIDDEN');
        if (post.status !== 'published' && name !== 'deleteCommunityPost') fail('这条分享已不存在');
      }
      if (name === 'toggleCommentLike') {
        const target = await db.get('comments', args[0]);
        if (!target) fail('评论已不存在');
        post = await db.get('posts', target.postId);
        if (!post || post.status !== 'published') fail('这条分享已不存在');
      }
      if (post && social) {
        snapshot.posts = [publicPost(post)];
        if (event.commentMode === 'patch') {
          const targetId = name === 'toggleCommentLike' ? args[0] : name === 'addComment' ? args[2] : '';
          const target = targetId ? await db.get('comments', targetId) : null;
          snapshot.comments = target?.postId === post.id ? [target].map(({ _id, ...item }) => item) : [];
        } else snapshot.comments = (await all(db, 'comments', { postId: post.id })).map(({ _id, ...item }) => item);
      }
      if (name === 'publishToCommunity') {
        const existing = await all(db, 'posts', { familyId: family.id, familyItemId: args[0], status: 'published' }, { fields: ['id', 'familyKind', 'kind'] });
        if (existing.some(post => (post.familyKind || (post.kind === 'menu' ? 'set' : 'dish')) === (args[1] || 'dish'))) fail('这道菜品或套餐已分享，请勿重复发布', 'ALREADY_SHARED');
      }
      if (name === 'saveRecipe' || name === 'publishToCommunity' && args[1] !== 'set') {
        const recipeId = name === 'saveRecipe' ? args[1] : args[0];
        snapshot.posts = await recipeIdentityPosts(db, family.id, snapshot.recipes.find(recipe => recipe.id === recipeId));
      }
      const previousComments = clone(snapshot.comments);
      const actions = createKitchenActions({ getState: () => snapshot, commit: next => { snapshot = next; }, newId: identifier, today: () => todayInChina(now()), now });
      let output;
      try { output = actions[name](...args) ?? null; }
      catch (error) { fail(error.message, ['CONFLICT', 'ALREADY_SHARED'].includes(error.code) ? error.code : 'INVALID'); }
      if (name === 'submitOrder') {
        const previousIds = new Set(before.orders.map(order => order.id));
        snapshot.orders = snapshot.orders.map(order => previousIds.has(order.id) ? order : captureOrderDiaryParticipants(order, family, now()));
      }
      if (name === 'publishToCommunity') {
        const shared = snapshot.posts.find(item => item.id === output);
        const previousPost = await db.get('posts', shared.id);
        const familySnapshot = postFamilySnapshot(previousPost || shared, family);
        if (familySnapshot) shared.familySnapshot = familySnapshot;
        await db.set('posts', shared.id, { ...shared, card: postCard({ ...shared, importedFamilyCount: previousPost?.importedFamilyCount || 0 }), familyId: family.id, status: 'published', assetIds: [...new Set([...imageReferences(shared), ...familySnapshotAssetIds(familySnapshot)])], importedFamilyCount: previousPost?.importedFamilyCount || 0, search: JSON.stringify([shared.title, ...shared.recipes.map(recipe => [recipe.title, recipe.ingredients.map(item => item.name)])]).toLowerCase(), createdAt: previousPost?.createdAt || now() });
      } else if (name === 'deleteCommunityPost') {
        await db.set('posts', post.id, { ...post, status: 'deleted', deletedAt: now() });
        await persist(db, before, snapshot, []);
      } else if (name === 'addComment' || name === 'toggleCommentLike') {
        for (const comment of snapshot.comments) if (JSON.stringify(comment) !== JSON.stringify(previousComments.find(item => item.id === comment.id))) await db.set('comments', comment.id, comment);
      } else if (name === 'addCollection') {
        const key = documentId(family.id, post.id);
        if (!await db.get('imports', key)) {
          await db.set('imports', key, { familyId: family.id, postId: post.id, createdAt: now() });
          await db.set('posts', post.id, { ...post, card: postCard({ ...post, importedFamilyCount: (post.importedFamilyCount || 0) + 1 }), importedFamilyCount: (post.importedFamilyCount || 0) + 1 });
        }
      }
      if (!social) await persist(db, before, snapshot, fields);
      const commentIds = ['addComment', 'toggleCommentLike'].includes(name) ? snapshot.comments.filter(comment => JSON.stringify(comment) !== JSON.stringify(previousComments.find(item => item.id === comment.id))).map(comment => comment.id) : [];
      await db.set('requests', requestKey, { familyId: family.id, fingerprint, value: output, createdAt: now(), ...(commentIds.length ? { commentIds } : {}) });
      const changes = { family: snapshot.family };
      for (const field of fields) if (JSON.stringify(before[field]) !== JSON.stringify(snapshot[field])) {
        changes[field] = snapshot[field].map(item => ({ key: documentId(family.id, item.id), item })).sort((left, right) => left.key.localeCompare(right.key)).map(entry => entry.item);
      }
      const commentChanges = ['addComment', 'toggleCommentLike'].includes(name) ? snapshot.comments.slice().sort((left, right) => left.id.localeCompare(right.id)) : [];
      if (commentChanges.length && event.commentMode !== 'patch') changes.comments = commentChanges;
      return { value: output, familyId: family.id, userId, baseRevision: family.revision, revision: snapshot.family.revision, changes, ...(event.commentMode === 'patch' ? { commentChanges } : {}), postChanges: {
        upsert: name === 'addCollection' ? [publicPost({ ...post, importedFamilyCount: (await db.get('posts', post.id)).importedFamilyCount })] : [],
        remove: name === 'deleteCommunityPost' ? [post.id] : [],
      } };
    });
    // Project names only after persistence: account changes must not rewrite comment history.
    const identity = createIdentityPresentation(repository);
    if (committed.commentChanges) committed.commentChanges = await Promise.all(committed.commentChanges.map(identity.comment));
    if (committed.changes?.comments) committed.changes.comments = await Promise.all(committed.changes.comments.map(identity.comment));
    if (committed.postChanges?.upsert) committed.postChanges.upsert = await Promise.all(committed.postChanges.upsert.map(identity.community));
    const { value } = committed;
    if (event.responseMode === 'changes' && !committed.replay && committed.baseRevision === revision && name !== 'publishToCommunity') {
      return { ...committed, media: await sign({ changes: committed.changes, posts: committed.postChanges.upsert }) };
    }
    const result = await bootstrap(userId, { includeFeed: event.includeFeed, defaultProfileVersion: event.defaultProfileVersion });
    if (['addComment', 'toggleCommentLike'].includes(name)) {
      const postId = name === 'addComment' ? event.args[0] : (await repository.get('comments', event.args[0]))?.postId;
      if (event.commentMode === 'patch') result.commentChanges = committed.commentChanges || (await commentPage(postId)).comments;
      else result.snapshot.comments = await Promise.all((await all(repository, 'comments', { postId })).map(({ _id, ...item }) => identity.comment(item)));
    }
    return { ...result, value };
  }
  const mealArchive = createMealAutoArchive({ repository, now });
  const mealPosts = createMealPostService({ repository, now, throttle, archiveForUser: mealArchive.archiveForUser });
  const families = createFamilyService({ repository, membership, bootstrap, throttle, now, cleanupMedia });
  const friendShares = createFriendShares({ repository, membership, familyState, imageReferences, persist, bootstrap, now, throttle });
  async function createUploadTicket(openid, userId, familyId, profile = false, familyDraftRequest = '', mealPhoto = false) {
    await throttle(userId, profile ? 'profileUpload' : 'media', profile ? 10 : 40);
    const id = identifier('upload');
    const path = `private/${openid}/${id}.jpg`;
    const previewPath = `private/${openid}/${id}-preview.jpg`;
    const expiresAt = now() + 3600000;
    const save = db => db.set('media', id, { familyId, userId, path, previewPath, profile, ...(mealPhoto ? { mealPhoto: true } : {}), ...(familyDraftRequest ? { familyDraftRequest } : {}), expiresAt, ...(!profile && !familyDraftRequest ? { uploadInFlightUntil: expiresAt } : {}) });
    if (profile || familyDraftRequest) await save(repository);
    else await mediaOperations.write(userId, familyId, save);
    return { id, path, previewPath };
  }
  async function confirmUpload(event, userId, familyId, profile = false, familyDraftRequest = '', mealPhoto = false) {
    const ticket = await repository.get('media', event.ticket);
    if (!ticket || ticket.userId !== userId || ticket.familyId !== familyId || Boolean(ticket.profile) !== profile || Boolean(ticket.mealPhoto) !== mealPhoto || (ticket.familyDraftRequest || '') !== familyDraftRequest || ticket.expiresAt <= now()) fail('上传授权已过期，请重新选择图片', 'FORBIDDEN');
    if (typeof event.fileId !== 'string' || !event.fileId.startsWith('cloud://') || !event.fileId.endsWith(`/${ticket.path}`)) fail('图片路径不匹配', 'FORBIDDEN');
    if (event.previewFileId !== undefined && (typeof event.previewFileId !== 'string' || !event.previewFileId.startsWith('cloud://') || !ticket.previewPath || !event.previewFileId.endsWith(`/${ticket.previewPath}`))) fail('预览图片路径不匹配', 'FORBIDDEN');
    if (ticket.result) {
      if (ticket.sourceFileId !== event.fileId) fail('图片路径不匹配', 'FORBIDDEN');
      return ticket.result;
    }
    let result;
    const save = async (db, stored) => {
      const fileId = typeof stored === 'string' ? stored : stored.fileId;
      result = { fileId, ...(stored.encryptionKey ? { protected: true } : {}) };
      await db.set('media', hash(fileId), { familyId, userId, fileId, confirmed: true, createdAt: now(), ...(mealPhoto ? { mealPhoto: true } : {}), ...(profile ? { profile: true } : {}), ...(familyDraftRequest ? { familyDraftRequest } : {}), ...(stored.encryptionKey ? { encryptionKey: stored.encryptionKey } : {}), ...(stored.variants ? { variants: stored.variants } : {}), ...(stored.contentType ? { contentType: stored.contentType, bytes: stored.bytes } : {}) });
      await db.set('media', event.ticket, { ...ticket, sourceFileId: event.fileId, result, uploadInFlightUntil: 0 });
    };
    const produce = storageTracker => storeImage(event.fileId, { ...ticket, storageTracker }, event.previewFileId);
    if (profile || familyDraftRequest) {
      const stored = await produce();
      await repository.transaction(db => save(db, stored));
    } else await mediaOperations.store(userId, familyId, produce, save);
    return result;
  }
  async function readMedia(userId, event) {
    const batch = event.action === 'mediaBatch';
    if (batch && (!Array.isArray(event.images) || !event.images.length || event.images.length > 6 || event.images.some(item => !item || !displayVariants.includes(item.variant)))) fail('每次最多读取 6 张预览图');
    const requests = batch ? event.images : [event];
    const validFileId = fileId => typeof fileId === 'string' && fileId.startsWith('cloud://') && fileId.length <= 1000;
    const [family, mediaRecords, postRecords, share, invitation] = await Promise.all([
      optionalFamily(userId),
      readDocumentResults(repository, 'media', requests.filter(request => validFileId(request.fileId)).map(request => hash(request.fileId))),
      readDocumentResults(repository, 'posts', requests.map(request => request.postId), { fields: ['status', 'assetIds'] }),
      event.shareToken ? friendShares.read(repository, event.shareToken) : null,
      event.inviteToken ? readFamilyInvitation(repository, event.inviteToken, now) : null,
    ]);
    let familyImages;
    const coverFamilies = new Map();
    const publishedReads = new Map();
    const read = async request => {
      const { fileId, variant = 'original', knownVersion, transport, postId } = request;
      if (!validFileId(fileId)) fail('图片标识无效');
      if (!['original', ...displayVariants].includes(variant)) fail('图片尺寸无效');
      if (transport !== undefined && transport !== 'url') fail('图片传输方式无效');
      const mediaResult = mediaRecords.get(hash(fileId));
      if (mediaResult?.error) throw mediaResult.error;
      const media = mediaResult?.value;
      if (!media?.confirmed) fail('无权查看图片', 'FORBIDDEN');
      const mealPhotoAllowed = media.mealPhoto && (media.mealPostId ? await canReadMealImage(repository, fileId, userId, media) : media.userId === userId);
      if (media.mealPhoto && !mealPhotoAllowed) fail('无权查看这张餐食照片', 'FORBIDDEN');
      const ownProfile = media.profile && media.userId === userId;
      const ownFamilyDraft = media.familyDraftRequest && media.userId === userId;
      const memberProfile = media.profile && family?.members.some(member => member.avatar === fileId);
      const invitedCover = invitation?.family.cover === fileId && displayVariants.includes(variant);
      if (!mealPhotoAllowed && !ownProfile && !ownFamilyDraft && !memberProfile && !invitedCover && !share?.assetIds.includes(fileId) && (!family || media.familyId !== family.id)) {
        const postResult = postRecords.get(postId);
        if (postResult?.error) throw postResult.error;
        const hintedPost = postResult?.value;
        const hasPublishedHint = hintedPost?.status === 'published' && hintedPost.assetIds?.includes(fileId);
        if (!hasPublishedHint && !publishedReads.has(fileId)) publishedReads.set(fileId, repository.list('posts', { status: 'published', assetIds: { contains: fileId } }, { limit: 1, fields: ['_id'] }));
        if (!hasPublishedHint && !(await publishedReads.get(fileId)).length && !await canReadMealImage(repository, fileId, userId, media) && !await canReadCurrentIdentityImage(repository, { postId, fileId, userId, variant })) {
          if (!coverFamilies.has(media.familyId)) coverFamilies.set(media.familyId, repository.get('families', media.familyId));
          const sourceFamily = await coverFamilies.get(media.familyId);
          const joinedCover = sourceFamily && !sourceFamily.deletedAt && sourceFamily.cover === fileId && sourceFamily.members.some(member => member.id === userId);
          if (!joinedCover) {
            if (!family) fail('无权查看图片', 'FORBIDDEN');
            familyImages ||= familyState(repository, family, userId, true, ['recipes', 'mealSets', 'inventory', 'orders']).then(snapshot => new Set(imageReferences(snapshot)));
            if (!(await familyImages).has(fileId)) fail('无权查看图片', 'FORBIDDEN');
          }
        }
      }
      const version = imageVersion(fileId, variant);
      if (knownVersion === version) return { unchanged: true, version };
      return { ...await measure(`media.deliver.${variant}`, () => readImage(fileId, media, variant, { transport })), version };
    };
    if (!batch) return read(event);
    const results = await Promise.all(requests.map(async request => {
      try { return { ok: true, data: await read(request) }; }
      catch (error) { onError(error, { action: 'mediaBatch' }); return { ok: false, code: error.code || 'INTERNAL', message: error.code ? error.message : '图片暂时无法加载，请重试' }; }
    }));
    return { images: results };
  }
  async function dispatch(event, openid) {
    if (!openid) fail('请在微信中登录后重试', 'UNAUTHENTICATED');
    if (!event || Buffer.byteLength(JSON.stringify(event)) > 800000) fail('请求过大');
    validateEnvelope(event);
    const userId = hash(openid);
    const action = event.action;
    if (action === 'recordAccountVisit') return recordAccountVisit(userId, event.spaceId);
    if (action === 'accountAccess') return accountAccess.status(userId);
    if (action === 'bindAccountPhone') { await throttle(userId, 'phone-login', 10); return accountAccess.bind(userId, event); }
    // Existing released clients retain their protocol. Updated clients must bind
    // before bootstrapping; account identity remains the trusted WeChat OPENID.
    if (action === 'bootstrap') return bootstrap(userId, event);
    if (action === 'switchWorkspace') {
      await throttle(userId, 'workspace', 20);
      await switchWorkspace({ repository, userId, event, now });
      return bootstrap(userId, { includeFeed: false, defaultProfileVersion: event.defaultProfileVersion });
    }
    if (action === 'mediaContent' || action === 'mediaBatch') return readMedia(userId, event);
    if (action === 'command') return command(userId, event);
    if (mealPostActions.includes(action)) return mealPosts(action, event, userId);
    if (familyActions.includes(action)) return families(action, event, userId);
    if (['createDishShare', 'readShare', 'importShare'].includes(action)) return friendShares.handle(action, event, userId);
    if (action === 'profileMediaTicket') return createUploadTicket(openid, userId, `profile-${userId}`, true);
    if (action === 'profileMediaConfirm') return confirmUpload(event, userId, `profile-${userId}`, true);
    if (action === 'familyCoverTicket' || action === 'familyCoverConfirm') {
      if (typeof event.requestId !== 'string' || !/^[\w-]{12,100}$/.test(event.requestId)) fail('请重新打开新建家庭页面');
      const draftFamilyId = `family-draft-${userId}-${event.requestId}`;
      return action === 'familyCoverTicket'
        ? createUploadTicket(openid, userId, draftFamilyId, false, event.requestId)
        : confirmUpload(event, userId, draftFamilyId, false, event.requestId);
    }
    if (action === 'profileUpload') {
      if (typeof event.base64 !== 'string' || !event.base64.length || event.base64.length > 700000 || event.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.base64)) fail('头像格式或大小无效');
      await throttle(userId, 'profileUpload', 10);
      const stored = await storeImageBytes(Buffer.from(event.base64, 'base64'), { familyId: `profile-${userId}`, userId, profile: true });
      await repository.set('media', hash(stored.fileId), { ...stored, userId, familyId: `profile-${userId}`, profile: true, confirmed: true, createdAt: now() });
      return { fileId: stored.fileId };
    }
    let family;
    let requestedPost;
    if (action === 'readPost') [family, requestedPost] = await Promise.all([optionalFamily(userId), repository.get('posts', event.postId)]);
    else ({ family } = await membership(repository, userId));
    if (action === 'createInvite') {
      if (family.kind === 'personal') fail('个人空间不能邀请成员', 'FORBIDDEN');
      if (family.ownerId !== userId) fail('只有家庭管理员可以邀请家人', 'FORBIDDEN');
      if (event.familyId && event.familyId !== family.id) fail('当前家庭已变更，请重试', 'CONFLICT');
      await throttle(userId, 'invite', 5);
      const code = randomBytes(6).toString('hex').toUpperCase();
      const expiresAt = now() + 24 * 60 * 60 * 1000;
      return repository.transaction(async db => {
        const current = (await membership(db, userId)).family;
        if (current.id !== family.id) fail('当前家庭已变更，请重试', 'CONFLICT');
        if (current.kind === 'personal' || current.ownerId !== userId) fail('没有邀请权限', 'FORBIDDEN');
        if (current.inviteId) { const old = await db.get('invites', current.inviteId); if (old) await db.set('invites', current.inviteId, { ...old, revoked: true }); }
        await db.set('invites', hash(code), { familyId: current.id, createdBy: userId, remaining: 19, expiresAt, revoked: false });
        await db.set('families', current.id, { ...current, inviteId: hash(code) });
        return { code, expiresAt, familyName: current.name };
      });
    }
    if (action === 'authorizedImport') return authorizedImport(event, { userId, family });
    if (action === 'feed') {
      const type = ['全部', '菜品', '套餐'].includes(event.type) ? event.type : '全部';
      const where = { status: 'published' };
      if (type !== '全部') where.kind = type === '套餐' ? 'menu' : 'dish';
      if (event.search?.trim()) where.search = { regex: text(event.search, 60, '搜索内容').toLowerCase().split(/\s+/).map(term => `(?=.*${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`).join('') };
      if (event.category && event.category !== '全部' && type !== '套餐') where.categories = { contains: event.category };
      const limit = event.compact === true ? 16 : 30;
      const ownershipFields = ['id', 'familyId', 'familyItemId', 'familyKind', 'publisherId', 'publisherType'];
      const result = await readCommunityFeedPage(repository, { where, cursor: event.cursor || '', limit, sort: event.sort, seed: event.seed, ...(event.compact === true ? { fields: ['card', ...(event.includeImageManifests === true ? ['assetIds'] : []), ...ownershipFields] } : {}) });
      const page = result.rows;
      const legacyPosts = event.compact === true ? await readDocuments(repository, 'posts', page.slice(0, limit).filter(row => !row.card).map(row => row._id)) : new Map();
      const posts = [];
      for (const row of page.slice(0, limit)) {
        if (event.compact !== true) posts.push(publicPost(row));
        else if (row.card) posts.push({ ...row.card, sourceKind: 'community', ...Object.fromEntries(ownershipFields.map(field => [field, field === 'id' ? row.id || row._id : row[field] || ''])) });
        else {
          const legacy = legacyPosts.get(row._id);
          if (legacy?.status === 'published') posts.push(postCard(legacy));
        }
      }
      const authorizations = event.compact === true ? page.slice(0, limit).map(row => row.card ? { status: 'published', assetIds: row.assetIds } : legacyPosts.get(row._id)) : page.slice(0, limit);
      const identity = createIdentityPresentation(repository);
      const presented = await Promise.all(posts.map(post => identity.community(post)));
      return { posts: presented, cursor: result.cursor, feedVersion: 2, media: await signPosts(presented), ...(event.includeImageManifests === true ? { imageManifests: await postImageManifests(posts, authorizations) } : {}) };
    }
    if (action === 'readPost') {
      const post = requestedPost;
      if (!post || post.status !== 'published') fail('这条分享已不存在');
      const [page, imageManifests] = await Promise.all([
        !family || event.includeComments === false ? { comments: [], commentCursor: '' } : event.paginateComments === true ? commentPage(post.id) : all(repository, 'comments', { postId: post.id }).then(comments => ({ comments: comments.map(({ _id, ...item }) => item) })),
        event.includeImageManifests === true ? postImageManifests([post], [post], true) : undefined,
      ]);
      const identity = createIdentityPresentation(repository);
      const safe = await identity.community(publicPost(post));
      page.comments = await Promise.all(page.comments.map(comment => identity.comment(comment)));
      if (!family) { delete safe.familyId; delete safe.familyItemId; delete safe.publisherId; }
      return { post: safe, ...page, media: await signPosts([post]), ...(imageManifests ? { imageManifests } : {}) };
    }
    if (action === 'readComments') {
      const post = await repository.get('posts', event.postId);
      if (!post || post.status !== 'published') fail('这条分享已不存在');
      return commentPage(post.id, event.cursor || '');
    }
    if (action === 'report') {
      await throttle(userId, 'report', 5);
      const post = await repository.get('posts', event.postId);
      if (!post || post.status !== 'published') fail('内容已不存在');
      await repository.set('reports', hash(`${post.id}:${userId}`), { postId: post.id, reporterId: userId, reason: text(event.reason, 300, '举报原因'), status: 'pending', createdAt: now() });
      return {};
    }
    if (action === 'mealMediaTicket' || action === 'mealMediaConfirm') {
      if (event.familyId !== family.id) fail('使用空间已变更，请重新上传', 'CONFLICT');
      return action === 'mealMediaTicket' ? createUploadTicket(openid, userId, family.id, false, '', true) : confirmUpload(event, userId, family.id, false, '', true);
    }
    if (action === 'mediaTicket') {
      if (event.familyId && event.familyId !== family.id) fail('家庭已变更，请重新上传', 'CONFLICT');
      return createUploadTicket(openid, userId, family.id);
    }
    if (action === 'mediaUpload') {
      if (typeof event.base64 !== 'string' || !event.base64.length || event.base64.length > 700000 || event.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.base64)) fail('图片格式或大小无效', 'IMAGE_SIZE');
      if (!storeImageBytes) fail('图片服务暂不可用');
      await throttle(userId, 'media', 40);
      const stored = await mediaOperations.store(userId, family.id,
        storageTracker => storeImageBytes(Buffer.from(event.base64, 'base64'), { familyId: family.id, userId, storageTracker }),
        (db, stored) => db.set('media', hash(stored.fileId), { familyId: family.id, userId, fileId: stored.fileId, confirmed: true, encryptionKey: stored.encryptionKey, ...(stored.variants ? { variants: stored.variants } : {}), createdAt: now() }));
      return { fileId: stored.fileId, protected: true };
    }
    if (action === 'mediaConfirm') {
      if (event.familyId && event.familyId !== family.id) fail('家庭已变更，请重新上传', 'CONFLICT');
      return confirmUpload(event, userId, family.id);
    }
    if (action === 'mediaUrl') {
      const record = typeof event.fileId === 'string' ? await repository.get('media', hash(event.fileId)) : null;
      if (record?.mealPhoto && !(record.mealPostId ? await canReadMealImage(repository, event.fileId, userId, record) : record.userId === userId)) fail('无权查看这张餐食照片', 'FORBIDDEN');
      const media = await repository.get('media', hash(event.fileId || ''));
      if (!media?.confirmed || (media.familyId !== family.id && !await canReadMealImage(repository, event.fileId, userId, media))) fail('无权查看图片', 'FORBIDDEN');
      return { media: await signFiles([media.fileId]) };
    }
    fail('不支持的请求');
  }
  return async (event, context) => {
    try { return { ok: true, data: legacyIngredientAmounts(await dispatch(restoreIngredientCommand(event), context?.OPENID), event?.ingredientUnitsVersion) }; }
    catch (error) {
      onError(error, { action: event?.action });
      return { ok: false, code: error.code || 'INTERNAL', message: error.code ? error.message : '服务暂不可用，请稍后重试', serviceCode: typeof error.errCode === 'number' ? error.errCode : undefined };
    }
  };
}
