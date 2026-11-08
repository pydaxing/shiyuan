import test from 'node:test';
import assert from 'node:assert/strict';
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

test('historical partial deployment rejects identity v2 instead of generating an incomplete backend', async () => {
  await assert.rejects(buildFamilyOwnershipHotfix(baseline), /历史家庭归属补丁已停用/);
  await assert.rejects(buildFamilyOwnershipHotfix(baseline.replace('function canDeleteCommunityPost', 'function changedPolicy')), /历史家庭归属补丁已停用/);
  await assert.rejects(buildFamilyOwnershipHotfix(`${baseline}\n${baseline}`), /历史家庭归属补丁已停用/);
});

test('an already patched production baseline remains explicitly rejected', async () => {
  await assert.rejects(buildFamilyOwnershipHotfix(`${baseline}\nconst ownershipFields = [];`), /已包含家庭归属补丁/);
});
