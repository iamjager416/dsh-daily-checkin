/**
 * 森空岛（skland）内置登录 —— 走鹰角网络通行证短信登录换 user_token。
 *
 * 原插件没有这一层（只能玩家手动从网页抠 content）。这里补上：
 *   general/v1/send_phone_code           发短信（type=2 表示登录用途）
 *   user/auth/v2/token_by_phone_code     手机号 + 验证码换 token
 * 拿到的 token 与从网页抠出来的 user_token 等价，可直接喂给 skland.js。
 */
const HG_BASE = "https://as.hypergryph.com";

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "content-type": "application/json;charset=UTF-8",
  origin: "https://ak.hypergryph.com",
  referer: "https://ak.hypergryph.com",
};

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: -1, msg: `响应解析失败: HTTP ${response.status}` };
  }
}

/** 发送鹰角登录短信验证码。 */
export async function sendSklandCode(phone) {
  const resp = await postJson(`${HG_BASE}/general/v1/send_phone_code`, { phone, type: 2 });
  if (resp?.status === 0) return { ok: true };
  if (resp?.status === 1) {
    // 风控要求人机验证（GeeTest v3 的 gt/challenge），插件不做滑块兜底
    throw new Error("鹰角要求人机验证（滑块），这次无法自动通过，请稍后重试或换网络");
  }
  throw new Error(`发送验证码失败：${resp?.msg ?? `status=${resp?.status}`}`);
}

/** 手机号 + 验证码换 user_token（未校验）。 */
export async function exchangeSklandToken(phone, code) {
  const resp = await postJson(`${HG_BASE}/user/auth/v2/token_by_phone_code`, { phone, code });
  if (resp?.status !== 0 || !resp?.data?.token) {
    const message = resp?.msg ?? `status=${resp?.status}`;
    if (/验证码|码错误|失效/.test(String(message))) throw new Error(`验证码不对或已过期：${message}`);
    throw new Error(`登录失败：${message}`);
  }
  return { token: String(resp.data.token), uid: resp.data.uid ?? resp.data.userId ?? "" };
}
