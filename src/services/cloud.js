import { ref } from 'vue';
import { emptySnapshot } from '../domain/empty.js';
import { INGREDIENT_UNITS_VERSION } from '../domain/ingredient-units.js';
import { createMediaCache } from './media-cache.js';
import { createMediaBatch } from './media-batch.js';
import { createImageStorage } from './image-storage.js';
import { createImageManifests } from './image-manifests.js';
import { displayVariants, imageRequest, imageVersion } from '../domain/image-variants.js';
import { createPersistentCache, flushPersistentCaches } from './persistent-cache.js';
import { createCachedReads } from './cached-reads.js';
import { invalidateCommunityFeed } from './community-feed.js';
import { createCommandQueue } from './command-queue.js';
import { createCommandJournal } from './command-journal.js';
import { createImportProvenance } from './import-provenance.js';

export const cloudMode = import.meta.env?.VITE_DATA_MODE === 'cloud';
export const cloudEnvironment = import.meta.env?.VITE_CLOUD_ENV || '';
export const cloudFunction = import.meta.env?.VITE_CLOUD_FUNCTION || 'kitchen';
export const cloudStatus = ref({ phase: cloudMode ? 'connecting' : 'local', error: '', revision: 0, busy: false, syncing: false, pending: 0, userId: '', familyId: '', familyRecoveryRequired: false });
export const commandQueueStatus = ref({ pendingCount: 0, syncing: false, operations: [], failures: [] });
export const mutationStatus = ref({ pending: [], failures: [] });
export const mediaUrls = ref({});
export const mediaFailures = ref({});
export const mediaRecovery = ref(0);
export const mediaScopeRevision = ref(0);
const mediaContexts = new Map();
export const accountProfile = ref({ name: '', avatar: '' });
let shareMediaToken = '';
let inviteMediaToken = '';
let stateRef;
let initialized = false;
let requestSequence = 0;
let pendingRefresh;
let pendingFamilyRecovery;
let deletionUserId = '';
let pendingDeletions = [];
let refreshIsBackground = false;
let commandQueue;
const commandJournal = createCommandJournal({ key: `shiyuan-commands-v1-units${INGREDIENT_UNITS_VERSION}-${cloudEnvironment}-${cloudFunction}` });
const snapshotCache = createPersistentCache(`shiyuan-snapshot-v1-units${INGREDIENT_UNITS_VERSION}-${cloudEnvironment}-${cloudFunction}`, { maxEntries: 1, writeDelay: 150 });
const postDetails = createCachedReads({ cache: createPersistentCache(`shiyuan-details-v3-units${INGREDIENT_UNITS_VERSION}-${cloudEnvironment}-${cloudFunction}`, { maxEntries: 20, writeDelay: 150, validate: entry => Number.isFinite(entry?.savedAt) && typeof entry.value?.post?.id === 'string' && Array.isArray(entry.value.post.recipes) && Array.isArray(entry.value.comments) }) });
const importProvenance = createImportProvenance({ cache: createPersistentCache(`shiyuan-import-provenance-v1-${cloudEnvironment}-${cloudFunction}`, { maxEntries: 8, maxChars: 600000, maxAge: Number.MAX_SAFE_INTEGER }) });
let savedSnapshot;
const currentScope = () => `${cloudEnvironment}:${cloudFunction}:${cloudStatus.value.userId}:${cloudStatus.value.familyId}`;
const imageScope = (scope = currentScope()) => `${scope}${shareMediaToken ? `:share:${shareMediaToken}` : ''}${inviteMediaToken ? `:invite:${inviteMediaToken}` : ''}`;
const fetchDisplayImage = createMediaBatch(invokeCloud);
const imageManifests = createImageManifests();
const imageStorage = createImageStorage(() => wx);
const protectedImages = createMediaCache({
  ...imageStorage,
  prepareImage: async image => {
    try { return await imageStorage.prepareImage(image); }
    catch (error) {
      if (error.code === 'IMAGE_URL') imageManifests.forget(image.version);
      if (!/url not in domain list|domain.*(?:list|valid)|不在.*合法域名/i.test(error.cause?.errMsg || '')) throw error;
      const request = imageRequest(image.version || '');
      if (!displayVariants.includes(request.variant)) throw new Error('原图下载域名尚未配置，请联系管理员');
      return imageStorage.prepareImage(await invokeCloud('mediaContent', { ...request, ...(mediaContexts.has(request.fileId) ? { postId: mediaContexts.get(request.fileId) } : {}) }));
    }
  },
  urls: mediaUrls,
  concurrency: 6,
  maxEntries: 400,
  maxBytes: 48 * 1024 * 1024,
  priority: key => imageRequest(key).variant === 'original',
  fetchImage: (key, knownVersion) => {
    const image = imageRequest(key);
    const manifest = imageManifests.get(key);
    if (manifest) return Promise.resolve(knownVersion === key ? { unchanged: true, version: key, urlExpiresAt: manifest.urlExpiresAt } : manifest);
    const request = { ...image, knownVersion, transport: 'url', ...(mediaContexts.has(image.fileId) ? { postId: mediaContexts.get(image.fileId) } : {}) };
    return request.variant === 'original' ? invokeCloud('mediaContent', request) : fetchDisplayImage(request);
  },
  onError: (error, key) => { mediaFailures.value[key] = error.message || '图片加载失败'; },
  onSuccess: key => { delete mediaFailures.value[key]; },
});
export function bindCloudState(state) {
  stateRef = state;
  let renderedScope = '';
  commandQueue = createCommandQueue({
    snapshot: state.value,
    journal: commandJournal,
    send: async payload => {
      if (pendingRefresh) await pendingRefresh.catch(() => {});
      postDetails.clear();
      return invokeCloud('command', payload);
    },
    reconcile: async (result, operationId) => {
      const operation = commandQueueStatus.value.operations.find(entry => entry.id === operationId);
      await applyCloudResult(result, 'command', operationId);
      postDetails.clear();
      if (['publishToCommunity', 'deleteCommunityPost', 'addCollection'].includes(operation?.name)) invalidateCommunityFeed({ reset: false });
    },
    refresh: () => cloudCall('bootstrap'),
    onChange: snapshot => {
      const scope = commandQueue?.getScope() || '';
      if ((renderedScope && scope !== renderedScope) || snapshot.family.id !== stateRef.value.family.id || snapshot.activeMemberId !== stateRef.value.activeMemberId) stateRef.value = snapshot;
      else for (const [field, value] of Object.entries(snapshot)) if (JSON.stringify(stateRef.value[field]) !== JSON.stringify(value)) stateRef.value[field] = value;
      renderedScope = scope;
    },
    onStatus: status => {
      commandQueueStatus.value = status;
      mutationStatus.value = { pending: status.operations.filter(operation => operation.status !== 'failed'), failures: status.failures };
      cloudStatus.value.syncing = status.syncing;
      cloudStatus.value.pending = status.pendingCount;
    },
    onFailure: error => {
      cloudStatus.value.error = error.message || '同步失败，请重试';
      if (['NO_FAMILY', 'UNAUTHENTICATED'].includes(error.code)) clearCloudIdentity(error);
    },
  });
  const saved = cloudMode ? snapshotCache.get('current') : undefined;
  savedSnapshot = undefined;
  if (saved?.familyId && saved.userId && Number.isSafeInteger(saved.revision) && saved.snapshot?.family?.id === saved.familyId && saved.snapshot.activeMemberId === saved.userId && Array.isArray(saved.snapshot.family.members) && saved.snapshot.family.members.some(member => member?.id === saved.userId) && ['recipes', 'mealSets', 'orders', 'inventory', 'purchases'].every(field => Array.isArray(saved.snapshot[field]))) savedSnapshot = saved;
}

