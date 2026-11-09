// Phone and location never enter profile/family/feed serializers.
export const ACCOUNT_LOGIN_VERSION = 1;
export const ACCOUNT_PRIVACY_VERSION = '2026-11-09';
const fail = (message, code = 'INVALID') => { throw Object.assign(new Error(message), { code }); };
export const accountAccessSummary = user => ({ accountLoginVersion: ACCOUNT_LOGIN_VERSION, phoneBound: Boolean(user?.privateContact?.verifiedAt && user.privateContact.phoneNumber) });
export function createAccountAccess({ repository, exchangePhone, appId, now }) {
  async function status(userId) { return accountAccessSummary(await repository.get('users', userId)); }
  async function bind(userId, event) {
    if (event.privacyVersion !== ACCOUNT_PRIVACY_VERSION) fail('请阅读并同意隐私协议');
    if ((await status(userId)).phoneBound) return status(userId);
    if (typeof event.code !== 'string' || !event.code.trim() || event.code.length > 1024) fail('请重新点击手机号登录', 'PHONE_CODE_REQUIRED');
    if (!exchangePhone) fail('手机号服务尚未配置，请稍后重试', 'PHONE_SERVICE_UNAVAILABLE');
    let result;
    try { result = await exchangePhone(event.code); }
    catch { fail('手机号授权未完成，请重新点击登录', 'PHONE_EXCHANGE_FAILED'); }
    const expectedAppId = typeof appId === 'function' ? appId() : appId;
    const info = result?.phoneInfo || result?.phone_info;
    const number = info?.purePhoneNumber || info?.pure_phone_number;
    const country = String(info?.countryCode || info?.country_code || '');
    if (!expectedAppId || result?.errCode || result?.errcode || typeof number !== 'string' || !/^\d{5,20}$/.test(number) || !/^\d{1,4}$/.test(country) || info?.watermark?.appid !== expectedAppId) fail('手机号验证失败，请重新授权', 'PHONE_EXCHANGE_FAILED');
    return repository.transaction(async db => {
      const user = await db.get('users', userId);
      if (accountAccessSummary(user).phoneBound) return accountAccessSummary(user);
      const next = { ...user, createdAt: user?.createdAt || now(), privateContact: { phoneNumber: number, countryCode: country, verifiedAt: now(), provider: 'wechat', privacyVersion: ACCOUNT_PRIVACY_VERSION } };
      await db.set('users', userId, next);
      return accountAccessSummary(next);
    });
  }
  return { status, bind };
}
