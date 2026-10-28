import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeed } from '../src/data/seed.js';
import { makeShare, parseShare } from '../src/domain/sharing.js';
import { importCollection, validateRecipe } from '../src/domain/kitchen.js';
import { createKitchenActions } from '../src/domain/actions.js';
import { normalizeCommand } from '../server/validation.mjs';

const provenance = { source: 'HowToCook', url: 'https://github.com/Anduin2017/HowToCook', license: 'Unlicense', attribution: 'HowToCook contributors', note: '文字改编；未试做。原文用量保留，不自动缩放。' };
const recipe = { ...createSeed().recipes[0], provenance };

test('recipe provenance survives normalization, sharing, imports and edits', () => {
  const [normalized] = normalizeCommand('saveRecipe', [{ ...recipe, provenance: { ...provenance, untrusted: true } }]);
  assert.deepEqual(normalized.provenance, provenance);
  const share = parseShare(makeShare(recipe, [recipe], '我家'));
  assert.deepEqual(share.recipes[0].provenance, provenance);
  const imported = importCollection([], share);
  assert.deepEqual(imported[0].provenance, provenance);
  let state = createSeed();
  state.recipes = imported;
  const actions = createKitchenActions({ getState: () => state, commit: next => { state = next; }, newId: prefix => `${prefix}-new` });
  const { provenance: omitted, ...draft } = imported[0];
  actions.saveRecipe({ ...draft, title: '编辑后的菜' }, draft.id);
  assert.deepEqual(state.recipes[0].provenance, provenance);
  assert.match(normalized.provenance.note, /文字改编/);
  assert.match(normalized.provenance.attribution, /HowToCook contributors/);
});

test('recipe provenance rejects unsafe urls, malformed and excessive text', () => {
  for (const value of [null, [], { ...provenance, url: 'javascript:alert(1)' }, { ...provenance, note: '长'.repeat(1501) }, { ...provenance, source: '' }]) assert.throws(() => validateRecipe({ ...recipe, provenance: value }), /来源/);
  assert.doesNotThrow(() => validateRecipe(createSeed().recipes[0]));
});