function queueContext() { return { scope: cloudStatus.value.familyId ? currentScope() : '', familyId: cloudStatus.value.familyId, userId: cloudStatus.value.userId, revision: cloudStatus.value.revision }; }
function ensureQueueContext() {
  if (commandQueue.getScope() !== queueContext().scope) commandQueue.activate(stateRef.value, queueContext());
}
function clearCloudIdentity(error) {
  clearPrivateCache();
  cloudStatus.value = { ...cloudStatus.value, familyId: '', userId: '', revision: 0, phase: error.code === 'NO_FAMILY' ? 'onboarding' : 'error' };
  commandQueue.activate(emptySnapshot(), queueContext());
}

export function retryCommand(id) { ensureQueueContext(); return commandQueue.retry(id); }
export function discardCommand(id) { ensureQueueContext(); return commandQueue.discard(id); }
export const retryMutation = retryCommand;
export const dismissMutation = discardCommand;

export function mergeCloudCommunity({ posts = [], comments = [], removePostIds = [] } = {}) {
  if (!commandQueue || cloudStatus.value.phase !== 'ready') return;
  ensureQueueContext();
  const previous = commandQueue.getBase();
  const next = { ...previous,
    posts: [...new Map([...previous.posts, ...posts].map(post => [post.id, post])).values()].filter(post => !removePostIds.includes(post.id)),
    comments: [...new Map([...previous.comments, ...comments].map(comment => [comment.id, comment])).values()].filter(comment => !removePostIds.includes(comment.postId)),
  };
  commandQueue.receive(next, commandQueue.getRevision());
}
function clearImages() { protectedImages.clear(); imageManifests.clear(); mediaFailures.value = {}; mediaContexts.clear(); mediaScopeRevision.value += 1; }
function activateImages(scope) { protectedImages.activate?.(scope); imageManifests.activate(scope); }
function clearPrivateCache() { savedSnapshot = undefined; snapshotCache.clear(); postDetails.clear(); invalidateCommunityFeed(); clearImages(); }
function postDetailKey(postId, options) { return options.includeComments === false ? `${postId}:no-comments` : postId; }
export function peekCommunityPost(postId, options = {}) { return postDetails.peek(currentScope(), postDetailKey(postId, options)); }
export function readCommunityPost(postId, options = {}) { return postDetails.read(currentScope(), postDetailKey(postId, options), () => invokeCloud('readPost', { postId, paginateComments: true, includeComments: options.includeComments !== false })); }
export function flushCloudCache() { protectedImages.flush?.(); flushPersistentCaches(); }
export function recoverVisibleImages() { mediaRecovery.value += 1; }
export function setShareMediaToken(token = '') {
  shareMediaToken = token;
  activateImages(imageScope());
  mediaFailures.value = {};
  mediaScopeRevision.value += 1;
}
export function setInviteMediaToken(token = '') {
  inviteMediaToken = token;
  activateImages(imageScope());
  mediaFailures.value = {};
  mediaScopeRevision.value += 1;
}
export function rememberMedia(media = {}) {
  for (const [key, value] of Object.entries(media)) {
    if (typeof value === 'string') mediaUrls.value[key] = value;
    else if (typeof value?.postId === 'string') mediaContexts.set(key, value.postId);
  }
  while (mediaContexts.size > 2000) mediaContexts.delete(mediaContexts.keys().next().value);
}
export function resolveImage(value, variant = 'card', options) {
  if (typeof value !== 'string' || !value.startsWith('cloud://')) return value;
  if (!cloudMode) return mediaUrls.value[value] || '';
  const version = imageVersion(value, variant);
  const resolved = protectedImages.resolve(version, options);
  return resolved || (variant === 'detail' ? protectedImages.peek(imageVersion(value, 'card')) : '');
}
export function peekImage(value, variant = 'card') {
  if (typeof value !== 'string' || !value.startsWith('cloud://')) return value;
  if (!cloudMode) return mediaUrls.value[value] || '';
  return protectedImages.peek(imageVersion(value, variant)) || (variant === 'detail' ? protectedImages.peek(imageVersion(value, 'card')) : '');
}
export function loadImage(value, variant = 'card', options) {
  return cloudMode && typeof value === 'string' && value.startsWith('cloud://') ? protectedImages.load(imageVersion(value, variant), options) : Promise.resolve(resolveImage(value, variant));
}

