# DeepSeek Harness × SlashX Gateway

`dsh-plugin-slashx-gateway` 是一个 DeepSeek Harness Host Bundle。它把 Harness
实例暴露为遵循 `slashx.request.v1` / `slashx.response.v1` 的 SlashX 服务端点，
并提供文本、图片、文件、音视频、引用、卡片和按钮所需的安全媒体入口与制品出口。

当前版本：`0.1.0`。兼容目标：DeepSeek Harness `>=0.1.0-rc.6 <0.2.0`。
Harness 仍处于 Developer Preview；生产升级前必须在预发布环境重新运行本包测试和
连接验收。

## 兼容性结论

本插件的目标是“协议传输完整兼容 + 语义能力显式协商”，不是把所有文件都伪装成
模型原生输入。

| SlashX 能力 | 插件接收/返回 | Harness 中的真实处理 |
|---|---:|---|
| 请求文本 | 是 | 原生文本内容块 |
| 请求图片 | 是 | 网关下载/解码并校验后，作为 Harness 原生图片内容块；最终仍取决于所选模型是否支持图片 |
| 请求 PDF、Office、文本、代码等文件 | 是 | 安全下载到会话工作区，并给 Agent 提供路径、MIME、大小和 SHA-256；由文件工具读取，不冒充原生模型附件 |
| 请求音频、视频 | 是 | 安全落盘为工作区文件；若要理解内容，需要在 Harness 中另配转写、抽帧或媒体分析工具 |
| 引用、按钮点击 | 是 | 作为有边界的结构化上下文交给 Agent |
| Markdown 响应 | 是 | 普通助手文本；SlashX 客户端具备 `markdown` capability 时渲染 |
| 图片、视频、音频、文件响应 | 是 | Agent 调用 `slashx_deliver`；本地文件经签名制品服务发布为 HTTPS URL，或使用已有远程 HTTP(S) URL |
| 引用、卡片、按钮响应 | 是 | Agent 调用 `slashx_deliver`，插件按 `slashx.response.v1` 校验；客户端不支持时转为附件或 Markdown 降级，不静默丢失 |
| 异步回调 | 是 | 支持 `extensions.slashxAsync`、一次性 callback token、轮询和取消入口 |
| 文本逐 token SSE | 否（0.1.0） | 当前返回完整终态响应，长任务使用异步回调；能力端点会明确报告这一限制 |

重要边界：插件可以保证字段、校验、落盘和返回格式；它不能保证当前所选模型会看懂
视频，也不能凭空生成图片或文件。媒体生成与理解依赖实际装入 Harness 的模型和工具。

另外，SlashX 当前聊天运行链虽然协议定义了独立的 `input.videos`，聊天页的部分路径
仍会把视频放进 `attachments`，部分旧路径主要发送文本。本插件同时接受
`videos` 和带 `attachmentType=video` 的 `attachments`；要宣称端到端全部打通，仍需在
后续“DeepSeek Harness 服务商”阶段完成 SlashX 聊天入口的独立视频字段验收。

当前 SlashX 的 HTTP 同步调用路径还只声明 `stream`、`markdown`（异步时再加
`async_callback`）客户端能力。因此即使聊天 UI 和 `slashx.response.v1` 已定义图片、
视频、音频、卡片和按钮，本插件也会遵守本次请求的 capability，把这些内容显式降级为
附件或 Markdown。要在 SlashX 页面原生显示全部富组件，后续服务商接入必须让聊天路由
按真实页面能力发送 `image`、`video`、`audio`、`card`、`action`，并补齐端到端渲染验收；
插件不能擅自忽略客户端声明。

## 工作原理

一次调用经过以下真实链路：

1. Gateway 校验完整 `slashx.request.v1`、Bearer 鉴权、请求大小和幂等 `runId`。
2. URL 媒体执行 DNS/重定向 SSRF 检查，并把实际连接固定到已校验 IP，防止 DNS
   重绑定；Base64 媒体解码并校验大小和真实文件头。
3. 图片进入 Harness 的图片内容块；其他媒体写入该 SlashX 会话独立的工作区。
4. Gateway 通过 Harness `ctx.apiProxy` 创建或恢复确定性 Session，监听事件流并提交提示。
5. 普通 Markdown 取 Harness 最终助手文本。富响应由同一 Bundle 注册的
   `slashx_deliver` 工具结构化提交。
