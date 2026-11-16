# dsh-workbuddy-connect

WorkBuddy 成长中心（积分活动）的 DSH 工具包：给账号池里的每个账号跑每日签到、五个成长任务、猫猫宠物与旅行。

它与官方 `dsh-connect-workbuddy` **分工不重叠**，但**共用同一个账号池**：

| | `dsh-connect-workbuddy` | 本包 |
| --- | --- | --- |
| 管什么 | 模型侧：池里哪个账号有额度就把请求路由过去 | 成长中心：签到、任务、宠物、旅行 |
| 凭据来源 | 写 vault | **读同一个 vault**，不重复登录流程 |
| 写操作 | 签到（`daily-checkin`） | 签到、接受任务、领任务奖、开宠物、派/收旅行 |

两个包读同一份 `~/.dsh/workbuddy-vault/<region>/<accountId>.json`，账号池只有一个真相来源。装本包**不需要**再登一次账号：`dsh-connect-workbuddy` 已经把 token 写进 vault 了。

## 安装

本包是 **host-only bundle**（没有客户端 UI），`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后会往 profile 的 cordis 配置里插一条 `workbuddy-connect` 条目。

在 DSH 里用 `plugin_manager install_bundle`，`target` 传本目录的绝对路径即可；也可以先把仓库克隆到本地再装：

```powershell
git clone git@github.com:luoxh8/dsh-workbuddy-connect.git
# 然后 plugin_manager install_bundle --target <克隆下来的目录>
```

装完重启 DSH，工具列表里出现三个 `workbuddy_growth_*`。

## 三个工具

### `workbuddy_growth_status`

只读。逐账号回报签到、积分、连续天数、成长等级、能量、宠物、旅行状态与五个任务进度，外加一句「下一步该做什么」。

```
workbuddy_growth_status({ accounts: [] })       // 全部账号
workbuddy_growth_status({ accounts: ["Kris"] }) // 按 id / 昵称 / uid 前缀筛
```

### `workbuddy_growth_run`

跑一遍每日流程，顺序与人在客户端里的操作一致：

1. 签到（今日已签则跳过）
2. 接受所有 `not_accepted` 的任务（依赖宠物的三项会被服务端拒绝，这里如实记下）
3. 领「新手任务」→ 服务端直接赠送第一只猫
4. 可选：补发客户端遥测事件（见 `report` 参数）
5. 领取所有 `completed` 的任务奖励
6. 旅行：`arrived` 就收奖；`traveling` 就报到站时间；`idle` 就派出去
7. 再读一次任务状态收尾

```js
workbuddy_growth_run({ apply: true })                                   // 全账号
workbuddy_growth_run({ apply: true, report: ["share"], locationId: 1 })  // 顺带推技能分享 + 指定咖啡馆
workbuddy_growth_run({ apply: false })                                  // 演练：只回报下一步
```

`apply` 是本包唯一的安全闸：不给 `true` 就一个写请求都不发。

### `workbuddy_growth_report`

成长服务**没有**「标记任务完成」的接口，完成度纯服务端判定。有些任务只能靠客户端遥测事件推动，这个工具就是补发那些事件：

| `kind` | 事件 | 对应任务 | 实效 |
| --- | --- | --- | --- |
| `share` | 技能分享六连（入口点击/详情曝光/渠道动作/deeplink/转换/安全校验） | `skill_share` | ✅ 实测能到 `completed` |
| `chat` | 一次对话七连（点击/发送/请求/响应/状态/完成） | `RichMeow_Chat` | ⚠️ 服务端不认账，进度不动 |
| `library` | 资料库页面曝光 + 阅读完成 | `Library_read` | ⚠️ 服务端不认账，进度不动 |

`sent` 成功只代表**遥测入口收下了**，不代表任务推进 —— 工具会顺手再读一次任务状态，把「已完成」的清单一起回给你，真假一目了然。

## 硬边界与突破方法（实测结论）

成长任务的完成度由**服务端埋点**判定，纯 API 伪造 `/v2/report` 事件对 `RichMeow_Chat` / `Library_read` 一律无效（HTTP 200 但进度恒 0）。经实测，正确做法是**用真实桌面客户端跑一遍动作**：

- **`RichMeow_Chat`**（桌面端对话 1 次）：在登录了目标账号的 WorkBuddy 客户端里真发一条消息即可。
- **`Library_read`**（读完资料库介绍）：在客户端「资料库」里打开 `WorkBuddy资料库介绍.html` 并把 iframe 内的文档滚到底，服务端即置为 `completed`，再调 claim 领 50 分。
- **`skill_share`**：唯一能用本包 `report` 工具纯 API 推动的任务（六连事件，实测到 `completed`）。
- **`wb_wechat_oa_subscribe_task`**（关注公众号满 24 小时）：判定完全在微信侧（openid + 关注时长）。`/v2/activity/growth/subscribe-task/status` 返回 `subscribed:false / advanced:false`，所有 `*claim/*advance/*refresh` 变体接口都不存在；`claim` 直接返回 `task not completed`。**只能真人微信扫码关注「腾讯 WorkBuddy」公众号并等满 24 小时**，同一微信号只能领一次，脚本与客户端自动化都推进不了。

### 用 CDP 驱动客户端完成对话/阅读（可复用的自动化套路）

多开一个隔离的 WorkBuddy 客户端实例，注入目标账号登录态后开 `--remote-debugging-port`，用 CDP 直接读 DOM、点导航、在跨域 iframe 里滚动。要点：

1. 登录文件必须写到 `<sandbox>\home\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info`（客户端按 `os.homedir()` 解析，少一层 `home\` 就会 `noAuthFile`）。
2. 启动前 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（DSH 环境自带这个变量，不删会让 WorkBuddy 当 Node 跑）。
3. 杀旧实例匹配要用宽松模式 `*wbx*$Account*`（反斜杠会被命令行转义）。
4. CDP 读 DOM 用 `Runtime.evaluate`；文档在跨域 iframe 里，要对 iframe 自己的 target 建 WebSocket 才能 `window.scrollTo`。

因此每天能自动拿满的是：签到 100 + 新手任务 300（仅首次）+ 技能分享 50 + 对话 50 + 阅读 50 + 旅行 5~10；公众号那 50 分需真人补一次。

## 配置

```yaml
- id: workbuddy-connect
  name: dsh-workbuddy-connect
  config:
    region: cn          # vault 子目录，默认 cn
    vaultDir: ''        # 直接指定 vault 目录时用；留空走 ~/.dsh/workbuddy-vault/<region>
```

## 开发

```powershell
node test/snapshot.mjs      # 只读：读 vault → 打印每账号状态
node test/tools.mjs         # 假 ctx 注册三个工具 + 用真校验器验 schema
```

模块划分：

- `lib/upstream.js` — vault 读取、token 刷新（写回 vault）、growth/billing/report 三套请求头与调用
- `lib/growth.js` — 成长中心每个端点的封装 + `snapshot()` + `nextStepOf()`
- `lib/actions.js` — 三批遥测事件
- `lib/daily.js` — 一天的动作序列
- `index.js` — 工具定义（`parameters` 是 JSON Schema，不是 spec 形式）

工具名保留 `workbuddy_growth_*` 前缀：它们描述的是「成长中心」这个功能区，与包名 `dsh-workbuddy-connect`（连接 WorkBuddy 账号池）互不冲突。

## 许可

MIT