export async function invokeCloud(action, payload = {}) {
  if (!cloudEnvironment) throw new Error('尚未配置云开发环境，请联系管理员');
  if (typeof wx === 'undefined' || !wx.cloud) throw new Error('请在微信小程序中使用云端家庭');
  if (!initialized) { wx.cloud.init({ env: cloudEnvironment, traceUser: false }); initialized = true; }
  const manifestContext = imageManifests.context();
  const includesManifests = ['feed', 'readPost'].includes(action);
  const imageAccess = ['mediaContent', 'mediaBatch'].includes(action) ? { ...(shareMediaToken ? { shareToken: shareMediaToken } : {}), ...(inviteMediaToken ? { inviteToken: inviteMediaToken } : {}) } : {};
  const response = await wx.cloud.callFunction({ name: cloudFunction, data: { action, ...imageAccess, ...(includesManifests ? { includeImageManifests: true } : {}), ...payload, ingredientUnitsVersion: INGREDIENT_UNITS_VERSION } });
  if (!response.result?.ok) {
    const error = new Error(response.result?.message || '服务暂不可用，请稍后重试');
    error.code = response.result?.code;
    error.serverRejected = response.result?.ok === false;
    throw error;
  }
  if (includesManifests) {
    const { imageManifests: manifests, ...result } = response.result.data;
    imageManifests.remember(manifests, manifestContext);
    return result;
  }
  return response.result.data;
}