6. 本地生成物只能从当前会话工作区发布；插件使用 `realpath` 防止 `..` 和符号链接越界，
   再产生有过期时间和 HMAC 签名的下载 URL。
7. Gateway 返回完整 `slashx.response.v1`；异步请求则先返回 `running`，完成后用一次性
   token 回调 SlashX。

每个 SlashX `conversationId` 映射为固定 Harness Session。请求按会话串行，避免两个并发
Turn 的富媒体交付串线。运行账本只保存请求摘要和最终响应，不保存 callback token。
网关重启后若发现某个 run 只有 `running` 记录，会返回
`RUN_OUTCOME_UNCERTAIN`，不会自动重复执行可能产生外部副作用的任务。

## 计费归集

插件只声明 SlashX 的两种计费方式：

- `flat_per_run`：按次计费。SlashX 在执行前按配置的固定积分扣费，插件无需用 Token
  决定价格。
- `pass_through`：按 Token 计费。插件在成功响应中返回可核验的输入、输出和总 Token，
  SlashX 使用自己的模型档位与加价规则结算；插件不自行计算积分或金额。

按 Token 归集覆盖根智能体、所有本次运行中新建的子智能体、可继续调用的既有子智能体，
以及模型自动重试产生的每次调用。Harness `TokenUsage` 中各输入字段互不重叠，因此：

```text
usage.promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
usage.completionTokens = outputTokens
usage.totalTokens = usage.promptTokens + usage.completionTokens
```

`reasoningTokens` 只作为输出明细放在
`extensions.slashxHarness.metering.reasoningTokens`，不会再叠加到输出 Token，避免重复计费。
完整计量明细位于 `extensions.slashxHarness.metering`，其中包含缓存读写、子智能体数、
模型调用次数、模型列表、`usageComplete` 和 `incompleteReasons`。

网关先记录每个会话的事件序号基线，再按父子会话关系归集；根 Turn 完成后还会等待全部
子智能体停止并连续两次获得稳定目录。只要模型未报告 usage、Token 非法/溢出、事件流或
子智能体目录不可用、根 Session 在请求前已经运行、既有子智能体发生无法唯一归因的并发活动，`usageComplete` 就为
`false`，同时从顶层响应中省略 `usage`。这会让 SlashX 的 `pass_through` 结算因缺少可信
Token 而失败关闭，避免少计或错计；`flat_per_run` 不依赖该字段，仍按既定按次规则处理。

## 安装

需要 Node.js 22.19+，以及可正常启动的官方 Harness `web` profile。
`web` profile 提供本插件依赖的 `ctx.apiProxy`；不要把本插件装入不含 ApiProxy 的
`headless` profile。

```bash
# 首次运行会初始化官方 web profile
npx @deepseek-ai/dsh@0.1.0-rc.6 web --dump-config

# npm 发布后
dsh plugin --profile web add dsh-plugin-slashx-gateway

# 从本地 checkout 验证
dsh plugin --profile web add /absolute/path/to/dsh-plugin-slashx-gateway

# 确认组合层出现 dsh-plugin-slashx-gateway
dsh web --dump-config
```

生成至少 32 字符的随机访问令牌，并设置运行变量：

```bash
export SLASHX_GATEWAY_TOKEN="$(openssl rand -base64 32)"
export SLASHX_GATEWAY_STATE_ROOT="/srv/deepseek-harness/slashx-gateway"
export SLASHX_GATEWAY_PUBLIC_BASE_URL="https://harness.example.com"

dsh web
```

默认 Gateway 只监听 `127.0.0.1:3090`。`dsh web` 自带的浏览器服务与 Gateway 是两个
不同端口；SlashX 只需要访问 Gateway，不需要访问 Harness 原生 `/api`。

## 反向代理

生产环境必须在 Caddy、Nginx 或同等代理上终止 TLS。下面只代理 SlashX Gateway，
不会暴露 Harness 原生 API：

```caddyfile
harness.example.com {
  reverse_proxy /slashx-provider/* 127.0.0.1:3090
  reverse_proxy /healthz 127.0.0.1:3090
}
```

不要直接把 `dsh web --host 0.0.0.0` 或 Harness `/api` 暴露到公网。官方 Web Server 当前
不负责 TLS、认证或 Origin 安全策略。

## SlashX 连接配置

在 SlashX 中先使用“自建 HTTP 服务”连接：

