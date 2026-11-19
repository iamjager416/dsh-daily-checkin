/**
 * 库街区（kurobbs）H5 短信登录：GeeTest 滑块 → getSmsCodeForH5 →
 * sdkLoginForH5 → user_token。
 *
 * 滑块求解在 ./geetest.js（纯 JS，无原生依赖）。
 */
import { solveGeetest } from "./geetest.js";

const CAPTCHA_ID = "ec4aa4174277d822d73f2442a165a2cd";
const GET_SMS_URL = "https://api.kurobbs.com/user/getSmsCodeForH5";
const SDK_LOGIN_URL = "https://api.kurobbs.com/user/sdkLoginForH5";

const LOGIN_DEVCODE = "QZlE9fzPUlHON9FGUsfLfWwyM2dRKr6K";
const LOGIN_DISTINCT_ID = "19dafdce461609-023472cbe40c9b-1e462c69-2073600-19dafdce462ebd";

function loginHeaders() {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Origin: "https://www.kurobbs.com",
    Referer: "https://www.kurobbs.com/",
    source: "h5",
    version: "3.0.1",
    devCode: LOGIN_DEVCODE,
    distinct_id: LOGIN_DISTINCT_ID,
    "sec-ch-ua": '"Google Chrome";v="126", "Chromium";v="126", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  };
}

async function postForm(url, data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) body.set(key, String(value));
  const response = await fetch(url, {
    method: "POST",
    headers: loginHeaders(),
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, msg: `响应解析失败: HTTP ${response.status}` };
  }
}

/**
 * 走一遍滑块并发短信验证码。
 * @param {string} phone
 * @returns {Promise<{ok:true}>}
 */
export async function kuroSendSms(phone) {
  const seccode = await solveGeetest(CAPTCHA_ID);
  // 原插件先空 geeTestData 触发一次会话，再带 seccode 发短信
  await postForm(GET_SMS_URL, { mobile: phone, geeTestData: "" });
  const resp = await postForm(GET_SMS_URL, { mobile: phone, geeTestData: JSON.stringify(seccode) });
  if (resp?.data?.geeTest === false) return { ok: true };
  if (resp?.data?.geeTest === true) throw new Error("滑块验证未被接受，请重试");
  throw new Error(`发送短信失败：${resp?.msg ?? JSON.stringify(resp).slice(0, 160)}`);
}

/**
 * 用短信验证码登录，返回 token。
 * @param {string} phone
 * @param {string} code
 */
export async function kuroLogin(phone, code) {
  const resp = await postForm(SDK_LOGIN_URL, { mobile: phone, code });
  if (resp?.code !== 200 || !resp?.data?.token) {
    throw new Error(`登录失败：${resp?.msg ?? `code=${resp?.code}`}`);
  }
  return {
    token: String(resp.data.token),
    userId: resp.data.userId ?? resp.data.userId,
    nickname: resp.data.nickname ?? resp.data.nickName ?? "",
    devcode: LOGIN_DEVCODE,
    distinct_id: LOGIN_DISTINCT_ID,
  };
}