async function applyCloudResult(input, action, operationId) {
  let result = input;
  const previousScope = currentScope();
  const before = commandQueue.getBase();
  const operation = commandQueueStatus.value.operations.find(entry => entry.id === operationId);
  // Only a directly acknowledged patch proves which records this import created.
  const canRecordImport = operation?.name === 'addCollection' && Boolean(input.changes) && input.baseRevision === commandQueue.getRevision() && input.familyId === cloudStatus.value.familyId && (!input.userId || input.userId === cloudStatus.value.userId);
  if (result.unchanged && (!cloudStatus.value.familyId || (result.userId && result.userId !== cloudStatus.value.userId) || result.familyId !== cloudStatus.value.familyId)) {
    if (savedSnapshot?.familyId === result.familyId && savedSnapshot.userId === result.userId && savedSnapshot.revision === result.revision) result = { ...result, snapshot: savedSnapshot.snapshot };
    else { clearPrivateCache(); result = await invokeCloud('bootstrap', { includeFeed: false }); }
  }
  if (result.changes && (result.familyId !== cloudStatus.value.familyId || (result.userId && result.userId !== cloudStatus.value.userId) || result.baseRevision !== commandQueue.getRevision())) {
    result = { ...await invokeCloud('bootstrap', { includeFeed: false }), value: result.value, ...(result.commentChanges ? { commentChanges: result.commentChanges } : {}) };
  }
  if (operationId && (result.familyId !== cloudStatus.value.familyId || (result.userId && result.userId !== cloudStatus.value.userId))) throw Object.assign(new Error('家庭已变化，操作结果保留在原家庭，请重新同步核对'), { code: 'SCOPE_CHANGED' });
  if (result.profile) accountProfile.value = result.profile;
  const changedScope = Boolean(result.familyId !== cloudStatus.value.familyId || (result.userId && result.userId !== cloudStatus.value.userId));
  if (!changedScope && result.revision < commandQueue.getRevision()) {
    if (operationId) commandQueue.receive(commandQueue.getBase(), commandQueue.getRevision(), operationId);
    return result;
  }
  let next = changedScope ? result.snapshot || emptySnapshot() : { ...commandQueue.getBase() };
  if (result.snapshot && !changedScope) {
    for (const [field, value] of Object.entries(result.snapshot)) {
      if (field === 'comments' && (action === 'bootstrap' || result.commentChanges)) continue;
      if (field === 'posts' && !value.length) continue;
      next[field] = value;
    }
  }
  if (result.changes) for (const field of ['family', 'recipes', 'mealSets', 'orders', 'inventory', 'purchases', 'comments']) if (result.changes[field] !== undefined) next[field] = result.changes[field];
  if (result.commentChanges?.length) next.comments = [...new Map([...next.comments, ...result.commentChanges].map(entry => [entry.id, entry])).values()].sort((left, right) => left.id.localeCompare(right.id));
  const updates = result.postChanges?.upsert || [];
  const removed = result.postChanges?.remove || (operation?.name === 'deleteCommunityPost' ? [operation.args[0]] : []);
  if (updates.length || removed.length) {
    next.posts = next.posts.filter(post => !removed.includes(post.id)).map(post => updates.find(entry => entry.id === post.id) || post);
    next.comments = next.comments.filter(comment => !removed.includes(comment.postId));
    if (Array.isArray(next.sharedItems)) next.sharedItems = next.sharedItems.filter(item => !removed.includes(item.postId));
  }
  if (changedScope) {
    if (cloudStatus.value.familyId || (savedSnapshot && (savedSnapshot.familyId !== result.familyId || savedSnapshot.userId !== result.userId))) clearPrivateCache();
    activateImages(imageScope(`${cloudEnvironment}:${cloudFunction}:${result.userId}:${result.familyId}`));
  }
  if (result.needsFamily) { next = emptySnapshot(); clearPrivateCache(); }
  observeFamilyDeletions(result, result.userId || cloudStatus.value.userId);
  const recoveryRequired = Boolean(pendingFamilyRecovery || pendingDeletions.length);
  cloudStatus.value = { ...cloudStatus.value, phase: result.needsFamily ? (recoveryRequired ? 'error' : 'onboarding') : 'ready', error: recoveryRequired ? familyRecoveryError().message : '', familyRecoveryRequired: recoveryRequired, pendingDeletions: [...pendingDeletions], revision: result.revision ?? cloudStatus.value.revision, userId: result.userId || cloudStatus.value.userId, familyId: result.familyId || '', lastSyncedAt: Date.now() };
  if (canRecordImport && !changedScope && !result.needsFamily) {
    const collection = updates.find(post => post.id === operation.args[0]?.id) || operation.args[0];
    importProvenance.record(currentScope(), before, next, collection);
  }
  if (!result.needsFamily && cloudStatus.value.familyId) next = importProvenance.apply(currentScope(), next);
  if (commandQueue.getScope() !== queueContext().scope || previousScope !== currentScope()) commandQueue.activate(next, queueContext());
  else commandQueue.receive(next, cloudStatus.value.revision, operationId);
  rememberMedia(result.media);
  imageManifests.remember(result.imageManifests);
  if (result.snapshot || result.changes) {
    savedSnapshot = { familyId: cloudStatus.value.familyId, userId: cloudStatus.value.userId, revision: cloudStatus.value.revision, snapshot: { ...commandQueue.getBase(), posts: [], comments: [] } };
    snapshotCache.set('current', savedSnapshot);
  }
  return result;
}

