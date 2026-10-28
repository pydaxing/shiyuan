import solarLunar from 'solarlunar';
import { kitchenOrders, localDate, validDate } from './kitchen.js';

export function homeDateLabel(date) {
  if (!validDate(date)) return '';
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const [year, month, day] = date.split('-');
  const current = new Date(`${date}T12:00:00`);
  const solarLabel = `${month}月${day}日`;
  const weekday = weekdays[current.getDay()];
  const lunar = solarLunar.solar2lunar(Number(year), Number(month), Number(day));
  return lunar === -1 ? `${solarLabel} · ${weekday}` : `${solarLabel} · ${lunar.monthCn}${lunar.dayCn} · ${weekday}`;
}

export function kitchenWelcome(orders, today = localDate()) {
  const visibleOrders = kitchenOrders(orders, today);
  if (!visibleOrders.length) return { mode: 'empty', title: '今天还没安排餐食', recordTitle: '' };
  const activeOrders = visibleOrders.filter(order => ['pending', 'accepted'].includes(order.status));
  if (activeOrders.length) return { mode: 'active', title: '有餐食预定，快来准备吧！', recordTitle: '' };
  const recordTitle = visibleOrders.every(order => order.status === 'cancelled') ? '' : visibleOrders.every(order => order.status === 'completed') ? '已开饭' : '餐食记录';
  return { mode: 'idle', title: '还没有餐食，快来预订吧！', recordTitle };
}
