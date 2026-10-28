import { makeShare, parseShare } from '../domain/sharing.js';

export async function portableShare(item, recipes, author, kind = 'dish', platform = uni) {
  const payload = JSON.parse(makeShare(item, recipes, author, kind));
  async function portable(image) {
    if (!image || image.startsWith('/static/') || image.startsWith('data:')) return image || '';
    if (!platform.getFileSystemManager) throw new Error('无法读取分享图片，请重新选择照片');
    const data = await new Promise((resolve, reject) => platform.getFileSystemManager().readFile({ filePath: image, encoding: 'base64', success: (result) => resolve(result.data), fail: () => reject(new Error('图片读取失败，请重新选择照片后分享')) }));
    const type = /\.png$/i.test(image) ? 'png' : /\.webp$/i.test(image) ? 'webp' : 'jpeg';
    return `data:image/${type};base64,${data}`;
  }
  payload.image = await portable(payload.image);
  for (const recipe of payload.recipes) {
    recipe.image = await portable(recipe.image);
    for (const step of recipe.steps) {
      if (step.images) step.images = await Promise.all(step.images.map(portable));
      else step.image = await portable(step.image);
    }
  }
  const text = JSON.stringify(payload);
  if (text.length > 12000000) throw new Error('分享内容过大，请减少步骤图片');
  parseShare(text);
  return text;
}
