# dsh-balance-lite

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）桌面端 / Web 端提供的**实时余额插件**。

在侧边栏底部常驻一个余额徽标，点击查看充值余额、赠送余额、数据来源与更新时间，每 60 秒自动刷新。

> 直接调用 dsh 自带的账号服务取数，不依赖第三方余额插件，也没有版本豁免。

## 功能

- 侧边栏底部余额徽标：`余额 ¥0.00`
- 点击展开明细面板：充值余额 / 赠送余额 / 来源 / 更新时间
- 每 60 秒自动刷新，面板内可手动强制刷新
- 同时显示 **OpenCode Go 套餐用量**：5 小时 / 本周 / 本月剩余百分比与重置时间（读取 `OPENCODE_API_KEY`，调用官方 `GET https://opencode.ai/zen/go/v1/usage`）
- 双取数通道：
  1. **DeepSeek 账号**（`ctx.deepseekAccount.getBalance`）——桌面端登录后自动可用
  2. **API Key**（`DEEPSEEK_API_KEY`）——回退调用官方 `GET https://api.deepseek.com/user/balance`（默认关闭，需显式开启）
- 路由带 `connection` 鉴权栅栏（登录 Cookie / Host / Origin 校验），与官方 Host 路由同一套安全模型；鉴权服务缺失时**失败关闭**
- 20 秒服务端快照缓存，避免多客户端轮询打爆接口

## 安全说明

- **API Key 永不离开宿主进程**：仅在 `fetch` 时进入 `Authorization` 头，发往写死的 `https://api.deepseek.com/user/balance`；不写日志、不落盘、不返回给浏览器。
- 账号通道完全不接触 Key（由 `ctx.deepseekAccount` 内部处理 token）。
- **API Key 通道默认关闭**（`allowApiKey` 默认为 `false`），需显式开启；账号异常时不会自动读取 Key。
- `fetch` 使用 `redirect: 'error'`，杜绝重定向把凭据带去其他位置。
- 路由鉴权失败关闭：`connection.requestRejection` 不存在或抛错时直接返回 503。
- 响应带 `x-content-type-options: nosniff`、`referrer-policy: no-referrer`、`cache-control: no-store`。
- 一次余额解析有 20s 总超时，超时后释放 in-flight 状态，不会永久卡死路由。
- 上游响应体上限 256 KiB，钱包数量上限 20。
- 失败结果只缓存 5s，避免上游故障时每个请求都重试。
- **OpenCode Go 用量**只读取 `OPENCODE_API_KEY`，只发往 `https://opencode.ai/zen/go/v1/usage`；未配置该 Key 时不发起任何请求，`showOpenCodeGo: false` 可完全关闭。
- OpenCode Go 用量与 DeepSeek 余额相互独立：任一失败都不影响另一个的显示。

### 启用 API Key 回退

默认关闭。需要时在该 profile 的 `cordis.patch.yml` 中追加：

```yaml
- id: dsh-balance-lite
  config:
    allowApiKey: true
    # 可选：一次余额解析的超时，单位毫秒，默认 20000
    timeoutMs: 20000
    # 可选：显示 OpenCode Go 用量，默认 true；设为 false 则完全不读取 OPENCODE_API_KEY
    showOpenCodeGo: true
```



## 兼容性

| 项目 | 版本 |
|---|---|
| dsh | `^0.2.2-rc.1`（`engines.dsh`） |
| 客户端平台 | `web`（桌面端与 Web 端共用） |
| peer 依赖 | 无 |

## 安装

### 桌面端（Electron 托管 profile）

桌面端 profile 由 Electron 独占，`dsh plugin` 命令无法操作，需要手工放置：

1. 将本仓库目录复制到桌面端 profile（只复制运行所需文件，不要把 `.git` 带进去）：

   ```powershell
   $src = "C:\path\to\dsh-balance-lite"
   $dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-balance-lite"
   New-Item -ItemType Directory -Force -Path $dst | Out-Null
   Copy-Item "$src\lib" $dst -Recurse -Force
   Copy-Item "$src\package.json", "$src\cordis.patch.yml" $dst -Force
   ```

2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 末尾追加：

   ```json
   "@local/dsh-balance-lite"
   ```

   > 文件需为 **UTF-8 无 BOM**。

3. 重启 DeepSeek Harness 桌面端。

### Web 端

同样把包放进 `~/.dsh/profiles/web/node_modules/@local/dsh-balance-lite`，并把包名加入该 profile 的 `dsh.profile.bundles`。

## 结构

```
dsh-balance-lite/
├─ package.json          # dsh.bundle / dsh.client 清单
├─ cordis.patch.yml      # bundle 补丁：插入宿主插件条目
└─ lib/
   ├─ index.js           # 宿主侧：注册 GET /dsh-balance-lite/api/balance
   └─ client.js          # 浏览器侧：sidebar.footer.action 余额徽标
```

## 接口

`GET /dsh-balance-lite/api/balance`

```json
{
  "ok": true,
  "source": "account",
  "wallets": [{ "currency": "CNY", "balance": "0E-16" }],
  "bonusWallets": [{ "currency": "CNY", "balance": "0" }],
  "updatedAt": "2026-11-06T00:09:50.801Z",
  "opencodeGo": {
    "ok": true,
    "windows": [
      { "key": "rolling", "status": "ok", "percentRemaining": 60, "resetsAt": "2026-11-06T10:00:00.000Z" },
      { "key": "weekly", "status": "ok", "percentRemaining": 80, "resetsAt": "2026-11-10T00:00:00.000Z" },
      { "key": "monthly", "status": "rate-limited", "percentRemaining": 0, "resetsAt": "2026-12-01T00:00:00.000Z" }
    ],
    "updatedAt": "2026-11-06T00:09:50.900Z"
  }
}
```

`opencodeGo` 与余额相互独立，失败时返回 `code`：

| code | 含义 |
|---|---|
| `no-key` | 未配置 `OPENCODE_API_KEY` |
| `not-subscribed` | 账号未订阅 OpenCode Go（403 `EntitlementError`） |
| `disabled` | 配置中关闭了该功能 |
| `failed` / `unavailable` | 网络或响应异常 |

未登录且无 API Key 时：

```json
{
  "ok": false,
  "code": "signed-out",
  "message": "尚未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY。"
}
```

参数 `?force=1` 可跳过 20 秒缓存。

## 测试

零依赖测试套件：

```powershell
npm test
# 或
node test/plugin.test.mjs
```

覆盖：鉴权失败关闭、默认关闭 API Key、显式启用后的固定端点/禁止重定向/Key 不回流、解析超时与 in-flight 释放、失败缓存、钱包数量上限、非 GET 拒绝、响应加固头。

## 开发

无构建步骤，`lib/index.js` 与 `lib/client.js` 均为可直接加载的 ESM / ModuleLoader 产物。

```powershell
node --check lib/index.js
node --check lib/client.js
```

## License

MIT
