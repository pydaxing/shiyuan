import cloud from 'wx-server-sdk';
import { createWechatRepository } from './wechat-repository.mjs';
import { createMealAutoArchive } from './meal-auto-archive.mjs';
import { createMealArchiveTrigger, MEAL_ARCHIVE_TOKEN_HASH_ENV } from './meal-archive-trigger.mjs';

// Keep scheduled jobs in a separate function from authenticated application
// calls. wx-server-sdk gets identity from environment variables, which may
// otherwise remain from a previous invocation when an instance is reused.
process.env.TZ = 'Asia/Shanghai';
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const database = cloud.database();
const archive = createMealAutoArchive({ repository: createWechatRepository(database) });
const trigger = createMealArchiveTrigger({ archive, tokenHash: process.env[MEAL_ARCHIVE_TOKEN_HASH_ENV] });

export async function main(event) {
  return trigger(event, cloud.getWXContext());
}