export async function cloudCall(action, payload = {}) {
  const sequence = ++requestSequence;
  try {
    if (cloudStatus.value.phase === 'ready') ensureQueueContext();
    const result = await invokeCloud(action, action === 'bootstrap' ? { includeFeed: false, includeSharedItems: !Array.isArray(commandQueue.getBase().sharedItems), includeImageManifests: cloudStatus.value.phase !== 'ready', ...payload } : payload);
    if (sequence !== requestSequence) return result;
    return await applyCloudResult(result, action);
  } catch (error) {
    if (sequence !== requestSequence) throw error;
    cloudStatus.value.error = error.message || '网络连接失败，请重试';
    if (['NO_FAMILY', 'UNAUTHENTICATED'].includes(error.code)) clearCloudIdentity(error);
    else if (!cloudStatus.value.familyId) cloudStatus.value.phase = 'error';
    throw error;
  }
}

export function refreshCloud({ background = false } = {}) {
  if (cloudStatus.value.busy) return Promise.resolve();
  if (cloudStatus.value.familyRecoveryRequired) return recoverFamilyState();
  if (pendingRefresh) {
    if (!background && refreshIsBackground) return pendingRefresh.then(() => refreshCloud());
    return pendingRefresh;
  }
  if (background && cloudStatus.value.phase === 'ready' && Date.now() - (cloudStatus.value.lastSyncedAt || 0) < 15000) return Promise.resolve();
  const known = cloudStatus.value.phase === 'ready' && cloudStatus.value.familyId ? cloudStatus.value : savedSnapshot;
  const payload = background && known ? { knownFamilyId: known.familyId, knownRevision: known.revision } : {};
  refreshIsBackground = background;
  commandQueue.pause();
  const loading = commandQueue.isRunning() ? commandQueue.whenIdle().then(() => cloudCall('bootstrap', payload)) : cloudCall('bootstrap', payload);
  pendingRefresh = loading.finally(() => { pendingRefresh = undefined; commandQueue.resume(); });
  return pendingRefresh;
}

export function remoteAction(name, args) {
  if (cloudStatus.value.phase !== 'ready') return Promise.reject(new Error('请先创建或加入家庭'));
  if (cloudStatus.value.familyRecoveryRequired) return Promise.reject(familyRecoveryError());
  if (cloudStatus.value.busy) return Promise.reject(new Error('正在保存家庭变更，请稍后再操作'));
  ensureQueueContext();
  return commandQueue.enqueue(name, args);
}

