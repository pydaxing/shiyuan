import assert from 'node:assert/strict';

export function confirmedUploadResult(response) {
  const result = response?.result;
  assert.ok(response?.ok === true && result?.success === true, '微信未确认上传成功');
  if (result.taskId || result.status) {
    assert.equal(result.status, 'success', '上传任务尚未完成，不能将等待确认或失败记为上传成功');
    assert.equal(result.result?.success, true, '上传任务没有最终成功结果');
    return result.result;
  }
  assert.ok(Number.isFinite(result.info?.size?.total) && result.info.size.total > 0, '上传缺少实际代码包回执');
  return result;
}
