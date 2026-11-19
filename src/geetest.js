/**
 * GeeTest v4 求解（对应原插件 geeked/geeked.py + geeked/sign.py）。
 *
 * 只实现 slide 类型：load → 取 slice/bg 图 → 滑块求解 → generate_w → verify → seccode。
 * 密码学部分走 node:crypto（AES-CBC / RSA-PKCS1 / MD5 / SHA），无需 pycryptodome。
 */
import crypto from "node:crypto";
import { decodePng, toGray } from "./png.js";
import { solveSlide } from "./slide.js";

const GEETEST_BASE = "https://gcaptcha4.geevisit.com";
const STATIC_BASE = "https://static.geetest.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 1024-bit RSA 公钥（Geetest 用于加密 w 的对称密钥），来自原插件 sign.py。 */
const RSA_N =
  "00C1E3934D1614465B33053E7F48EE4EC87B14B95EF88947713D25EECBFF7E74C7977D02DC1D9451F79DD5D1C10C29ACB6A9B4D6FB7D0A0279B6719E1772565F09AF627715919221AEF91899CAE08C0D686D748B20A3603BE2318CA6BC2B59706592A9219D0BF05C9F65023A21D2330807252AE0066D59CEEFA5F2748EA80BAB81";
const RSA_E = "10001";

