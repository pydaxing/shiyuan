// Timeline links open without the normal authenticated Mini Program session.
export function isMomentsPreview(options) {
  if (options && options.scene !== undefined) return Number(options.scene) === 1154;
  try {
    const api = globalThis.wx || globalThis.uni;
    const entry = api?.getEnterOptionsSync?.() || api?.getLaunchOptionsSync?.();
    return Number(entry?.scene) === 1154;
  } catch { return false; }
}

export function momentsCard() {
  // Do not inherit account, invitation or private workspace query parameters.
  return { title: '食愿小灶 · 把每一餐过成喜欢的日常', query: '', imageUrl: '/static/tomato.png' };
}

export function enableMomentsMenu() {
  const api = globalThis.wx || globalThis.uni;
  api?.showShareMenu?.({ menus: ['shareAppMessage', 'shareTimeline'], fail() {} });
}
