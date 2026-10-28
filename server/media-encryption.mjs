import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const header = Buffer.from('SHIYUAN1');

export function encryptImage(bytes) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { bytes: Buffer.concat([header, nonce, cipher.getAuthTag(), encrypted]), key: key.toString('base64') };
}

export function decryptImage(bytes, encodedKey) {
  if (bytes.length < 36 || !bytes.subarray(0, 8).equals(header)) throw new Error('Invalid encrypted image');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(encodedKey, 'base64'), bytes.subarray(8, 20));
  decipher.setAuthTag(bytes.subarray(20, 36));
  return Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
}
