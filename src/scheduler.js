/**
 * 插件内置定时器：按 ~/.dsh/checkin/schedule.json 里的时间，每天跑一次三个平台的签到。
 *
 * 设计取舍：
 *   - 用「每 30 秒看一眼」而不是一次性 setTimeout：电脑休眠/系统改时间后不会漂；
 *   - lastRunDate 落盘，插件重启、DSH 重启都不会重复跑同一天；
 *   - 结果写到 report.json，配合 checkin_report 工具按需查询（不主动推 QQ，避免主动消息频控）。
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadVault, saveVault } from "./vault.js";
import { runKuroCheckin } from "./kuro.js";
import { runSklandCheckin } from "./skland.js";
import { nteSignAccount, pickNteAccount } from "./nte.js";
import { sendQqText } from "./qqPush.js";

const DIR = join(homedir(), ".dsh", "checkin");
const SCHEDULE_FILE = join(DIR, "schedule.json");
const REPORT_FILE = join(DIR, "report.json");
const NOTIFY_FILE = join(DIR, "notify.json");
const LOGIN_FILE = join(DIR, "login.json");
const TICK_MS = 30_000;

export const PROVIDER_LABELS = { kuro: "库街区", skland: "森空岛", nte: "塔吉多" };

/** ISO 时间 → 本机时区的可读格式（不显示 T/Z）。 */
export function formatLocal(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const DEFAULT_SCHEDULE = {
  enabled: true,
  time: "22:00",
  providers: ["kuro", "skland", "nte"],
  lastRunDate: "",
};

export function loadSchedule() {
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULE_FILE, "utf8"));
    return { ...DEFAULT_SCHEDULE, ...parsed };
  } catch {
    return { ...DEFAULT_SCHEDULE };
  }
}

export function loadNotify() {
  try {
    return { enabled: false, appId: "", appSecret: "", target: "", ...JSON.parse(readFileSync(NOTIFY_FILE, "utf8")) };
  } catch {
    return { enabled: false, appId: "", appSecret: "", target: "" };
  }
}

export function loadLoginPhones() {
  try {
    return { kuro: "", skland: "", nte: "", ...JSON.parse(readFileSync(LOGIN_FILE, "utf8")) };
  } catch {
    return { kuro: "", skland: "", nte: "" };
  }
}

export function saveLoginPhones(phones) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(LOGIN_FILE, `${JSON.stringify(phones, null, 2)}\n`, "utf8");
}

/**
 * 把插件页设置表单里的值同步到文件（只覆盖页面上确实填过的字段）。
 * @param {object} config - apply() 收到的插件配置
 */
export function syncConfigToFiles(config) {
  if (!config) return;
  let touched = false;

  const schedule = loadSchedule();
  if (typeof config.scheduleEnabled === "boolean" && config.scheduleEnabled !== schedule.enabled) {
    schedule.enabled = config.scheduleEnabled;
    touched = true;
  }
  if (typeof config.scheduleTime === "string") {
    const time = normalizeTime(config.scheduleTime);
    if (time && time !== schedule.time) {
      schedule.time = time;
      touched = true;
    }
  }
  if (Array.isArray(config.scheduleProviders) && config.scheduleProviders.length > 0) {
    const providers = config.scheduleProviders.filter((item) => ["kuro", "skland", "nte"].includes(item));
    if (providers.length > 0 && providers.join(",") !== (schedule.providers ?? []).join(",")) {
      schedule.providers = providers;
      touched = true;
    }
  }
  if (touched) saveSchedule(schedule);

  const notify = loadNotify();
  let notifyTouched = false;
  if (typeof config.pushEnabled === "boolean" && config.pushEnabled !== notify.enabled) {
    notify.enabled = config.pushEnabled;
    notifyTouched = true;
  }
  for (const [field, key] of [["pushTarget", "target"], ["pushAppId", "appId"], ["pushAppSecret", "appSecret"]]) {
    if (typeof config[field] === "string" && config[field].trim() !== "" && config[field] !== notify[key]) {
      notify[key] = config[field].trim();
      notifyTouched = true;
    }
  }
  if (notifyTouched) saveNotify(notify);

  const phones = loadLoginPhones();
  let phoneTouched = false;
  for (const [field, key] of [["kuroPhone", "kuro"], ["sklandPhone", "skland"], ["ntePhone", "nte"]]) {
    if (typeof config[field] === "string" && config[field].trim() !== "" && config[field].trim() !== phones[key]) {
      phones[key] = config[field].trim();
      phoneTouched = true;
    }
  }
  if (phoneTouched) saveLoginPhones(phones);
}
export function saveNotify(notify) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(NOTIFY_FILE, `${JSON.stringify(notify, null, 2)}\n`, "utf8");
}