- Endpoint：`https://harness.example.com/slashx-provider/v1/run`
- Auth：Bearer Token
- Secret：与 `SLASHX_GATEWAY_TOKEN` 相同
- Async callback：建议开启，尤其是生成视频、处理大文件或长 Agent 任务时
- Timeout：同步任务应不小于 Gateway 的预期执行时长

能力探测：

```bash
curl -H "Authorization: Bearer $SLASHX_GATEWAY_TOKEN" \
  https://harness.example.com/slashx-provider/v1/capabilities
```

健康检查：

```bash
curl https://harness.example.com/healthz
```

## 富媒体响应工具

Bundle 会向 Harness 注册 `slashx_deliver`。该工具只接受当前活跃 SlashX run 的
`runId`，并且调用它的 Harness Session 必须与该 run 一致。示例参数：

```json
{
  "runId": "11111111-1111-4111-8111-111111111111",
  "text": "## 分析完成\n报告和预览如下。",
  "images": [
    {
      "localPath": "output/preview.png",
      "mimeType": "image/png",
      "fileName": "preview.png"
    }
  ],
  "attachments": [
    {
      "localPath": "output/report.pdf",
      "mimeType": "application/pdf",
      "fileName": "report.pdf",
      "attachmentType": "document"
    }
  ],
  "citations": [
    {
      "index": 1,
      "title": "数据来源",
      "url": "https://example.com/source"
    }
  ],
  "cards": [
    {
      "type": "summary",
      "title": "处理结果",
      "fields": [{ "label": "状态", "value": "已完成" }]
    }
  ],
  "actions": [
    { "label": "继续处理", "kind": "send_message", "value": "继续处理" },
    { "label": "打开来源", "kind": "open_url", "value": "https://example.com/source" }
  ],
  "conversationUpdate": { "title": "文件分析结果", "modeTag": "done" }
}
```

`localPath` 必须位于当前 SlashX 会话工作区。公网 URL 必须使用 HTTP(S)，卡片图片和
`open_url` 按钮同样不能使用 `javascript:`、`file:` 等协议。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `SLASHX_GATEWAY_HOST` | `127.0.0.1` | 仅支持 `127.0.0.1` 或显式的 `0.0.0.0`；生产推荐回环 + 反代 |
| `SLASHX_GATEWAY_PORT` | `3090` | Gateway 端口 |
| `SLASHX_GATEWAY_TOKEN` | 无 | 必填，至少 32 字符 |
| `SLASHX_GATEWAY_PUBLIC_BASE_URL` | 无 | 本地生成物对 SlashX 可访问的 HTTPS Origin；未设置时仅能返回已有远程 URL |
| `SLASHX_GATEWAY_STATE_ROOT` | 当前目录下 `.deepseek-harness/slashx-gateway` | 会话工作区、运行账本和制品目录 |
| `SLASHX_GATEWAY_AGENT_PRESET` | Harness 默认 | 新 Session 使用的 Harness Agent Preset |
| `SLASHX_GATEWAY_REQUEST_TIMEOUT_MS` | `300000` | 同步 Harness Turn 上限，1 秒到 1 小时 |
| `SLASHX_GATEWAY_MAX_REQUEST_BYTES` | `16777216` | JSON 请求体上限 |
| `SLASHX_GATEWAY_MAX_MEDIA_BYTES` | `26214400` | 单个输入媒体及单个输出制品上限 |
| `SLASHX_GATEWAY_MAX_TOTAL_MEDIA_BYTES` | `52428800` | 单请求全部输入媒体上限 |
| `SLASHX_GATEWAY_MAX_CONVERSATION_BYTES` | `1073741824` | 单个用户 + Agent + 会话工作区累计上限 |
| `SLASHX_GATEWAY_MAX_PRINCIPAL_BYTES` | `5368709120` | 单个用户 + Agent 跨会话工作区累计上限 |
| `SLASHX_GATEWAY_MAX_WORKSPACE_BYTES` | `21474836480` | 所有会话工作区累计上限 |
| `SLASHX_GATEWAY_MAX_ARTIFACT_STORE_BYTES` | `2147483648` | 未过期签名制品累计字节上限 |
| `SLASHX_GATEWAY_MAX_STORED_ARTIFACTS` | `10000` | 未过期签名制品数量上限 |
| `SLASHX_GATEWAY_MAX_ARTIFACT_BYTES_PER_RUN` | `104857600` | 单个 run 可发布的本地制品累计上限 |
| `SLASHX_GATEWAY_MAX_ARTIFACTS_PER_RUN` | `20` | 单个 run 可发布的本地制品数量上限 |
| `SLASHX_GATEWAY_ASSET_TTL_SECONDS` | `86400` | 签名制品 URL 有效期 |
| `SLASHX_GATEWAY_MAX_CONCURRENT_RUNS` | `4` | 同时执行的 Harness Turn 上限 |
| `SLASHX_GATEWAY_MAX_QUEUED_RUNS` | `100` | 全局待执行 run 上限；超过后返回可重试的 `GATEWAY_BUSY` |
| `SLASHX_GATEWAY_MAX_RUN_LEDGER_ENTRIES` | `100000` | 文件账本最多保留的 run 数；满额时拒绝新 run |
| `SLASHX_GATEWAY_MAX_RUN_LEDGER_ENTRIES_PER_PRINCIPAL` | `10000` | 单个用户 + Agent 的账本上限，避免独占全局账本 |
| `SLASHX_GATEWAY_RUN_RETENTION_SECONDS` | `2592000` | 已完成 run 的账本保留期；不自动删除结果不确定的 run |
| `SLASHX_GATEWAY_ALLOW_HTTP_MEDIA` | `0` | 仅开发环境确有需要时设为 `1` |
| `SLASHX_GATEWAY_PRIVATE_MEDIA_HOSTS` | 空 | 逗号分隔的精确私网媒体域名白名单；不要填写通配符 |

