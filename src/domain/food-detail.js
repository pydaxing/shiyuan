export function foodDetailToolbarOpacity(scrollTop) {
  const offset = typeof scrollTop === 'number' && Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  return Math.round(Math.min(offset / 120, 1) * 100) / 100;
}
