export function checkoutPresentation({ closed, hasSelection, hasOrder, dirty, dishCount }) {
  if (closed) return { action: 'blocked', label: '请先更换餐次', tip: '这一餐已做好，请换个日期或餐次。', warning: true };
  if (hasSelection && !dirty || hasOrder && !hasSelection && !dishCount) return { action: 'view', label: '去加菜', tip: '这一餐已经安排好了，备菜中也可以继续加菜。' };
  if (!dishCount) {
    if (hasSelection) return { action: 'withdraw', label: '撤回我的选菜', tip: '将撤回你这一餐的选菜，家人的不变。', warning: true };
    return { action: 'choose', label: '去选菜', tip: '先选几道想吃的菜吧。' };
  }
  if (hasSelection) return { action: 'update', label: '更新这餐选菜', tip: '只更新你的菜品和备注，不影响家人。' };
  return { action: 'submit', label: '送到厨房', tip: hasOrder ? '家人已点这一餐，你选的菜会合并到同一单。' : '' };
}
