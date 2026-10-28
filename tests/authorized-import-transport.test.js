import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createImageTransport, uploadLocalImage } from '../scripts/authorized-import-transport.mjs';

function imageFile(buffer = Buffer.from('authorized image')) {
  return { uploadHash: createHash('sha256').update(buffer).digest('hex'), base64: buffer.toString('base64'), bytes: buffer.length };
}

async function transportFor(context) {
  const transport = await createImageTransport();
  context.after(() => transport.close());
  return transport;
}

function getImage(transport, pathname, { token = transport.token, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${transport.url}${pathname}`, {
      method,
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body, address: outgoing.socket.remoteAddress }));
      response.on('error', reject);
    });
    outgoing.setTimeout(2000, () => outgoing.destroy(new Error('Test HTTP timeout')));
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function runtime({ requestImage, beforeUpload, familyId = 'family-test' } = {}) {
  const evaluations = [];
  const requests = [];
  const uploads = [];
  const status = { familyId, userId: 'original-openid' };
  const cloud = {
    cloudStatus: { value: status },
    async invokeCloud(action, payload) {
      uploads.push({ action, payload });
      if (beforeUpload) await beforeUpload({ cloud, action, payload });
      return { fileId: 'cloud://env/approved/image', protected: true, internal: 'not returned' };
    },
  };
  const evaluate = async (source, args) => {
    evaluations.push({ source, args });
    assert.ok(source.startsWith('async function'));
    assert.ok(JSON.stringify(args).length < 1024);
    const invoke = runInNewContext(`(${source})`, {
      require(module) {
        assert.equal(module, 'services/cloud.js');
        return cloud;
      },
      wx: {
        request(options) {
          requests.push(options);
          if (requestImage) return requestImage(options, cloud);
          fetch(options.url, { headers: options.header }).then(async response => {
            options.success({ statusCode: response.status, data: await response.json() });
          }).catch(options.fail);
        },
      },
    });
    return invoke(...args);
  };
  return { cloud, status, evaluate, evaluations, requests, uploads };
}

test('transport binds IPv4 loopback, uses independent 32-byte tokens and serves unchanged JSON', async context => {
  const transport = await transportFor(context);
  const other = await transportFor(context);
  assert.match(transport.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.match(transport.token, /^[a-f0-9]{64}$/);
  assert.notEqual(transport.token, other.token);
  assert.equal(new URL(transport.url).search, '');
  assert.ok(!transport.url.includes(transport.token));
  const file = imageFile(Buffer.from([0, 255, 127, 128, 1, 2, 3]));
  transport.setFile(file);
  const response = await getImage(transport, `/image/${file.uploadHash}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.address, '127.0.0.1');
  assert.deepEqual(JSON.parse(response.body), { base64: file.base64, bytes: file.bytes, hash: file.uploadHash });
  assert.deepEqual(Buffer.from(JSON.parse(response.body).base64, 'base64'), Buffer.from(file.base64, 'base64'));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.ok(!JSON.stringify(response).includes(transport.token));
});

test('missing or wrong bearer tokens fail closed without echoing credentials or image data', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  transport.setFile(file);
  for (const options of [
    { token: null },
    { token: 'wrong' },
    { token: 'f'.repeat(64) },
    { headers: { Authorization: transport.token } },
    { headers: { Authorization: `Basic ${transport.token}` } },
    { headers: { Authorization: `Bearer ${transport.token}extra` } },
  ]) {
    const response = await getImage(transport, `/image/${file.uploadHash}`, options);
    assert.equal(response.statusCode, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'Forbidden' });
    assert.ok(!JSON.stringify(response).includes(transport.token));
    assert.ok(!response.body.includes(file.base64));
  }
  const query = await getImage(transport, `/image/${file.uploadHash}?token=${transport.token}`, { token: null });
  assert.equal(query.statusCode, 403);
  assert.ok(!JSON.stringify(query).includes(transport.token));
});

