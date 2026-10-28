import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const nativeRequire = createRequire(import.meta.url);
const allowedModules = new Set(['node:crypto', 'node:async_hooks', 'node:perf_hooks']);

export async function loadCloudApplication(file) {
  const source = await readFile(file, 'utf8');
  const module = { exports: {} };
  const sdk = { init() {}, database: () => ({}), DYNAMIC_CURRENT_ENV: 'isolated-test' };
  const context = vm.createContext({
    module, exports: module.exports, Buffer, URL, TextEncoder, TextDecoder, structuredClone, setTimeout, clearTimeout, console,
    process: { env: {} },
    require(name) {
      if (name === 'wx-server-sdk') return sdk;
      if (allowedModules.has(name)) return nativeRequire(name);
      throw new Error(`隔离回归测试禁止加载外部模块：${name}`);
    },
  });
  vm.runInContext(source, context, { filename: file, timeout: 5000 });
  const factory = vm.runInContext('createApplication', context);
  return options => {
    const application = factory(options);
    return async (...args) => structuredClone(await application(...args));
  };
}
