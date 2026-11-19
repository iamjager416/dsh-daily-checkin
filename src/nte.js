/**
 * 异环（NTE / 塔吉多）客户端。
 *
 * 登录走「手机号 + 短信验证码」路径，然后签到：
 *   sendPhoneCaptchaWithOutLogin → checkPhoneCaptchaWithOutLogin → login →
 *   usercenter/api/login（换 accessToken/refreshToken）→ 角色 → 社区/游戏签到。
 * 不做密码登录、云异环登录与多聊天用户管理。
 */
import crypto from "node:crypto";

const APP_ID = "10550";
const USER_CENTER_APP_ID = "10551";
const SECRET = "89155cc4e8634ec5b1b6364013b23e3e";
const APPVERSION = "1.1.0";
const DS_SALT = "pUds3dfMkl";
const DEFAULT_GAME_ID = "1289";
const COMMUNITY_ID = "1";
const OKHTTP_UA = "okhttp/4.12.0";

const DEVICE = {
  deviceType: "LGE-AN10",
  type: "16",
  deviceName: "LGE-AN10",
  versionCode: "1",
  areaCodeId: "1",
  deviceSys: "12",
  deviceModel: "LGE-AN10",
  sdkVersion: "4.129.0",
  bid: "com.pwrd.htassistant",
  channelId: "1",
};

const SEND_CAPTCHA_URL = "https://user.laohu.com/m/newApi/sendPhoneCaptchaWithOutLogin";
const CHECK_CAPTCHA_URL = "https://user.laohu.com/m/newApi/checkPhoneCaptchaWithOutLogin";
const LOGIN_URL = "https://user.laohu.com/openApi/sms/new/login";
const USER_CENTER_LOGIN_URL = "https://bbs-api.tajiduo.com/usercenter/api/login";
const REFRESH_TOKEN_URL = "https://bbs-api.tajiduo.com/usercenter/api/refreshToken";
const GET_GAME_ROLES_URL = "https://bbs-api.tajiduo.com/usercenter/api/v2/getGameRoles";
const APP_SIGNIN_URL = "https://bbs-api.tajiduo.com/apihub/api/signin";
const GAME_SIGNIN_URL = "https://bbs-api.tajiduo.com/apihub/awapi/sign";
const GAME_SIGN_STATE_URL = "https://bbs-api.tajiduo.com/apihub/awapi/signin/state";

const FORM_HEADERS = { platform: "android", "Content-Type": "application/x-www-form-urlencoded" };

