// The checksums of the bluetooth protocols.

/** CRC-16/MODBUS (QiYi cubes and timers) */
export function crc16modbus(data: readonly number[]): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b;
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

/** CRC-16/CCITT-FALSE (GAN smart timer) */
export function crc16ccitt(data: readonly number[]): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
  }
  return crc & 0xffff;
}
