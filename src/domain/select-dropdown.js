export function selectDropdownGeometry(anchor, viewport, optionCount) {
  if (!Number.isFinite(anchor?.left) || !Number.isFinite(anchor?.bottom) || !Number.isFinite(viewport?.windowWidth) || !Number.isFinite(viewport?.windowHeight) || optionCount < 1) return null;
  const gutter = 12;
  const width = Math.min(176, viewport.windowWidth - gutter * 2);
  const top = Math.max(gutter, anchor.bottom + 4);
  const rows = Math.ceil(optionCount / 2);
  const height = Math.min(rows * 44 + (rows - 1) * 4 + 18, viewport.windowHeight - top - gutter);
  if (width <= 0 || height <= 0) return null;
  const left = Math.max(gutter, Math.min(anchor.left, viewport.windowWidth - width - gutter));
  return { top, left, width, height };
}
