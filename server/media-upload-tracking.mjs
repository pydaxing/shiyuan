// Register the intended path before sending bytes. A lost upload response can
// then be recovered through the storage metadata API during family cleanup.
export async function uploadTrackedFile(upload, options, ticket = {}) {
  await ticket.storageTracker?.record({ path: options.cloudPath });
  const result = await upload(options);
  if (typeof result?.fileID !== 'string' || !result.fileID.startsWith('cloud://')) throw new Error('云存储未返回有效文件 ID');
  await ticket.storageTracker?.record({ path: options.cloudPath, fileId: result.fileID });
  return result;
}

export async function removeTrackedFiles(remove, fileIds, ticket = {}) {
  const requested = [...new Set(fileIds.filter(fileId => typeof fileId === 'string' && fileId.startsWith('cloud://')))];
  const removed = [];
  for (let offset = 0; offset < requested.length; offset += 50) {
    const batch = requested.slice(offset, offset + 50);
    let response;
    try { response = await remove({ fileList: batch }); } catch { continue; }
    const results = Array.isArray(response) ? response : response?.fileList;
    if (!Array.isArray(results)) continue;
    for (const fileId of batch) {
      const matching = results.filter(item => item.fileID === fileId);
      if (matching.length === 1 && matching[0].status === 0) removed.push(fileId);
    }
  }
  let trackingPending = false;
  if (removed.length) {
    try { await ticket.storageTracker?.discard(removed); } catch { trackingPending = true; }
  }
  const success = new Set(removed);
  return { removed, remaining: requested.filter(fileId => !success.has(fileId)), trackingPending };
}
