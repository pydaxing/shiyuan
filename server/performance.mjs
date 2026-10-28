import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const requests = new AsyncLocalStorage();

export async function measure(operation, callback) {
  const request = requests.getStore();
  if (!request) return callback();
  const start = performance.now();
  let failure;
  try { return await callback(); }
  catch (error) {
    const code = String(error.code || error.errCode || error.name || 'UNKNOWN');
    failure = { failed: true, errorCode: /^[\w.-]{1,80}$/.test(code) ? code : 'UNKNOWN' };
    throw error;
  }
  finally {
    if (request.spans.length < 256) request.spans.push({ operation, startMs: Math.round(start - request.start), durationMs: Math.round(performance.now() - start), ...failure });
    else request.omitted += 1;
  }
}

export function diagnose(callback, firstInvocation) {
  const request = { start: performance.now(), spans: [], omitted: 0 };
  return requests.run(request, async () => {
    const result = await callback();
    if (result.code === 'UNAUTHENTICATED') return result;
    return { ...result, diagnostics: { version: 1, serverMs: Math.round(performance.now() - request.start), firstInvocation, spans: request.spans.slice(), omitted: request.omitted } };
  });
}
