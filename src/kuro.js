/**
 * 库街区（kurobbs）签到客户端。
 *
 * 只保留 token 路径：游戏签到（鸣潮 gameId=3 / 战双 gameId=2）、社区签到、
 * 库洛币余额。GeeTest 一键登录与短信流程见 kuroLogin.js。
 * 请求头与网页版 H5 保持一致；设备标识来自凭据库。
 */
const API_BASE = "https://api.kurobbs.com";

const ENDPOINTS = {
  userMine: `${API_BASE}/user/mineV2`,
  userSignIn: `${API_BASE}/user/signIn`,
  roleList: `${API_BASE}/gamer/role/list`,
  roleListFallback: `${API_BASE}/user/role/findRoleList`,
  goldTotal: `${API_BASE}/encourage/gold/getTotalGold`,
  gameSignIn: `${API_BASE}/encourage/signIn/v2`,
  gameSignRecord: `${API_BASE}/encourage/signIn/queryRecordV2`,
};

export const GAMES = {
  wuwa: { id: "3", name: "鸣潮", serverId: "7f574e49b1f24c4c915e74bb1dfd4e4d" },
  pgr: { id: "2", name: "战双", serverId: "1000" },
};

const CODE = { success: 200, alreadySigned: 1511, userInfoError: 1513, loginExpired: 220 };
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function h5Headers(cred) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    Host: "api.kurobbs.com",
    Origin: "https://www.kurobbs.com",
    Referer: "https://www.kurobbs.com/",
    "User-Agent": USER_AGENT,
    source: "h5",
    version: "3.0.1",
    devCode: cred.devcode ?? "",
    distinct_id: cred.distinct_id ?? "",
    token: cred.token,
  };
}

/** POST 表单，返回解析后的 JSON；网络/解析失败统一成 {code:-1,...}。 */
async function post(cred, url, data = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) body.set(key, String(value));
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: h5Headers(cred),
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { code: -1, msg: `网络请求失败: ${String(error?.message ?? error)}` };
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: -1, msg: `响应解析失败: HTTP ${response.status}` };
  }
}

function rewardText(entity) {
  return String(entity?.goodsName ?? entity?.name ?? "").trim();
}

async function getUserId(cred) {
  const result = await post(cred, ENDPOINTS.userMine, { size: "10" });
  if (result?.code === CODE.success && result?.data) {
    const mine = result.data?.mine ?? {};
    if (mine.userId) {
      return {
        id: String(mine.userId),
        gold: mine.goldNum,
        userName: String(mine.userName ?? "").trim(),
      };
    }
  }
  return { id: "", gold: undefined, userName: "" };
}

async function getRoleInfo(cred, gameId) {
  for (const endpoint of [ENDPOINTS.roleList, ENDPOINTS.roleListFallback]) {
    const result = await post(cred, endpoint, { gameId });
    const code = result?.code ?? -1;
    if (code === CODE.loginExpired) return { expired: true };
    if (code === CODE.success && result?.data) {
      const data = result.data;
      const roleList = Array.isArray(data) ? data : data?.roleList ?? [];
      if (Array.isArray(roleList) && roleList.length > 0) {
        const role = roleList[0];
        return {
          roleId: String(role?.roleId ?? ""),
          serverId: String(role?.serverId ?? ""),
          roleName: String(role?.roleName ?? ""),
        };
      }
    }
  }
  return {};
}

async function signGame(cred, gameKey, accountUid = "") {
  const game = GAMES[gameKey];
  const role = await getRoleInfo(cred, game.id);
  if (role.expired) return "❌ 登录已过期，请重新绑定 token";
  if (!role.roleId) return `⚠️ ${game.name} 未查询到角色信息，跳过`;

  const result = await post(cred, ENDPOINTS.gameSignIn, {
    gameId: game.id,
    serverId: role.serverId || game.serverId,
    roleId: role.roleId,
    reqMonth: String(new Date().getMonth() + 1).padStart(2, "0"),
  });
  const code = result?.code ?? -1;
  const who = role.roleName ? `${game.name} · ${role.roleName}` : game.name;
  if (code === CODE.success) {
    const reward = await queryReward(cred, game, role);
    return `✅ ${who}（uid=${accountUid}）：签到成功`;
  }
  if (code === CODE.alreadySigned) return `✅ ${who}（uid=${accountUid}）：今天已签到`;
  if (code === CODE.loginExpired) return `❌ ${who}（uid=${accountUid}）：登录已过期`;
  if (code === CODE.userInfoError) return `❌ ${who}（uid=${accountUid}）：用户信息异常`;
  return `❌ ${who}（uid=${accountUid}）：${result?.msg ?? result?.message ?? "未知错误"}`;
}

