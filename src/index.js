/**
 * dsh-checkin —— 三个平台的每日签到工具（库街区 / 森空岛 / 塔吉多）。
 *
 * 设计：
 *   - 凭据统一放在 ~/.dsh/checkin/credentials.json（不进会话、不进记忆）；
 *   - 每个平台一个工具（checkin_kuro / checkin_skland / checkin_nte）；
 *   - 定时由内置 scheduler.js 负责（30 秒轮询 + lastRunDate 落盘，不依赖 dsh-cron）；
 *   - 不做多用户管理：DSH 侧由 QQ 机器人白名单负责。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecret, loadVault, saveVault, VAULT_DIR, VAULT_FILE } from "./vault.js";
import { runKuroCheckin } from "./kuro.js";
import { runSklandCheckin, validateSklandToken } from "./skland.js";
import { sendSklandCode, exchangeSklandToken } from "./sklandLogin.js";
import { startScheduler, loadSchedule, saveSchedule, loadReport, runAllCheckins, normalizeTime, loadNotify, saveNotify, loadLoginPhones, syncConfigToFiles, formatLocal, buildPushText, PROVIDER_LABELS, SCHEDULE_FILE } from "./scheduler.js";
import { sendQqText } from "./qqPush.js";
import { nteSendCode, nteVerifyLogin, nteSignAccount, pickNteAccount } from "./nte.js";
import { kuroSendSms, kuroLogin } from "./kuroLogin.js";
import { installRoutes, uninstallRoutes } from "./webRoutes.js";

export const name = "dsh-daily-checkin";
export const inject = ["tools"];
export { Config } from "./config.js";

const LOG_DIR = join(homedir(), ".dsh", "logs");
const LOG_FILE = join(LOG_DIR, "dsh-checkin.log");
const PENDING_NTE = join(VAULT_DIR, "pending-nte.json");
const PENDING_KURO = join(VAULT_DIR, "pending-kuro.json");
const PENDING_SKLAND = join(VAULT_DIR, "pending-skland.json");
const PENDING_TTL_MS = 5 * 60 * 1000;

function readPendingJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writePendingJson(path, value) {
  mkdirSync(VAULT_DIR, { recursive: true });
  if (value === null) {
    try {
      writeFileSync(path, "{}\n", "utf8");
    } catch {
      // ignore
    }
    return;
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const readPendingNte = () => readPendingJson(PENDING_NTE);
const writePendingNte = (value) => writePendingJson(PENDING_NTE, value);
const readPendingKuro = () => readPendingJson(PENDING_KURO);
const writePendingKuro = (value) => writePendingJson(PENDING_KURO, value);
const readPendingSkland = () => readPendingJson(PENDING_SKLAND);
const writePendingSkland = (value) => writePendingJson(PENDING_SKLAND, value);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // 日志失败不影响签到
  }
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  if (!enabled) return;
  // 插件页设置 → 文件（只同步页面上确实填过的字段）
  syncConfigToFiles(config);

  ctx.inject(["tools"], async (toolsCtx) => {
    let defineTool = null;
    try {
      ({ defineTool } = await import("@deepseek-ai/dsh-tools"));
    } catch {
      defineTool = null;
    }
    const register = (spec) => {
      const tool = defineTool ? defineTool(spec) : spec;
      toolsCtx.tools.register(tool);
    };

    register({
      name: "checkin_kuro",
      description:
        "执行库街区每日签到（鸣潮/战双游戏签到 + 社区签到 + 库洛币余额）。凭据取自 ~/.dsh/checkin/credentials.json 的 kuro 段，无需传参。",
      parameters: {
        type: "object",
        properties: {
          games: { type: "boolean", description: "是否做游戏签到（默认 true）" },
          forum: { type: "boolean", description: "是否做社区签到（默认 true）" },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) =>
          value?.ok
            ? [{ type: "text", text: (value.lines ?? []).join("\n") }]
            : [{ type: "text", text: (value?.lines ?? []).join("\n") || "库街区签到失败" }],
      },
      async execute(args = {}) {
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        const cred = vault.kuro;
        if (!cred?.token) throw new Error("凭据库里没有 kuro.token");
        const result = await runKuroCheckin(cred, {
          signGames: args.games !== false && cred.signGames !== false,
          signForum: args.forum !== false && cred.signForum !== false,
        });
        if (result.account?.id || result.account?.userName) {
          vault.kuro = { ...vault.kuro, userId: result.account.id, userName: result.account.userName };
          saveVault(vault);
        }
        log(`kuro checkin ok=${result.ok} expired=${result.expired} lines=${result.lines.length}`);
        return { ok: result.ok, expired: result.expired, lines: result.lines, account: result.account };
      },
    });

    register({
      name: "checkin_skland",
      description:
        "执行森空岛每日签到（明日方舟 + 终末地）。凭据取自 ~/.dsh/checkin/credentials.json 的 skland 段，无需传参。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") || "森空岛签到失败" }],
      },
      async execute() {
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        const cred = vault.skland;
        if (!cred?.token) throw new Error("凭据库里没有 skland.token");
        const result = await runSklandCheckin(cred.token);
        log(`skland checkin ok=${result.ok} expired=${result.expired} lines=${result.lines.length}`);
        return { ok: result.ok, expired: result.expired, nickname: result.nickname, lines: result.lines };
      },
    });

    register({
      name: "checkin_skland_login_start",
      description:
        "森空岛（skyland）内置登录第一步：通过鹰角网络通行证给手机号发送短信验证码（5 分钟内有效）。之后用 checkin_skland_login_verify 换取 user_token。",
      parameters: {
        type: "object",
        properties: { phone: { type: "string", description: "11 位手机号；省略则用插件设置里的默认手机号" } },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const phone = String(args.phone ?? "").trim() || loadLoginPhones().kuro;
        if (!phone) throw new Error("没有手机号：请传 phone，或在插件设置里填「库街区登录手机号」");
        if (!/^\d{11}$/.test(phone)) throw new Error("手机号格式不正确（需要 11 位数字）");
        const previous = readPendingSkland();
        const now = Date.now();
        if (previous && previous.phone === phone && now - previous.sentAt < 60_000) {
          const wait = Math.ceil((60_000 - (now - previous.sentAt)) / 1000);
          return { lines: [`⏳ 刚发过验证码，请 ${wait} 秒后再试`] };
        }
        const today = new Date().toISOString().slice(0, 10);
        const sentToday = previous?.date === today ? (previous.sentToday ?? 0) : 0;
        if (sentToday >= 10) return { lines: ["❌ 今天该手机号已达 10 次验证码上限，明天再试"] };

        await sendSklandCode(phone);
        writePendingSkland({ phone, sentAt: now, date: today, sentToday: sentToday + 1 });
        log(`skland send sms phone=${phone.slice(0, 3)}****`);
        return {
          lines: [
            `📱 鹰角验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}`,
            "把验证码发给我，用 checkin_skland_login_verify 换 token（5 分钟内有效）。",
          ],
        };
      },
    });

    register({
      name: "checkin_skland_login_verify",
      description:
        "森空岛内置登录第二步：提交鹰角短信验证码换取 user_token，校验后写入凭据库。之后 checkin_skland 直接用新 token。",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "短信验证码" } },
        required: ["code"],
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const code = String(args.code ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式不正确");
        const pending = readPendingSkland();
        if (!pending?.phone) return { lines: ["❌ 没有待验证的登录，请先调用 checkin_skland_login_start(phone)"] };
        if (Date.now() - pending.sentAt > PENDING_TTL_MS) {
          writePendingSkland(null);
          return { lines: ["❌ 验证码已过期（5 分钟），请重新发送"] };
        }

        const result = await exchangeSklandToken(pending.phone, code);
        const valid = await validateSklandToken(result.token);
        if (!valid) {
          return { lines: ["❌ token 换到了但校验失败（可能账号未绑定森空岛），未写入凭据库"] };
        }
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        vault.skland = { ...(vault.skland ?? {}), token: result.token, uid: result.uid, loginAt: new Date().toISOString() };
        saveVault(vault);
        writePendingSkland(null);
        log(`skland login ok uid=${result.uid}`);
        return {
          lines: [
            `✅ 森空岛登录成功${result.uid ? `（uid=${result.uid}）` : ""}`,
            "token 已写入凭据库，checkin_skland 现在用这个新 token。",
          ],
        };
      },
    });

    register({
      name: "checkin_kuro_login_start",
      description:
        "库街区短信登录第一步：自动求解 GeeTest 滑块验证码并给指定手机号发送短信验证码（5 分钟内有效）。之后用 checkin_kuro_login_verify 提交验证码换取 user_token。",
      parameters: {
        type: "object",
        properties: { phone: { type: "string", description: "11 位手机号；省略则用插件设置里的默认手机号" } },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const phone = String(args.phone ?? "").trim() || loadLoginPhones().kuro;
        if (!phone) throw new Error("没有手机号：请传 phone，或在插件设置里填「库街区登录手机号」");
        if (!/^\d{11}$/.test(phone)) throw new Error("手机号格式不正确（需要 11 位数字）");
        const previous = readPendingKuro();
        const now = Date.now();
        if (previous && previous.phone === phone && now - previous.sentAt < 60_000) {
          const wait = Math.ceil((60_000 - (now - previous.sentAt)) / 1000);
          return { lines: [`⏳ 刚发过验证码，请 ${wait} 秒后再试（或用上一条验证码直接 checkin_kuro_login_verify）`] };
        }
        const today = new Date().toISOString().slice(0, 10);
        const sentToday = previous?.date === today ? (previous.sentToday ?? 0) : 0;
        if (sentToday >= 10) return { lines: ["❌ 今天该手机号已达 10 次验证码上限，明天再试"] };

        await kuroSendSms(phone);
        writePendingKuro({ phone, sentAt: now, date: today, sentToday: sentToday + 1 });
        log(`kuro send sms phone=${phone.slice(0, 3)}****`);
        return {
          lines: [
            `📱 验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}（滑块已自动通过）`,
            "把收到的验证码发给我，用 checkin_kuro_login_verify 完成登录（5 分钟内有效）。",
          ],
        };
      },
    });

    register({
      name: "checkin_kuro_login_verify",
      description:
        "库街区短信登录第二步：提交收到的验证码完成登录，把 user_token 写入凭据库。之后 checkin_kuro 会使用新 token。",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "短信验证码" } },
        required: ["code"],
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const code = String(args.code ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式不正确");
        const pending = readPendingKuro();
        if (!pending?.phone) return { lines: ["❌ 没有待验证的登录，请先调用 checkin_kuro_login_start(phone)"] };
        if (Date.now() - pending.sentAt > PENDING_TTL_MS) {
          writePendingKuro(null);
          return { lines: ["❌ 验证码已过期（5 分钟），请重新发送"] };
        }

        const result = await kuroLogin(pending.phone, code);
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        vault.kuro = {
          ...(vault.kuro ?? { enabled: true, signGames: true, signForum: true }),
          token: result.token,
          devcode: result.devcode,
          distinct_id: result.distinct_id,
          userId: result.userId,
          loginAt: new Date().toISOString(),
        };
        saveVault(vault);
        writePendingKuro(null);
        log(`kuro login ok userId=${result.userId}`);
        return {
          lines: [
            `✅ 库街区登录成功（userId=${result.userId}${result.nickname ? `，${result.nickname}` : ""}）`,
            "token 已写入凭据库，checkin_kuro 现在会用这个新 token 签到。",
          ],
        };
      },
    });

    register({
      name: "checkin_nte_start",
      description:
        "异环（NTE）短信登录第一步：给指定手机号发送短信验证码，并登记一次待验证登录（5 分钟内有效）。之后用 checkin_nte_verify 提交验证码。",
      parameters: {
        type: "object",
        properties: { phone: { type: "string", description: "11 位手机号；省略则用插件设置里的默认手机号" } },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const phone = String(args.phone ?? "").trim() || loadLoginPhones().kuro;
        if (!phone) throw new Error("没有手机号：请传 phone，或在插件设置里填「库街区登录手机号」");
        if (!/^\d{11}$/.test(phone)) throw new Error("手机号格式不正确（需要 11 位数字）");
        const previous = readPendingNte();
        const now = Date.now();
        if (previous && previous.phone === phone && now - previous.sentAt < 60_000) {
          const wait = Math.ceil((60_000 - (now - previous.sentAt)) / 1000);
          return { lines: [`⏳ 刚发过验证码，请 ${wait} 秒后再试（也可直接用上一条验证码 + checkin_nte_verify）`] };
        }
        const today = new Date().toISOString().slice(0, 10);
        const sentToday = previous?.date === today ? (previous.sentToday ?? 0) : 0;
        if (sentToday >= 10) return { lines: ["❌ 今天该手机号已达 10 次验证码上限，明天再试"] };

        const deviceId = await nteSendCode(phone);
        writePendingNte({ phone, deviceId, sentAt: now, date: today, sentToday: sentToday + 1 });
        log(`nte send code phone=${phone.slice(0, 3)}****`);
        return {
          lines: [
            `📱 验证码已发送到 ${phone.slice(0, 3)}****${phone.slice(-4)}`,
            "把收到的验证码发给机器人，我会用 checkin_nte_verify 完成登录（5 分钟内有效）。",
          ],
        };
      },
    });

    register({
      name: "checkin_nte_verify",
      description:
        "异环（NTE）短信登录第二步：提交收到的验证码完成登录，并把 refreshToken 写入凭据库。之后用 checkin_nte_sign 执行签到。",
      parameters: {
        type: "object",
        properties: { code: { type: "string", description: "短信验证码" } },
        required: ["code"],
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const code = String(args.code ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) throw new Error("验证码格式不正确");
        const pending = readPendingNte();
        if (!pending?.phone || !pending?.deviceId) return { lines: ["❌ 没有待验证的登录，请先调用 checkin_nte_start(phone)"] };
        if (Date.now() - pending.sentAt > PENDING_TTL_MS) {
          writePendingNte(null);
          return { lines: ["❌ 验证码已过期（5 分钟），请重新发送"] };
        }

        const account = await nteVerifyLogin(pending.phone, code, pending.deviceId);
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        vault.nte = {
          ...(vault.nte ?? {}),
          ...account,
          enabled: true,
          boundAt: new Date().toISOString(),
        };
        delete vault.nte.accounts;
        saveVault(vault);
        writePendingNte(null);
        log(`nte login ok uid=${account.uid} roles=${account.roleIds.length}`);
        return {
          lines: [
            `✅ 塔吉多登录成功（uid=${account.uid}，手机 ${account.phoneMasked}）`,
            `账号已绑定；角色 ${account.roleIds.length} 个。`,
            "现在可以调用 checkin_nte_sign 执行签到。",
          ],
        };
      },
    });

    register({
      name: "checkin_nte_sign",
      description: "对凭据库里已登录的异环账号执行签到（社区 + 游戏角色）。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute() {
        const vault = loadVault();
        if (vault.__error) throw new Error(`读取凭据库失败: ${vault.__error}`);
        const account = pickNteAccount(vault.nte);
        if (!account) return { lines: ["❌ 还没有绑定塔吉多账号，请先 checkin_nte_start + checkin_nte_verify"] };
        const lines = ["【塔吉多】"];
        let failed = false;
        try {
          for (const line of await nteSignAccount(account)) {
            lines.push(line);
            if (line.startsWith("❌")) failed = true;
          }
        } catch (error) {
          failed = true;
          lines.push(`❌ ${String(error?.message ?? error)}`);
        }
        vault.nte = { ...vault.nte, ...account, enabled: true };
        delete vault.nte.accounts;
        saveVault(vault);
        log(`nte checkin ok=${!failed} uid=${account.uid}`);
        return { ok: !failed, lines };
      },
    });

    register({
      name: "checkin_status",
      description:
        "查看签到凭据配置状态（只显示脱敏摘要，不返回明文 token）：哪些平台已配置、是否启用。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute() {
        const vault = loadVault();
        const lines = [`凭据库：${VAULT_FILE}`];
        if (vault.__error) {
          lines.push(`❌ 读取失败：${vault.__error}`);
          return { lines };
        }
        for (const provider of ["kuro", "skland", "nte"]) {
          const entry = vault[provider];
          if (!entry) {
            lines.push(`${PROVIDER_LABELS[provider] ?? provider}: (未配置)`);
            continue;
          }
          const status = entry.enabled === false ? "已禁用" : "已启用";
          const label = PROVIDER_LABELS[provider] ?? provider;
          if (provider === "nte") {
            const account = pickNteAccount(entry);
            if (!account) {
              lines.push(`${label}: ${status}  未绑定账号`);
            } else {
              lines.push(`${label}: ${status}  账号 uid=${account.uid} 角色=${(account.roleIds ?? []).length}`);
            }
            continue;
          }
          const who =
            provider === "skland"
              ? (entry.uid ? `  账号 uid=${entry.uid}` : "")
              : entry.userId
                ? `  账号 uid=${entry.userId}`
                : "";
          lines.push(`${label}: ${status}  token=${maskSecret(entry.token ?? "")}${who}`);
        }
        return { lines };
      },
    });

    register({
      name: "checkin_schedule_get",
      description: "查看插件内置定时签到设置（时间、是否启用、参与平台、上次运行日期）以及最近一次报告的时间。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute() {
        const schedule = loadSchedule();
        const report = loadReport();
        const notify = loadNotify();
        const lines = [
          `定时签到：${schedule.enabled ? "已启用" : "已停用"}`,
          `每天 ${schedule.time}（本机时区）`,
          `参与平台：${(schedule.providers ?? []).map((id) => PROVIDER_LABELS[id] ?? id).join("、") || "(无)"}`,
          `上次自动运行：${schedule.lastRunDate || "还没有"}`,
          `最近报告：${report ? (report.atLocal ?? formatLocal(report.at)) : "还没有"}`,
          `QQ 主动推送：${notify.enabled ? `已启用（${notify.target}）` : "未启用"}`,
          schedule.lastPushAt ? `上次推送：${formatLocal(schedule.lastPushAt)}（${schedule.lastPushOk ? "成功" : `失败：${schedule.lastPushError ?? ""}`}）` : "上次推送：还没有",
          `配置文件：${SCHEDULE_FILE}`,
        ];
        return { lines, schedule, reportAt: report?.at ?? null };
      },
    });

    register({
      name: "checkin_schedule_set",
      description:
        "修改插件内置定时签到：时间（HH:MM，本机时区）、是否启用、参与平台（kuro/skland/nte 的任意组合）。立即生效，不需要重启。",
      parameters: {
        type: "object",
        properties: {
          time: { type: "string", description: "每天运行时间，格式 HH:MM，例如 22:00" },
          enabled: { type: "boolean", description: "是否启用定时签到" },
          providers: {
            type: "array",
            items: { type: "string", enum: ["kuro", "skland", "nte"] },
            description: "参与平台",
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const current = loadSchedule();
        const next = { ...current };
        if (args.time !== undefined) {
          const normalized = normalizeTime(args.time);
          if (!normalized) throw new Error("时间格式不对，需要 HH:MM（例如 22:00）");
          next.time = normalized;
        }
        if (args.enabled !== undefined) next.enabled = Boolean(args.enabled);
        if (Array.isArray(args.providers) && args.providers.length > 0) next.providers = args.providers;
        saveSchedule(next);
        log(`schedule set time=${next.time} enabled=${next.enabled} providers=${(next.providers ?? []).join(",")}`);
        return {
          lines: [
            `✅ 已更新：${next.enabled ? "启用" : "停用"}，每天 ${next.time}，平台 ${(next.providers ?? []).join("、")}`,
            "下一次到点会自动运行（最多 30 秒误差）。",
          ],
          schedule: next,
        };
      },
    });

    register({
      name: "checkin_report",
      description: "读取最近一次定时签到（或手动全量签到）的报告内容。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute() {
        const report = loadReport();
        if (!report) return { lines: ["还没有签到报告。可以让定时任务到点跑，或调用 checkin_all 立即跑一次。"] };
        return {
          lines: [`报告时间：${report.atLocal ?? formatLocal(report.at)}（${report.ok ? "全部成功" : "有失败项"}）`, ...(report.lines ?? [])],
          report,
        };
      },
    });

    register({
      name: "checkin_push_test",
      description: "用插件的 QQ 推送通道发一条测试消息（默认发到 notify.json 配置的会话），用来验证主动消息是否可用。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "可选的测试文本" } },
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute(args = {}) {
        const notify = loadNotify();
        if (!notify.enabled) throw new Error("QQ 主动推送未启用（notify.json）");
        const report = loadReport();
        const fallback = report
          ? buildPushText(report)
          : `【签到插件】推送通道测试 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
        const text = String(args.text ?? "").trim() || fallback;
        const result = await sendQqText({ ...notify, text });
        const schedule = loadSchedule();
        saveSchedule({
          ...schedule,
          lastPushAt: new Date().toISOString(),
          lastPushOk: result.ok,
          lastPushError: result.ok ? "" : result.errors.join(" | ").slice(0, 200),
        });
        log(`push test ok=${result.ok} sent=${result.sent} errors=${result.errors.join("|").slice(0, 120)}`);
        return {
          ok: result.ok,
          lines: result.ok ? [`✅ 已发送 ${result.sent} 条到 ${notify.target}`] : [`❌ 发送失败：${result.errors.join(" | ")}`],
        };
      },
    });
    register({
      name: "checkin_all",
      description: "立即依次执行三个平台的签到（与定时任务同一套逻辑），并写一份报告供 checkin_report 读取。",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: (value?.lines ?? []).join("\n") }],
      },
      async execute() {
        const report = await runAllCheckins(loadSchedule().providers ?? ["kuro", "skland", "nte"]);
        log(`manual run-all ok=${report.ok}`);
        return { ok: report.ok, lines: report.lines, at: report.at };
      },
    });

    // 插件详情页设置面板的后端路由（只注册一次，重载时替换处理函数）
    ctx.inject(["webServer"], (webCtx) => {
      try {
        const count = installRoutes(webCtx.webServer);
        log(`web routes ready (new registrations: ${count})`);
      } catch (error) {
        log(`web routes failed: ${String(error?.message ?? error)}`);
      }
      const cleanup = () => {
        try {
          uninstallRoutes();
        } catch {
          // ignore
        }
      };
      if (typeof webCtx.effect === "function") webCtx.effect(() => cleanup, "dsh-checkin: web routes");
      else if (typeof ctx.on === "function") ctx.on("dispose", cleanup);
    });

    log(`registered checkin tools (defineTool=${Boolean(defineTool)})`);

    // 内置定时器：每 30 秒看一眼是否到点
    const stopScheduler = startScheduler((report) => {
      log(`scheduled run ok=${report.ok} lines=${report.lines?.length ?? 0}`);
      try {
        appendFileSync(LOG_FILE, `${new Date().toISOString()} scheduled-report ${JSON.stringify(report).slice(0, 500)}\n`, "utf8");
      } catch {
        // ignore
      }
    });
    if (typeof ctx.on === "function") ctx.on("dispose", () => stopScheduler());
  });
}
