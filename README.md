# dsh-balance-lite

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）桌面端 / Web 端提供的**实时余额插件**。

在侧边栏底部常驻一个余额徽标，点击查看充值余额、赠送余额、数据来源与更新时间，每 60 秒自动刷新。

> 直接调用 dsh 自带的账号服务取数，不依赖第三方余额插件，也没有版本豁免。

## 功能

- 侧边栏底部余额徽标：`余额 ¥0.00`
- 点击展开明细面板：充值余额 / 赠送余额 / 来源 / 更新时间
- 每 60 秒自动刷新，面板内可手动强制刷新
- 双取数通道：
  1. **DeepSeek 账号**（`ctx.deepseekAccount.getBalance`）——桌面端登录后自动可用
  2. **API Key**（`DEEPSEEK_API_KEY`）——回退调用官方 `GET https://api.deepseek.com/user/balance`
- 路由带 `connection` 鉴权栅栏（登录 Cookie / Host / Origin 校验），与官方 Host 路由同一套安全模型；鉴权服务缺失时**失败关闭**
- 20 秒服务端快照缓存，避免多客户端轮询打爆接口

## 安全说明

- **API Key 永不离开宿主进程**：仅在 `fetch` 时进入 `Authorization` 头，发往写死的 `https://api.deepseek.com/user/balance`；不写日志、不落盘、不返回给浏览器。
- 账号通道完全不接触 Key（由 `ctx.deepseekAccount` 内部处理 token）。
- `fetch` 使用 `redirect: 'error'`，杜绝重定向把凭据带去其他位置。
- 路由鉴权失败关闭：`connection.requestRejection` 不存在或抛错时直接返回 503。
- 响应带 `x-content-type-options: nosniff`、`referrer-policy: no-referrer`、`cache-control: no-store`。
- 可完全禁用 API Key 通道（默认为 `true`），只用账号登录时建议关闭。

### 禁用 API Key 回退

在该 profile 的 `cordis.patch.yml` 中追加：

```yaml
- id: dsh-balance-lite
  config:
    allowApiKey: false
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

1. 将本仓库目录复制到桌面端 profile：

   ```powershell
   $dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@local\dsh-balance-lite"
   New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
   Copy-Item . $dst -Recurse -Force
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
  "updatedAt": "2026-11-06T00:09:50.801Z"
}
```

未登录且无 API Key 时：

```json
{
  "ok": false,
  "code": "signed-out",
  "message": "尚未登录 DeepSeek 账号，也未配置 DEEPSEEK_API_KEY。"
}
```

参数 `?force=1` 可跳过 20 秒缓存。

## 开发

无构建步骤，`lib/index.js` 与 `lib/client.js` 均为可直接加载的 ESM / ModuleLoader 产物。

```powershell
node --check lib/index.js
node --check lib/client.js
```

## License

MIT
