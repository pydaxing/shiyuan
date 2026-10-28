const failure = message => Object.assign(new Error(message), { code: 'QUEUE_STORAGE' });

export function createCommandJournal({ key, platform = () => typeof wx !== 'undefined' ? wx : undefined }) {
  const storageKey = scope => `${key}:${encodeURIComponent(scope)}`;
  return {
    read(scope) {
      const storage = platform();
      if (!storage?.getStorageSync || !storage?.setStorageSync) throw failure('无法保存待同步操作，请检查本机存储后重试');
      try {
        const raw = storage.getStorageSync(storageKey(scope));
        if (!raw) return [];
        const saved = JSON.parse(raw);
        if (saved.version !== 1 || saved.scope !== scope || !Array.isArray(saved.operations) || saved.operations.some(operation =>
          !operation || typeof operation.id !== 'string' || !/^[\w-]{12,100}$/.test(operation.id) || typeof operation.name !== 'string' ||
          !Array.isArray(operation.args) || operation.scope !== scope || typeof operation.dependencies !== 'string' || !Number.isFinite(operation.createdAt) ||
          !['queued', 'sending', 'uncertain', 'blocked', 'failed'].includes(operation.status) ||
          (operation.sent && (operation.sent.requestId !== operation.id || !Array.isArray(operation.sent.args) || !Number.isSafeInteger(operation.sent.revision)))
        )) throw new Error('invalid journal');
        return saved.operations;
      } catch { throw failure('待同步记录无法读取，已保留原记录，请勿清理缓存'); }
    },
    write(scope, operations) {
      const storage = platform();
      if (!storage?.setStorageSync) throw failure('无法保存待同步操作，请检查本机存储后重试');
      try {
        const raw = JSON.stringify({ version: 1, scope, operations });
        if (raw.length > 1500000 || operations.length > 100) throw new Error('capacity');
        storage.setStorageSync(storageKey(scope), raw);
      } catch { throw failure('待同步记录保存失败，请释放本机空间后重试；操作未丢弃'); }
    },
  };
}
