// Keep transport diagnostics available to debugging without exposing SDK traces in UI.
export function cloudErrorMessage(failure) {
  const message = typeof failure === 'string' ? failure : failure?.errMsg || failure?.message || '';
  if (/failed to fetch|timeout|timed out|network/i.test(message)) return '网络连接暂时不稳定，请稍后重试确认同步结果';
  if (/cloud\.|callId:|trace:/i.test(message)) return '云服务暂时连接不上，请稍后重试确认同步结果';
  return message || '暂时未能同步，请稍后重试';
}
export function cloudTransportError(failure) {
  if (failure?.code && failure?.message && cloudErrorMessage(failure) === failure.message) return failure;
  const error = new Error(cloudErrorMessage(failure), { cause: failure });
  error.code = 'NETWORK';
  return error;
}
