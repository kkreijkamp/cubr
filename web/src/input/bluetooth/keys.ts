// The keys the cubes and timers use, as published in csTimer (hardware/*.js, there LZString-compressed).
// Several are combined with the device's MAC address before use.

/** GAN: [gen1 by version 0x01xx, gen1 by 0x02xx (unused), gen2 key, gen2 iv, AiCube key, AiCube iv, 251 UI key, 251 UI iv] */
export const GAN_KEYS: readonly (readonly number[])[] = [
  [198, 202, 21, 223, 79, 110, 19, 182, 119, 13, 230, 89, 58, 175, 186, 162],
  [67, 226, 91, 214, 125, 220, 120, 216, 7, 96, 163, 218, 130, 60, 1, 241],
  [1, 2, 66, 40, 49, 145, 22, 7, 32, 5, 24, 84, 66, 17, 18, 83],
  [17, 3, 50, 40, 33, 1, 118, 39, 32, 149, 120, 20, 50, 18, 2, 67],
  [5, 18, 2, 69, 2, 1, 41, 86, 18, 120, 18, 118, 129, 1, 8, 3],
  [1, 68, 40, 6, 134, 33, 34, 40, 81, 5, 8, 49, 130, 2, 33, 6],
  [88, 152, 97, 252, 31, 236, 215, 96, 159, 133, 211, 98, 190, 55, 23, 44],
  [127, 97, 208, 82, 117, 193, 57, 82, 8, 46, 84, 29, 138, 120, 99, 77],
];

/** MoYu (WCU) 32: key, iv */
export const MOYU32_KEYS: readonly (readonly number[])[] = [
  [21, 119, 58, 92, 103, 14, 45, 31, 23, 103, 42, 19, 155, 103, 82, 87],
  [17, 35, 38, 37, 134, 42, 44, 59, 85, 6, 127, 49, 126, 103, 33, 87],
];

/** QiYi smart cube */
export const QIYI_CUBE_KEY: readonly number[] = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];

/** QiYi smart timer: sixteen 0x77 */
export const QIYI_TIMER_KEY: readonly number[] = Array(16).fill(0x77);

/** a key (and IV) with the MAC mixed into its first six bytes, csTimer's way: (k + mac[5 - i]) mod 255 */
export function withMac(base: readonly number[], mac: readonly number[], mod = 255): number[] {
  const out = base.slice();
  for (let i = 0; i < 6; i++) out[i] = (out[i] + mac[5 - i]) % mod;
  return out;
}

/** "aa:bb:cc:dd:ee:ff" to bytes */
export function macBytes(mac: string): number[] {
  return mac.split(/[:-]/).map((h) => parseInt(h, 16));
}

export const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
