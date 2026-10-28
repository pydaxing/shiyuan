import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const activeTransports = new WeakSet();

function transportError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function createImageTransport() {
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  let currentFile = null;
  let closed = false;
  let closing;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Connection', 'close');
    const supplied = Buffer.from(request.headers.authorization || '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      response.writeHead(403);
      response.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    if (request.method !== 'GET' || !currentFile || request.url !== `/image/${currentFile.hash}`) {
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    response.end(JSON.stringify(currentFile));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    setFile(file) {
      if (closed) throw transportError('IMAGE_TRANSPORT_CLOSED', '本机传图桥已关闭');
      const { uploadHash, base64, bytes } = file || {};
      if (typeof uploadHash !== 'string' || !/^[a-f0-9]{64}$/.test(uploadHash)
        || typeof base64 !== 'string' || !base64.length || base64.length % 4 !== 0
        || !Number.isSafeInteger(bytes) || bytes <= 0 || base64.length !== Math.ceil(bytes / 3) * 4) {
        throw transportError('IMAGE_TRANSPORT_INVALID_FILE', '图片摘要、base64 或字节数无效');
      }
      const decoded = Buffer.from(base64, 'base64');
      if (decoded.length !== bytes || decoded.toString('base64') !== base64
        || createHash('sha256').update(decoded).digest('hex') !== uploadHash) {
        throw transportError('IMAGE_TRANSPORT_INVALID_FILE', '图片内容与摘要或字节数不符');
      }
      currentFile = { base64, bytes, hash: uploadHash };
    },
    clearFile() {
      currentFile = null;
    },
    close() {
      if (!closing) {
        closed = true;
        currentFile = null;
        closing = new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}

async function requestAndUploadImage(url, token, hash, bytes, length, familyId) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  try {
    const cloud = require('services/cloud.js');
    const checkFamily = () => {
      if (!familyId || cloud.cloudStatus?.value?.familyId !== familyId) {
        throw fail('FAMILY_CHANGED', '家庭已变更，停止上传');
      }
    };
    checkFamily();
    const response = await new Promise((resolve, reject) => {
      const networkFailure = () => reject(fail('IMAGE_TRANSPORT_UNREACHABLE', 'wx.request 无法访问本机传图桥，请由主调用方检查运行环境，不要绕过域名限制'));
      try {
        wx.request({
          url: `${url}/image/${hash}`,
          method: 'GET',
          header: { Authorization: `Bearer ${token}` },
          dataType: 'json',
          responseType: 'text',
          timeout: 15000,
          success: resolve,
          fail: networkFailure,
        });
      } catch {
        networkFailure();
      }
    });
    if (response?.statusCode !== 200) {
      const error = fail('IMAGE_TRANSPORT_HTTP_ERROR', '本机传图桥返回非 200 状态，停止上传');
      if (Number.isInteger(response?.statusCode)) error.statusCode = response.statusCode;
      throw error;
    }
    const image = response.data;
    if (!image || image.hash !== hash || image.bytes !== bytes
      || typeof image.base64 !== 'string' || image.base64.length !== length
      || image.base64.length / 4 * 3 - (image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0) !== bytes
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.base64)) {
      throw fail('IMAGE_TRANSPORT_INTEGRITY_ERROR', '本机图片摘要、base64 长度或字节数不一致');
    }
    checkFamily();
    const uploaded = await cloud.invokeCloud('mediaUpload', { base64: image.base64 });
    checkFamily();
    if (typeof uploaded?.fileId !== 'string' || !uploaded.fileId.startsWith('cloud://') || typeof uploaded.protected !== 'boolean') {
      throw fail('IMAGE_TRANSPORT_UPLOAD_RESULT_INVALID', '云端未返回有效图片结果，请核查，不自动重试上传');
    }
    return { fileId: uploaded.fileId, protected: uploaded.protected };
  } catch (error) {
    return {
      error: String(error?.message || '图片上传失败，请核查，不自动重试').split(token).join('[redacted]'),
      code: typeof error?.code === 'string' ? error.code.split(token).join('[redacted]') : 'IMAGE_TRANSPORT_UPLOAD_FAILED',
      ...(Number.isInteger(error?.statusCode) ? { statusCode: error.statusCode } : {}),
    };
  }
}

export async function uploadLocalImage(evaluate, transport, file, familyId) {
  if (typeof evaluate !== 'function' || typeof familyId !== 'string' || !familyId.trim()) {
    throw transportError('IMAGE_TRANSPORT_INVALID_ARGUMENT', '需要异步 evaluate 和预期家庭 ID');
  }
  if (activeTransports.has(transport)) throw transportError('IMAGE_TRANSPORT_BUSY', '本机传图桥正在上传另一张图片');
  activeTransports.add(transport);
  try {
    transport.setFile(file);
    const result = await evaluate(requestAndUploadImage.toString(), [transport.url, transport.token, file.uploadHash, file.bytes, file.base64.length, familyId]);
    if (result?.error) {
      const error = transportError(result.code || 'IMAGE_TRANSPORT_UPLOAD_FAILED', result.error);
      if (Number.isInteger(result.statusCode)) error.statusCode = result.statusCode;
      throw error;
    }
    if (typeof result?.fileId !== 'string' || !result.fileId.startsWith('cloud://') || typeof result.protected !== 'boolean') {
      throw transportError('IMAGE_TRANSPORT_UPLOAD_RESULT_INVALID', '未收到有效上传结果，请核查，不自动重试');
    }
    return { fileId: result.fileId, protected: result.protected };
  } catch (error) {
    const sanitized = transportError(
      String(error?.code || 'IMAGE_TRANSPORT_EVALUATE_FAILED').split(transport.token).join('[redacted]'),
      String(error?.message || 'IDE 执行失败，请核查，不自动重试').split(transport.token).join('[redacted]'),
    );
    if (Number.isInteger(error?.statusCode)) sanitized.statusCode = error.statusCode;
    throw sanitized;
  } finally {
    transport.clearFile();
    activeTransports.delete(transport);
  }
}
