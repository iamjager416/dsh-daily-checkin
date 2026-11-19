/**
 * 纯 JS 单 DES（ECB、仅加密）——用于森空岛设备指纹里的字段混淆。
 *
 * 为什么不用 node:crypto：DSH 宿主是 Electron/BoringSSL，3DES/DES 都被禁用
 * （"'des-ede3-ecb' Unknown cipher"），而 skland 的 DES_RULE 要求标准 DES ECB。
 * 数据量很小（几 KB 指纹），BigInt + 查表的实现足够，且在任何 JS 运行时可用。
 */

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13,
  12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
  24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
  59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39,
  31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
  29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4,
  26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40,
  51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

function permute(value, table, inputBits) {
  let out = 0n;
  for (const position of table) {
    const bit = (value >> BigInt(inputBits - position)) & 1n;
    out = (out << 1n) | bit;
  }
  return out;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigIntToBytes(value, length) {
  const out = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function subkeys(keyBytes) {
  const key = bytesToBigInt(keyBytes);
  const pc1 = permute(key, PC1, 64);
  let c = (pc1 >> 28n) & 0xfffffffn;
  let d = pc1 & 0xfffffffn;
  const keys = [];
  for (let round = 0; round < 16; round += 1) {
    const shift = BigInt(SHIFTS[round]);
    c = ((c << shift) | (c >> (28n - shift))) & 0xfffffffn;
    d = ((d << shift) | (d >> (28n - shift))) & 0xfffffffn;
    const cd = (c << 28n) | d;
    keys.push(permute(cd, PC2, 56));
  }
  return keys;
}

function feistel(right, key) {
  const expanded = permute(right, E, 32) ^ key; // 48 bits
  let out = 0n;
  for (let box = 0; box < 8; box += 1) {
    const chunk = Number((expanded >> BigInt(42 - 6 * box)) & 0x3fn);
    const row = ((chunk & 0x20) >> 4) | (chunk & 1);
    const column = (chunk >> 1) & 0x0f;
    out = (out << 4n) | BigInt(SBOX[box][row * 16 + column]);
  }
  return permute(out, P, 32);
}

function encryptBlock(blockBytes, keyBytes) {
  const keys = subkeys(keyBytes);
  const block = permute(bytesToBigInt(blockBytes), IP, 64);
  let left = (block >> 32n) & 0xffffffffn;
  let right = block & 0xffffffffn;
  for (let round = 0; round < 16; round += 1) {
    const next = left ^ feistel(right, keys[round]);
    left = right;
    right = next;
  }
  const pre = (right << 32n) | left; // 末轮后交换 L/R 再合并（R16 || L16）
  return bigIntToBytes(permute(pre, FP, 64), 8);
}

/**
 * 单 DES ECB 加密（零填充，与 Python 版一致：始终补 1..8 字节 0）。
 * @param {string} keyText - 8 字符密钥
 * @param {string} plainText - 明文
 * @returns {Buffer} 密文
 */
export function desEcbEncrypt(keyText, plainText) {
  const key = Buffer.alloc(8);
  const keySource = Buffer.isBuffer(keyText) ? keyText : Buffer.from(keyText, "utf8");
  keySource.copy(key, 0, 0, 8);
  const data = Buffer.isBuffer(plainText) ? plainText : Buffer.from(plainText, "utf8");
  const padLen = 8 - (data.length % 8);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
  const out = Buffer.alloc(padded.length);
  for (let offset = 0; offset < padded.length; offset += 8) {
    encryptBlock(padded.subarray(offset, offset + 8), key).copy(out, offset);
  }
  return out;
}
