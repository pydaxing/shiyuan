// A single photo keeps its complete aspect ratio in a bounded preview.
export function singleFeedImageWidth(width, height) {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) return 160;
  return Math.min(200, 240 * width / height, width);
}
