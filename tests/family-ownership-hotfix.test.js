import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { buildFamilyOwnershipHotfix } from '../scripts/build-family-ownership-hotfix.mjs';

const baseline = `var privateImageDelivery = { preserved: true };
var ingredientUnitProtocol = { version: 'production-only' };
function recipeFieldErrors(recipe) {
  return {};
}
function validateRecipe(recipe) {
  return true;
}
function familyPublications(snapshot) {
  return [];
}
function canDeleteCommunityPost(post, memberId) {
  return post.publisherId === memberId;
}
// server/friend-shares.mjs
var import_node_crypto3 = require("node:crypto");
var hash2 = (value) => (0, import_node_crypto3.createHash)("sha256").update(value).digest("hex");
var fail3 = (message, code = "INVALID") => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
function createFriendShares({ repository, membership, familyState, imageReferences: imageReferences2, persist, bootstrap, now, throttle }) {
  return {};
}
function importCollection(recipes, collection) {
  return recipes;
}
function createKitchenActions() {
  function saveRecipe(recipe, editingId) {
    validateRecipe(recipe);
    preserveProductionAction(recipe);
  }
  function deleteCommunityPost(postId) {
    legacyDeletion(postId);
  }
  function addCollection(collection) {
    legacyImport(collection);
  }
}
function normalizeCommand(name, args) {
  validateRecipe(recipe);
  preserveProductionNormalization(args);
}
function createApplication() {
  function postCard(post) {
    return post.card;
  }
  async function mutate() {
        if (name === "deleteCommunityPost" && !canDeleteCommunityPost(post, userId))
          fail4("cannot delete", "FORBIDDEN");
        if (post.familyId === family.id)
          await persist(db, before, snapshot, []);
        else if (post.familyId) {
          updateSourceFamily(post.familyId);
        }
    preserveProductionTransaction();
  }
  async function feed() {
      const result = await readCommunityFeedPage(repository, {});
      for (const row of result.rows) {
        if (!row.card) preserveLegacyFeed(row);
        else if (row.card)
          posts.push(row.card);
      }
    preserveProductionMediaAuthorization();
  }
}
`;

test('family ownership patch preserves unrelated production logic and contains only declared replacements', async () => {
  const { code, replacements } = await buildFamilyOwnershipHotfix(baseline);
  const context = vm.createContext({ require: createRequire(import.meta.url) });
  vm.runInContext(code, context);
  assert.equal(context.privateImageDelivery.preserved, true);
  assert.equal(context.ingredientUnitProtocol.version, 'production-only');
  for (const marker of ['preserveProductionAction(recipe)', 'preserveProductionNormalization(args)', 'preserveProductionTransaction()', 'preserveProductionMediaAuthorization()']) assert.ok(code.includes(marker), marker);
  assert.equal(replacements.length, 16);
  assert.equal(new Set(replacements.map(item => item.label)).size, 16);
  assert.ok(replacements.every(item => item.beforeSha256 !== item.afterSha256));
  assert.ok(code.includes('canDeleteCommunityPost(post, userId, family.id)'));
  assert.ok(code.includes('validateRecipe(recipe, { requireStepTitles: true });'));
  assert.ok(code.includes('const ownershipFields ='));
  assert.ok(code.includes('function matchesImportedSource('));
  assert.ok(code.includes('sourceFamilyId: collection.familyId'));
  assert.ok(code.includes('shareId: newId("shared-dish")'));
  assert.ok(code.includes('fail4("cannot delete", "FORBIDDEN")'));
  assert.doesNotMatch(code, /fail5\(|import_node_crypto5\./);
});

test('friend share extraction keeps the production crypto and error helper bindings', async () => {
  const { code } = await buildFamilyOwnershipHotfix(baseline);
  const context = vm.createContext({ require: createRequire(import.meta.url) });
  vm.runInContext(code, context);
  const shares = context.createFriendShares({ now: () => 100 });
  await assert.rejects(shares.read({}, 'invalid'), { code: 'INVALID' });
  const token = 'a'.repeat(48);
  const lookups = [];
  await assert.rejects(shares.read({ get: async (...args) => { lookups.push(args); return null; } }, token), { code: 'SHARE_EXPIRED' });
  assert.deepEqual(lookups, [['shares', createHash('sha256').update(token).digest('hex')]]);
  context.makeShare = () => JSON.stringify({ title: '菜品', kind: 'dish', image: '' });
  const writes = [];
  const db = { set: async (...args) => { writes.push(args); } };
  const shareCreator = context.createFriendShares({
    repository: { transaction: operation => operation(db) },
    membership: async () => ({ family: { id: 'family', name: '家庭', members: [{ id: 'user', membershipId: 'membership' }] } }),
    familyState: async () => ({ recipes: [{ id: 'dish' }] }),
    imageReferences: () => [],
    now: () => 100,
    throttle: async () => {},
  });
  const created = await shareCreator.handle('createDishShare', { familyId: 'family', kind: 'dish', itemId: 'dish' }, 'user');
  assert.match(created.token, /^[a-f0-9]{48}$/);
  assert.equal(writes[0][0], 'shares');
  assert.equal(writes[0][1], createHash('sha256').update(created.token).digest('hex'));
  assert.equal(writes[0][2].membershipId, 'membership');
});

test('missing, duplicated and already patched baseline anchors stop family ownership preparation', async () => {
  await assert.rejects(buildFamilyOwnershipHotfix(baseline.replace('function canDeleteCommunityPost', 'function changedPolicy')), /定义不唯一/);
  await assert.rejects(buildFamilyOwnershipHotfix(baseline.replace('posts.push(row.card)', 'changedFeed(row.card)')), /锚点不唯一/);
  await assert.rejects(buildFamilyOwnershipHotfix(`${baseline}\n${baseline}`), /(?:定义|锚点)不唯一/);
  await assert.rejects(buildFamilyOwnershipHotfix(baseline.replace('var import_node_crypto3 = require("node:crypto");', '')), /好友分享 crypto 锚点不唯一/);
  await assert.rejects(buildFamilyOwnershipHotfix(baseline.replace('var import_node_crypto3 = require("node:crypto");', 'var import_node_crypto3 = require("node:crypto");\nvar import_node_crypto9 = require("node:crypto");')), /好友分享 crypto 锚点不唯一/);
  const { code } = await buildFamilyOwnershipHotfix(baseline);
  await assert.rejects(buildFamilyOwnershipHotfix(code), /已包含家庭归属补丁/);
});
