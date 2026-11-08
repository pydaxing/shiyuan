import { createHash, timingSafeEqual } from 'node:crypto';

export const MEAL_ARCHIVE_FUNCTION = 'kitchen-diary-archive';
export const MEAL_ARCHIVE_TRIGGER = 'meal-diary-every-minute';
export const MEAL_ARCHIVE_TOKEN_HASH_ENV = 'MEAL_ARCHIVE_TRIGGER_TOKEN_SHA256';
export const MEAL_ARCHIVE_CRON = '0 * * * * * *';
const denied = () => { throw Object.assign(new Error('餐食归档触发授权无效'), { code: 'FORBIDDEN' }); };

// Timer events are plain JSON and can be imitated by callFunction. The private
// trigger argument is therefore authenticated in addition to its event shape.
// It lives only in the deployment's protected trigger configuration; the runtime
// stores its SHA-256 digest. Do not log the event or the trigger argument.
export function createMealArchiveTrigger({ archive, tokenHash, now = Date.now }) {
  return async (event, context = {}) => {
    if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) throw Object.assign(new Error('餐食归档触发器尚未配置'), { code: 'ARCHIVE_CONFIG' });
    if (context.OPENID || context.FROM_OPENID || context.UID || context.TCB_UUID || context.extendedContext?.userId
      || /^(?:wx_client|wx_devtools|web|http)(?:$|_)/.test(context.SOURCE || '')) denied();
    if (event?.Type !== 'Timer' || event.TriggerName !== MEAL_ARCHIVE_TRIGGER || event.action !== undefined
      || typeof event.Message !== 'string' || !/^[a-f0-9]{64}$/.test(event.Message)) denied();
    const time = typeof event.Time === 'string' ? Date.parse(event.Time) : NaN;
    if (!Number.isFinite(time) || time > now() + 30000 || time < now() - 300000) denied();
    const digest = createHash('sha256').update(event.Message).digest();
    if (!timingSafeEqual(digest, Buffer.from(tokenHash, 'hex'))) denied();
    return { ok: true, data: await archive.runScheduled() };
  };
}
