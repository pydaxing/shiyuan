import { dateOffset } from '../domain/kitchen.js';
import { FAMILY_APPEARANCE_DEFAULTS } from '../domain/family.js';

const ingredient = (name, quantity, unit) => ({ name, quantity, unit });
const steps = (texts, image) => texts.map((text, index) => ({ title: ['准备食材', '下锅烹饪', '调味装盘'][index], text, image: index === texts.length - 1 ? image : `/static/step-${index === 0 ? 'prep' : 'cook'}.png` }));

const tomato = {
  id: 'tomato', title: '番茄炒蛋', category: '素菜', minutes: 12, servings: 2, image: '/static/tomato.png', tag: '家的味道', author: '食愿厨房',
  description: '酸甜的番茄汁裹着软嫩鸡蛋，是一碗米饭最好的搭档。',
  ingredients: [ingredient('番茄', 400, 'g'), ingredient('鸡蛋', 3, '个'), ingredient('食用油', 15, 'ml'), ingredient('盐', 3, 'g')],
  steps: steps(['番茄洗净切块，鸡蛋打入碗中搅匀。刀具与砧板保持清洁。', '锅中加油，中火烧热后倒入蛋液，轻推至完全凝固后盛出。放入番茄翻炒，沿锅边加少量清水煮出汁。', '倒回鸡蛋，加盐翻炒均匀，确认蛋液完全凝固、番茄软熟后关火装盘。'], '/static/tomato.png'),
};
const chicken = {
  id: 'chicken', title: '香菇滑鸡', category: '荤菜', minutes: 25, servings: 2, image: '/static/chicken.png', tag: '下饭担当', author: '食愿厨房',
  description: '香菇吸满鲜香汤汁，鸡肉嫩而不柴。留一点汁拌饭刚刚好。',
  ingredients: [ingredient('鸡腿肉', 350, 'g'), ingredient('香菇', 150, 'g'), ingredient('生抽', 15, 'ml'), ingredient('食用油', 10, 'ml')],
  steps: steps(['鸡腿肉切块，加生抽抓匀腌制 10 分钟。香菇清洗切片，生熟食材使用不同砧板。', '热锅加油，下鸡肉翻炒至表面变色，加入香菇和少量清水，加盖中小火焖煮约 10 分钟。', '检查最大块鸡肉中心熟透、无生肉质感；必要时延长加热。开盖收汁后盛出，不以表面变色作为熟透的唯一依据。'], '/static/chicken.png'),
};
const broccoli = {
  id: 'broccoli', title: '蒜蓉西兰花', category: '素菜', minutes: 10, servings: 2, image: '/static/broccoli.png', tag: '清爽一点', author: '食愿厨房',
  description: '脆嫩的一抹绿，给今天的餐桌留一点清爽。',
  ingredients: [ingredient('西兰花', 300, 'g'), ingredient('大蒜', 15, 'g'), ingredient('食用油', 10, 'ml'), ingredient('盐', 2, 'g')],
  steps: steps(['西兰花切成小朵充分清洗，大蒜去皮切末。', '水烧开后下西兰花煮约 2 分钟，捞出沥水；热锅放油，小火炒香蒜末。', '倒入西兰花，加盐翻炒至熟，保留适口脆度后装盘。'], '/static/broccoli.png'),
};
const soup = {
  id: 'soup', title: '玉米排骨汤', category: '汤羹', minutes: 60, servings: 3, image: '/static/soup.png', tag: '慢慢炖的爱', author: '食愿厨房',
  description: '玉米的清甜和热汤的暖意，适合全家慢慢喝。',
  ingredients: [ingredient('排骨', 500, 'g'), ingredient('玉米', 2, '根'), ingredient('胡萝卜', 150, 'g'), ingredient('盐', 4, 'g')],
  steps: steps(['排骨冷水入锅烧开，撇去浮沫后捞出洗净。玉米、胡萝卜洗净切段。', '将食材放入汤锅，加足量清水。煮开后转小火加盖炖约 45 分钟，留意水量防止干烧。', '确认排骨熟透、蔬菜软熟后加盐调味，分碗饮用时注意热汤烫口。'], '/static/soup.png'),
};
const rice = {
  id: 'rice', title: '什锦蛋炒饭', category: '主食', minutes: 15, servings: 2, image: '/static/rice.png', tag: '一碗就满足', author: '食愿厨房',
  description: '米粒、蔬菜和鸡蛋在锅里相遇，忙碌时也认真吃饭。',
  ingredients: [ingredient('熟米饭', 400, 'g'), ingredient('鸡蛋', 2, '个'), ingredient('胡萝卜', 100, 'g'), ingredient('食用油', 15, 'ml'), ingredient('盐', 3, 'g')],
  steps: steps(['准备新鲜熟米饭，或及时冷藏且保存妥当的米饭。胡萝卜切小丁，鸡蛋打散。', '热锅加油，将鸡蛋炒至完全凝固，加入胡萝卜丁翻炒至软熟。', '倒入米饭压散翻炒，加盐调味，确保米饭整体充分加热后装碗；不使用常温久放的米饭。'], '/static/rice.png'),
};
const beef = {
  id: 'beef', title: '彩椒炒牛肉', category: '荤菜', minutes: 20, servings: 2, image: '/static/beef.png', tag: '今晚加个菜', author: '食愿厨房',
  description: '一盘色彩明亮的家常小炒，让回家吃饭变得更期待。',
  ingredients: [ingredient('牛肉', 300, 'g'), ingredient('彩椒', 200, 'g'), ingredient('生抽', 15, 'ml'), ingredient('食用油', 15, 'ml')],
  steps: steps(['牛肉逆纹切片，用生抽抓匀。彩椒洗净去籽切块。生熟食材分开处理。', '热锅放油，下牛肉翻炒，再加入彩椒炒匀，按需加少量清水避免干锅。', '持续翻炒至牛肉和蔬菜熟透，收汁装盘。时间随肉片厚度调整。'], '/static/beef.png'),
};

