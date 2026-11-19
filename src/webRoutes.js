/**
 * 插件详情页设置面板的 Host 路由。
 *
 * 客户端 bundle（client/client.js）通过相对路径 api/dsh-checkin/... 调用它们：
 *   GET  /api/dsh-checkin/config      读取设置与账号绑定状态（secret 只回 hasSecret）
 *   POST /api/dsh-checkin/config      写入设置（定时 / 推送）
 *   POST /api/dsh-checkin/login/send  发送短信验证码（provider + phone）
 *   POST /api/dsh-checkin/login/verify 提交验证码完成绑定（provider + code）
 *   POST /api/dsh-checkin/run         立即执行一次全量签到
 */
import {
  loadSchedule,
  saveSchedule,
  loadNotify,
  saveNotify,
  loadLoginPhones,
  saveLoginPhones,
  loadReport,
  normalizeTime,
  runAllCheckins,
  runAllCheckinsExclusive,
  isCheckinRunning,
  nextRunAt,
  buildPushText,
} from "./scheduler.js";
import { sendQqText } from "./qqPush.js";
import { loadVault, saveVault } from "./vault.js";
import { kuroSendSms, kuroLogin } from "./kuroLogin.js";
import { sendSklandCode, exchangeSklandToken } from "./sklandLogin.js";
import { validateSklandToken } from "./skland.js";
import { nteSendCode, nteVerifyLogin, pickNteAccount } from "./nte.js";

export const ROUTE_BASE = "/api/dsh-checkin/v4";
const LOGIN_COOLDOWN_MS = 60_000;

/** provider -> { phone, deviceId?, sentAt } */
const pendingLogins = new Map();

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  return JSON.parse(text);
}

function snapshot() {
  const schedule = loadSchedule();
  const notify = loadNotify();
  const phones = loadLoginPhones();
  const report = loadReport();
  const vault = loadVault();
  const nteAccount = pickNteAccount(vault.nte);
  return {
    schedule: {
      enabled: schedule.enabled !== false,
      time: schedule.time,
      providers: schedule.providers ?? [],
      lastRunDate: schedule.lastRunDate ?? "",
      lastRunAt: schedule.lastRunAt ?? "",
      lastPushAt: schedule.lastPushAt ?? "",
      lastPushOk: schedule.lastPushOk ?? null,
      lastPushError: schedule.lastPushError ?? "",
    },
    notify: {
      enabled: notify.enabled === true,
      target: notify.target ?? "",
      appId: notify.appId ?? "",
      hasSecret: Boolean(notify.appSecret),
    },
    phones: { kuro: phones.kuro ?? "", skland: phones.skland ?? "", nte: phones.nte ?? "" },
    accounts: {
      kuro: vault.kuro?.token ? { uid: vault.kuro.userId ?? "", name: vault.kuro.userName ?? "" } : null,
      skland: vault.skland?.token ? { uid: vault.skland.uid ?? "", name: vault.skland.nickName ?? "" } : null,
      nte: nteAccount ? { uid: nteAccount.uid ?? "", name: "" } : null,
    },
    nextRunAt: nextRunAt(schedule),
    reportAt: report?.atLocal ?? "",
    reportOk: report?.ok ?? null,
    reportLines: report?.lines ?? [],
  };
}

const PROVIDERS = ["kuro", "skland", "nte"];

async function sendCode(provider, phone) {
  if (!PROVIDERS.includes(provider)) throw new Error(`不支持的平台：${provider}`);
  if (!/^\d{11}$/.test(phone)) throw new Error("手机号格式不正确（需要 11 位数字）");
  const previous = pendingLogins.get(provider);
  if (previous && Date.now() - previous.sentAt < LOGIN_COOLDOWN_MS) {
    const wait = Math.ceil((LOGIN_COOLDOWN_MS - (Date.now() - previous.sentAt)) / 1000);
    throw new Error(`发送太频繁，请 ${wait} 秒后再试`);
  }

  let deviceId = "";
  if (provider === "kuro") await kuroSendSms(phone);
  else if (provider === "skland") await sendSklandCode(phone);
  else deviceId = await nteSendCode(phone);

  pendingLogins.set(provider, { phone, deviceId, sentAt: Date.now() });
  const phones = loadLoginPhones();
  phones[provider] = phone;
  saveLoginPhones(phones);
  return { sent: true, phone, expiresIn: 300 };
}

