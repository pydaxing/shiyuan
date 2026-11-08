/** Offline, read-only audit. No SDK, credentials, network or writes.
 * Input: { collections: { users: [...], families: [...], ... }, completeCollections: [...] }
 * A direct { users: [...], ... } export is also accepted, but missing targets
 * remain unverified unless their collection is explicitly declared complete.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const privateCollections = ['recipes', 'meal_sets', 'orders', 'inventory', 'purchases'];
const collectionNames = ['users', 'families', 'family_public_ids', ...privateCollections, 'posts', 'meal_posts', 'meal_reactions', 'comments', 'invites', 'shares', 'requests', 'media', 'imports', 'reports', 'rate_limits'];
const idOf = row => row?._id || row?.id;
const live = row => row && !row.deletedAt && row.status !== 'deleted';
const isString = value => typeof value === 'string' && value.length > 0;

export function auditDataRelations(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object export');
  const source = input.collections || input;
  const complete = new Set(input.completeCollections || []);
  for (const name of complete) if (!collectionNames.includes(name) || !Array.isArray(source[name])) throw new Error('Complete collections must be included as document arrays');
  const rows = Object.fromEntries(collectionNames.map(name => [name, Array.isArray(source[name]) ? source[name] : []]));
  for (const name of collectionNames) {
    if (source[name] !== undefined && !Array.isArray(source[name])) throw new Error(`Invalid collection format: ${name}`);
    if (rows[name].some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error(`Invalid document format: ${name}`);
  }
  const issues = [];
  // Opaque references intentionally omit business names, file URLs and tokens.
  const ref = (collection, value) => `${collection}:${hash(value).slice(0, 20)}`;
  function add(level, code, collection, row, targetCollection, targetId) {
    issues.push({ level, code, ref: ref(collection, idOf(row) || rows[collection].indexOf(row)), ...(targetCollection && isString(targetId) ? { target: ref(targetCollection, targetId) } : {}) });
  }
  const indexes = Object.fromEntries(collectionNames.map(name => [name, new Map()]));
  for (const name of collectionNames) for (const row of rows[name]) {
    const id = idOf(row);
    if (!isString(id)) { add('error', 'DOCUMENT_ID_MISSING', name, row); continue; }
    if (indexes[name].has(id)) add('error', 'DOCUMENT_ID_DUPLICATE', name, row);
    indexes[name].set(id, row);
    if (row.id && row._id && row.id !== row._id && !privateCollections.includes(name)) add('warning', 'PUBLIC_ID_DIFFERS_FROM_DOCUMENT_KEY', name, row);
  }
  function relation(collection, row, field, targetCollection, targetId = row[field], { optional = false, historical = false } = {}) {
    if (!isString(targetId)) { if (!optional) add('legacy', 'REFERENCE_MISSING', collection, row); return null; }
    const target = indexes[targetCollection].get(targetId);
    if (!target) add(complete.has(targetCollection) ? (historical ? 'info' : 'error') : 'unverified', historical ? 'HISTORICAL_SOURCE_UNAVAILABLE' : 'REFERENCE_UNRESOLVED', collection, row, targetCollection, targetId);
    return target;
  }
  const entityIndexes = Object.fromEntries(privateCollections.map(name => [name, new Map()]));
  for (const name of privateCollections) for (const row of rows[name]) {
    const value = row.value;
    relation(name, row, 'familyId', 'families');
    if (!value || !isString(value.id)) { add('error', 'ENTITY_ID_MISSING', name, row); continue; }
    const key = `${row.familyId}:${value.id}`;
    if (entityIndexes[name].has(key)) add('error', 'ENTITY_ID_DUPLICATE_IN_SPACE', name, row);
    entityIndexes[name].set(key, row);
    if (row._id && row._id !== hash(key)) add('warning', 'COMPOSITE_DOCUMENT_KEY_MISMATCH', name, row);
  }
  for (const user of rows.users) {
    const userId = idOf(user);
    const familyIds = new Set([...(Array.isArray(user.familyIds) ? user.familyIds : []), user.familyId].filter(Boolean));
    for (const familyId of familyIds) {
      const family = relation('users', user, '', 'families', familyId);
      if (family && (!live(family) || family.kind === 'personal' || !family.members?.some(member => member.id === userId))) add('error', 'USER_MEMBERSHIP_DISAGREES', 'users', user, 'families', familyId);
    }
    if (user.personalSpaceId) {
      const space = relation('users', user, 'personalSpaceId', 'families');
      if (space && (space.id !== `personal-${userId}` || space.ownerId !== userId || space.kind !== 'personal')) add('error', 'PERSONAL_SPACE_IDENTITY_INVALID', 'users', user, 'families', user.personalSpaceId);
    }
    if (user.activeMode === 'personal' && !user.personalSpaceId) add('error', 'ACTIVE_PERSONAL_SPACE_MISSING', 'users', user);
  }
  for (const family of rows.families) {
    if (!live(family)) continue;
    const members = Array.isArray(family.members) ? family.members : [];
    if (!members.some(member => member.id === family.ownerId)) add('error', 'FAMILY_OWNER_NOT_MEMBER', 'families', family);
    const seen = new Set();
    for (const member of members) {
      if (!isString(member?.id)) { add('error', 'MEMBER_ID_MISSING', 'families', family); continue; }
      if (seen.has(member.id)) add('error', 'MEMBER_ID_DUPLICATE', 'families', family, 'users', member.id);
      seen.add(member.id);
      const user = relation('families', family, '', 'users', member.id);
      if (!member.membershipId) add('legacy', 'MEMBERSHIP_GENERATION_MISSING', 'families', family, 'users', member.id);
      if (user && (member.name !== user.name || (member.avatar || '') !== (user.avatar || ''))) add('warning', 'MEMBER_PROFILE_DIFFERS', 'families', family, 'users', member.id);
      if (user && family.kind !== 'personal' && user.familyId !== family.id && !user.familyIds?.includes(family.id)) add('error', 'FAMILY_MEMBERSHIP_DISAGREES', 'families', family, 'users', member.id);
    }
    if (family.kind === 'personal' && (family.id !== `personal-${family.ownerId}` || members.length !== 1)) add('error', 'PERSONAL_MEMBERS_INVALID', 'families', family);
  }
  for (const row of rows.family_public_ids) {
    const family = relation('family_public_ids', row, 'familyId', 'families', row.familyId, { historical: true });
    if (family?.publicId && family.publicId !== idOf(row)) add('error', 'PUBLIC_FAMILY_ID_DISAGREES', 'family_public_ids', row, 'families', row.familyId);
  }
  for (const row of rows.meal_reactions) if (row.postId && row.userId && row._id !== hash(`${row.postId}:${row.userId}`)) add('warning', 'REACTION_DOCUMENT_KEY_MISMATCH', 'meal_reactions', row);
  for (const row of rows.requests) {
    if (row.kind === 'retired_family_request_v1') continue;
    if (row.kind === 'meal_post_v1') relation('requests', row, 'postId', 'meal_posts', row.postId, { historical: true });
    else if (row.familyId) relation('requests', row, 'familyId', 'families', row.familyId, { historical: true });
  }
  for (const collection of ['recipes', 'meal_sets']) for (const row of rows[collection]) {
    const item = row.value || {};
    if (item.sourceFamilyId) relation(collection, row, '', 'families', item.sourceFamilyId, { historical: true });
    // sourceId is a published version, not an original recipe ID. Do not join it
    // to recipes by name or require a retained source for an independent copy.
  }
  for (const row of rows.meal_sets) for (const recipeId of row.value?.recipeIds || []) {
    if (!entityIndexes.recipes.has(`${row.familyId}:${recipeId}`)) add(complete.has('recipes') ? 'error' : 'unverified', 'MEAL_SET_RECIPE_UNRESOLVED', 'meal_sets', row, 'recipes', `${row.familyId}:${recipeId}`);
  }
  const reservations = new Set();
  for (const row of rows.orders) {
    const order = row.value || {};
    const key = `${row.familyId}:${order.date}:${order.meal}`;
    if (['pending', 'accepted'].includes(order.status)) {
      if (reservations.has(key)) add('warning', 'MULTIPLE_ACTIVE_ORDERS_SAME_MEAL', 'orders', row);
      reservations.add(key);
    }
    // Orders deliberately contain historical recipe/member snapshots. Deleting
    // a recipe or leaving a family must not invalidate a past meal.
    for (const item of order.items || []) if (!isString(item.recipe?.id)) add('legacy', 'ORDER_RECIPE_REFERENCE_MISSING', 'orders', row);
    if (order.mealPostId) relation('orders', row, '', 'meal_posts', order.mealPostId, { historical: true });
  }
  for (const row of rows.posts) {
    if (!live(row)) continue;
    if (row.publisherType !== 'official' && row.publisherId !== 'official:shiyuan') {
      relation('posts', row, 'publisherId', 'users', row.publisherId, { historical: true });
      relation('posts', row, 'familyId', 'families', row.familyId, { historical: true });
    }
  }
  for (const row of rows.meal_posts) {
    if (!live(row)) continue;
    relation('meal_posts', row, 'spaceId', 'families', row.spaceId, { historical: true });
    relation('meal_posts', row, 'authorId', 'users', row.authorId, { historical: true });
    if (!['public', 'private'].includes(row.visibility) && !(row.visibility === 'family' && row.mealSharingVersion === 2 && row.mealContext === 'family')) add('error', 'MEAL_VISIBILITY_INVALID', 'meal_posts', row);
    const family = indexes.families.get(row.spaceId);
    if (family && !live(family) && row.visibility === 'private') add('warning', 'PRIVATE_MEAL_IN_DELETED_SPACE', 'meal_posts', row);
    if (row.orderId && !entityIndexes.orders.has(`${row.spaceId}:${row.orderId}`)) add(complete.has('orders') ? 'info' : 'unverified', 'HISTORICAL_ORDER_UNAVAILABLE', 'meal_posts', row);
    if ((row.dishes || []).some(dish => !dish.recipeId)) add('legacy', 'MEAL_DISH_SOURCE_REFERENCE_MISSING', 'meal_posts', row);
  }
  const relations = [
    ['meal_reactions', 'postId', 'meal_posts'], ['meal_reactions', 'userId', 'users'],
    ['comments', 'postId', 'posts'], ['comments', 'memberId', 'users'],
    ['reports', 'postId', 'posts'], ['imports', 'postId', 'posts'],
  ];
  for (const [collection, field, target] of relations) for (const row of rows[collection]) {
    if (collection === 'imports' && row.kind) continue; // Global import/review jobs are a different record type.
    const parent = relation(collection, row, field, target, row[field], { historical: true });
    if (collection === 'meal_reactions' && field === 'postId' && parent && !live(parent)) add('info', 'REACTION_ON_DELETED_MEAL', collection, row);
    if (collection === 'comments' && field === 'postId' && row.parentId) {
      const comment = relation(collection, row, 'parentId', 'comments', row.parentId, { historical: true });
      if (comment && comment.postId !== row.postId) add('error', 'COMMENT_PARENT_CROSSES_POST', collection, row, 'comments', row.parentId);
    }
  }
  for (const collection of ['invites', 'shares']) for (const row of rows[collection]) {
    // Revoked/expired links are history, not proof of current access.
    if (row.revoked) continue;
    relation(collection, row, 'familyId', 'families', row.familyId, { historical: true });
  }
  for (const row of rows.media) {
    if (!row.confirmed || !row.mealPostId) continue;
    const post = relation('media', row, 'mealPostId', 'meal_posts', row.mealPostId, { historical: true });
    if (post && (post.spaceId !== row.familyId || post.authorId !== row.mealPostOwnerId)) add('error', 'MEAL_MEDIA_OWNER_DISAGREES', 'media', row);
    if (post && live(post) && !post.assetIds?.includes(row.fileId)) add('warning', 'MEAL_MEDIA_NOT_IN_POST_ASSETS', 'media', row);
  }
  // File variants are physical objects, not necessarily separate media rows.
  const knownFiles = new Set();
  function cloudRefs(value, out) {
    if (typeof value === 'string' && value.startsWith('cloud://')) out.add(value);
    else if (Array.isArray(value)) value.forEach(item => cloudRefs(item, out));
    else if (value && typeof value === 'object') Object.values(value).forEach(item => cloudRefs(item, out));
  }
  rows.media.forEach(row => cloudRefs(row, knownFiles));
  for (const collection of ['users', 'families', ...privateCollections, 'posts', 'meal_posts']) for (const row of rows[collection]) {
    const refs = new Set(); cloudRefs(row, refs);
    for (const fileId of refs) if (!knownFiles.has(fileId)) add(complete.has('media') ? 'warning' : 'unverified', 'MEDIA_REFERENCE_UNRESOLVED', collection, row, 'media', fileId);
  }
  const byLevel = Object.fromEntries(['error', 'warning', 'legacy', 'info', 'unverified'].map(level => [level, issues.filter(issue => issue.level === level).length]));
  const byCode = {};
  issues.forEach(issue => { byCode[issue.code] = (byCode[issue.code] || 0) + 1; });
  return { auditVersion: 1, readOnly: true, scope: 'offline-export', counts: Object.fromEntries(collectionNames.map(name => [name, rows[name].length])), completeCollections: [...complete].sort(), summary: { byLevel, byCode }, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/audit-data-relations.mjs /absolute/path/export.json');
    const result = auditDataRelations(JSON.parse(await readFile(process.argv[2], 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.summary.byLevel.error) process.exitCode = 1;
  } catch {
    // JSON parser errors can quote input containing PII. Never print them.
    process.stderr.write('Audit could not read a valid supported JSON export. No data was changed.\n');
    process.exitCode = 2;
  }
}