const tofu = {
  id: 'tofu', title: '菌菇豆腐煲', category: '素菜', minutes: 20, servings: 2, image: '/static/tofu.png', tag: '新鲜灵感', author: '食愿厨房',
  description: '豆腐和菌菇的鲜味，在小锅里慢慢融合。',
  ingredients: [ingredient('豆腐', 300, 'g'), ingredient('香菇', 100, 'g'), ingredient('生抽', 10, 'ml'), ingredient('食用油', 10, 'ml')],
  steps: steps(['豆腐切块，香菇洗净切片。', '热锅放油炒香香菇，加入豆腐、生抽和适量清水，小火煮约 10 分钟。', '确认食材充分煮熟，稍收浓汤汁即可，盛出时注意砂锅和汤汁温度。'], '/static/tofu.png'),
};
const pumpkin = {
  id: 'pumpkin', title: '暖心南瓜汤', category: '汤羹', minutes: 25, servings: 2, image: '/static/pumpkin.png', tag: '暖暖一碗', author: '食愿厨房',
  description: '一碗甜润的南瓜汤，把一天的疲惫慢慢放下。',
  ingredients: [ingredient('南瓜', 400, 'g'), ingredient('牛奶', 200, 'ml'), ingredient('盐', 1, 'g')],
  steps: steps(['南瓜去皮去籽切小块。牛奶配方不适合乳制品过敏者。', '南瓜加清水煮约 15 分钟至软熟，用压泥器压碎。', '加入牛奶和盐，小火搅拌加热，避免溢锅；盛出稍凉后食用。'], '/static/pumpkin.png'),
};

export const collections = [
  { id: 'weekday', title: '下班后，也要好好吃饭', author: '食愿厨房', image: '/static/tofu.png', label: '快手晚餐', recipes: [tofu, broccoli, rice] },
  { id: 'weekend', title: '周末，给家人煲一锅汤', author: '食愿厨房', image: '/static/pumpkin.png', label: '周末家宴', recipes: [pumpkin, chicken, broccoli] },
];

const dishPost = (recipe, categories, tall = false) => ({ id: `dish-${recipe.id}`, kind: 'dish', title: recipe.title, author: '食愿厨房', image: recipe.image, recipes: [recipe], categories, tall });
export const communityPosts = [
  dishPost(tofu, ['家常', '轻食', '素菜'], true),
  { ...collections[0], kind: 'menu', title: '下班后的快手晚餐', categories: ['快手', '家常'] },
  dishPost(tomato, ['快手', '家常', '素菜']),
  { ...collections[1], kind: 'menu', title: '周末，三道菜一桌饭', categories: ['家常', '汤羹'], tall: true },
  dishPost(broccoli, ['快手', '轻食', '素菜'], true),
  dishPost(chicken, ['家常', '荤菜']),
  { id: 'light-menu', kind: 'menu', title: '清爽轻食双人餐', author: '食愿厨房', image: '/static/broccoli.png', recipes: [broccoli, tofu], categories: ['轻食', '素菜'], tall: true },
  dishPost(pumpkin, ['汤羹', '轻食'], true),
  dishPost(beef, ['快手', '荤菜']),
  dishPost(rice, ['快手', '主食']),
];

export function createSeed() {
  return {
    version: 1,
    family: { ...FAMILY_APPEARANCE_DEFAULTS, members: [{ id: 'me', name: '我', role: '家庭管理员' }, { id: 'partner', name: '家人', role: '家庭成员' }, { id: 'chef', name: '家人', role: '家庭成员' }] },
    activeMemberId: 'me',
    recipes: [tomato, chicken, broccoli, soup, rice, beef].map((recipe) => ({ ...recipe, sourceId: recipe.id })),
    orders: [],
    inventory: [
      { id: 'stock-tomato', name: '番茄', quantity: 260, unit: 'g', location: '冷藏', expiresOn: dateOffset(2) },
      { id: 'stock-eggs', name: '鸡蛋', quantity: 4, unit: '个', location: '冷藏', expiresOn: dateOffset(10) },
      { id: 'stock-chicken', name: '鸡腿肉', quantity: 150, unit: 'g', location: '冷冻', expiresOn: dateOffset(20) },
      { id: 'stock-broccoli', name: '西兰花', quantity: 300, unit: 'g', location: '冷藏', expiresOn: dateOffset(1) },
      { id: 'stock-oil', name: '食用油', quantity: 300, unit: 'ml', location: '常温', expiresOn: dateOffset(120) },
      { id: 'stock-salt', name: '盐', quantity: 200, unit: 'g', location: '常温', expiresOn: '' },
      { id: 'stock-soy', name: '生抽', quantity: 100, unit: 'ml', location: '常温', expiresOn: dateOffset(90) },
    ],
  };
}