test('only the exact active image GET path is served and CORS is never enabled', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  transport.setFile(file);
  for (const pathname of ['/', '/etc/passwd', '/image/unknown', '/image/%2e%2e%2fetc%2fpasswd', `/image/${file.uploadHash}/`, `/image/${file.uploadHash}?token=${transport.token}`]) {
    const response = await getImage(transport, pathname);
    assert.equal(response.statusCode, 404);
    assert.ok(!JSON.stringify(response).includes(transport.token));
    assert.ok(!response.body.includes(file.base64));
  }
  for (const method of ['OPTIONS', 'POST', 'PUT', 'DELETE', 'HEAD', 'GET']) {
    const response = await getImage(transport, `/image/${file.uploadHash}`, { method, headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(response.statusCode, method === 'GET' ? 200 : 404);
    assert.ok(!Object.keys(response.headers).some(header => header.startsWith('access-control-')));
  }
});

test('setFile snapshots one image, replacement revokes the old hash and clearFile revokes all access', async context => {
  const transport = await transportFor(context);
  const original = imageFile();
  assert.equal((await getImage(transport, `/image/${original.uploadHash}`)).statusCode, 404);
  const mutable = { ...original, path: '/etc/passwd' };
  transport.setFile(mutable);
  mutable.base64 = 'changed';
  assert.equal(JSON.parse((await getImage(transport, `/image/${original.uploadHash}`)).body).base64, original.base64);
  const replacement = imageFile(Buffer.from('replacement'));
  transport.setFile(replacement);
  assert.equal((await getImage(transport, `/image/${original.uploadHash}`)).statusCode, 404);
  assert.equal((await getImage(transport, `/image/${replacement.uploadHash}`)).statusCode, 200);
  transport.clearFile();
  transport.clearFile();
  assert.equal((await getImage(transport, `/image/${replacement.uploadHash}`)).statusCode, 404);
});

test('invalid files cannot expose paths, incorrect hashes, truncated bytes or noncanonical base64', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  for (const invalid of [null, {}, { ...file, uploadHash: '../../etc/passwd' }, { ...file, uploadHash: '0'.repeat(64) }, { ...file, bytes: file.bytes + 1 }, { ...file, bytes: 0 }, { ...file, base64: `${file.base64}\n` }, { ...file, base64: '!'.repeat(file.base64.length) }, { ...imageFile(Buffer.from('a')), base64: 'YR==' }]) {
    assert.throws(() => transport.setFile(invalid), { code: 'IMAGE_TRANSPORT_INVALID_FILE' });
  }
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('close is idempotent, stops HTTP and refuses new files', async context => {
  const transport = await transportFor(context);
  transport.setFile(imageFile());
  await Promise.all([transport.close(), transport.close()]);
  assert.throws(() => transport.setFile(imageFile()), { code: 'IMAGE_TRANSPORT_CLOSED' });
  await assert.rejects(getImage(transport, '/'), { code: 'ECONNREFUSED' });
});

test('one asynchronous IDE evaluation transfers a large image via HTTP and the normal media API', async context => {
  const transport = await transportFor(context);
  const file = imageFile(Buffer.alloc(350000, 42));
  const simulated = runtime();
  const result = await uploadLocalImage(simulated.evaluate, transport, file, 'family-test');
  assert.deepEqual(result, { fileId: 'cloud://env/approved/image', protected: true });
  assert.equal(simulated.evaluations.length, 1);
  assert.ok(!JSON.stringify(simulated.evaluations[0]).includes(file.base64));
  assert.equal(simulated.requests.length, 1);
  assert.equal(simulated.requests[0].url, `${transport.url}/image/${file.uploadHash}`);
  assert.equal(simulated.requests[0].header.Authorization, `Bearer ${transport.token}`);
  assert.equal(simulated.requests[0].method, 'GET');
  assert.equal(simulated.requests[0].dataType, 'json');
  assert.ok(simulated.requests[0].timeout > 0);
  assert.equal(simulated.uploads.length, 1);
  assert.equal(simulated.uploads[0].action, 'mediaUpload');
  assert.deepEqual(Object.keys(simulated.uploads[0].payload), ['base64']);
  assert.equal(simulated.uploads[0].payload.base64, file.base64);
  assert.equal(simulated.status.userId, 'original-openid');
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  await uploadLocalImage(simulated.evaluate, transport, imageFile(), 'family-test');
  assert.equal(simulated.uploads.length, 2);
});

test('wrong initial family or a family change during HTTP refuses the upload and clears the image', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const initial = runtime({ familyId: 'other-family' });
  await assert.rejects(uploadLocalImage(initial.evaluate, transport, file, 'family-test'), { code: 'FAMILY_CHANGED' });
  assert.equal(initial.requests.length, 0);
  assert.equal(initial.uploads.length, 0);
  const changed = runtime({ requestImage(options, cloud) {
    cloud.cloudStatus.value = { familyId: 'other-family', userId: 'original-openid' };
    options.success({ statusCode: 200, data: { base64: file.base64, bytes: file.bytes, hash: file.uploadHash } });
  } });
  await assert.rejects(uploadLocalImage(changed.evaluate, transport, file, 'family-test'), { code: 'FAMILY_CHANGED' });
  assert.equal(changed.uploads.length, 0);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('HTTP failures never upload, retry, echo server contents or leak the token', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  for (const statusCode of [301, 403, 404, 500]) {
    const simulated = runtime({ requestImage(options) { options.success({ statusCode, data: { error: transport.token } }); } });
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), error => {
      assert.equal(error.code, 'IMAGE_TRANSPORT_HTTP_ERROR');
      assert.equal(error.statusCode, statusCode);
      assert.ok(!error.stack.includes(transport.token));
      return true;
    });
    assert.equal(simulated.requests.length, 1);
    assert.equal(simulated.uploads.length, 0);
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  }
});

test('wx network errors and synchronous request exceptions have a stable code and no credentials', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  for (const synchronous of [false, true]) {
    const simulated = runtime({ requestImage(options) {
      if (synchronous) throw new Error(`domain blocked: ${transport.token}`);
      options.fail({ errMsg: `request:fail ${transport.token}` });
    } });
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), error => {
      assert.equal(error.code, 'IMAGE_TRANSPORT_UNREACHABLE');
      assert.match(error.message, /wx.request/);
      assert.ok(!error.stack.includes(transport.token));
      return true;
    });
    assert.equal(simulated.requests.length, 1);
    assert.equal(simulated.uploads.length, 0);
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  }
});

