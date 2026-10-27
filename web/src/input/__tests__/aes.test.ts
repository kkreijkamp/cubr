import { describe, expect, it } from 'vitest';
import { Aes128, SBOX } from '../bluetooth/aes128';
import { crc16ccitt, crc16modbus } from '../bluetooth/crc';
import { GAN_KEYS, macBytes, withMac } from '../bluetooth/keys';

const hex = (s: string) => s.match(/../g)!.map((h) => parseInt(h, 16));

describe('AES-128', () => {
  it('matches the FIPS-197 example (appendix C.1)', () => {
    const aes = new Aes128(hex('000102030405060708090a0b0c0d0e0f'));
    const block = hex('00112233445566778899aabbccddeeff');
    expect(aes.encrypt(block)).toEqual(hex('69c4e0d86a7b0430d8cdb78070b4c55a'));
    expect(aes.decrypt(block)).toEqual(hex('00112233445566778899aabbccddeeff'));
  });

  it('matches the FIPS-197 key expansion example (appendix A.1)', () => {
    const aes = new Aes128(hex('2b7e151628aed2a6abf7158809cf4f3c'));
    // AES-128 known answer: plaintext 3243f6a8885a308d313198a2e0370734 -> 3925841d02dc09fbdc118597196a0b32
    expect(aes.encrypt(hex('3243f6a8885a308d313198a2e0370734'))).toEqual(hex('3925841d02dc09fbdc118597196a0b32'));
  });

  it('has the AES S-box: the multiplicative inverse in GF(2^8), then the affine map', () => {
    const mul = (a: number, b: number) => {
      let p = 0;
      for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
      }
      return p;
    };
    for (let x = 0; x < 256; x++) {
      let inv = 0;
      if (x) for (let y = 1; y < 256; y++) if (mul(x, y) === 1) inv = y;
      const rot = (v: number, k: number) => ((v << k) | (v >> (8 - k))) & 0xff;
      expect(SBOX[x], `S(${x})`).toBe(inv ^ rot(inv, 1) ^ rot(inv, 2) ^ rot(inv, 3) ^ rot(inv, 4) ^ 0x63);
    }
  });

  it('round-trips random blocks and leaves bytes past 16 alone', () => {
    const aes = new Aes128(GAN_KEYS[2]);
    for (let i = 0; i < 50; i++) {
      const b = Array.from({ length: 20 }, () => Math.floor(Math.random() * 256));
      const tail = b.slice(16);
      const copy = b.slice();
      aes.encrypt(b);
      expect(b.slice(16)).toEqual(tail);
      aes.decrypt(b);
      expect(b).toEqual(copy);
    }
  });
});

describe('keys and checksums', () => {
  it('mixes the MAC into a key the way csTimer does', () => {
    // GAN gen2: key[i] = (key[i] + mac[5 - i]) % 255
    const key = withMac(GAN_KEYS[2], macBytes('AB:12:34:56:78:9A'));
    expect(key.slice(0, 6)).toEqual([(1 + 0x9a) % 255, (2 + 0x78) % 255, (66 + 0x56) % 255, (40 + 0x34) % 255, (49 + 0x12) % 255, (145 + 0xab) % 255]);
    expect(key.slice(6)).toEqual(GAN_KEYS[2].slice(6));
  });

  it('computes CRC-16/MODBUS and CRC-16/CCITT-FALSE', () => {
    const ascii = [...'123456789'].map((c) => c.charCodeAt(0));
    // the standard check values
    expect(crc16modbus(ascii)).toBe(0x4b37);
    expect(crc16ccitt(ascii)).toBe(0x29b1);
  });
});
