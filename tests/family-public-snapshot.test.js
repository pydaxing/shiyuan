import test from 'node:test';
import assert from 'node:assert/strict';
import { FAMILY_AVATARS, familyAvatar } from '../src/domain/family.js';
import { snapshotFamilyPublicIdentity, postFamilySnapshot, familySnapshotAssetIds } from '../src/domain/family-public-snapshot.js';

test('public family identity contains only the public name, avatar, cover and short ID', () => {
  const family = { id: 'internal-family', publicId: 'sy-a0b1c2', name: ' 我们的小家 ', cover: 'cloud://environment/family-cover', avatar: FAMILY_AVATARS[1], ownerId: 'owner', members: [{ id: 'secret-member' }], inviteId: 'private-invite', friendInviteToken: 'private-token' };
  assert.deepEqual(snapshotFamilyPublicIdentity(family), { name: '我们的小家', avatar: family.cover, cover: family.cover, publicId: 'sy-a0b1c2' });
  assert.deepEqual(familySnapshotAssetIds(snapshotFamilyPublicIdentity(family)), [family.cover]);
  assert.equal(family.name, ' 我们的小家 ');
});

test('family default avatar matches the existing family view without exposing internal IDs', () => {
  const family = { id: 'legacy-family', name: '原来的家' };
  assert.deepEqual(snapshotFamilyPublicIdentity(family), { name: family.name, avatar: familyAvatar(family), cover: '', publicId: '' });
  assert.deepEqual(snapshotFamilyPublicIdentity(), { name: '', avatar: '', cover: '', publicId: '' });
});

test('snapshot accepts only supported image references and the exact short ID format', () => {
  for (const reference of ['https://example.com/private.jpg', 'data:image/png;base64,aaaa', 'wxfile://private.jpg', '/private/image.png', 'cloud://env/bad\npath']) {
    const identity = snapshotFamilyPublicIdentity({ name: '家庭', avatar: reference, cover: reference, publicId: 'sy-ABC123' });
    assert.equal(identity.cover, '');
    assert.ok(FAMILY_AVATARS.includes(identity.avatar));
    assert.equal(identity.publicId, '');
  }
  assert.equal(snapshotFamilyPublicIdentity({ id: 'sy-123abc', name: '家庭' }).publicId, 'sy-123abc');
});

test('an existing publication snapshot is immutable across family rename, cover change or deletion', () => {
  const original = { name: '发布时的家', avatar: FAMILY_AVATARS[2], cover: '', publicId: 'sy-12abcd' };
  const post = { author: '另一名称', familySnapshot: { ...original, ownerId: 'private' } };
  const renamed = { name: '改名后的家', cover: 'cloud://env/new-cover', publicId: 'sy-000000' };
  assert.deepEqual(postFamilySnapshot(post, renamed), original);
  assert.deepEqual(postFamilySnapshot(post), original);
  assert.deepEqual(postFamilySnapshot({ card: { familySnapshot: original } }, renamed), original);
});

test('legacy user posts keep the recorded author name while acquiring verified family appearance', () => {
  const family = { name: '现在的名称', avatar: FAMILY_AVATARS[0], cover: '', publicId: 'sy-123abc' };
  assert.deepEqual(postFamilySnapshot({ author: '分享时的名称' }, family), { name: '分享时的名称', avatar: FAMILY_AVATARS[0], cover: '', publicId: 'sy-123abc' });
  assert.equal(postFamilySnapshot({ author: '' }, family).name, family.name);
  assert.deepEqual(postFamilySnapshot({ author: '只保留了名字' }), { name: '只保留了名字', avatar: '', cover: '', publicId: '' });
  assert.equal(postFamilySnapshot({}), undefined);
});

test('official imports never inherit the administrator household or override source attribution', () => {
  const family = { name: '执行导入的家', cover: 'cloud://env/private-cover' };
  for (const official of [{ publisherType: 'official' }, { publisherId: 'official:shiyuan' }]) {
    const post = { ...official, author: '原作者', familySnapshot: { name: '旧误写' } };
    assert.equal(postFamilySnapshot(post, family), undefined);
    assert.equal(post.author, '原作者');
  }
});

test('unsafe names and internal IDs are not converted into public snapshot fields', () => {
  for (const name of ['x'.repeat(21), 'family\u0000name', {}, null]) {
    assert.equal(snapshotFamilyPublicIdentity({ name, publicId: 'family-internal' }).name, '');
  }
  assert.deepEqual(familySnapshotAssetIds({ avatar: 'cloud://env/avatar', cover: 'cloud://env/cover', ownerId: 'cloud://env/private' }), ['cloud://env/avatar', 'cloud://env/cover']);
});
