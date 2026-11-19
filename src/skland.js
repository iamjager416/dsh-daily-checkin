/**
 * 森空岛（skland）签到客户端。
 *
 * 链路：user_token → grant(authorization) → credential(cred/token) → 绑定列表 →
 * 明日方舟 /api/v1/game/attendance + 终末地 /web/v1/game/endfield/attendance。
 *
 * 设备指纹 dId 是必需的：DES 混淆 + gzip + AES-CBC + RSA 加密后向
 * fp-it.portal101.cn/deviceprofile/v4 申请，进程内缓存一次。
 *
 * 注意：Node 默认 OpenSSL 3 可能不提供单 DES，这里用 3DES(EDE) 且三段密钥相同，
 * 数学上等价于单 DES（E(D(E(x))) = E(x)），以规避 legacy provider 限制。
 */
import crypto from "node:crypto";
import zlib from "node:zlib";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 12; SM-A5560 Build/V417IR; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/101.0.4951.61 Safari/537.36; SKLand/1.52.1";
const LOGIN_USER_AGENT = "Skland/1.0.1 (com.hypergryph.skland; build:100001014; Android 31; ) Okhttp/4.11.0";

const GRANT_URL = "https://as.hypergryph.com/user/oauth2/v2/grant";
const CRED_URL = "https://zonai.skland.com/web/v1/user/auth/generate_cred_by_code";
const BINDING_URL = "https://zonai.skland.com/api/v1/game/player/binding";
const ARKNIGHTS_URL = "https://zonai.skland.com/api/v1/game/attendance";
const ENDFIELD_URL = "https://zonai.skland.com/web/v1/game/endfield/attendance";
const DEVICE_URL = "https://fp-it.portal101.cn/deviceprofile/v4";

const BROWSER_ENV = {
  plugins:
    "MicrosoftEdgePDFPluginPortableDocumentFormatinternal-pdf-viewer1,MicrosoftEdgePDFViewermhjfbmdgcfjbbpaeojofohoefgiehjai1",
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  canvas: "259ffe69",
  timezone: -480,
  platform: "Win32",
  url: "https://www.skland.com/",
  referer: "",
  res: "1920_1080_24_1.25",
  clientSize: "0_0_1080_1920_1920_1080_1920_1080",
  status: "0011",
};

const DES_TARGET = {
  protocol: 102,
  organization: "UWXspnCCJN4sfYlNfqps",
  appId: "default",
  os: "web",
  version: "3.0.0",
  sdkver: "3.0.0",
  box: "",
  rtype: "all",
  subVersion: "1.0.0",
  time: 0,
};

const DES_RULE = {
  appId: { cipher: "DES", is_encrypt: 1, key: "uy7mzc4h", obfuscated_name: "xx" },
  box: { is_encrypt: 0, obfuscated_name: "jf" },
  canvas: { cipher: "DES", is_encrypt: 1, key: "snrn887t", obfuscated_name: "yk" },
  clientSize: { cipher: "DES", is_encrypt: 1, key: "cpmjjgsu", obfuscated_name: "zx" },
  organization: { cipher: "DES", is_encrypt: 1, key: "78moqjfc", obfuscated_name: "dp" },
  os: { cipher: "DES", is_encrypt: 1, key: "je6vk6t4", obfuscated_name: "pj" },
  platform: { cipher: "DES", is_encrypt: 1, key: "pakxhcd2", obfuscated_name: "gm" },
  plugins: { cipher: "DES", is_encrypt: 1, key: "v51m3pzl", obfuscated_name: "kq" },
  pmf: { cipher: "DES", is_encrypt: 1, key: "2mdeslu3", obfuscated_name: "vw" },
  protocol: { is_encrypt: 0, obfuscated_name: "protocol" },
  referer: { cipher: "DES", is_encrypt: 1, key: "y7bmrjlc", obfuscated_name: "ab" },
  res: { cipher: "DES", is_encrypt: 1, key: "whxqm2a7", obfuscated_name: "hf" },
  rtype: { cipher: "DES", is_encrypt: 1, key: "x8o2h2bl", obfuscated_name: "lo" },
  sdkver: { cipher: "DES", is_encrypt: 1, key: "9q3dcxp2", obfuscated_name: "sc" },
  status: { cipher: "DES", is_encrypt: 1, key: "2jbrxxw4", obfuscated_name: "an" },
  subVersion: { cipher: "DES", is_encrypt: 1, key: "eo3i2puh", obfuscated_name: "ns" },
  svm: { cipher: "DES", is_encrypt: 1, key: "fzj3kaeh", obfuscated_name: "qr" },
  time: { cipher: "DES", is_encrypt: 1, key: "q2t3odsk", obfuscated_name: "nb" },
  timezone: { cipher: "DES", is_encrypt: 1, key: "1uv05lj5", obfuscated_name: "as" },
  tn: { cipher: "DES", is_encrypt: 1, key: "x9nzj1bp", obfuscated_name: "py" },
  trees: { cipher: "DES", is_encrypt: 1, key: "acfs0xo4", obfuscated_name: "pi" },
  ua: { cipher: "DES", is_encrypt: 1, key: "k92crp1t", obfuscated_name: "bj" },
  url: { cipher: "DES", is_encrypt: 1, key: "y95hjkoo", obfuscated_name: "cf" },
  version: { is_encrypt: 0, obfuscated_name: "version" },
  vpw: { cipher: "DES", is_encrypt: 1, key: "r9924ab5", obfuscated_name: "ca" },
};

