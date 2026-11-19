/**
 * 最小 PNG 解码器：只支持 8-bit、非隔行、colorType 2(RGB) / 6(RGBA) / 0(灰度)。
 * 用于 GeeTest 滑块图（slice 80x80 RGBA、bg 300x200 RGB）。
 */
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 PNG。
 * @param {Buffer} buffer
 * @returns {{width:number,height:number,channels:number,data:Uint8Array}}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 8).compare(SIGNATURE) !== 0) {
    throw new Error("不是 PNG 文件");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`不支持的 PNG 位深: ${bitDepth}`);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`不支持的 PNG colorType: ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? out[rowStart + x - channels] : 0;
      const up = y > 0 ? out[prevStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[prevStart + x - channels] : 0;
      let decoded;
      switch (filter) {
        case 0: decoded = value; break;
        case 1: decoded = value + left; break;
        case 2: decoded = value + up; break;
        case 3: decoded = value + ((left + up) >> 1); break;
        case 4: decoded = value + paeth(left, up, upLeft); break;
        default: throw new Error(`不支持的 PNG 过滤类型: ${filter}`);
      }
      out[rowStart + x] = decoded & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

/** 转灰度（OpenCV 的 BT.601 系数）。RGBA 忽略 alpha，与 cv2 COLOR_BGRA2GRAY 一致。 */
export function toGray(image) {
  const { width, height, channels, data } = image;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const base = i * channels;
    if (channels === 1) {
      gray[i] = data[base];
    } else {
      gray[i] = 0.114 * data[base] + 0.587 * data[base + 1] + 0.299 * data[base + 2];
    }
  }
  return { width, height, gray };
}
