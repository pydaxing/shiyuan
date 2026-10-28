const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

export const COVER_RATIOS = Object.freeze({ family: GOLDEN_RATIO, recipe: GOLDEN_RATIO, square: 1 });

export function imageFrameStyle(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return {};
  return { height: '0px', minHeight: '0px', paddingTop: `${100 / ratio}%` };
}

export function coverFrameStyle(frame = 'recipe') {
  return imageFrameStyle(COVER_RATIOS[frame] || COVER_RATIOS.recipe);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function validateSize(size) {
  if (![size?.width, size?.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('无法读取图片或取景框尺寸，请重试');
}

export function fitCropImage(source, frame, zoom = 1, center = { x: .5, y: .5 }) {
  validateSize(source);
  validateSize(frame);
  const scale = Math.max(frame.width / source.width, frame.height / source.height) * clamp(Number(zoom) || 1, 1, 3);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    width, height,
    x: clamp(frame.width / 2 - width * center.x, frame.width - width, 0),
    y: clamp(frame.height / 2 - height * center.y, frame.height - height, 0),
  };
}

export function cropOffset(image, frame, position) {
  return { x: clamp(Number(position.x) || 0, frame.width - image.width, 0), y: clamp(Number(position.y) || 0, frame.height - image.height, 0) };
}

export function cropRectangle(image, frame, position = image) {
  validateSize(image);
  validateSize(frame);
  const offset = cropOffset(image, frame, position);
  return { x: -offset.x / image.width, y: -offset.y / image.height, width: Math.min(1, frame.width / image.width), height: Math.min(1, frame.height / image.height) };
}

export function cropFocus(image, frame, position = image) {
  const crop = cropRectangle(image, frame, position);
  return { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 };
}

export function cropFromBounds(frame, image) {
  validateSize(frame);
  validateSize(image);
  if (![frame.left, frame.top, image.left, image.top].every(Number.isFinite)) throw new Error('无法读取图片位置，请重新调整');
  const position = { x: image.left - frame.left, y: image.top - frame.top };
  if (position.x > 1 || position.y > 1 || position.x + image.width < frame.width - 1 || position.y + image.height < frame.height - 1) throw new Error('图片尚未铺满取景框，请调整后重试');
  return cropRectangle(image, frame, position);
}

export function cropPixels(source, crop) {
  validateSize(source);
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) throw new Error('取景范围无效，请重新调整');
  return { x: crop.x * source.width, y: crop.y * source.height, width: crop.width * source.width, height: crop.height * source.height };
}
