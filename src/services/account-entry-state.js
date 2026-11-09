export const ACCOUNT_PRIVACY_VERSION = '2026-11-09';
export function phoneAuthorizationError(detail) {
  const message = typeof detail?.errMsg === 'string' ? detail.errMsg : '';
  const errno = Number(detail?.errno);
  if (errno === 1400001) return '手机号服务暂不可用，请稍后重试（1400001）';
  if (/privacy/i.test(message)) return '微信隐私授权未完成，请重新点击微信登录';
  if (/no permission|permission denied/i.test(message)) return '小程序暂无手机号接口权限，请联系开发者处理';
  if (/user deny|user cancel|user denied|cancelled/i.test(message)) return '已取消手机号授权，请点击微信登录重试';
  if (detail?.encryptedData && detail?.iv) return '微信返回了旧版授权结果，请更新微信后重试';
  const suffix = Number.isSafeInteger(errno) && errno !== 0 ? `（${errno}）` : '';
  return `微信未返回手机号登录凭证，请稍后重试${suffix}`;
}
export function createAccountEntry({ request, changed = () => {} }) {
  let state = { phase: 'checking', busy: false, error: '' };
  let checking;
  const waiters = new Set();
  const update = patch => { state = { ...state, ...patch }; changed(state); if (state.phase === 'ready') { for (const resolve of waiters) resolve(); waiters.clear(); } };
  const valid = result => { if (result?.accountLoginVersion !== 1 || typeof result.phoneBound !== 'boolean') throw new Error('登录服务需要更新，请稍后重试'); return result; };
  async function check() {
    if (state.phase === 'ready' || state.phase === 'phone') return;
    if (checking) return checking;
    update({ phase: 'checking', error: '' });
    checking = (async () => {
      try { const result = valid(await request('accountAccess')); update({ phase: result.phoneBound ? 'ready' : 'phone' }); }
      catch (error) { update({ phase: 'error', error: error.message || '网络连接失败，请重试' }); }
      finally { checking = null; }
    })();
    return checking;
  }
  async function ensureReady() {
    if (state.phase === 'ready') return;
    const ready = new Promise(resolve => waiters.add(resolve));
    await check();
    return ready;
  }
  function beginAuthorization() {
    if (state.phase === 'phone' && !state.busy) update({ error: '' });
  }
  async function bind(detail, consent) {
    if (state.busy || state.phase !== 'phone') return;
    if (!consent) { update({ error: '请先阅读并同意隐私协议' }); return; }
    if (typeof detail?.code !== 'string' || !detail.code.trim()) { update({ error: phoneAuthorizationError(detail) }); return; }
    update({ busy: true, error: '' });
    try {
      const result = valid(await request('bindAccountPhone', { code: detail.code, privacyVersion: ACCOUNT_PRIVACY_VERSION }));
      if (!result.phoneBound) throw new Error('手机号未绑定成功，请重新授权');
      update({ phase: 'ready' });
    } catch (error) {
      // An acknowledged database write may outlive a lost response. Check it
      // before requesting another one-time phone code; never replay the code.
      try { const result = valid(await request('accountAccess')); if (result.phoneBound) { update({ phase: 'ready' }); return; } } catch {}
      update({ error: error.message || '登录失败，请重试' });
    } finally { update({ busy: false }); }
  }
  return { check, ensureReady, bind, beginAuthorization, getState: () => state };
}