const RSA_PUBLIC_KEY =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCmxMNr7n8ZeT0tE1R9j/mPixoinPkeM+k4VGIn/s0k7N5rJAfnZ0eMER+QhwFvshzo0LNmeUkpR8uIlU/GEVr8mN28sKmwd2gpygqj0ePnBmOW4v0ZVwbSYK+izkhVFk2V/doLoMbWy6b+UnA8mkjvg0iYWRByfRsK2gdl7llqCwIDAQAB";

import { desEcbEncrypt } from "./des.js";

function md5Hex(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function aesCbcEncryptHex(data, keyText) {
  const encoded = Buffer.from(data.toString("base64"), "utf8");
  let paddedB64 = encoded;
  if (encoded.length % 16 !== 0) {
    paddedB64 = Buffer.concat([encoded, Buffer.alloc(16 - (encoded.length % 16), 0)]);
  }
  // PKCS7（Python 的 pad 在对齐时补满一整块）
  const padLen = 16 - (paddedB64.length % 16);
  const padded = Buffer.concat([paddedB64, Buffer.alloc(padLen, padLen)]);
  const key = Buffer.from(keyText, "utf8").subarray(0, 16);
  const iv = Buffer.from("0102030405060708", "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex");
}

function randomUuid() {
  return crypto.randomUUID();
}

function smid() {
  const timeStr = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const uid = randomUuid();
  const v = `${timeStr}${md5Hex(uid)}00`;
  const suffix = crypto
    .createHash("md5")
    .update(`smsk_web_${v}`, "utf8")
    .digest()
    .subarray(0, 7)
    .toString("hex");
  return `${v}${suffix}0`;
}

function tnInput(data) {
  let result = "";
  for (const key of Object.keys(data).sort()) {
    const value = data[key];
    if (typeof value === "number" && Number.isInteger(value)) result += String(value * 10000);
    else if (value !== null && typeof value === "object") result += tnInput(value);
    else result += value ? String(value) : "";
  }
  return result;
}

function applyDesRules(data) {
  const result = {};
  for (const [key, raw] of Object.entries(data)) {
    const value = typeof raw === "string" ? raw : String(raw);
    const rule = DES_RULE[key];
    if (!rule) {
      result[key] = raw;
      continue;
    }
    if (rule.is_encrypt === 1) {
      const encrypted = desEcbEncrypt(rule.key, value);
      result[rule.obfuscated_name] = encrypted.toString("base64");
    } else {
      result[rule.obfuscated_name] = raw;
    }
  }
  return result;
}

let cachedDeviceId = "";

/** 生成/复用设备指纹 dId（形如 B<deviceId>）。 */
export async function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId;

  const uid = randomUuid();
  const priIdHex = crypto.createHash("md5").update(uid, "utf8").digest().subarray(0, 8).toString("hex");

  const publicKey = crypto.createPublicKey({
    key: Buffer.from(RSA_PUBLIC_KEY, "base64"),
    format: "der",
    type: "spki",
  });
  const ep = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(uid, "utf8"));

  const nowMs = Date.now();
  const fingerprint = {
    ...BROWSER_ENV,
    vpw: randomUuid(),
    trees: randomUuid(),
    svm: nowMs,
    pmf: nowMs,
  };
  const target = { ...DES_TARGET, smid: smid(), ...fingerprint };
  target.tn = md5Hex(tnInput(target));

  const desResult = applyDesRules(target);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(desResult), "utf8"), { level: 2 });
  const data = aesCbcEncryptHex(compressed, priIdHex);

  const response = await postJson(
    DEVICE_URL,
    { appId: "default", compress: 2, data, encode: 5, ep: ep.toString("base64"), organization: "UWXspnCCJN4sfYlNfqps", os: "web" },
    { "User-Agent": USER_AGENT },
    3,
  );
  if (response?.code !== 1100) {
    throw new Error(`设备指纹生成失败: ${JSON.stringify(response).slice(0, 300)}`);
  }
  cachedDeviceId = `B${response.detail?.deviceId ?? ""}`;
  return cachedDeviceId;
}