async function verifyCode(provider, code) {
  if (!PROVIDERS.includes(provider)) throw new Error(`不支持的平台：${provider}`);
  const pending = pendingLogins.get(provider);
  if (!pending) throw new Error("还没有发送验证码，请先点「发送验证码」");
  if (Date.now() - pending.sentAt > 5 * 60 * 1000) {
    pendingLogins.delete(provider);
    throw new Error("验证码已过期（5 分钟），请重新发送");
  }
  if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式不正确");

  const vault = loadVault();
  if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);

  if (provider === "kuro") {
    const result = await kuroLogin(pending.phone, code);
    vault.kuro = {
      ...(vault.kuro ?? { enabled: true, signGames: true, signForum: true }),
      token: result.token,
      devcode: result.devcode,
      distinct_id: result.distinct_id,
      userId: result.userId,
      loginAt: new Date().toISOString(),
    };
    saveVault(vault);
  } else if (provider === "skland") {
    const result = await exchangeSklandToken(pending.phone, code);
    if (!(await validateSklandToken(result.token))) throw new Error("token 换到了但校验失败（账号可能未绑定森空岛）");
    vault.skland = { ...(vault.skland ?? {}), token: result.token, uid: result.uid ?? "", loginAt: new Date().toISOString() };
    saveVault(vault);
  } else {
    const account = await nteVerifyLogin(pending.phone, code, pending.deviceId);
    vault.nte = { ...(vault.nte ?? {}), ...account, enabled: true, boundAt: new Date().toISOString() };
    delete vault.nte.accounts;
    saveVault(vault);
  }

  pendingLogins.delete(provider);
  return snapshot();
}

/**
 * 路由只注册一次（用 globalThis 记录），之后每次插件重载只替换处理函数。
 * 这样避免宿主里残留旧路由导致的 "duplicate exact route"。
 */
const HANDLERS_KEY = "__dshCheckinHandlers";
const INSTALLED_KEY = "__dshCheckinRoutesInstalled";
const DISPOSERS_KEY = "__dshCheckinRouteDisposers";

async function dispatch(key, request, response) {
  try {
    const handlers = globalThis[HANDLERS_KEY] ?? {};
    const handler = handlers[key];
    if (typeof handler !== "function") throw new Error("路由处理器尚未就绪");
    const data = await handler(request);
    if (!response.writableEnded) sendJson(response, 200, { ok: true, data });
  } catch (error) {
    if (!response.writableEnded) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error).slice(0, 300) });
    }
  }
}

function routeDefinitions() {
  const exact = (method, path, key) => ({
    kind: "exact",
    method,
    path,
    handler: (request, response) => dispatch(key, request, response),
  });
  return [
    exact("GET", `${ROUTE_BASE}/config`, "config"),
    exact("POST", `${ROUTE_BASE}/config/save`, "save"),
    exact("POST", `${ROUTE_BASE}/login/send`, "send"),
    exact("POST", `${ROUTE_BASE}/login/verify`, "verify"),
    exact("POST", `${ROUTE_BASE}/run`, "run"),
  ];
}

