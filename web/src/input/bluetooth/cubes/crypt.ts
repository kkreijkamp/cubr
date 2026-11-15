// GAN gen2+ and MoYu 32 encryption: AES-128 on the first 16 bytes and on the last 16 (they overlap for
// messages under 32 bytes), each XORed with an IV (csTimer gancube.js decode / encode).
import type { Aes128 } from '../aes128';

export function decode(aes: Aes128 | null, bytes: number[]): number[] {
  const ret = bytes.slice();
  if (!aes) return ret;
  const iv = aes.iv ?? [];
  if (ret.length > 16) {
    const offset = ret.length - 16;
    const block = aes.decrypt(ret.slice(offset));
    for (let i = 0; i < 16; i++) ret[i + offset] = block[i] ^ (iv[i] | 0);
  }
  aes.decrypt(ret);
  for (let i = 0; i < 16; i++) ret[i] ^= iv[i] | 0;
  return ret;
}

export function encode(aes: Aes128 | null, bytes: number[]): number[] {
  const ret = bytes.slice();
  if (!aes) return ret;
  const iv = aes.iv ?? [];
  for (let i = 0; i < 16; i++) ret[i] ^= iv[i] | 0;
  aes.encrypt(ret);
  if (ret.length > 16) {
    const offset = ret.length - 16;
    const block = ret.slice(offset);
    for (let i = 0; i < 16; i++) block[i] ^= iv[i] | 0;
    aes.encrypt(block);
    for (let i = 0; i < 16; i++) ret[i + offset] = block[i];
  }
  return ret;
}