async function postJson(url, payload, extraHeaders = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...extraHeaders },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError ?? new Error("request failed");
}

async function requestJson(method, url, headers = {}, body) {
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
}

async function grant(userToken) {
  const did = await getDeviceId();
  const response = await postJson(
    GRANT_URL,
    { appCode: "4ca99fa6b56cc2ba", token: userToken, type: 0 },
    { "User-Agent": LOGIN_USER_AGENT, "Accept-Encoding": "gzip", Connection: "close", dId: did },
  );
  if (response?.status !== 0) throw new Error(`授权失败: ${response?.message ?? "unknown"}`);
  return response.data.code;
}

async function getCredential(authorization) {
  const did = await getDeviceId();
  const response = await postJson(
    CRED_URL,
    { code: authorization, kind: 1 },
    { "User-Agent": LOGIN_USER_AGENT, "Accept-Encoding": "gzip", Connection: "close", dId: did },
  );
  if (response?.code !== 0) throw new Error(`换取凭据失败: ${response?.message ?? "unknown"}`);
  return { token: response.data.token, cred: response.data.cred };
}

function baseHeaders(did) {
  return {
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "gzip",
    Connection: "close",
    "X-Requested-With": "com.hypergryph.skland",
    dId: did,
  };
}

function generateSignature(token, path, bodyOrQuery, did) {
  const timestamp = Math.floor(Date.now() / 1000) - 2;
  const headerCa = { platform: "3", timestamp: String(timestamp), dId: did, vName: "1.0.0" };
  const headerCaStr = JSON.stringify(headerCa);
  const raw = `${path}${bodyOrQuery}${timestamp}${headerCaStr}`;
  const hmacHex = crypto.createHmac("sha256", Buffer.from(token, "utf8")).update(raw, "utf8").digest("hex");
  return { sign: md5Hex(hmacHex), headerCa };
}

function signedHeaders(url, method, body, cred, did) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const query = parsed.search ? parsed.search.slice(1) : "";
  const { sign, headerCa } = generateSignature(cred.token, path, method === "GET" ? query : body ?? "", did);
  const headers = baseHeaders(did);
  headers.cred = cred.cred;
  headers.sign = sign;
  for (const [key, value] of Object.entries(headerCa)) headers[key] = String(value);
  return headers;
}

async function getBindings(cred) {
  const did = await getDeviceId();
  const headers = signedHeaders(BINDING_URL, "GET", null, cred, did);
  const response = await requestJson("GET", BINDING_URL, headers);
  if (response?.code !== 0) {
    const message = response?.message ?? "unknown";
    if (message === "用户未登录") throw new Error("森空岛登录已过期，请重新获取 token");
    throw new Error(`获取绑定列表失败: ${message}`);
  }
  const bindings = [];
  for (const item of response?.data?.list ?? []) {
    const appCode = item?.appCode ?? "";
    if (appCode !== "arknights" && appCode !== "endfield") continue;
    for (const binding of item?.bindingList ?? []) {
      bindings.push({
        appCode,
        gameName: binding?.gameName ?? "未知",
        nickname: binding?.nickName ?? "未知",
        channelName: binding?.channelName ?? "未知",
        uid: binding?.uid ?? "",
        gameId: binding?.gameId ?? 1,
        roles: binding?.roles ?? [],
      });
    }
  }
  return bindings;
}

const ALREADY_SIGNED = ["已签到", "请勿重复", "重复签到", "already", "签到过", "今日已"];

function isAlreadySigned(message) {
  const text = String(message ?? "").toLowerCase();
  return ALREADY_SIGNED.some((keyword) => text.includes(keyword.toLowerCase()));
}

function awardText(awards) {
  return Array.isArray(awards) && awards.length > 0 ? `，获得 ${awards.join("、")}` : "";
}

