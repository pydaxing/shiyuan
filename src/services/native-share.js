import { foodCover } from '../domain/presentation.js';

let sequence = 0;
const cards = new Map();
export const defaultShare = () => ({ title: '食愿小灶 · 一家人，好好吃饭', path: '/pages/index/index', imageUrl: '/static/tomato.png' });
export function registerShare(card) { const key = `native-share-${++sequence}`; cards.set(key, card); return key; }
export function removeShare(key) { cards.delete(key); }
export function shareMessage(event, fallback) {
  const key = event?.target?.dataset?.shareKey || event?.target?.dataset?.sharekey;
  return cards.get(key) || fallback || defaultShare();
}
export function invitationCard(invite) { return { title: `邀请你加入「${invite.familyName}」一起点餐`, path: `/pages/invite/index?token=${encodeURIComponent(invite.token)}`, imageUrl: '/static/tomato.png' }; }
export function dishShareCard(share) { return { title: `${share.kind === 'menu' || share.kind === 'set' ? '一起吃这份套餐' : '这道菜想和你一起吃'}：${share.title}`, path: share.token ? `/pages/shared/index?token=${encodeURIComponent(share.token)}` : `/pages/shared/index?postId=${encodeURIComponent(share.id)}`, imageUrl: foodCover(share.imageUrl, share.kind) }; }
