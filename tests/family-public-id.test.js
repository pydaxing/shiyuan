import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication, collections } from '../server/application.mjs';
import { createFamilyService } from '../server/families.mjs';
import { FAMILY_PUBLIC_IDS, newFamilyPublicId, reserveFamilyPublicId, retryFamilyPublicIdAllocation } from '../server/family-public-id.mjs';
import { isFamilyPublicId } from '../src/domain/family.js';
import { memoryRepository } from './helpers/memory-repository.js';

const clock = 1793145600000;
const duplicate = () => Object.assign(new Error('Document already exists'), { code: 'DOCUMENT_ALREADY_EXISTS' });
const success = async promise => { const result = await promise; assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };

function fixture({ repository = memoryRepository(), candidates = [] } = {}) {
  let generated = 0;
  const nextId = () => candidates[generated++] || `sy-${generated.toString(36).padStart(6, '0')}`;
  const membership = async (db, userId) => {
    const user = await db.get('users', userId);
    return { user, family: await db.get('families', user?.familyId) };
  };
  const bootstrap = async userId => {
    const { user, family } = await membership(repository, userId);
    return family && !family.deletedAt ? { familyId: user.familyId, snapshot: { family } } : { needsFamily: true };
  };
  const handle = createFamilyService({ repository, membership, bootstrap, throttle: async () => {}, now: () => clock, newPublicId: nextId });
  return {
    repository, handle, generated: () => generated,
    create: (userId = 'alice', requestId = `family-public-${userId}`, extra = {}) => handle('createFamily', { familyName: '测试家庭', name: userId, requestId, ...extra }, userId),
  };
}

// Unlike the serial memory fixture, these transactions can both read a missing key.
// An insert waits for the competing transaction and then either wins or rejects.
function racingRepository() {
  const base = memoryRepository();
  const locks = new Map();
  let releaseReads;
  const bothReads = new Promise(resolve => { releaseReads = resolve; });
  const stats = { missingReads: 0, rollbacks: 0, commits: 0 };
  return {
    ...base, stats,
    async transaction(callback) {
      const writes = [];
      const held = [];
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const transaction = {
        async get(name, id) {
          const staged = writes.findLast(write => write.name === name && write.id === id);
          const row = staged ? structuredClone(staged.value) : await base.get(name, id);
          if (name === FAMILY_PUBLIC_IDS && id === 'sy-000000' && !row && stats.missingReads < 2) {
            stats.missingReads += 1;
            if (stats.missingReads === 2) releaseReads();
            await bothReads;
          }
          return row;
        },
        async set(name, id, value) { writes.push({ kind: 'set', name, id, value: structuredClone(value) }); },
        async insert(name, id, value) {
          const key = `${name}/${id}`;
          while (locks.has(key)) await locks.get(key);
          locks.set(key, done);
          held.push(key);
          if (await base.get(name, id)) throw duplicate();
          writes.push({ kind: 'insert', name, id, value: structuredClone(value) });
        },
      };
      try {
        const result = await callback(transaction);
        await base.transaction(async db => {
          for (const write of writes) await db[write.kind](write.name, write.id, write.value);
        });
        stats.commits += 1;
        return result;
      } catch (error) {
        stats.rollbacks += 1;
        throw error;
      } finally {
        for (const key of held) locks.delete(key);
        finish();
      }
    },
  };
}

test('generated IDs have exactly the public lowercase base36 format', () => {
  for (let index = 0; index < 32; index += 1) assert.equal(isFamilyPublicId(newFamilyPublicId()), true);
  assert.ok(collections.includes(FAMILY_PUBLIC_IDS));
});

test('known occupied IDs are skipped and their permanent mappings remain intact', async () => {
  const server = fixture({ candidates: ['sy-000000', 'sy-zzzzzz'] });
  const original = { familyId: 'deleted-original-family', createdAt: 1 };
  await server.repository.insert(FAMILY_PUBLIC_IDS, 'sy-000000', original);
  const created = await server.create();
  assert.equal(created.snapshot.family.publicId, 'sy-zzzzzz');
  assert.match(created.familyId, /^family-\d+-[a-f0-9]{24}$/);
  assert.deepEqual(await server.repository.get(FAMILY_PUBLIC_IDS, 'sy-000000'), { ...original, _id: 'sy-000000' });
  assert.deepEqual(await server.repository.get(FAMILY_PUBLIC_IDS, 'sy-zzzzzz'), { _id: 'sy-zzzzzz', familyId: created.familyId, createdAt: clock });
  assert.equal((await server.repository.get('users', 'alice')).familyId, created.familyId);
});