async function signArknights(cred, binding) {
  const did = await getDeviceId();
  const body = JSON.stringify({ gameId: binding.gameId, uid: binding.uid });
  const headers = signedHeaders(ARKNIGHTS_URL, "POST", body, cred, did);
  headers["Content-Type"] = "application/json";
  const response = await requestJson("POST", ARKNIGHTS_URL, headers, body);
  if (response?.code !== 0) {
    const message = response?.message ?? "未知错误";
    const already = isAlreadySigned(message);
    return { ok: already, already, line: already ? `✅ 明日方舟 · ${binding.nickname}（uid=${binding.uid}）：今天已签到` : `❌ 明日方舟（uid=${binding.uid}）：${message}` };
  }
  const awards = (response?.data?.awards ?? []).map((award) => {
    const name = award?.resource?.name ?? "未知";
    const count = award?.count ?? 1;
    return `${name}x${count}`;
  });
  return { ok: true, line: `✅ 明日方舟 · ${binding.nickname}（uid=${binding.uid}）：签到成功` };
}

async function signEndfield(cred, binding) {
  const did = await getDeviceId();
  const results = [];
  if (!Array.isArray(binding.roles) || binding.roles.length === 0) {
    results.push(`❌ 终末地（uid=${binding.uid}）：没有角色数据`);
    return results;
  }
  for (const role of binding.roles) {
    const nickname = role?.nickname ?? binding.nickname;
    const roleId = role?.roleId ?? "";
    const serverId = role?.serverId ?? "";
    const headers = signedHeaders(ENDFIELD_URL, "POST", "", cred, did);
    headers["Content-Type"] = "application/json";
    headers["sk-game-role"] = `3_${roleId}_${serverId}`;
    headers.referer = "https://game.skland.com/";
    headers.origin = "https://game.skland.com/";
    const response = await requestJson("POST", ENDFIELD_URL, headers);
    if (response?.code !== 0) {
      const message = response?.message ?? "未知错误";
      results.push(isAlreadySigned(message) ? `✅ 终末地 · ${nickname}（uid=${binding.uid}）：今天已签到` : `❌ 终末地（uid=${binding.uid}）：${message}`);
      continue;
    }
    const ids = response?.data?.awardIds ?? [];
    const resourceMap = response?.data?.resourceInfoMap ?? {};
    const awards = [];
    for (const award of ids) {
      const info = resourceMap?.[award?.id];
      if (info) awards.push(`${info.name ?? "未知"}x${info.count ?? 1}`);
    }
    results.push(`✅ 终末地 · ${nickname}（uid=${binding.uid}）：签到成功`);
  }
  return results;
}

/**
 * 执行一次森空岛签到（明日方舟 + 终末地）。
 * @param {string} userToken - 森空岛 user_token
 * @returns {Promise<{ok:boolean, lines:string[], nickname:string, expired:boolean}>}
 */
/** 校验 user_token 是否还能换到 credential（登录后自检用）。 */
export async function validateSklandToken(userToken) {
  try {
    const authorization = await grant(userToken);
    await getCredential(authorization);
    return true;
  } catch {
    return false;
  }
}
export async function runSklandCheckin(userToken) {
  const lines = ["【森空岛】"];
  if (!userToken) {
    lines.push("❌ 未配置森空岛 token");
    return { ok: false, lines, nickname: "", expired: false };
  }
  try {
    const authorization = await grant(userToken);
    const cred = await getCredential(authorization);
    const bindings = await getBindings(cred);
    if (bindings.length === 0) {
      lines.push("⚠️ 没有找到明日方舟/终末地绑定");
      return { ok: true, lines, nickname: "", expired: false };
    }
    const nickname = bindings[0].nickname;
    let failed = false;
    for (const binding of bindings) {
      if (binding.appCode === "arknights") {
        const result = await signArknights(cred, binding);
        lines.push(result.line);
        if (!result.ok) failed = true;
      } else if (binding.appCode === "endfield") {
        for (const line of await signEndfield(cred, binding)) {
          lines.push(line);
          if (line.startsWith("❌")) failed = true;
        }
      }
    }
    const gameUids = bindings.map((binding) => ({ game: binding.gameName, uid: binding.uid })).filter((item) => item.uid);
    return { ok: !failed, lines, nickname, accountUid: gameUids[0]?.uid ?? "", gameUids, expired: false };
  } catch (error) {
    const message = String(error?.message ?? error);
    const expired = message.includes("登录已过期") || message.includes("授权失败");
    lines.push(`❌ ${message}`);
    return { ok: false, lines, nickname: "", expired };
  }
}