test('mismatched hashes, bytes, base64 lengths and malformed HTTP data never reach the cloud', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const data = { hash: file.uploadHash, base64: file.base64, bytes: file.bytes };
  for (const invalid of [null, JSON.stringify(data), { ...data, hash: 'wrong' }, { ...data, bytes: data.bytes + 1 }, { ...data, base64: data.base64.slice(4) }, { ...data, base64: 123 }, { ...data, base64: 'A'.repeat(data.base64.length) }, { ...data, base64: '!'.repeat(data.base64.length) }]) {
    const simulated = runtime({ requestImage(options) { options.success({ statusCode: 200, data: invalid }); } });
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), { code: 'IMAGE_TRANSPORT_INTEGRITY_ERROR' });
    assert.equal(simulated.uploads.length, 0);
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  }
});

test('cloud moderation and network failures propagate without retries or alternate upload APIs', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  for (const code of ['IMAGE_FORMAT', 'PERMISSION_DENIED', 'NETWORK_ERROR']) {
    const simulated = runtime({ beforeUpload() { throw Object.assign(new Error(`upload rejected ${transport.token}`), { code }); } });
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), error => {
      assert.equal(error.code, code);
      assert.ok(!error.stack.includes(transport.token));
      return true;
    });
    assert.equal(simulated.uploads.length, 1);
    assert.equal(simulated.status.userId, 'original-openid');
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  }
});

test('IDE failures clear the image, redact diagnostics and do not automatically evaluate again', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  let calls = 0;
  await assert.rejects(uploadLocalImage(async () => {
    calls += 1;
    throw new Error(`IDE failure ${transport.token}`);
  }, transport, file, 'family-test'), error => {
    assert.equal(error.code, 'IMAGE_TRANSPORT_EVALUATE_FAILED');
    assert.ok(!error.stack.includes(transport.token));
    return true;
  });
  assert.equal(calls, 1);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  await assert.rejects(uploadLocalImage(async () => ({ pending: true }), transport, file, 'family-test'), { code: 'IMAGE_TRANSPORT_UPLOAD_RESULT_INVALID' });
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('overlapping uploads are rejected without replacing or clearing the in-flight image', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const simulated = runtime();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = uploadLocalImage(async (...args) => { await gate; return simulated.evaluate(...args); }, transport, file, 'family-test');
  try {
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, imageFile(Buffer.from('second')), 'family-test'), { code: 'IMAGE_TRANSPORT_BUSY' });
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 200);
  } finally {
    release();
    await first;
  }
  assert.equal(simulated.uploads.length, 1);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('real local HTTP authorization failures cannot invoke mediaUpload', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const simulated = runtime({ requestImage(options) {
    fetch(options.url, { headers: { Authorization: 'Bearer invalid' } }).then(async response => {
      options.success({ statusCode: response.status, data: await response.json() });
    }).catch(options.fail);
  } });
  await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), { code: 'IMAGE_TRANSPORT_HTTP_ERROR', statusCode: 403 });
  assert.equal(simulated.uploads.length, 0);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('a family change while awaiting the cloud never reports success or repeats the write', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const simulated = runtime({ beforeUpload({ cloud }) { cloud.cloudStatus.value.familyId = 'other-family'; } });
  await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), { code: 'FAMILY_CHANGED' });
  assert.equal(simulated.uploads.length, 1);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
});

test('invalid upload arguments and files fail before evaluation and leave the transport reusable', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  const simulated = runtime();
  for (const familyId of ['', ' ', null]) {
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, familyId), { code: 'IMAGE_TRANSPORT_INVALID_ARGUMENT' });
  }
  await assert.rejects(uploadLocalImage(null, transport, file, 'family-test'), { code: 'IMAGE_TRANSPORT_INVALID_ARGUMENT' });
  transport.setFile(file);
  await assert.rejects(uploadLocalImage(simulated.evaluate, transport, { ...file, bytes: 0 }, 'family-test'), { code: 'IMAGE_TRANSPORT_INVALID_FILE' });
  assert.equal(simulated.evaluations.length, 0);
  assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  await uploadLocalImage(simulated.evaluate, transport, file, 'family-test');
  assert.equal(simulated.uploads.length, 1);
});

test('invalid cloud receipts fail explicitly without a second write', async context => {
  const transport = await transportFor(context);
  const file = imageFile();
  for (const result of [undefined, {}, { fileId: '/local/image', protected: true }, { fileId: 'cloud://env/image' }]) {
    const simulated = runtime();
    simulated.cloud.invokeCloud = async (action, payload) => {
      simulated.uploads.push({ action, payload });
      return result;
    };
    await assert.rejects(uploadLocalImage(simulated.evaluate, transport, file, 'family-test'), { code: 'IMAGE_TRANSPORT_UPLOAD_RESULT_INVALID' });
    assert.equal(simulated.uploads.length, 1);
    assert.equal((await getImage(transport, `/image/${file.uploadHash}`)).statusCode, 404);
  }
});
