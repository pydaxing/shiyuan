// Display states are independent of the legacy persisted order status.
export function orderRecordState(order) {
  if (order.diaryDeletedAt || order.recordState === 'deleted') return 'deleted';
  if (order.recordState) return order.recordState;
  if (order.autoArchivedAt && order.mealPostId) return 'recorded';
  if (order.status !== 'completed') return '';
  return order.mealPostId ? 'recorded' : 'missing';
}
export function orderStatusLabel(order) {
  const record = orderRecordState(order);
  if (record === 'deleted') return '日记已删除';
  if (record === 'recorded') return '已记录';
  if (order.status === 'completed') return '历史已结束';
  return order.status === 'cancelled' ? '已取消' : '已安排';
}
