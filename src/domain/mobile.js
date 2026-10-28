export function pageHeaderStyle(windowInfo, capsule) {
  if (!capsule) return {};
  const width = Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375;
  const top = Number(capsule.top) || (Number(windowInfo.statusBarHeight) || 20) + 4;
  const bottom = Number(capsule.bottom) || top + 32;
  const bottomPadding = 12;
  const reserved = Math.max(0, width - (Number(capsule.left) || width - 96)) + 8;
  const side = `max(0px, calc(${reserved}px - var(--page-gutter)))`;
  return { paddingTop: `${top}px`, minHeight: `${bottom + bottomPadding}px`, paddingBottom: `${bottomPadding}px`, paddingLeft: side, paddingRight: side };
}

export function pageHeaderHeight(windowInfo = {}, capsule = null) {
  if (windowInfo.uniPlatform === 'mp-weixin') return Number.parseFloat(pageHeaderStyle(windowInfo, capsule || {}).minHeight);
  const width = Number(windowInfo.windowWidth || windowInfo.screenWidth) || 375;
  return width > 760 ? 64 : 52;
}

export function sheetTopInset(windowInfo, capsule = null) {
  const statusBar = Math.max(0, Number(windowInfo.statusBarHeight) || 0);
  if (capsule === null) return Math.max(24, statusBar);
  const capsuleBottom = Number(capsule.bottom) || statusBar + 44;
  return Math.max(24, statusBar, capsuleBottom) + 12;
}

export function keyboardLayout(windowHeight, keyboardHeight, topInset = 24) {
  const height = Math.min(windowHeight, Math.max(0, Number(keyboardHeight) || 0));
  return { bottom: height, maxHeight: Math.max(0, windowHeight - height - topInset) };
}

export function nativeKeyboardInset(restHeight, windowHeight, keyboardHeight) {
  return Math.max(0, keyboardHeight - Math.max(0, restHeight - windowHeight));
}

export function visualKeyboardFrame(windowHeight, viewport, topInset = 24) {
  const top = Math.max(0, viewport.offsetTop || 0);
  const bottom = Math.max(0, windowHeight - viewport.height - top);
  return { bottom, maxHeight: Math.max(0, windowHeight - bottom - Math.max(topInset, top)) };
}

export function keyboardTransition(duration) {
  return Number.isFinite(duration) && duration >= 0 ? Math.min(duration, 400) : 240;
}

export function fieldScrollTop(current, field, viewport, gap = 20) {
  if (!field || !viewport) return current;
  if (field.top < viewport.top + gap) return Math.max(0, current + field.top - viewport.top - gap);
  if (field.bottom > viewport.bottom - gap) return Math.max(0, current + Math.min(field.bottom - viewport.bottom + gap, field.top - viewport.top - gap));
  return current;
}
