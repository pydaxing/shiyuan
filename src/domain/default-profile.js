// Versioned, immutable choices. Selection uses the authenticated user ID, never
// a nickname, device identifier, render time or Math.random(). Keep v1 ordering.
export const DEFAULT_PROFILE_VERSION = 1;
const avatarLabels = ['米饭团子', '小笼包子', '番茄小圆', '胡萝卜头', '太阳煎蛋', '吐司早安', '桃桃软糖', '西兰小花', '饺子弯弯', '草莓点点', '蘑菇小伞', '牛奶咕嘟', '南瓜暖暖', '面条卷卷', '玉米金粒', '牛油果果', '橙子晴天', '饭团海苔', '豌豆三颗', '茶杯慢慢'];
export const DEFAULT_AVATARS = Object.freeze(avatarLabels.map((name, index) => Object.freeze({
  id: `food-${String(index + 1).padStart(2, '0')}`,
  name,
  src: `/static/default-avatars/food-${String(index + 1).padStart(2, '0')}.png`,
})));

export const DEFAULT_NICKNAMES = Object.freeze([
  '一口小饭团', '暖暖小馒头', '番茄慢半拍', '今天吃面呀', '小锅咕嘟嘟',
  '晚风拌米饭', '清晨一碗粥', '月亮蒸包子', '橙子开饭啦', '桃桃在煮汤',
  '栗子小厨房', '软软糯米团', '香菜也可爱', '芋圆等开饭', '山药晒太阳',
  '小葱拌豆腐', '米粒散步中', '认真吃早饭', '汤圆有点甜', '土豆慢慢炖',
  '玉米晒月亮', '南瓜好心情', '豆包看晚霞', '小熊煎荷包', '荷包蛋早安',
  '面包边边脆', '布丁打个盹', '红豆有小灶', '绿豆慢慢熬', '糯米遇见你',
  '橘子小饭桌', '柚子吃饱啦', '青柠小围裙', '饭团不迟到', '锅铲有点忙',
  '一勺好滋味', '芝麻小星星', '蘑菇撑把伞', '茄子会微笑', '豌豆排排坐',
  '西兰花开饭', '萝卜等雨停', '秋葵小分队', '小白菜散步', '红薯暖手心',
  '豆腐轻轻晃', '紫薯抱抱团', '山楂想吃饭', '莲藕有点脆', '银耳慢慢煮',
  '核桃小伙伴', '杏仁听风声', '腰果打招呼', '花生小满足', '小饼干出炉',
  '一颗小馄饨', '饺子捏月亮', '春卷卷春天', '烧麦冒热气', '蒸糕松松软',
  '包子藏惊喜', '汤面暖肚子', '年糕爱拉丝', '饭勺小助手', '小碗盛星光',
  '盘子转个圈', '筷子开动啦', '围裙有阳光', '厨房等花开', '一桌小欢喜',
  '慢火好时光', '热汤有回音', '三餐都期待', '早饭不缺席', '午后小甜点',
  '晚餐有着落', '好好吃一顿', '今天也光盘', '一口好心情', '小口尝春天',
  '煮饭等月亮', '晨光配吐司', '晚霞配热汤', '星星煮白粥', '风里有饭香',
  '桃子小团圆', '草莓小饭友', '苹果慢慢啃', '蓝莓小口袋', '葡萄爱下厨',
  '柿子红了呀', '梨子煮甜汤', '樱桃双倍甜', '枣枣有精神', '芒果小太阳',
  '牛奶冒泡泡', '豆浆趁热喝', '茶香小日子', '可可暖呼呼', '薄荷小清新',
]);

const avatarsById = new Map(DEFAULT_AVATARS.map(avatar => [avatar.id, avatar]));
const avatarsByPath = new Map(DEFAULT_AVATARS.map(avatar => [avatar.src, avatar]));
const nonempty = value => typeof value === 'string' && value.trim() ? value : '';
function choiceIndex(userId, kind, count) {
  let value = 2166136261;
  for (const character of `shiyuan-default-v1:${kind}:${userId}`) {
    value = Math.imul(value ^ character.codePointAt(0), 16777619) >>> 0;
  }
  return value % count;
}

export const isDefaultAvatar = value => typeof value === 'string' && avatarsByPath.has(value);
export const defaultAvatarIdForPath = value => avatarsByPath.get(value)?.id || '';
export const isDefaultAvatarId = value => typeof value === 'string' && avatarsById.has(value);
export function defaultAvatarIdForUser(userId, preferredId = '') {
  if (!nonempty(userId)) return '';
  return isDefaultAvatarId(preferredId) ? preferredId : DEFAULT_AVATARS[choiceIndex(userId, 'avatar', DEFAULT_AVATARS.length)].id;
}
export function defaultAvatarForUser(userId, preferredId = '') {
  return avatarsById.get(defaultAvatarIdForUser(userId, preferredId))?.src || '';
}
export function defaultNicknameForUser(userId) {
  return nonempty(userId) ? DEFAULT_NICKNAMES[choiceIndex(userId, 'nickname', DEFAULT_NICKNAMES.length)] : '';
}
export function profileWithDefaults(profile, userId) {
  return {
    name: nonempty(profile?.name) || defaultNicknameForUser(userId),
    avatar: nonempty(profile?.avatar) || defaultAvatarForUser(userId, profile?.defaultAvatarId),
  };
}

// The legacy avatar field only contains user-uploaded cloud images or ''. New
// static resources must never be persisted there: old packages lack those files.
export function compatibleDefaultProfilePayload(payload, baseline) {
  const result = { ...payload };
  if (isDefaultAvatar(result.avatar)) {
    result.defaultAvatarId = defaultAvatarIdForPath(result.avatar);
    result.avatar = '';
  }
  if (result.expectedProfile) {
    result.expectedProfile = { ...result.expectedProfile };
    const expectedDefaultId = defaultAvatarIdForPath(result.expectedProfile.avatar);
    // Translate only the exact displayed value the caller compared against.
    // A stale, different nickname/avatar must remain stale, not be rebased to a
    // newer account value while waiting for an in-flight refresh.
    if (baseline?.raw && baseline?.displayed) {
      for (const field of ['name', 'avatar']) {
        if (result.expectedProfile[field] === baseline.displayed[field]) result.expectedProfile[field] = baseline.raw[field] || '';
      }
    }
    if (isDefaultAvatar(result.expectedProfile.avatar)) result.expectedProfile.avatar = '';
    if (expectedDefaultId) result.expectedProfile.defaultAvatarId = expectedDefaultId;
  }
  return result;
}
