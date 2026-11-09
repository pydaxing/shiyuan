// Display states are independent of the legacy persisted order status.
export function orderRecordState(order) {
  if (order.diaryDeletedAt || order.recordState === 'deleted') return 'deleted';
  if (order.recordState) return order.recordState;
  if (order.status !== 'completed') return '';
  return order.mealPostId ? 'recorded' : 'missing';
}
export function orderStatusLabel(order) {
  const record = orderRecordState(order);
  if (record === 'deleted') return '记录已删除';
  if (order.status === 'completed') return record === 'recorded' ? '已记录' : '历史已结束';
  return order.status === 'cancelled' ? '已取消' : '已安排';
}
