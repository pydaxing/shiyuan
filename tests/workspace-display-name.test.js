import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceDisplayName } from '../src/domain/workspace-identity.js';
import { familyShareContext } from '../src/services/prepared-shares.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { createSeed } from '../src/data/seed.js';

test('personal attribution follows the profile or owner, never the workspace label', () => {
  const family = { kind: 'personal', name: '我的餐桌', ownerId: 'one', members: [{ id: 'two', name: '别人' }, { id: 'one', name: '原昵称' }] };
  assert.equal(workspaceDisplayName(family, { name: ' 新昵称 ' }), '新昵称');
  assert.equal(workspaceDisplayName(family), '原昵称');
  assert.equal(workspaceDisplayName({ kind: 'personal', name: '我的餐桌' }), '我');
  assert.equal(workspaceDisplayName({ name: '家庭厨房' }, { name: '昵称' }), '家庭厨房');
});

test('renaming a personal owner invalidates prepared friend shares', () => {
  const snapshot = createSeed();
  snapshot.posts = [];
  snapshot.family.kind = 'personal';
  snapshot.family.ownerId = snapshot.family.members[0].id;
  snapshot.family.id = 'personal-one';
  const session = { phase: 'ready', userId: snapshot.family.ownerId, familyId: snapshot.family.id };
  const selection = { kind: 'dish', itemId: snapshot.recipes[0].id };
  const before = familyShareContext(snapshot, session, selection);
  snapshot.family.members[0].name = '新昵称';
  assert.notEqual(familyShareContext(snapshot, session, selection).fingerprint, before.fingerprint);
});

test('personal publication stores nickname on the post and its recipes', () => {
  let snapshot = createSeed();
  snapshot.posts = [];
  snapshot.family.kind = 'personal';
  snapshot.family.name = '我的餐桌';
  snapshot.family.ownerId = snapshot.activeMemberId;
  snapshot.family.members.find(member => member.id === snapshot.activeMemberId).name = '新昵称';
  const recipe = snapshot.recipes[0];
  recipe.image = '/static/tomato.png';
  const actions = createKitchenActions({ getState: () => snapshot, commit: value => { snapshot = value; }, newId: prefix => `${prefix}-test` });
  actions.publishToCommunity(recipe.id, 'dish');
  const post = snapshot.posts.find(post => post.id === 'post-test');
  assert.equal(post.author, '新昵称');
  assert.equal(post.recipes[0].author, '新昵称');
});