function familyRecoveryError(cause) {
  const clearing = pendingDeletions.length || pendingFamilyRecovery?.requiresDeletion;
  const message = clearing
    ? '家庭已停用，私有数据尚未确认清理完成，请继续清理。'
    : '退出或删除的结果尚未确认，请重新同步家庭状态后再操作。';
  return Object.assign(new Error(message), { code: 'FAMILY_RECOVERY_REQUIRED', cause });
}

function observeFamilyDeletions(result, userId) {
  if (!userId) return;
  if (deletionUserId !== userId) {
    deletionUserId = userId;
    pendingDeletions = [];
    if (pendingFamilyRecovery?.userId !== userId) pendingFamilyRecovery = undefined;
  }
  const valid = item => item && typeof item.familyId === 'string' && item.familyId.length > 0 && item.familyId.length <= 200 && ['pending', 'complete'].includes(item.status);
  if (result.pendingDeletions !== undefined) {
    if (!Array.isArray(result.pendingDeletions) || !result.pendingDeletions.every(valid)) throw familyRecoveryError(new Error('家庭清理进度读取不完整'));
    pendingDeletions = result.pendingDeletions.filter(item => item.status === 'pending');
  }
  if (result.deletion !== undefined) {
    if (!valid(result.deletion)) throw familyRecoveryError(new Error('家庭清理进度读取不完整'));
    pendingDeletions = pendingDeletions.filter(item => item.familyId !== result.deletion.familyId);
    if (result.deletion.status === 'pending') pendingDeletions.push(result.deletion);
  }
}

function assertRecoveryUser(userId, result) {
  if (!userId || cloudStatus.value.userId !== userId || (result?.userId && result.userId !== userId)) {
    throw Object.assign(new Error('登录账号已变化，请重新同步当前账号的家庭状态'), { code: 'SCOPE_CHANGED' });
  }
}

function finishFamilyRecovery() {
  pendingFamilyRecovery = undefined;
  cloudStatus.value.familyRecoveryRequired = pendingDeletions.length > 0;
  cloudStatus.value.pendingDeletions = [...pendingDeletions];
  cloudStatus.value.error = pendingDeletions.length ? familyRecoveryError().message : '';
  if (!cloudStatus.value.familyId) cloudStatus.value.phase = pendingDeletions.length ? 'error' : 'onboarding';
}

// A continuation always targets a server-confirmed deletion or the exact family
// from the unresolved delete request. Never substitute the newly active family.
async function continueFamilyDeletions(userId, requiredFamilyId = '') {
  const targets = [...new Set([...pendingDeletions.map(item => item.familyId), requiredFamilyId].filter(Boolean))];
  const deadline = Date.now() + 20000;
  let result;
  let calls = 0;
  for (const familyId of targets) {
    while (calls < 3 && Date.now() < deadline) {
      assertRecoveryUser(userId);
      result = await invokeCloud('continueFamilyDeletion', { familyId });
      calls += 1;
      assertRecoveryUser(userId, result);
      if (result?.userId !== userId || result?.deletion?.familyId !== familyId || !['pending', 'complete'].includes(result.deletion.status)) {
        throw familyRecoveryError(new Error('家庭清理结果读取不完整'));
      }
      await applyCloudResult(result, 'continueFamilyDeletion');
      if (result.deletion.status === 'complete') break;
    }
    if (result?.deletion?.familyId !== familyId || result.deletion.status !== 'complete') throw familyRecoveryError();
  }
  return result;
}

async function reconcileFamilyState() {
  const pending = pendingFamilyRecovery;
  const expectedUserId = pending?.userId || cloudStatus.value.userId;
  try {
    let snapshot = await cloudCall('bootstrap');
    const userId = cloudStatus.value.userId;
    if (expectedUserId) assertRecoveryUser(expectedUserId, snapshot);
    const result = await invokeCloud('listFamilies');
    assertRecoveryUser(userId);
    if (!Array.isArray(result.families)) throw new Error('家庭身份读取不完整，请重试');
    observeFamilyDeletions(result, userId);
    const removed = Boolean(pending && !pending.rejected && pending.userId === userId && !result.families.some(family => family.id === pending.familyId));
    const continuation = await continueFamilyDeletions(userId, removed && pending?.requiresDeletion ? pending.familyId : '');
    if (continuation) snapshot = continuation;
    finishFamilyRecovery();
    return { ...snapshot, families: result.families, recovered: true, removed };
  } catch (cause) {
    if (cause.code === 'SCOPE_CHANGED') throw cause;
    const error = familyRecoveryError(cause);
    cloudStatus.value.familyRecoveryRequired = true;
    cloudStatus.value.error = error.message;
    if (!cloudStatus.value.familyId) cloudStatus.value.phase = 'error';
    throw error;
  }
}

