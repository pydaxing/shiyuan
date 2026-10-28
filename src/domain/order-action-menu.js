const actionIcons = new Map([['cancel', 'cancel'], ['restore', 'restore'], ['edit', 'edit'], ['remove', 'trash-danger']]);

export function orderMenuIcon(action) {
  return actionIcons.get(action) || '';
}

export function orderMenuActions(status, hasDishes = true) {
  const actions = [];
  if (['pending', 'accepted'].includes(status)) actions.push({ action: 'cancel', label: '取消' });
  if (status === 'cancelled' && hasDishes) actions.push({ action: 'restore', label: '恢复' });
  actions.push({ action: 'remove', label: '删除' });
  return actions;
}

export function orderMenuGeometry(anchor, viewport, count) {
  if (![anchor?.left, anchor?.right, anchor?.top, anchor?.bottom, viewport?.windowWidth, viewport?.windowHeight].every(Number.isFinite) || !Number.isInteger(count) || count < 1) return null;
  const gutter = 12;
  const gap = 6;
  const width = Math.min(128, viewport.windowWidth - gutter * 2);
  if (width < 44 || anchor.right <= 0 || anchor.left >= viewport.windowWidth || anchor.bottom <= 0 || anchor.top >= viewport.windowHeight || anchor.right <= anchor.left || anchor.bottom <= anchor.top) return null;
  const desiredHeight = count * 44 + 10;
  const below = viewport.windowHeight - gutter - anchor.bottom - gap;
  const above = anchor.top - gutter - gap;
  const placement = below < desiredHeight && above > below ? 'above' : 'below';
  const height = Math.min(desiredHeight, placement === 'above' ? above : below);
  if (height < 54) return null;
  const left = Math.max(gutter, Math.min(anchor.right, viewport.windowWidth - gutter) - width);
  const top = placement === 'above' ? anchor.top - gap - height : anchor.bottom + gap;
  const pointer = Math.max(12, Math.min(width - 12, (anchor.left + anchor.right) / 2 - left));
  return { top, left, width, height, pointer, placement };
}