function md5(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function randomHex(length = 32) {
  return crypto.randomBytes(length / 2).toString("hex");
}

/** AES-128-ECB + PKCS7 + base64，密钥取 secret 后 16 字符。 */
function aesBase64(text, secret = SECRET) {
  const key = Buffer.from(secret.slice(-16), "utf8");
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString("base64");
}

/** md5(按 key 排序拼接的值 + secret)。 */
function signature(params, secret = SECRET) {
  const values = Object.keys(params)
    .sort()
    .map((key) => String(params[key]))
    .join("");
  return md5(values + secret);
}

function generateDs() {
  const timestamp = Math.floor(Date.now() / 1000);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const nonce = Array.from(crypto.randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join("");
  const digest = md5(`${timestamp}${nonce}${APPVERSION}${DS_SALT}`);
  return `${timestamp},${nonce},${digest}`;
}

function taiDuoHeaders(headers = {}) {
  const merged = { ...headers };
  merged.appversion = merged.appversion ?? APPVERSION;
  merged.platform = merged.platform ?? "android";
  merged.ds = generateDs();
  return merged;
}

async function formPost(url, data, headers = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) body.set(key, String(value));
  const isTajiduo = new URL(url).hostname === "bbs-api.tajiduo.com";
  const response = await fetch(url, {
    method: "POST",
    headers: isTajiduo ? taiDuoHeaders(headers) : headers,
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
}

async function getJson(url, params = {}, headers = {}) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
  const isTajiduo = target.hostname === "bbs-api.tajiduo.com";
  const response = await fetch(target, {
    method: "GET",
    headers: isTajiduo ? taiDuoHeaders(headers) : headers,
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
}

const isOk = (resp) => resp?.code === 0;

function messageOf(resp) {
  for (const key of ["msg", "message"]) {
    if (typeof resp?.[key] === "string" && resp[key].trim() !== "") return resp[key].replace(/\s+/g, " ").slice(0, 180);
  }
  return `接口返回错误（code=${String(resp?.code)}）`;
}

const ALREADY_SIGNED = ["已签到", "签到过", "重复签到"];
const isAlreadySigned = (message) => ALREADY_SIGNED.some((key) => String(message ?? "").includes(key));

function maskPhone(phone) {
  const text = String(phone ?? "");
  return text.length >= 7 ? `${text.slice(0, 3)}****${text.slice(-4)}` : "****";
}

/** 取当前绑定的塔吉多账号：新结构是单对象，兼容旧的 accounts 数组。 */
export function pickNteAccount(entry) {
  if (!entry) return null;
  if (entry.refreshToken) return entry;
  return Array.isArray(entry.accounts) ? entry.accounts[0] ?? null : null;
}
/** 发送短信验证码；返回本次登录会话的 deviceId。 */
export async function nteSendCode(phone) {
  const deviceId = randomHex(32);
  const data = {
    ...DEVICE,
    deviceId,
    t: String(Math.floor(Date.now() / 1000)),
    appId: APP_ID,
    cellphone: phone,
  };
  data.sign = signature(data);
  const resp = await formPost(SEND_CAPTCHA_URL, data, FORM_HEADERS);
  if (!isOk(resp)) throw new Error(`发送验证码失败：${messageOf(resp)}`);
  return deviceId;
}

async function fetchGameRoles(accessToken, uid, deviceId, gameId) {
  const resp = await getJson(
    GET_GAME_ROLES_URL,
    { gameId },
    { platform: "android", authorization: accessToken, uid, deviceid: deviceId, appversion: APPVERSION, "User-Agent": OKHTTP_UA },
  );
  if (!isOk(resp)) throw new Error(`获取角色列表失败：${messageOf(resp)}`);
  const roles = Array.isArray(resp?.data?.roles) ? resp.data.roles : [];
  return roles
    .map((role) => ({
      roleId: String(role?.roleId ?? role?.role_id ?? ""),
      roleName: String(role?.roleName ?? role?.name ?? ""),
    }))
    .filter((role) => role.roleId !== "");
}

/**
 * 校验验证码并完成登录，返回账号对象（含 refreshToken/accessToken/uid/roles）。
 * @param {string} phone
 * @param {string} code
 * @param {string} deviceId - nteSendCode 返回值
 */
export async function nteVerifyLogin(phone, code, deviceId) {
  const check = {
    ...DEVICE,
    deviceId,
    t: String(Math.floor(Date.now() / 1000)),
    captcha: code,
    appId: APP_ID,
    cellphone: phone,
  };
  check.sign = signature(check);
  const checkResp = await formPost(CHECK_CAPTCHA_URL, check, FORM_HEADERS);
  if (!isOk(checkResp)) throw new Error(`验证码错误：${messageOf(checkResp)}`);

  const login = {
    deviceType: DEVICE.deviceType,
    idfa: "",
    sign: "",
    adm: "",
    type: DEVICE.type,
    deviceId,
    version: DEVICE.versionCode,
    deviceName: DEVICE.deviceName,
    mac: "",
    t: String(Date.now()),
    areaCodeId: DEVICE.areaCodeId,
    captcha: aesBase64(code),
    appId: APP_ID,
    deviceSys: DEVICE.deviceSys,
    cellphone: aesBase64(phone),
    deviceModel: DEVICE.deviceModel,
    sdkVersion: DEVICE.sdkVersion,
    bid: DEVICE.bid,
    channelId: DEVICE.channelId,
  };
  login.sign = signature(login);
  const loginResp = await formPost(LOGIN_URL, login, FORM_HEADERS);
  if (!isOk(loginResp)) throw new Error(`登录失败：${messageOf(loginResp)}`);
  const token = loginResp?.result?.token;
  const userId = loginResp?.result?.userId;
  if (!token || userId === undefined) throw new Error("登录返回缺少 token/userId");

  const centerResp = await formPost(
    USER_CENTER_LOGIN_URL,
    { token, userIdentity: String(userId), appId: USER_CENTER_APP_ID },
    {
      ...FORM_HEADERS,
      deviceid: deviceId,
      authorization: "",
      appversion: APPVERSION,
      uid: "10000000",
      "User-Agent": OKHTTP_UA,
    },
  );
  if (!isOk(centerResp)) throw new Error(`用户中心登录失败：${messageOf(centerResp)}`);
  const center = centerResp?.data ?? {};
  if (!center.accessToken || !center.refreshToken) throw new Error("用户中心返回缺少 accessToken/refreshToken");

  const account = {
    refreshToken: center.refreshToken,
    accessToken: center.accessToken,
    uid: String(center.uid ?? userId),
    deviceId,
    gameId: DEFAULT_GAME_ID,
    phoneMasked: maskPhone(phone),
    roles: [],
    roleIds: [],
  };
  try {
    account.roles = await fetchGameRoles(account.accessToken, account.uid, deviceId, account.gameId);
    account.roleIds = account.roles.map((role) => role.roleId);
  } catch {
    // 角色列表失败不阻塞登录
  }
  return account;
}

async function refreshAccessToken(account) {
  const headers = {
    ...FORM_HEADERS,
    deviceid: account.deviceId,
    authorization: account.refreshToken,
    appversion: APPVERSION,
    uid: "10000000",
    "User-Agent": OKHTTP_UA,
  };
  const body = new URLSearchParams();
  const target = taiDuoHeaders(headers);
  const response = await fetch(REFRESH_TOKEN_URL, {
    method: "POST",
    headers: target,
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 402) throw new Error("refreshToken 已失效，请重新登录");
  const resp = await response.json();
  if (!isOk(resp)) throw new Error(`刷新 token 失败：${messageOf(resp)}`);
  const data = resp?.data ?? {};
  if (!data.accessToken || !data.refreshToken) throw new Error("刷新 token 返回缺少字段");
  account.accessToken = data.accessToken;
  account.refreshToken = data.refreshToken;
  if (data.uid) account.uid = String(data.uid);
  return account.accessToken;
}

async function communitySignin(accessToken, uid, deviceId) {
  const resp = await formPost(
    APP_SIGNIN_URL,
    { communityId: COMMUNITY_ID },
    {
      ...FORM_HEADERS,
      authorization: accessToken,
      uid,
      deviceid: deviceId,
      appversion: APPVERSION,
      "User-Agent": OKHTTP_UA,
    },
  );
  if (isOk(resp)) {
    const exp = resp?.data?.exp ?? 0;
    const coin = resp?.data?.goldCoin ?? 0;
    return `✅ 社区签到（uid=${uid}）：签到成功`;
  }
  const message = messageOf(resp);
  return isAlreadySigned(message) ? `✅ 社区签到（uid=${uid}）：今天已签到` : `❌ 社区签到（uid=${uid}）：${message}`;
}

async function gameSignin(accessToken, roleId, gameId, roleName = "") {
  const resp = await formPost(
    GAME_SIGNIN_URL,
    { roleId, gameId },
    { ...FORM_HEADERS, authorization: accessToken, appversion: APPVERSION, "User-Agent": OKHTTP_UA },
  );
  if (isOk(resp)) {
    return `✅ 异环 · ${roleName || roleId}（uid=${roleId}）：签到成功`;
  }
  const message = messageOf(resp);
  return isAlreadySigned(message) ? `✅ 异环 · ${roleName || roleId}（uid=${roleId}）：今天已签到` : `❌ 异环（uid=${roleId}）：${message}`;
}

/**
 * 对单个已保存账号执行签到（社区 + 游戏角色）。
 * @param {object} account - 凭据库 nte.accounts[] 中的一项（会被就地更新 accessToken/refreshToken）
 */
export async function nteSignAccount(account) {
  const lines = [];
  const accessToken = await refreshAccessToken(account);
  lines.push(await communitySignin(accessToken, account.uid, account.deviceId));
  try {
    const roles = await fetchGameRoles(accessToken, account.uid, account.deviceId, account.gameId);
    if (roles.length === 0) lines.push("⚠️ 没有查到游戏角色，跳过游戏签到");
    for (const role of roles) {
      lines.push(await gameSignin(accessToken, role.roleId, account.gameId, role.roleName));
    }
    account.roles = roles;
    account.roleIds = roles.map((role) => role.roleId);
  } catch (error) {
    lines.push(`❌ ${String(error?.message ?? error)}`);
  }
  account.lastSignAt = new Date().toISOString();
  return lines;
}
