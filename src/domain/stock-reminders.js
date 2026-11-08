import { dateOffset, localDate } from './kitchen.js';
// Planning reminders in days [room, fridge, freezer]. These are deliberately
// not claimed as measured remaining shelf life; package/opening dates take priority.
const profiles = {
  leaf: [0, 3, 30], root: [7, 7, 30], vegetable: [2, 5, 30], mushroom: [0, 3, 30],
  fruit: [3, 5, 30], meat: [0, 1, 90], poultry: [0, 1, 90], seafood: [0, 1, 60],
  egg: [0, 14, 30], tofu: [0, 2, 30], dairy: [0, 3, 30], cheese: [0, 7, 30],
  dry: [90, 90, 90], noodle: [7, 3, 30], sauce: [30, 30, 30], paste: [0, 7, 30],
  spice: [90, 90, 90], prepared: [0, 2, 30], unknown: [0, 1, 7],
};
export function stockReminder(entry, location, today = localDate()) {
  let profile = entry?.storageProfile || 'unknown';
  const name = entry?.name || '';
  // Perishable exceptions within broad shopping categories.
  if (/肉末|肝|心|腰|肚|肠|肺|血|胗/.test(name) && ['meat', 'poultry'].includes(profile)) profile = 'seafood';
  if (/鲜|饺子皮|馄饨皮|烧卖皮|春卷皮|河粉|肠粉|粿条|年糕/.test(name) && profile === 'noodle') profile = 'tofu';
  if (/面包|吐司|法棍|贝果|可颂|馒头|花卷|包子|窝头|饼胚/.test(name) && profile === 'noodle') profile = 'prepared';
  if (['腐竹', '豆豉'].includes(name)) profile = 'dry';
  if (['鸡蛋清', '鸡蛋黄'].includes(name)) profile = 'tofu';
  const days = (profiles[profile] || profiles.unknown)[{ 常温: 0, 冷藏: 1, 冷冻: 2 }[location] ?? 1];
  let note = '预估提醒，以包装、开封日期及实际状态为准';
  if (location === '冷冻') note = '按持续 −18°C 冷冻估算用完提醒，冷冻不代表品质永久不变';
  if (location === '常温' && days === 0) note = '不宜常温久放，请及时冷藏；今天提醒处理';
  if (location === '冷冻' && profile === 'egg') note = '带壳生蛋不宜冷冻；建议改为冷藏';
  return { days, date: dateOffset(days, new Date(`${today}T12:00:00`)), note };
}