function bigIntToBase64Url(buffer) {
  let hex = buffer.toString("hex").replace(/^0+/, "");
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

function rsaPublicKey() {
  const n = BigInt(`0x${RSA_N}`);
  const nBytes = Buffer.from(n.toString(16).padStart(2, "0"), "hex");
  const e = BigInt(`0x${RSA_E}`);
  const eBytes = Buffer.from(e.toString(16).padStart(2, "0"), "hex");
  return crypto.createPublicKey({
    format: "jwk",
    key: { kty: "RSA", n: bigIntToBase64Url(nBytes), e: bigIntToBase64Url(eBytes) },
  });
}

/** 16 位十六进制随机串（对应原插件 Signer.rand_uid）。 */
function randUid() {
  let result = "";
  for (let i = 0; i < 4; i += 1) {
    result += Math.floor(65536 * (1 + Math.random()))
      .toString(16)
      .padStart(4, "0")
      .slice(-4);
  }
  return result;
}

function aesCbcEncrypt(plainText, keyText) {
  const key = Buffer.from(keyText, "utf8").subarray(0, 16);
  // 原插件用的是 ASCII 的 16 个 '0'，不是 16 个零字节——差异只在首块，但服务端解不出来。
  const iv = Buffer.from("0000000000000000", "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
}

function rsaEncryptHex(text) {
  // 手写 PKCS#1 v1.5：00 || 02 || PS(非零随机) || 00 || M，再做 m^e mod n。
  // 不用 node:crypto 的 RSA_PKCS1_PADDING——实测服务端能解 Python 版却解不了 OpenSSL 版。
  const n = BigInt(`0x${RSA_N}`);
  const e = BigInt(`0x${RSA_E}`);
  const message = Buffer.from(text, "utf8");
  const k = 128; // 1024-bit
  const psLength = k - message.length - 3;
  const ps = Buffer.alloc(psLength);
  for (let i = 0; i < psLength; i += 1) {
    let byte = 0;
    while (byte === 0) byte = crypto.randomBytes(1)[0];
    ps[i] = byte;
  }
  const em = Buffer.concat([Buffer.from([0x00, 0x02]), ps, Buffer.from([0x00]), message]);
  let m = BigInt(`0x${em.toString("hex")}`);
  // 模幂（e = 65537）
  let result = 1n;
  let base = m % n;
  let exponent = e;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % n;
    base = (base * base) % n;
    exponent >>= 1n;
  }
  let hex = result.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hex.padStart(k * 2, "0");
}

function md5Hex(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function hashHex(func, text) {
  return crypto.createHash(func).update(text, "utf8").digest("hex");
}

/** encrypt_w：pt=1 时 = hex(AES(json, uid)) + RSA(uid)。 */
function encryptW(rawJson, pt) {
  if (!pt || pt === "0") return encodeURIComponent(rawJson);
  if (pt !== "1") throw new Error(`不支持的 GeeTest pt: ${pt}`);
  const uid = randUid();
  const encryptedInput = aesCbcEncrypt(rawJson, uid);
  return encryptedInput.toString("hex") + rsaEncryptHex(uid);
}

/** 调试用：返回 w 的组成部分，供本地核对。 */
export function __debugEncryptW(rawJson, fixedUid) {
  const uid = fixedUid ?? randUid();
  const encryptedInput = aesCbcEncrypt(rawJson, uid);
  return { uid, json: rawJson, encHex: encryptedInput.toString("hex"), rsaHex: rsaEncryptHex(uid) };
}

function generatePow(lotNumber, captchaId, hashFunc, hashVersion, bits, date) {
  const powString = `${hashVersion}|${bits}|${hashFunc}|${date}|${captchaId}|${lotNumber}||`;
  const hexZeros = Math.floor(bits / 4);
  const extraBits = bits % 4;
  const prefix = "0".repeat(hexZeros);
  const maxHexChar = extraBits === 1 ? "7" : extraBits === 2 ? "3" : extraBits === 3 ? "1" : "";
  for (;;) {
    const uid = randUid();
    const combined = powString + uid;
    const hashed = hashHex(hashFunc, combined);
    if (!hashed.startsWith(prefix)) continue;
    if (extraBits === 0 || hashed[hexZeros] <= maxHexChar) {
      return { pow_msg: combined, pow_sign: hashed };
    }
  }
}

/** lot_number → 嵌套字典（原插件 LotParser 的固定映射）。 */
function lotParserDict(lotNumber) {
  const slice = (start, end) => lotNumber.slice(start, end + 1);
  // 对应原插件 LotParser 的 "(n[15:20])+.+(n[20:27])+.+(n[2:3]+n[8:9])" → "n[10:15]"
  const parts = [[[15, 20]], [[20, 27]], [[2, 3], [8, 9]]];
  const inputs = parts.map((pairs) => pairs.map(([a, b]) => slice(a, b)).join("")).join(".");
  const result = slice(10, 15);
  let dict = result;
  for (let i = inputs.length - 1; i >= 0; i -= 1) {
    dict = { [inputs[i]]: dict };
  }
  return dict;
}

function buildBase(data, captchaId, riskType) {
  const pow = generatePow(
    data.lot_number,
    captchaId,
    data.pow_detail.hashfunc,
    data.pow_detail.version,
    data.pow_detail.bits,
    data.pow_detail.datetime,
  );
  const base = {
    LwjO: "dLVB",
    ...pow,
    ...lotParserDict(data.lot_number),
    biht: "1426265548",
    device_id: "",
    em: { cp: 0, ek: "11", nt: 0, ph: 0, sc: 0, si: 0, wd: 1 },
    gee_guard: {
      roe: { auh: "3", aup: "3", cdc: "3", egp: "3", res: "3", rew: "3", sep: "3", snh: "3" },
    },
    ep: "123",
    geetest: "captcha",
    lang: "zh",
    lot_number: data.lot_number,
  };

  if (riskType === "slide") {
    if (!data.__slideLeft && data.__slideLeft !== 0) throw new Error("缺少滑块位置");
    const left = data.__slideLeft + Math.random() * 0.5;
    base.passtime = 600 + Math.floor(Math.random() * 601);
    base.setLeft = left;
    base.userresponse = left / 1.0059466666666665 + 2;
  } else {
    throw new Error(`不支持的 GeeTest risk_type: ${riskType}`);
  }
  return base;
}

function generateW(data, captchaId, riskType) {
  return encryptW(JSON.stringify(buildBase(data, captchaId, riskType)), data.pt);
}

export { buildBase as __debugBuildBase };

function parseJsonp(text, callback) {
  const start = text.indexOf(`${callback}(`);
  if (start < 0) throw new Error(`GeeTest 返回格式异常: ${text.slice(0, 120)}`);
  const end = text.lastIndexOf(")");
  return JSON.parse(text.slice(start + callback.length + 1, end));
}

function randomCallback() {
  return `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "*/*" } });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function loadCaptcha(captchaId) {
  const callback = randomCallback();
  const challenge = crypto.randomUUID();
  const url = new URL(`${GEETEST_BASE}/load`);
  url.searchParams.set("captcha_id", captchaId);
  url.searchParams.set("challenge", challenge);
  url.searchParams.set("client_type", "web");
  url.searchParams.set("risk_type", "slide");
  url.searchParams.set("lang", "eng");
  url.searchParams.set("callback", callback);
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "*/*", "accept-language": "en-US,en;q=0.9" },
  });
  const json = parseJsonp(await response.text(), callback);
  return { data: json.data, callback };
}

/**
 * 完整求解一次滑块验证码。
 * @param {string} captchaId - 库街区使用的 captcha_id
 * @returns {Promise<string>} seccode
 */
export async function solveGeetest(captchaId) {
  const { data, callback: loadCallback } = await loadCaptcha(captchaId);
  const [slideBuf, bgBuf] = await Promise.all([
    fetchBuffer(`${STATIC_BASE}/${data.slice}`),
    fetchBuffer(`${STATIC_BASE}/${data.bg}`),
  ]);
  const left = solveSlide(slideBuf, bgBuf, decodePng, toGray);
  data.__slideLeft = left;

  const w = generateW(data, captchaId, "slide");
  const callback = loadCallback;
  const url = new URL(`${GEETEST_BASE}/verify`);
  url.searchParams.set("callback", callback);
  url.searchParams.set("captcha_id", captchaId);
  url.searchParams.set("client_type", "web");
  url.searchParams.set("lot_number", data.lot_number);
  url.searchParams.set("risk_type", "slide");
  url.searchParams.set("payload", data.payload);
  url.searchParams.set("process_token", data.process_token);
  url.searchParams.set("payload_protocol", "1");
  url.searchParams.set("pt", "1");
  url.searchParams.set("w", w);
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "*/*", "accept-language": "en-US,en;q=0.9" },
  });
  const json = parseJsonp(await response.text(), callback);
  const result = json.data ?? json;
  if (!result?.seccode) {
    throw new Error(`滑块验证失败: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return result.seccode;
}
