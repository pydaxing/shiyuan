import { readDocuments } from './repository-reads.mjs';
import { legacyCompletedMealId } from './meal-auto-archive.mjs';

// Read-only projection. Never reinterpret a legacy completed flag as a diary.
export async function withOrderRecordStates(repository, spaceId, orders, today) {
  const visible = orders.filter(order => order.status === 'completed' && order.date >= today && !order.diaryDeletedAt);
  const records = await readDocuments(repository, 'meal_posts', visible.map(order => order.mealPostId || legacyCompletedMealId(spaceId, order.id)));
  const states = new Map(await Promise.all(visible.map(async order => {
    let post = records.get(order.mealPostId || legacyCompletedMealId(spaceId, order.id));
    if (!post && !order.mealPostId) {
      const rows = await repository.list('meal_posts', { spaceId, orderId: order.id }, { limit: 2, fields: ['status', 'spaceId', 'orderId'] });
      post = rows.find(row => row.status === 'deleted') || rows.find(row => row.status === 'published');
    }
    const belongs = post?.spaceId === spaceId && (!post.orderId || post.orderId === order.id);
    return [order.id, belongs && post.status === 'published' ? 'recorded' : belongs && post.status === 'deleted' ? 'deleted' : 'missing'];
  })));
  return orders.map(order => ({ ...order, ...(order.diaryDeletedAt ? { recordState: 'deleted' } : states.has(order.id) ? { recordState: states.get(order.id) } : {}) }));
}