`SLASHX_GATEWAY_PUBLIC_BASE_URL` 不能包含认证信息。生产环境应使用 HTTPS；HTTP 只用于
本机或受控开发环境。

## 运维和持久化

- 将 `SLASHX_GATEWAY_STATE_ROOT` 挂载到受保护的持久卷，权限建议 `0700`。
- 同一个 State Root 只运行一个 Gateway 进程。`0.1.0` 的账本是文件账本，不是多副本
  分布式锁；需要水平扩容时应改用共享数据库和会话级租约。
- 制品按 TTL 清理。视频下载支持 HTTP Range；浏览器可正常拖动播放。
- 全局并发和排队均有硬上限；应结合服务器 CPU、内存、模型并发额度调整。
- 已完成的运行账本按保留期清理；`running/uncertain` 记录不会自动删除，以免丢失
  去重保护。重复异步请求通过持久化 callback claim 抑制重复回调。
- 输入文件可能包含敏感数据。备份、日志采集和病毒扫描策略应覆盖 State Root。
- 网关不会记录 Bearer Token 或 callback token；反向代理也应关闭 Authorization 日志。

## 验证

```bash
npm run check
npm test
npm pack --dry-run
```

测试覆盖协议全字段、富响应结构、能力降级、Base64/MIME、SSRF、路径越界、制品发布、
幂等持久化、缓存 Token、子智能体/重试汇总、缺失用量失败关闭，以及真实 HTTP 请求经过
模拟 Harness ApiProxy 事件循环的完整链路。

发布前还应在真实服务器完成以下验收：

1. SlashX 聊天页分别发送文字、图片、PDF、音频和视频。
2. Harness 实际模型读取图片，实际工具读取工作区文件。
3. Agent 实际生成图片、视频或文件，并由 `slashx_deliver` 返回。
4. SlashX 分别渲染 Markdown、图片、视频、音频、附件、引用、卡片和按钮。
5. 验证大文件拒绝、超时、取消、异步回调、Gateway 重启、过期制品和重复 run。
6. 用真实 Harness 模型运行缓存命中、缓存写入、子智能体和模型重试场景，并把插件返回的
   `metering` 与各 Session 原始事件及 SlashX 最终积分流水逐笔核对。

本地测试通过不等于真实 SlashX 页面、真实 DeepSeek 模型、对象存储、反向代理或公网
回调已经验收。

## 已知限制

- Harness 的 PromptContentPart 当前原生只有文本和图片。音视频/任意文件必须借助工具。
- `0.1.0` 不输出逐 token SSE；富媒体以完整终态或异步回调交付。
- `retract` 不重写 Harness 的 append-only 历史，只会被明确标记为无法回滚的事件。
- 已经存在的 Harness Session 不会重复注入 SlashX `history`；空 Session 才使用请求历史
  作为启动上下文，避免重复上下文。
- 当前文件账本适合单实例。多副本需要数据库、租约和共享制品存储。

## License

MIT