export async function recoverFamilyState() {
  if (cloudStatus.value.busy) throw new Error('正在同步家庭状态，请稍后重试');
  if (commandQueue.hasUnresolved()) throw new Error('还有待同步或失败的操作，请先处理后再同步家庭状态');
  cloudStatus.value.busy = true;
  try {
    if (pendingRefresh) await pendingRefresh.catch(() => {});
    return await reconcileFamilyState();
  } finally { cloudStatus.value.busy = false; }
}

export async function manageFamily(action, payload = {}) {
  if (cloudStatus.value.familyRecoveryRequired) throw familyRecoveryError();
  if (cloudStatus.value.busy) throw new Error('正在保存，请稍后再切换家庭');
  if (commandQueue.hasUnresolved()) throw new Error('还有待同步或失败的操作，请先重试或处理后再切换家庭');
  cloudStatus.value.busy = true;
  try {
    if (pendingRefresh) await pendingRefresh.catch(() => {});
    if (commandQueue.hasUnresolved()) throw new Error('还有待同步或失败的操作，请先处理后再变更家庭');
    const removesMembership = ['leaveFamily', 'deleteFamily'].includes(action);
    // Versioned actions make old services reject before detaching membership.
    // The server decides whether an exit is the last one, including concurrent exits.
    const requestAction = removesMembership ? `${action}WithCleanup` : action === 'createFamily' ? ('coverSubtitle' in payload ? 'createFamilyWithSubtitle' : 'cover' in payload || 'coverTitle' in payload ? 'createFamilyWithAppearance' : action) : action;
    const request = { familyId: cloudStatus.value.familyId, ...payload };
    const userId = cloudStatus.value.userId;
    let response;
    try { response = await cloudCall(requestAction, request); }
    catch (error) {
      if (removesMembership && /不支持.*(请求|操作)/.test(error.message)) {
        error.message = '请先更新家庭服务，再退出或删除家庭';
        cloudStatus.value.error = error.message;
        throw error;
      }
      if (removesMembership && request.familyId) {
        if (cloudStatus.value.userId && cloudStatus.value.userId !== userId) assertRecoveryUser(userId);
        // An acknowledged business refusal did not submit this removal. Still
        // refresh memberships, but only resume deletion tasks the server lists.
        const rejected = error.serverRejected === true && ['FORBIDDEN', 'CONFLICT', 'NO_FAMILY', 'UNAUTHENTICATED', 'INVALID', 'RATE_LIMIT'].includes(error.code);
        pendingFamilyRecovery = { userId, familyId: request.familyId, rejected, requiresDeletion: !rejected && action === 'deleteFamily' };
        cloudStatus.value.familyRecoveryRequired = true;
        const recovery = await reconcileFamilyState();
        if (recovery.removed) return recovery;
        cloudStatus.value.error = error.message;
      }
      if (requestAction === 'createFamilyWithSubtitle' && /不支持.*(请求|操作)/.test(error.message)) error.message = '请更新家庭服务后再创建带主副标题的小家';
      throw error;
    }
    if (response.deletion || action === 'deleteFamily') {
      assertRecoveryUser(userId, response);
      if (response.deletion?.familyId !== request.familyId && response.deletion !== undefined) throw familyRecoveryError(new Error('家庭清理目标不一致'));
      if (response.deletion?.status === 'complete') { finishFamilyRecovery(); return response; }
      pendingFamilyRecovery = { userId, familyId: request.familyId, requiresDeletion: true };
      cloudStatus.value.familyRecoveryRequired = true;
      try {
        const completed = await continueFamilyDeletions(userId, request.familyId);
        finishFamilyRecovery();
        return completed;
      } catch (cause) {
        if (cause.code === 'SCOPE_CHANGED') throw cause;
        const error = familyRecoveryError(cause);
        cloudStatus.value.error = error.message;
        if (!cloudStatus.value.familyId) cloudStatus.value.phase = 'error';
        throw error;
      }
    }
    return response;
  } finally { cloudStatus.value.busy = false; }
}

