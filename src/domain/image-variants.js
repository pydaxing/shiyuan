export const displayVariants = ['card', 'detail'];
export const displayImageSettings = {
  card: { edge: 480, quality: 72, maxBytes: 80000 },
  detail: { edge: 960, quality: 82, maxBytes: 120000 },
};
export function imageVersion(fileId, variant = 'original') {
  return variant === 'original' ? fileId : `${fileId}#display-${variant}-v1`;
}
export function imageRequest(key) {
  const match = key.match(/#display-(card|detail)-v1$/);
  return match ? { fileId: key.slice(0, match.index), variant: match[1] } : { fileId: key, variant: 'original' };
}
