export const ACCOUNT_PRIVACY_VERSION = '2026-11-09';
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
  async function bind(detail, consent) {
    if (state.busy || state.phase !== 'phone') return;
    if (!consent) { update({ error: '请先阅读并同意隐私协议' }); return; }
    if (!detail?.code) { update({ error: '需要授权手机号才能登录，请点击按钮重试' }); return; }
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
  return { check, ensureReady, bind, getState: () => state };
}