async function queryReward(cred, game, role) {
  try {
    const result = await post(cred, ENDPOINTS.gameSignRecord, {
      gameId: game.id,
      serverId: role.serverId || game.serverId,
      roleId: role.roleId,
    });
    if (result?.code === CODE.success && Array.isArray(result.data) && result.data.length > 0) {
      return rewardText(result.data[0]);
    }
  } catch {
    // 奖励查询失败不算失败
  }
  return "";
}

async function signForum(cred, accountUid = "") {
  // 2026-11 实测：社区签到接口对 gameId=3 返回 10000 参数错误，gameId=2 可成功
  // （上游文档说该参数"没卵用"，但服务端已经变了）。先 2，再回退 3。
  let result = await post(cred, ENDPOINTS.userSignIn, { gameId: "2" });
  if ((result?.code ?? -1) === 10000) {
    result = await post(cred, ENDPOINTS.userSignIn, { gameId: "3" });
  }
  const code = result?.code ?? -1;
  if (code === CODE.success || result?.success) {
    const days = result?.data?.continueDays;
    return `✅ 社区签到（uid=${accountUid}）：签到成功`;
  }
  if (code === CODE.alreadySigned) return `✅ 社区签到（uid=${accountUid}）：今天已签到`;
  if (code === CODE.loginExpired) return `❌ 社区签到（uid=${accountUid}）：登录已过期`;
  return `❌ 社区签到（uid=${accountUid}）：${result?.msg ?? "未知错误"}`;
}

async function goldBalance(cred) {
  try {
    const result = await post(cred, ENDPOINTS.goldTotal, {});
    const gold = result?.data?.goldNum ?? result?.data?.totalGold;
    if (gold !== undefined && gold !== null) return `💰 库洛币余额：${gold}`;
  } catch {
    // 余额查询失败忽略
  }
  return "";
}

/**
 * 执行一次完整签到。
 * @param {object} cred - 凭据库里 kuro 段（token/devcode/distinct_id）
 * @param {object} [options]
 * @param {boolean} [options.signGames=true] - 是否做游戏签到
 * @param {boolean} [options.signForum=true] - 是否做社区签到
 * @returns {Promise<{ok:boolean, lines:string[], expired:boolean}>}
 */
export async function runKuroCheckin(cred, options = {}) {
  const doGames = options.signGames !== false;
  const doForum = options.signForum !== false;
  const lines = ["【库街区】"];

  if (!cred?.token) {
    lines.push("❌ 未配置库街区 token（~/.dsh/checkin/credentials.json）");
    return { ok: false, lines, expired: false };
  }
  const device = { ...cred, devcode: cred.devcode ?? "", distinct_id: cred.distinct_id ?? "" };

  const user = await getUserId(device);
  if (!user.id) lines.push("⚠️ 获取用户信息失败，token 可能已失效");

  let expired = false;
  if (doGames) {
    for (const key of ["wuwa", "pgr"]) {
      const line = await signGame(device, key, user.id);
      lines.push(line);
      if (line.includes("登录已过期")) {
        expired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!expired && doForum) {
    const line = await signForum(device, user.id);
    lines.push(line);
    if (line.includes("登录已过期")) expired = true;
  }
  if (!expired) {
    const gold = await goldBalance(device);
    if (gold) lines.push(gold);
  }

  const ok = !expired && !lines.some((line) => line.startsWith("❌"));
  return { ok, lines, expired, account: { id: user.id, userName: user.userName } };
}