test('concurrent empty reads cannot assign the same ID to two families', async () => {
  const repository = racingRepository();
  const server = fixture({ repository, candidates: ['sy-000000', 'sy-000000', 'sy-000001'] });
  const created = await Promise.all([server.create('alice'), server.create('bob')]);
  assert.equal(repository.stats.missingReads, 2, 'both transactions reached the absent-key race');
  assert.equal(repository.stats.rollbacks, 1, 'the losing insert rolls back the whole attempt');
  assert.equal(repository.stats.commits, 2);
  assert.equal(new Set(created.map(result => result.snapshot.family.publicId)).size, 2);
  assert.equal((await repository.list('families')).length, 2);
  assert.equal((await repository.list('requests')).length, 2);
  const reservations = await repository.list(FAMILY_PUBLIC_IDS);
  assert.equal(reservations.length, 2);
  for (const result of created) assert.equal(reservations.find(row => row._id === result.snapshot.family.publicId).familyId, result.familyId);
});

test('creation request replays retain one family and one public ID', async () => {
  const server = fixture();
  const [first, replay] = await Promise.all([server.create(), server.create()]);
  assert.equal(first.familyId, replay.familyId);
  assert.equal(first.snapshot.family.publicId, replay.snapshot.family.publicId);
  assert.equal(server.generated(), 1);
  for (const collection of ['families', 'requests', FAMILY_PUBLIC_IDS]) assert.equal((await server.repository.list(collection)).length, 1);
  await assert.rejects(server.create('alice', 'family-public-alice', { familyName: '不同名称' }), error => error.code === 'CONFLICT');
  assert.equal(server.generated(), 1);
});

test('failure after reservation and request staging rolls back every creation write', async () => {
  const repository = memoryRepository();
  const transaction = repository.transaction;
  const failure = Object.assign(new Error('family storage unavailable'), { code: 'STORAGE_UNAVAILABLE' });
  repository.transaction = callback => transaction(db => callback({ ...db, async set(name, id, value) {
    if (name === 'families') throw failure;
    return db.set(name, id, value);
  } }));
  const server = fixture({ repository });
  await assert.rejects(server.create(), error => error === failure);
  assert.equal(server.generated(), 1, 'unrelated failures are not retried as collisions');
  for (const name of [FAMILY_PUBLIC_IDS, 'families', 'requests', 'users']) assert.deepEqual(await repository.list(name), []);
});

test('invalid cover ownership after reservation leaves neither an orphan ID nor a family', async () => {
  const server = fixture();
  await assert.rejects(server.create('alice', 'family-invalid-cover', { cover: 'cloud://missing-cover' }), error => error.code === 'FORBIDDEN');
  for (const name of [FAMILY_PUBLIC_IDS, 'families', 'requests', 'users']) assert.deepEqual(await server.repository.list(name), []);
});

test('an unrelated unique-index failure is not mistaken for an occupied candidate', async () => {
  const repository = memoryRepository();
  const transaction = repository.transaction;
  const failure = duplicate();
  repository.transaction = callback => transaction(db => callback({ ...db, async insert() { throw failure; } }));
  const server = fixture({ repository });
  await assert.rejects(server.create(), error => error === failure);
  assert.equal(server.generated(), 1);
  assert.deepEqual(await repository.list(FAMILY_PUBLIC_IDS), []);
});

test('both candidate checks and concurrent-collision retries have hard bounds', async () => {
  const repository = memoryRepository();
  await repository.insert(FAMILY_PUBLIC_IDS, 'sy-000000', { familyId: 'taken', createdAt: 1 });
  let generated = 0;
  await assert.rejects(repository.transaction(db => reserveFamilyPublicId(db, { id: 'new' }, { newId: () => { generated += 1; return 'sy-000000'; }, attempts: 3 })), error => error.code === 'CAPACITY');
  assert.equal(generated, 3);
  let attempts = 0;
  const failure = duplicate();
  await assert.rejects(retryFamilyPublicIdAllocation(repository, async () => {
    attempts += 1;
    throw Object.assign(new Error('collision', { cause: failure }), { code: 'FAMILY_PUBLIC_ID_COLLISION', publicId: 'sy-000000' });
  }, { attempts: 3 }), error => error.code === 'CAPACITY' && error.cause.cause === failure);
  assert.equal(attempts, 3);
});