export function saveSchedule(schedule) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SCHEDULE_FILE, `${JSON.stringify(schedule, null, 2)}\n`, "utf8");
}

/** 下一次运行时间（本地 ISO），用于设置页展示。 */
export function nextRunAt(schedule = loadSchedule()) {
  if (schedule.enabled === false) return "";
  const time = normalizeTime(schedule.time);
  if (!time) return "";
  const [hour, minute] = time.split(":").map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
export function loadReport() {
  try {
    return JSON.parse(readFileSync(REPORT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveReport(report) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

/** 校验 "HH:MM"，返回规范化字符串；不合法返回 null。 */
export function normalizeTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localHHMM(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 依次跑三个平台的签到，返回报告对象。
 * @param {string[]} providers
 */
/**
 * 全局运行锁：定时 tick 与手动运行共用，避免同时刷新塔吉多 token 互相作废。
 *
 * 光有进程内 promise 不够：插件热重载后旧 fiber 的定时器还在跑（内存里同时存在
 * 多个 scheduler），每个模块实例各自持锁，跨实例互不可见 → 22:05 会并发跑好几次。
 * 所以额外落一个文件锁（原子 `wx` 创建），所有实例共享。
 */
let runningPromise = null;
const LOCK_FILE = join(DIR, "run.lock");
const LOCK_TTL_MS = 15 * 60 * 1000;

function tryLockFile() {
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const stat = statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs > LOCK_TTL_MS) {
        unlinkSync(LOCK_FILE);
        return tryLockFile();
      }
    } catch {
      // 锁文件刚好被释放，当成拿到锁再试一次
      return tryLockFile();
    }
    return false;
  }
}

function unlockFile() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

export function isCheckinRunning() {
  if (runningPromise !== null) return true;
  try {
    const stat = statSync(LOCK_FILE);
    return Date.now() - stat.mtimeMs <= LOCK_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * 拿锁执行一次全量签到；已有任务在跑（含其它实例）时返回 { skipped: true }。
 * @param {string[]} providers
 */
export async function runAllCheckinsExclusive(providers) {
  if (runningPromise !== null) return { skipped: true };
  if (!tryLockFile()) return { skipped: true, locked: true };
  runningPromise = runAllCheckins(providers);
  try {
    return { skipped: false, report: await runningPromise };
  } finally {
    runningPromise = null;
    unlockFile();
  }
}
/** 拼出定时推送的正文（测试推送与定时推送共用，保证格式一致）。时间用完整本地时间。 */
export function buildPushText(report) {
  const when = report.atLocal ?? formatLocal(report.at);
  return `【每日签到 ${when}】${report.ok ? "全部完成" : "有失败项"}\n\n${(report.lines ?? []).join("\n")}`;
}
export async function runAllCheckins(providers = ["kuro", "skland", "nte"]) {
  const startedAt = new Date().toISOString();
  const finishedAt = () => new Date().toISOString();
  const lines = [];
  const vault = loadVault();
  if (vault.__error) {
    return { at: startedAt, atLocal: formatLocal(startedAt), ok: false, lines: [`❌ 读取凭据库失败：${vault.__error}`] };
  }

  const runProvider = async (name) => {
    try {
      if (name === "kuro") {
        if (!vault.kuro?.token) return lines.push("【库街区】", "❌ 未配置 token");
        const result = await runKuroCheckin(vault.kuro, {
          signGames: vault.kuro.signGames !== false,
          signForum: vault.kuro.signForum !== false,
        });
        lines.push(...result.lines);
        if (result.account?.id || result.account?.userName) {
          vault.kuro = { ...vault.kuro, userId: result.account.id, userName: result.account.userName };
          saveVault(vault);
        }
      } else if (name === "skland") {
        if (!vault.skland?.token) return lines.push("【森空岛】", "❌ 未配置 token");
        const result = await runSklandCheckin(vault.skland.token);
        lines.push(...result.lines);
        if (result.nickname) {
          vault.skland = { ...vault.skland, nickName: result.nickname, uid: result.accountUid, gameUids: result.gameUids };
          saveVault(vault);
        }
      } else if (name === "nte") {
        const account = pickNteAccount(vault.nte);
        if (!account) return lines.push("【塔吉多】", "❌ 还没有绑定账号");
        lines.push("【塔吉多】");
        try {
          lines.push(...(await nteSignAccount(account)));
        } finally {
          // refreshToken 每次刷新都会轮换，必须立刻落盘，否则下一次用旧的就失效
          vault.nte = { ...vault.nte, ...account, enabled: true };
          delete vault.nte.accounts;
          saveVault(vault);
        }
      }
    } catch (error) {
      lines.push(`❌ ${String(error?.message ?? error)}`);
    }
  };

  for (let index = 0; index < providers.length; index += 1) {
    if (index > 0) lines.push("");
    await runProvider(providers[index]);
  }

  const ok = !lines.some((line) => line.startsWith("❌"));
  const report = { at: startedAt, atLocal: formatLocal(startedAt), ok, lines };
  saveReport(report);
  try {
    mkdirSync(join(homedir(), ".dsh", "logs"), { recursive: true });
    appendFileSync(join(homedir(), ".dsh", "logs", "dsh-checkin.log"), `${startedAt} scheduled-run\n${lines.join("\n")}\n`, "utf8");
  } catch {
    // 日志失败不影响签到
  }
  return report;
}

/**
 * 启动内置定时器。返回一个停止函数。
 * @param {(report: object) => void} [onReport]
 */
export function startScheduler(onReport) {
  let running = false;
  let disposed = false;

  const tick = async () => {
    if (disposed || running) return;
    const schedule = loadSchedule();
    if (!schedule.enabled) return;
    const time = normalizeTime(schedule.time);
    if (!time) return;
    const now = new Date();
    if (todayKey(now) === schedule.lastRunDate) return;
    if (localHHMM(now) < time) return;

    running = true;
    try {
      const outcome = await runAllCheckinsExclusive(schedule.providers ?? DEFAULT_SCHEDULE.providers);
      if (outcome.skipped) {
        // 手动运行正在进行：它负责推送，这里只记今天已处理，避免 30 秒后重复跑
        saveSchedule({ ...schedule, lastRunDate: todayKey(now) });
        return;
      }
      const report = outcome.report;
      const updated = { ...schedule, lastRunDate: todayKey(now), lastRunAt: report.at };

      // 主动推送：失败只记日志，不影响签到结果
      const notify = loadNotify();
      if (notify.enabled && notify.appId && notify.appSecret && notify.target) {
        const text = buildPushText(report);
        try {
          const result = await sendQqText({ ...notify, text });
          updated.lastPushAt = new Date().toISOString();
          updated.lastPushOk = result.ok;
          updated.lastPushError = result.ok ? "" : result.errors.join(" | ").slice(0, 200);
        } catch (error) {
          updated.lastPushAt = new Date().toISOString();
          updated.lastPushOk = false;
          updated.lastPushError = String(error?.message ?? error).slice(0, 200);
        }
      }
      saveSchedule(updated);
      onReport?.(report);
    } catch (error) {
      onReport?.({ at: new Date().toISOString(), ok: false, lines: [`❌ 定时签到异常：${String(error?.message ?? error)}`] });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // 启动时先看一眼：如果今天已过点且还没跑过，补跑
  void tick();

  return () => {
    disposed = true;
    clearInterval(timer);
  };
}

export { SCHEDULE_FILE, REPORT_FILE, DEFAULT_SCHEDULE };
