# dsh-checkin 开发笔记

> 面向改代码的人，不是用户文档。用户文档见仓库根目录 `README.md`。

## 结构

三个平台各一个客户端模块（`kuro.js` / `skland.js` / `nte.js`），登录单独放（`kuroLogin.js`、`sklandLogin.js`、`nte.js` 的短信登录），`scheduler.js` 管定时与推送，`index.js` 注册工具并接线，`webRoutes.js` 提供设置页用的 HTTP 路由。
凭据放在 `~/.dsh/checkin/credentials.json`，不经过 profile 配置，也不进会话历史。

## 工具

| 工具 | 作用 |
|---|---|
| `checkin_kuro` | 库街区签到：鸣潮 / 战双游戏签到 + 社区签到 + 库洛币余额 |
| `checkin_skland` | 森空岛签到：明日方舟 + 终末地 |
| `checkin_nte_sign` | 异环签到：社区 + 游戏角色 |
| `checkin_kuro_login_start(phone)` | 库街区短信登录第一步：自动过 GeeTest 滑块并发短信 |
| `checkin_kuro_login_verify(code)` | 库街区短信登录第二步：换 `user_token` 写库 |
| `checkin_skland_login_start(phone)` | 森空岛内置登录第一步：鹰角通行证发验证码 |
| `checkin_skland_login_verify(code)` | 森空岛内置登录第二步：换 `user_token` 写库 |
| `checkin_nte_start(phone)` | 异环短信登录第一步：发短信验证码 |
| `checkin_nte_verify(code)` | 异环短信登录第二步：换 `refreshToken` 写库 |
| `checkin_status` | 查看凭据状态（脱敏，不返回明文） |
| `checkin_schedule_get` / `checkin_schedule_set` | 查看 / 修改内置定时（HH:MM、开关、参与平台） |
| `checkin_report` | 读最近一次运行的报告 |
| `checkin_push_test` | 用推送通道发一条测试消息 |
| `checkin_all` | 立即按定时任务同一套逻辑全量跑一次 |

浏览器端面板在 `client/client.js`，注册进 `settings.section` 槽（DSH 设置侧边栏）；数据走 `/api/dsh-checkin/v4/*`（见 `src/webRoutes.js`）。

## 登录流程（都在插件里，不需要本地脚本）

**库街区**：`checkin_kuro_login_start(手机号)` → 手机收到短信 → `checkin_kuro_login_verify(验证码)`。
滑块由 `src/png.js` + `src/slide.js` + `src/geetest.js` 自动求解。

**森空岛**：`checkin_skland_login_start(手机号)` → `checkin_skland_login_verify(验证码)`，走鹰角通行证换 token，省掉手动从网页里抠 token。
发码接口是 `as.hypergryph.com/general/v1/send_phone_code`，如果返回 `status=1` 表示触发人机验证，本插件不做兜底。

**异环**：`checkin_nte_start(手机号)` → `checkin_nte_verify(验证码)`。
拿到 `refreshToken` 后，每次签到先用它换 `accessToken`。

验证码 5 分钟有效；同号码 60 秒冷却；每号码每天最多 10 次。

## 凭据库字段

```json
{
  "version": 1,
  "kuro":    { "token": "...", "devcode": "...", "distinct_id": "...", "signGames": true, "signForum": true },
  "skland":  { "token": "..." },
  "nte":     { "accounts": [ { "refreshToken": "...", "uid": "...", "deviceId": "...", "gameId": "1289", "roleIds": [] } ] }
}
```

## 刻意没做的部分

- kuro：论坛每日任务（浏览/点赞/分享）——收益低、请求多，默认不做；
- nte：密码登录、云异环登录与每日时长领取；
- 多用户 / 白名单：DSH 侧由 QQ 机器人白名单负责，插件不做。

## 实现踩过的坑（改代码前先看）

1. **DSH 宿主是 Electron/BoringSSL，DES 和 3DES 都被禁用**（`Unknown cipher`）。森空岛的设备指纹因此改用 `src/des.js` 纯 JS 实现。
2. **GeeTest 的 AES-CBC IV 是 ASCII 的 16 个 `'0'`（0x30）**，不是 16 个零字节。错误只影响首块，服务端报 `-50002 param decrypt error`。
3. **GeeTest 拒绝 OpenSSL 生成的 PKCS#1 RSA 密文**：同样的 JSON、同样的 uid，AES 部分逐字节相同，`node:crypto` 的 `publicEncrypt` 就是过不了。最终用手写 PKCS#1 v1.5 + BigInt 模幂解决。
4. 库街区社区签到 `/user/signIn` 现在要传 `gameId=2`（传 3 返回 `10000 参数错误`），代码里先 2 后 3 回退。

## 定时（插件内置，不依赖 dsh-cron）

- 配置在 `~/.dsh/checkin/schedule.json`：`{ enabled, time: "HH:MM", providers: [...], lastRunDate }`；
- 插件启动后每 30 秒检查一次，到点且今天没跑过就执行；
- `lastRunDate` 落盘，DSH/插件重启都不会重复跑同一天；电脑休眠醒来也能补跑；
- 报告写到 `~/.dsh/checkin/report.json`，用 `checkin_report` 查询；
- 默认每天 22:05、三平台全跑；跑完主动把结果推到 QQ（`notify.json`）。
- 时间跟随**本机系统时区**（用 `Date` 取本地时分，不写死任何时区）；系统时区变了它跟着变。
- 推送走 QQ 官方机器人 HTTP API（`bots.qq.com/app/getAppAccessToken` → `api.bot.qq.com/v2/users/{openid}/messages`），
  凭据在 `~/.dsh/checkin/notify.json`：`{ enabled, appId, appSecret, target }`。
- 推送失败不重试、不影响签到，会把 `lastPushOk=false` 和错误摘要写进 `schedule.json`，`checkin_schedule_get` 能看到。

改时间：`checkin_schedule_set(time="21:30")`；加平台/停用同理。

注意：异环的 `refreshToken` 每次刷新都会轮换，跑完必须立即写回凭据库（`scheduler.js` 的 nte 分支有 `finally { saveVault }`）。漏掉这一步，下一次就会报「refreshToken 已失效」。
