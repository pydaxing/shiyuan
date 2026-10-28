import { createHash, randomUUID } from 'node:crypto';

// Each invocation advances a small, persisted cursor. Only one connected group
// of media is held in the family document, never the entire cloud data set.
const PAGE_SIZE = 50;
const MAX_GROUP_RECORDS = 20;
const MAX_GROUP_REFERENCES = 200;
const ROOT_COLLECTIONS = ['users', 'families', 'recipes', 'meal_sets', 'orders', 'inventory', 'purchases', 'invites', 'shares', 'requests', 'imports', 'posts', 'comments', 'reports', 'media'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'FAMILY_MEDIA_CLEANUP' }); };

export function familyMediaCloudReferences(value, result = new Set()) {
  if (typeof value === 'string') { if (value.startsWith('cloud://')) result.add(value); }
  else if (value && typeof value === 'object') for (const item of Object.values(value)) familyMediaCloudReferences(item, result);
  return result;
}

function rootReferences(collection, row) {
  // Progress includes candidate file IDs, so it must not protect itself. A
  // deleted family's publicIdentity remains a real public-content reference.
  if (collection === 'families') { const { deletion, ...root } = row; return familyMediaCloudReferences(root); }
  if (collection === 'media') { const { familyDeletionMedia, familyDeletionRetention, ...root } = row; return familyMediaCloudReferences(root); }
  return familyMediaCloudReferences(row);
}

function assertDeleted(family, familyId) {
  if (!family || family.id !== familyId || !family.deletedAt || (family.members || []).length) fail('家庭尚未停用，不能清理图片');
}

function summary(state, reason) {
  return { complete: state.phase === 'complete', phase: state.phase, deletedRecords: state.deletedRecords, deletedFiles: state.deletedFiles, retainedRecords: state.retainedRecords, ...(reason ? { reason } : {}) };
}

/** removeFiles receives cloud file IDs and must return wx deleteFile's fileList.
 * resolveStoragePath is needed for upload tickets whose raw uploads only have a
 * cloud path. Missing resolution leaves cleanup pending instead of losing them.
 */