/** 注册（仅第一次）并总是把最新处理函数挂到全局。返回本次新注册条数。 */
export function installRoutes(webServer) {
  const handlers = {
    config: async () => snapshot(),
    save: async (request) => {
      const body = await readJsonBody(request);
      const schedule = loadSchedule();
      if (body.schedule && typeof body.schedule === "object") {
        if (typeof body.schedule.enabled === "boolean") schedule.enabled = body.schedule.enabled;
        if (typeof body.schedule.time === "string" && body.schedule.time.trim() !== "") {
          const time = normalizeTime(body.schedule.time);
          if (!time) throw new Error("时间格式不对，需要 HH:MM");
          schedule.time = time;
        }
        if (Array.isArray(body.schedule.providers)) {
          const providers = body.schedule.providers.filter((id) => PROVIDERS.includes(id));
          if (providers.length === 0) throw new Error("至少选择一个平台");
          schedule.providers = providers;
        }
        saveSchedule(schedule);
      }
      if (body.notify && typeof body.notify === "object") {
        const notify = loadNotify();
        if (typeof body.notify.enabled === "boolean") notify.enabled = body.notify.enabled;
        for (const [field, key] of [["target", "target"], ["appId", "appId"], ["appSecret", "appSecret"]]) {
          if (typeof body.notify[field] === "string" && body.notify[field].trim() !== "") {
            notify[key] = body.notify[field].trim();
          }
        }
        if (typeof notify.target === "string" && notify.target.trim() !== "" && !notify.target.includes(":")) {
          notify.target = `c2c:${notify.target.trim()}`;
        }
        if (typeof notify.target === "string" && notify.target.includes(":")) {
          const [scope, ...rest] = notify.target.split(":");
          const openid = rest.join(":").trim();
          if (!["c2c", "group"].includes(scope) || openid === "") {
            throw new Error("推送目标格式不对，应当形如 c2c:<openid> 或 group:<openid>");
          }
          notify.target = `${scope}:${openid}`;
        }
        if (notify.enabled && (!notify.target || !notify.appId || !notify.appSecret)) {
          throw new Error("启用推送需要填 target / appId / appSecret");
        }
        saveNotify(notify);
      }
      if (body.phones && typeof body.phones === "object") {
        const phones = loadLoginPhones();
        for (const key of PROVIDERS) {
          if (typeof body.phones[key] === "string" && body.phones[key].trim() !== "") {
            phones[key] = body.phones[key].trim();
          }
        }
        saveLoginPhones(phones);
      }
      return snapshot();
    },
    send: async (request) => {
      const body = await readJsonBody(request);
      const result = await sendCode(String(body.provider ?? ""), String(body.phone ?? "").trim());
      return { ...result, state: snapshot() };
    },
    verify: async (request) => {
      const body = await readJsonBody(request);
      return verifyCode(String(body.provider ?? ""), String(body.code ?? "").trim());
    },
    run: async (request) => {
      const body = await readJsonBody(request);
      const push = body.push !== false;
      const schedule = loadSchedule();
      const providers = schedule.providers ?? PROVIDERS;
      if (isCheckinRunning()) return { started: false, alreadyRunning: true, push };
      void (async () => {
        const outcome = await runAllCheckinsExclusive(providers);
        if (outcome.skipped) return;
        const report = outcome.report;
        if (!push) return;
        const notify = loadNotify();
        if (!notify.enabled || !notify.appId || !notify.appSecret || !notify.target) return;
        try {
          const result = await sendQqText({ ...notify, text: buildPushText(report) });
          const state = loadSchedule();
          saveSchedule({
            ...state,
            lastPushAt: new Date().toISOString(),
            lastPushOk: result.ok,
            lastPushError: result.ok ? "" : result.errors.join(" | ").slice(0, 200),
          });
        } catch (error) {
          const state = loadSchedule();
          saveSchedule({
            ...state,
            lastPushAt: new Date().toISOString(),
            lastPushOk: false,
            lastPushError: String(error?.message ?? error).slice(0, 200),
          });
        }
      })();
      return { started: true, alreadyRunning: false, push };
    },
  };
  globalThis[HANDLERS_KEY] = handlers;

  // 逐条注册：宿主的 exact 路由只按路径去重，重复的跳过即可，不能一条失败全跳过
  const disposers = [];
  let attempted = 0;
  for (const definition of routeDefinitions()) {
    attempted += 1;
    try {
      disposers.push(webServer.register(definition));
    } catch (error) {
      // 已注册过（例如插件热重载），忽略
    }
  }
  const previous = globalThis[DISPOSERS_KEY] ?? [];
  globalThis[DISPOSERS_KEY] = [...previous, ...disposers];
  globalThis[INSTALLED_KEY] = true;
  return disposers.length;
}


/** 插件停用时摘掉路由。 */
export function uninstallRoutes() {
  const disposers = globalThis[DISPOSERS_KEY] ?? [];
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // ignore
    }
  }
  globalThis[DISPOSERS_KEY] = [];
  globalThis[INSTALLED_KEY] = false;
}
