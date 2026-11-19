/**
 * 插件页「设置」表单的字段声明。
 *
 * 只有标了 .volatile() 的字段才会出现在设置页；这里所有字段都是 volatile，
 * 改完保存后会写回 profile 的 cordis patch，插件重载时 apply() 再把值同步进
 * ~/.dsh/checkin/{schedule,notify,login}.json。
 *
 * 不给默认值：未在页面上填过的字段保持 undefined，避免覆盖已有的 JSON 配置。
 */
import Schema from "@deepseek-ai/schemastery";

export const Config = Schema.object({
  scheduleEnabled: Schema.boolean().description("启用每日定时签到").volatile(),
  scheduleTime: Schema.string().description("定时时间（HH:MM，本机时区，例如 22:05）").volatile(),
  scheduleProviders: Schema.array(Schema.union(["kuro", "skland", "nte"]))
    .description("参与定时签到的平台")
    .volatile(),

  pushEnabled: Schema.boolean().description("签到完成后主动推送到 QQ").volatile(),
  pushTarget: Schema.string().description("推送目标（c2c:<openid> 或 group:<openid>）").volatile(),
  pushAppId: Schema.string().description("推送机器人 AppID").volatile(),
  pushAppSecret: Schema.string().role("secret").description("推送机器人 AppSecret").volatile(),

  kuroPhone: Schema.string().description("库街区登录手机号（登录时留空则用这里）").volatile(),
  sklandPhone: Schema.string().description("森空岛（鹰角通行证）登录手机号").volatile(),
  ntePhone: Schema.string().description("塔吉多（异环）登录手机号").volatile(),
});