test('an existing public ID is immutable and malformed existing IDs are not silently replaced', async () => {
  const db = { get() { assert.fail('Existing IDs must not allocate'); }, insert() { assert.fail('Existing IDs must not allocate'); } };
  assert.equal(await reserveFamilyPublicId(db, { id: 'internal', publicId: 'sy-abc123' }), 'sy-abc123');
  await assert.rejects(reserveFamilyPublicId(db, { id: 'internal', publicId: 'sy-ABC123' }), error => error.code === 'INVALID');
});

for (const action of ['deleteFamily', 'leaveFamily']) {
  test(`${action} preserves the public ID reservation permanently`, async () => {
    const server = fixture();
    const created = await server.create();
    const reservation = await server.repository.get(FAMILY_PUBLIC_IDS, created.snapshot.family.publicId);
    await server.handle(action, { familyId: created.familyId, confirmName: '测试家庭' }, 'alice');
    assert.deepEqual(await server.repository.get(FAMILY_PUBLIC_IDS, created.snapshot.family.publicId), reservation);
    assert.equal((await server.repository.get('families', created.familyId)).publicId, created.snapshot.family.publicId);
    assert.ok((await server.repository.get('families', created.familyId)).deletedAt);
  });
}

test('bootstrap, commands, listings and legacy invites preserve the internal/public ID split', async () => {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => clock, signFiles: async () => ({}) });
  const call = (action, payload = {}, openid = 'alice') => success(app({ action, ...payload }, { OPENID: openid }));
  const created = await call('createFamily', { familyName: '真实关系键', requestId: 'public-integration-create' });
  const { publicId, id } = created.snapshot.family;
  assert.equal(isFamilyPublicId(publicId), true);
  assert.equal(id, created.familyId);
  assert.notEqual(id, publicId);
  const updated = await call('command', { name: 'customizeFamily', args: [{ name: '改名后', cover: '', coverTitle: '家常味道', publicId: 'sy-evil00' }], familyId: id, revision: created.revision, requestId: 'public-integration-command' });
  assert.equal(updated.snapshot.family.publicId, publicId);
  const listed = await call('listFamilies');
  assert.equal(listed.families[0].id, id);
  assert.equal(listed.families[0].publicId, publicId);
  const legacy = await call('createInvite', { familyId: id });
  assert.match(legacy.code, /^[A-F0-9]{12}$/);
  const joined = await call('joinFamily', { code: legacy.code }, 'bob');
  assert.equal(joined.familyId, id);
  assert.equal(joined.snapshot.family.publicId, publicId);
  const invitation = await call('prepareInvite', { familyId: id });
  assert.match(invitation.token, /^[a-f0-9]{48}$/);
  const joinedByToken = await call('joinFamily', { token: invitation.token }, 'carol');
  assert.equal(joinedByToken.familyId, id);
  assert.equal(joinedByToken.snapshot.family.publicId, publicId);
  assert.equal((await repository.list(FAMILY_PUBLIC_IDS)).length, 1);
});

test('bootstrap reads a legacy family without allocating or changing its revision', async () => {
  const repository = memoryRepository();
  const app = createApplication({ repository, now: () => clock, signFiles: async () => ({}) });
  const created = await success(app({ action: 'createFamily', familyName: '旧家庭', requestId: 'public-legacy-create' }, { OPENID: 'alice' }));
  const family = await repository.get('families', created.familyId);
  await repository.remove(FAMILY_PUBLIC_IDS, family.publicId);
  delete family.publicId;
  await repository.set('families', family.id, family);
  const result = await success(app({ action: 'bootstrap' }, { OPENID: 'alice' }));
  assert.equal(result.snapshot.family.publicId, undefined);
  assert.equal(result.revision, family.revision);
  assert.deepEqual(await repository.get('families', family.id), family);
  assert.deepEqual(await repository.list(FAMILY_PUBLIC_IDS), []);
});