export async function uploadProfileAvatar(path, previews = {}) {
  const userId = cloudStatus.value.userId;
  const confirmed = await transferImage(path, 'profileMediaTicket', 'profileMediaConfirm', undefined, previews.previewPath || previews.cardPath, previews.onStage);
  if (cloudStatus.value.userId !== userId) throw new Error('登录状态已变更，请重新上传');
  await primeUploadedPreview(confirmed.fileId, previews);
  return confirmed.fileId;
}

export async function uploadFamilyCoverDraft(path, requestId, previews = {}) {
  const userId = cloudStatus.value.userId;
  const confirmed = await transferImage(path, 'familyCoverTicket', 'familyCoverConfirm', undefined, previews.previewPath || previews.cardPath, previews.onStage, { requestId });
  if (cloudStatus.value.userId !== userId) throw new Error('登录状态已变更，请重新上传');
  await primeUploadedPreview(confirmed.fileId, previews);
  return confirmed.fileId;
}

function uploadImageFile(filePath, cloudPath, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const success = value => { finished = true; resolve(value); };
    const fail = error => { finished = true; reject(error); };
    const task = wx.cloud.uploadFile({ filePath, cloudPath, success, fail });
    task?.onProgressUpdate?.(event => { if (!finished) onProgress(event); });
    task?.then?.(success, fail);
  });
}

async function transferImage(path, ticketAction, confirmAction, familyId, previewPath, onStage = () => {}, context = {}) {
  try {
    const scope = { ...context, ...(familyId ? { familyId } : {}) };
    const ticket = await invokeCloud(ticketAction, scope);
    const [uploaded, preview] = await Promise.all([
      uploadImageFile(path, ticket.path, event => onStage({ status: 'uploading', progress: event.progress })),
      ticket.previewPath && previewPath ? uploadImageFile(previewPath, ticket.previewPath) : undefined,
    ]);
    onStage({ status: 'saving' });
    return await invokeCloud(confirmAction, { ...scope, ticket: ticket.id, fileId: uploaded.fileID, ...(preview ? { previewFileId: preview.fileID } : {}) });
  } catch (failure) {
    if (failure.code && failure.message && !/cloud\.|callId:|trace:/i.test(failure.message)) throw failure;
    const detail = failure?.errMsg || failure?.message || '';
    const message = /no such file|not exist|ENOENT/i.test(detail) ? '这张照片暂时无法读取，请重新选择'
      : /permission|auth|denied/i.test(detail) ? '图片上传授权暂不可用，请重新进入小程序后重试'
      : /exceed.*size|request.*large/i.test(detail) ? '图片传输失败，请重新进入新版小程序后重试'
      : '图片上传未完成，请检查网络后重试';
    const error = new Error(message);
    error.code = 'IMAGE_TRANSFER';
    throw error;
  }
}

async function primeUploadedPreview(fileId, { previewPath, cardPath }) {
  await Promise.all([['detail', previewPath], ['card', cardPath]].filter(([, path]) => path).map(([variant, path]) => protectedImages.prime(imageVersion(fileId, variant), path).catch(() => {})));
}

export async function uploadCloudImage(path, previews = {}) {
  if (cloudStatus.value.phase !== 'ready') throw new Error('请先加入家庭');
  const familyId = cloudStatus.value.familyId;
  const confirmed = await transferImage(path, 'mediaTicket', 'mediaConfirm', familyId, previews.previewPath || previews.cardPath, previews.onStage);
  if (cloudStatus.value.familyId !== familyId || cloudStatus.value.phase !== 'ready') throw new Error('家庭已变更，请重新上传');
  if (confirmed.protected) {
    await primeUploadedPreview(confirmed.fileId, previews);
    return confirmed.fileId;
  }
  const signed = await invokeCloud('mediaUrl', { fileId: confirmed.fileId });
  rememberMedia(signed.media);
  if (signed.media[confirmed.fileId]?.protected) await protectedImages.load(imageVersion(confirmed.fileId, 'card'));
  return confirmed.fileId;
}