export function createFamilyDeletionMedia({ repository, removeFiles, resolveStoragePath, now = Date.now }) {
  async function update(familyId, previous, change) {
    return repository.transaction(async db => {
      const family = await db.get('families', familyId);
      assertDeleted(family, familyId);
      const current = family.deletion?.media;
      if (!current || current.jobId !== previous.jobId || current.revision !== previous.revision) return null;
      const next = await change(db, family, current);
      if (!next) return null;
      next.revision = current.revision + 1;
      await db.set('families', familyId, { ...family, deletion: { ...family.deletion, media: next } });
      return next;
    });
  }

  async function mediaReferences(row) {
    const refs = rootReferences('media', row);
    const unresolved = [];
    const pendingPaths = (row.uploadFiles || []).filter(item => !item.fileId).map(item => item.path);
    for (const path of [...new Set([row.path, row.previewPath, ...pendingPaths].filter(Boolean))]) {
      let fileId;
      try { fileId = await resolveStoragePath?.(path); } catch { /* Preserve the ticket until storage can be inspected. */ }
      if (typeof fileId === 'string' && fileId.startsWith('cloud://')) refs.add(fileId);
      else unresolved.push(path);
    }
    return { refs: [...refs], unresolved };
  }

  async function initialize(familyId) {
    return repository.transaction(async db => {
      const family = await db.get('families', familyId);
      assertDeleted(family, familyId);
      if (family.deletion?.media) {
        if (family.deletion.media.version !== 1) fail('图片清理版本不兼容');
        return family.deletion.media;
      }
      const state = { version: 1, jobId: randomUUID(), revision: 0, phase: 'select', after: '', deletedRecords: 0, deletedFiles: 0, retainedRecords: 0 };
      await db.set('families', familyId, { ...family, deletion: { ...family.deletion, media: state } });
      return state;
    });
  }

  const reset = state => { const { group, references, scanAfter, scanCollection, expanded, remaining, ...rest } = state; return { ...rest, phase: 'select' }; };

  async function retain(familyId, state) {
    return update(familyId, state, async (db, family, current) => {
      for (const item of current.group) {
        const row = await db.get('media', item.id);
        if (row && row.familyId === familyId) await db.set('media', item.id, { ...row, familyDeletionRetention: { jobId: current.jobId, retainedAt: now() } });
      }
      return { ...reset(current), after: current.group[0].id, retainedRecords: current.retainedRecords + current.group.length };
    });
  }

  async function step(familyId, state) {
    if (state.phase === 'complete') return { state };
    if (state.phase === 'select') {
      const [row] = await repository.list('media', { familyId }, { after: state.after, limit: 1 });
      if (!row) return { state: await update(familyId, state, async (_db, _family, current) => ({ ...current, phase: 'complete', completedAt: now() })) };
      if (row.uploadInFlightUntil > now()) return { state, reason: 'UPLOAD_IN_FLIGHT' };
      if (row.familyDeletionRetention?.jobId === state.jobId) return { state: await update(familyId, state, async (_db, _family, current) => ({ ...current, after: row._id })) };
      if (row.profile || row.familyDraftRequest) return { state: await update(familyId, state, async (db, _family, current) => {
        const existing = await db.get('media', row._id);
        if (!existing || existing.familyId !== familyId) return current;
        await db.set('media', row._id, { ...existing, familyDeletionRetention: { jobId: current.jobId, retainedAt: now() } });
        return { ...current, after: row._id, retainedRecords: current.retainedRecords + 1 };
      }) };
      if (row.familyDeletionMedia && row.familyDeletionMedia.jobId !== state.jobId) return { state, reason: 'UNKNOWN_MEDIA_CLEANUP' };
      const selected = await mediaReferences(row);
      if (selected.unresolved.length) return { state, reason: 'UPLOAD_PATH_UNRESOLVED' };
      if (selected.refs.length > MAX_GROUP_REFERENCES) return { state, reason: 'MEDIA_REFERENCE_LIMIT' };
      return { state: await update(familyId, state, async (_db, _family, current) => ({ ...current, phase: 'expand', group: [{ id: row._id, fingerprint: fingerprint(row), references: selected.refs }], references: selected.refs, scanAfter: '', expanded: false })) };
    }
    if (state.phase === 'expand') {
      const rows = await repository.list('media', { familyId }, { after: state.scanAfter, limit: PAGE_SIZE });
      const group = [...state.group], ids = new Set(group.map(item => item.id)), references = new Set(state.references);
      let expanded = state.expanded;
      for (const row of rows) {
        if (row.uploadInFlightUntil > now()) return { state, reason: 'UPLOAD_IN_FLIGHT' };
        if (ids.has(row._id)) continue;
        const candidate = await mediaReferences(row);
        if (!candidate.refs.some(ref => references.has(ref))) continue;
        if (row.familyDeletionRetention?.jobId === state.jobId || row.profile || row.familyDraftRequest) return { state: await retain(familyId, state) };
        if (candidate.unresolved.length) return { state, reason: 'UPLOAD_PATH_UNRESOLVED' };
        candidate.refs.forEach(ref => references.add(ref));
        group.push({ id: row._id, fingerprint: fingerprint(row), references: candidate.refs }); ids.add(row._id); expanded = true;
        if (group.length > MAX_GROUP_RECORDS || references.size > MAX_GROUP_REFERENCES) return { state, reason: 'MEDIA_REFERENCE_LIMIT' };
      }
      const end = rows.length < PAGE_SIZE;
      return { state: await update(familyId, state, async (_db, _family, current) => ({ ...current, group, references: [...references], expanded: end ? false : expanded, scanAfter: end ? '' : rows.at(-1)._id, ...(end && !expanded ? { phase: 'roots', scanCollection: 0 } : {}) })) };
    }
    if (state.phase === 'roots') {
      const collection = ROOT_COLLECTIONS[state.scanCollection];
      const rows = await repository.list(collection, {}, { after: state.scanAfter, limit: PAGE_SIZE });
      const references = new Set(state.references), ids = new Set(state.group.map(item => item.id));
      if (rows.some(row => !(collection === 'media' && ids.has(row._id)) && [...rootReferences(collection, row)].some(ref => references.has(ref)))) return { state: await retain(familyId, state) };
      const end = rows.length < PAGE_SIZE;
      if (end && state.scanCollection === ROOT_COLLECTIONS.length - 1) {
        const next = await update(familyId, state, async (db, _family, current) => {
          const selected = [];
          for (const item of current.group) {
            const row = await db.get('media', item.id);
            if (row?.uploadInFlightUntil > now()) return reset(current);
            if (!row || row.familyId !== familyId || fingerprint(row) !== item.fingerprint) return reset(current);
            selected.push(row);
          }
          for (const row of selected) await db.set('media', row._id, { ...row, confirmed: false, familyDeletionMedia: { jobId: current.jobId, state: 'deleting' } });
          return { ...current, phase: 'remove', remaining: [...current.references] };
        });
        return { state: next };
      }
      return { state: await update(familyId, state, async (_db, _family, current) => ({ ...current, scanCollection: end ? current.scanCollection + 1 : current.scanCollection, scanAfter: end ? '' : rows.at(-1)._id })) };
    }
    if (state.phase === 'remove') {
      if (state.remaining.length) {
        if (typeof removeFiles !== 'function') return { state, reason: 'STORAGE_DELETE_UNAVAILABLE' };
        const batch = state.remaining.slice(0, 10);
        let response;
        try { response = await removeFiles(batch); }
        catch { return { state, reason: 'STORAGE_DELETE_FAILED' }; }
        const results = Array.isArray(response) ? response : response?.fileList;
        const success = new Set();
        if (Array.isArray(results)) for (const fileId of batch) {
          const matching = results.filter(item => item.fileID === fileId);
          if (matching.length === 1 && matching[0].status === 0) success.add(fileId);
        }
        if (!success.size) return { state, reason: 'STORAGE_DELETE_FAILED' };
        const next = await update(familyId, state, async (_db, _family, current) => ({ ...current, remaining: current.remaining.filter(fileId => !success.has(fileId)), deletedFiles: current.deletedFiles + success.size }));
        return { state: next, ...(success.size < batch.length ? { reason: 'STORAGE_DELETE_FAILED' } : {}) };
      }
      return { state: await update(familyId, state, async (db, _family, current) => {
        for (const item of current.group) {
          const row = await db.get('media', item.id);
          if (row && (row.familyId !== familyId || row.familyDeletionMedia?.jobId !== current.jobId || row.confirmed !== false)) fail('图片清理状态已变更');
        }
        for (const item of current.group) await db.remove('media', item.id);
        return { ...reset(current), after: current.group[0].id, deletedRecords: current.deletedRecords + current.group.length };
      }) };
    }
    fail('图片清理进度无效');
  }

  return async function cleanup(familyId, { deadline = Date.now() + 8000, maxSteps = 32 } = {}) {
    let state = await initialize(familyId);
    for (let iteration = 0; iteration < Math.min(Math.max(maxSteps, 1), 200) && Date.now() < deadline; iteration += 1) {
      const result = await step(familyId, state);
      if (result.state) state = result.state;
      else state = await initialize(familyId); // Another invocation advanced it.
      if (result.reason || state.phase === 'complete') return summary(state, result.reason);
    }
    return summary(state);
  };
}
