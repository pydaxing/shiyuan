export function checkoutPresentation({ closed, hasOrder, dishCount, hasMeal = true }) {
  if (!hasMeal) return { action: 'validate', label: '确认安排', tip: '' };
  if (closed) return { action: 'blocked', label: '请先更换餐次', tip: '这一餐已记录，可查看原餐单。', warning: true };
  if (hasOrder) return { action: 'occupied', label: '确认安排', tip: '这一餐已安排，请选择其他日期、餐次。', warning: true };
  if (!dishCount) return { action: 'choose', label: '去选菜', tip: '先选几道想吃的菜吧。' };
  return { action: 'submit', label: '确认安排', tip: '' };
}
