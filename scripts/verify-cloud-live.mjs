import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { getShoppingRequirements, localDate } from '../src/domain/kitchen.js';

const project = `${process.cwd()}/dist/release`;
const directory = `${process.cwd()}/artifacts/deployment/live-cloud`;
await mkdir(directory, { recursive: true });

async function evaluate(label, callback, args = []) {
  const path = `${directory}/${label}-args.json`;
  await writeFile(path, JSON.stringify(args));
  const output = execFileSync('wechatide', ['-c', 'Codex', 'automation_evaluate', '--project', project, '--fn-source', callback.toString(), '--args-file', path], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  const response = JSON.parse(output.slice(output.indexOf('{')));
  await writeFile(`${directory}/${label}.json`, JSON.stringify(response, null, 2));
  assert.equal(response.ok, true, JSON.stringify(response));
  const result = response.result?.result?.result;
  assert.ok(result, JSON.stringify(response));
  return result;
}

if (process.argv[2] === 'image') {
  const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#efb775' } }).jpeg().toBuffer();
  const result = await evaluate('image', async function(base64) {
    const filePath = `${wx.env.USER_DATA_PATH}/shiyuan-cloud-verification.jpg`;
    wx.getFileSystemManager().writeFileSync(filePath, base64, 'base64');
    async function invoke(action, payload = {}) {
      const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action, ...payload } });
      if (!response.result.ok) throw new Error(JSON.stringify({ action, ...response.result, requestID: response.requestID }));
      return response.result.data;
    }
    const ticket = await invoke('mediaTicket');
    const uploaded = await wx.cloud.uploadFile({ cloudPath: ticket.path, filePath });
    const confirmed = await invoke('mediaConfirm', { ticket: ticket.id, fileId: uploaded.fileID });
    const signed = await invoke('mediaUrl', { fileId: confirmed.fileId });
    const content = await invoke('mediaContent', { fileId: confirmed.fileId });
    const direct = await wx.cloud.downloadFile({ fileID: confirmed.fileId });
    const directBytes = wx.getFileSystemManager().readFileSync(direct.tempFilePath);
    const header = String.fromCharCode.apply(null, Array.from(new Uint8Array(directBytes).slice(0, 8)));
    const approvedPath = confirmed.fileId.split('/').slice(3).join('/');
    let overwrite;
    try { await wx.cloud.uploadFile({ cloudPath: approvedPath, filePath }); overwrite = { allowed: true }; }
    catch (error) { overwrite = { allowed: false, code: error.errCode, message: error.errMsg }; }
    const deletion = await wx.cloud.deleteFile({ fileList: [confirmed.fileId] });
    wx.getFileSystemManager().unlinkSync(filePath);
    return { ticketId: ticket.id, approvedId: confirmed.fileId, uploadedId: uploaded.fileID, protectedDescriptor: signed.media[confirmed.fileId], matchesOriginal: content.base64 === base64, contentType: content.contentType, directStorageHeader: header, responseHasKey: JSON.stringify([confirmed, content, signed]).includes('encryptionKey'), overwrite, deletion: deletion.fileList.map(file => ({ status: file.status, errMsg: file.errMsg })) };
  }, [image.toString('base64')]);
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(result.protectedDescriptor, { protected: true });
  assert.equal(result.matchesOriginal, true);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(result.directStorageHeader, 'SHIYUAN1');
  assert.equal(result.responseHasKey, false);
  assert.equal(result.overwrite.allowed, false, 'Client can overwrite a protected image');
  assert.ok(result.deletion.every(file => file.status !== 0), 'Client can delete a protected image');
} else if (process.argv[2] === 'image-access') {
  const saved = JSON.parse(await readFile(`${directory}/image.json`, 'utf8')).result.result.result;
  const result = await evaluate('image-access', async function(fileId) {
    const direct = await wx.cloud.getTempFileURL({ fileList: [fileId] });
    const url = direct.fileList[0]?.tempFileURL;
    const directDownload = url ? await new Promise(resolve => wx.downloadFile({ url, success: result => resolve({ status: result.statusCode }), fail: error => resolve({ message: error.errMsg }) })) : { noUrl: true };
    let sdkDownload;
      try {
        const downloaded = await wx.cloud.downloadFile({ fileID: fileId });
        const bytes = wx.getFileSystemManager().readFileSync(downloaded.tempFilePath);
        sdkDownload = { allowed: true, header: String.fromCharCode.apply(null, Array.from(new Uint8Array(bytes).slice(0, 8))) };
      }
    catch (error) { sdkDownload = { allowed: false, code: error.errCode, message: error.errMsg }; }
    return { directDownload, sdkDownload };
  }, [saved.approvedId]);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.sdkDownload.header, 'SHIYUAN1', 'Direct storage must return ciphertext, never a photo');
} else if (process.argv[2] === 'business') {
  const runId = `qa-${Date.now()}`;
  let sequence = 0;
  const ledger = { runId, records: [], checks: [] };
  const ledgerPath = `${directory}/business-ledger.json`;
  try { await readFile(ledgerPath); throw new Error('已有验收记录，请先核对并清理，禁止重复创建'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function persist() { await writeFile(ledgerPath, JSON.stringify(ledger, null, 2)); }
  async function invoke(action, payload = {}, label = action) {
    const result = await evaluate(`business-${++sequence}-${label}`, async function(data) {
      const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data });
      return { ...response.result, requestID: response.requestID };
    }, [{ action, ...payload }]);
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data;
  }
  let current = await invoke('bootstrap');
  assert.ok(current.familyId);
  for (const field of ['recipes', 'mealSets', 'orders', 'inventory', 'purchases']) assert.equal(current.snapshot[field].length, 0, '真实家庭已有数据，请改为隔离验收，不能覆盖');
  ledger.familyId = current.familyId;
  ledger.userId = current.userId;
  ledger.originalFamily = current.snapshot.family;
  await persist();
  async function mutate(name, args, label = name) {
    current = await invoke('command', { name, args, revision: current.revision, requestId: `${runId}-${sequence}-${label}` }, label);
    return current;
  }
  async function track(collection, id, wrapped = false) {
    const documentId = wrapped ? createHash('sha256').update(`${ledger.familyId}:${id}`).digest('hex') : id;
    ledger.records.push({ collection, id: documentId });
    await persist();
  }
  async function checked(message) { ledger.checks.push(message); await persist(); console.log(`PASS ${message}`); }
  const imageResult = JSON.parse(await readFile(`${directory}/image.json`, 'utf8')).result.result.result;
  const image = imageResult.approvedId;
  const dish = { title: '验收玉米汤', category: '汤羹', servings: 2, minutes: 15, image, nutrition: '', ingredients: [{ name: '玉米', quantity: 0.5, unit: '根' }], steps: [{ title: '准备', text: '玉米洗净切段', images: [image, image] }, { title: '煮汤', text: '煮熟后盛出', images: [] }] };
  await mutate('saveRecipe', [dish], 'recipe-one');
  const firstId = current.snapshot.recipes.find(item => item.title === dish.title).id;
  await track('recipes', firstId, true);
  await mutate('saveRecipe', [{ ...dish, title: '验收番茄汤', ingredients: [{ name: '番茄', quantity: 1, unit: '个' }] }], 'recipe-two');
  const secondId = current.snapshot.recipes.find(item => item.id !== firstId).id;
  await track('recipes', secondId, true);
  await mutate('saveRecipe', [{ ...dish, nutrition: '搭配蔬菜食用' }, firstId], 'recipe-edit');
  assert.equal(current.snapshot.recipes.find(item => item.id === firstId).nutrition, '搭配蔬菜食用');
  await checked('带封面、多图步骤的菜品创建、编辑并持久化');
  await mutate('saveMealSet', [{ title: '验收双汤套餐', image, recipeIds: [firstId, secondId] }]);
  const setId = current.snapshot.mealSets[0].id;
  await track('meal_sets', setId, true);
  await mutate('submitOrder', [{ [`set:${setId}`]: 1, [firstId]: 1 }, { date: localDate(), meal: '宵夜' }, '验收后自动清理']);
  const orderId = current.snapshot.orders[0].id;
  await track('orders', orderId, true);
  assert.equal(current.snapshot.orders[0].items.length, 2);
  assert.equal(current.snapshot.orders[0].items[0].chosenBy.length, 1);
  const needs = getShoppingRequirements(current.snapshot);
  assert.equal(needs.find(item => item.name === '玉米').toBuy, 1);
  await checked('套餐加单品去重为两道菜，半根玉米采购按一根计算');
  await mutate('recordPurchase', [{ name: '玉米', quantity: 1, unit: '根', location: '冷藏', expiresOn: localDate(), image: '' }]);
  await track('purchases', current.snapshot.purchases[0].id, true);
  assert.equal(current.snapshot.purchases[0].expiresOn, localDate());
  await mutate('updateOrder', [orderId, 'accepted']);
  await mutate('updateOrder', [orderId, 'completed']);
  assert.deepEqual(getShoppingRequirements(current.snapshot), []);
  assert.ok(current.snapshot.orders[0].completedAt);
  await checked('不开冰箱可开饭，完成餐食后采购清空，开火记录持久化');
  await mutate('setFeature', ['fridge', true]);
  await mutate('addStock', [{ name: '玉米', quantity: 2, unit: '根', location: '冷藏', expiresOn: localDate(), image }]);
  await track('inventory', current.snapshot.inventory[0].id, true);
  await mutate('removeStock', [current.snapshot.inventory[0].id]);
  await mutate('setFeature', ['fridge', ledger.originalFamily.features.fridge]);
  await checked('冰箱开关、图片食材及到期日保存和删除');
  await mutate('publishToCommunity', [firstId, 'dish']);
  const postId = current.value;
  await track('posts', postId);
  assert.ok((await invoke('feed', { search: '验收玉米汤' })).posts.some(item => item.id === postId));
  await mutate('addComment', [postId, '验收评论']);
  const commentId = current.snapshot.comments[0].id;
  await track('comments', commentId);
  await mutate('addComment', [postId, '验收回复', commentId]);
  const replyId = current.snapshot.comments.find(item => item.id !== commentId).id;
  await track('comments', replyId);
  await mutate('toggleCommentLike', [commentId]);
  assert.ok(current.snapshot.comments.find(item => item.id === commentId).likes.includes(ledger.userId));
  assert.equal(current.snapshot.comments.find(item => item.id === replyId).replyToId, commentId);
  await mutate('deleteCommunityPost', [postId]);
  assert.equal((await invoke('feed', { search: '验收玉米汤' })).posts.length, 0);
  await checked('真实发布、广场搜索、评论、回复、点赞、删除分享');
  const invite = await invoke('createInvite');
  assert.match(invite.code, /^[A-F0-9]{12}$/);
  await checked('邀请码生成成功；第二个真实微信号入家仍需家人扫码验收');
  current = await invoke('bootstrap');
  assert.equal(current.snapshot.orders[0].status, 'completed');
  assert.equal(current.snapshot.recipes.length, 2);
  await checked('重新从云端读取后菜品、套餐、订单仍在');
  ledger.finished = true;
  await persist();
} else if (process.argv[2] === 'database-access') {
  const result = await evaluate('database-access', async function() {
    const checks = [];
    for (const collection of ['families', 'media', 'orders', 'posts', 'comments']) {
      try { await wx.cloud.database().collection(collection).limit(1).get(); checks.push({ collection, allowed: true }); }
      catch (error) { checks.push({ collection, allowed: false, code: error.errCode, message: error.errMsg }); }
    }
    return { checks };
  });
  console.log(JSON.stringify(result, null, 2));
  assert.ok(result.checks.every(item => !item.allowed), 'Client must not read database documents directly');
} else if (process.argv[2] === 'bootstrap') {
  const result = await evaluate('bootstrap', async function() {
    const response = await wx.cloud.callFunction({ name: 'kitchen-v2', data: { action: 'bootstrap' } });
    return response.result;
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log(JSON.stringify({ familyId: result.data.familyId, revision: result.data.revision, counts: Object.fromEntries(['recipes', 'mealSets', 'orders', 'inventory', 'purchases', 'posts', 'comments'].map(key => [key, result.data.snapshot[key].length])) }, null, 2));
} else {
  throw new Error('请选择 bootstrap 或 image');
}
