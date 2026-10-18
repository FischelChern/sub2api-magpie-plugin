[English](./README.en.md)

# sub2api-magpie-plugin

将 [Sub2API](https://github.com/Wei-Shaw/sub2api) 站点接入 [Magpie](https://usemagpie.ai)：查看当前 API key 对应的套餐、余额和模型，并在查询和模型发送请求中附加自定义请求头。

项目来源：`sub2api magpie`。本项目在此基础上重构，新增分层请求头配置、安全校验和本地测试。使用 Magpie 的 provider 插件接口，无运行时依赖，无需构建；需要 Node.js >= 20。

## 功能

- **套餐和用量**：读取 `GET /v1/usage`，显示套餐名、到期时间、日/周/月额度，或 key 总额度及限速窗口。
- **余额**：余额计费的 key 显示钱包余额，包括零余额。
- **模型列表**：读取 `GET /v1/models`，可选读取 `GET /backend-api/codex/models` 获取思考等级；后者不可用时保留已知等级或使用默认值。
- **账号绑定**：完整列出每个 API key 返回的模型，支持分页；发送使用所选账号自己的 Base URL、API key 和请求头，不在插件内切换 key 或模型。
- **原模型速度选择**：读取当前 key 报告的 Fast / Ultraspeed 能力，以 `serviceTiers` 交给 Magpie，让支持该能力的 Agent 在原模型上选择速度，不额外生成模型。
- **请求指标**：保留四种协议的用量、缓存和流式事件，由 Magpie 原生统计耗时、首响应、token、缓存命中率、输出速度和估算费用，不重复上报账单。
- **请求头**：支持全局、站点和账号级配置，查询及实际模型发送均生效，大小写不敏感地合并。
- **多站点/多账号**：可共用 `sub2api` 池，也可配置最多 8 个独立站点 provider。
- **站点图标**：自动发现并拉取站点网页图标，作为 Magpie 中该 provider 的图片，无需手动配置图片地址。

插件覆盖 Anthropic、OpenAI、国产模型和其他模型所用的以下四类对话协议。厂商分类不等于协议：同一个厂商或同一个模型，也可以由站点提供多种协议。

| 模型/厂商类别 | `protocol` | 默认发送接口 |
| --- | --- | --- |
| Anthropic / Claude | `anthropic` | `/v1/messages`，支持 `/v1/messages/count_tokens` |
| OpenAI / GPT / Codex | `responses`（别名 `openai`） | `/v1/responses` |
| DeepSeek、Kimi、GLM、Qwen、MiniMax 等国产模型，以及 Grok、其他兼容模型 | `chat-completions`（别名 `openai-compatible`） | `/v1/chat/completions` |
| Google Gemini 原生 | `gemini`（别名 `google`） | `/v1beta/models/{模型}:generateContent` 或 `:streamGenerateContent` |

默认 `auto`：按模型名称识别 Claude、GPT、Gemini，包括 `anthropic/`、`openai/`、`google/` 等带前缀名称，其余走 Chat Completions。自定义别名不一定能自动判断，使用下文的显式配置覆盖。插件保留响应流、状态码和取消信号，不缓冲模型响应。

## 本地安装

在本项目目录运行：

```sh
magpie plugin add "$PWD"
magpie plugin login sub2api
```

本项目包名为 `sub2api-magpie-plugin`；旧名称 `magpie-sub2api` 不再用于本项目的插件选项命令。已安装旧名称或 npm 版本时，先确认 `magpie plugin list`，再将插件来源切换到此本地目录，避免同时加载两个提供相同 provider 的插件。按包名安装依赖 npm 是否已发布，本次更名不自动发布。本项目没有自动修改本机现有插件、账号或配置。

更名不改变 provider ID：默认登录仍使用 `magpie plugin login sub2api`，模型仍为 `sub2api/<模型>`；已有账号和自定义站点 ID 不变。插件选项命令改用 `magpie plugin options sub2api-magpie-plugin`。

普通使用只需要配置站点 **Base URL**，例如：

```text
https://api.example.com
```

不需要手动添加 `/v1`、选择厂商/协议、填写账号名或额外请求头。插件自动补齐接口路径、发现模型，并按模型名称选择协议；新账号默认使用站点域名、key 后四位和地址/key 的短摘要命名，降低同后缀 key 或同域名不同部署路径的重名风险。已有账号 ID 保持不变。

**认证仍需要 API key**，由 Magpie 的 API key 登录表单单独收集。仅凭公开的站点地址无法查看某个账号的私有套餐、余额或发送计费请求。

也可以直接在插件选项里只填一个 `baseUrl`：

```json
{"baseUrl":"https://api.example.com"}
```

这样登录时连站点地址也无需再次填写，只输入 API key 即可。`baseUrl`、`baseURL`、`url` 都支持（同时存在时优先 `url`，其次 `baseURL`）。这只是没有保存站点地址的账号的默认地址，不会覆盖已有账号保存的站点。HTTP 和 HTTPS、IP 加端口、部署路径前缀均支持。

以下请求头、多站点、协议规则均为高级可选配置，正常使用无需填写。已有账号的名称和高级元数据仍兼容。Magpie 按账号名称记录模型和能力；修改名称时建议删除账号后重新登录。

### 自动站点图标

配置站点地址后，插件在加载配置时读取站点首页的 `<link rel="icon">` / `apple-touch-icon`，失败时尝试站点部署路径和 origin 根目录的 `favicon.ico`。仅在登录时填写地址的账号，在加载模型列表时后台发现图标，不阻塞模型列表；配置钩子仍等待图标，以便宿主读取初始图片。支持 HTTP/HTTPS、IP 加端口和部署前缀，无需额外图片选项。

- 独立站点 provider 各用自己的图标；池化 `sub2api` 使用本次插件加载后首个加载模型的账号站点图标，避免后续账号互相覆盖。配置中的默认地址仅在账号尚未加载时提供图标。
- 图标以 `data:image/…` 交给 Magpie 的 `auth.icon`，支持 PNG、JPEG、GIF、WebP、ICO、SVG；不向仓库或插件包写入下载文件。
- 首页和图标请求不携带 API key、自定义请求头或 Cookie，仅访问所配置地址的相同 origin，不跟随重定向，不访问外部 CDN 或上级域名。需要认证、跳转或跨域加载的图标可能无法获取。
- 每次发现共用 3 秒超时，首页最多 512 KiB，图片最多 1 MiB，并限制候选请求数。进程内成功缓存 1 小时、失败缓存 5 分钟，下次加载配置或模型时按需重试；刷新失败保留已有图标，不影响模型、用量和推理。

这里设置的是 **provider 图片**。Magpie 插件市场或“已安装”插件卡片使用包级静态 `magpie.icon`；本插件已内置 Sub2API 官方 `image.png`，不会随账号地址动态切换。图标来源为 [Sub2API 官方仓库](https://github.com/Wei-Shaw/sub2api/blob/main/assets/logo.svg)，仅作为品牌标识随插件分发，不属于本项目的 MIT 代码许可范围。

## 高级：自定义请求头

需要额外请求头时，在 Magpie 的插件选项编辑器中添加 `headers` 即可，不需要重新选择协议。例如：

```json
{
  "baseUrl": "https://api.example.com",
  "headers": {
    "User-Agent": "my-client",
    "X-Client": "magpie"
  }
}
```

这里的 `headers` 对套餐/余额查询、模型列表和实际模型发送均生效；没有特殊要求时保留空对象或省略。

如果 Codex 和 Claude 需要不同的客户端标识，可用 `protocolHeaders` 按协议配置。`codex` 是
`responses` 的别名，`claude` 是 `anthropic` 的别名；这些头只附加到实际模型请求，不会发送到用量或模型发现接口。

```json
{
  "protocolHeaders": {
    "codex": { "originator": "codex_cli_rs" },
    "claude": { "anthropic-beta": "interleaved-thinking-2025-05-14" }
  }
}
```

协议请求头的优先级低于全局、站点和账号 `headers`，同名配置仍由后者覆盖；账号也可在
`metadata.protocolHeaders` 中单独配置。

### 全局和站点

```sh
magpie plugin options sub2api-magpie-plugin '{
  "headers": {
    "User-Agent": "my-magpie-client",
    "X-Client": "magpie"
  },
  "sites": [
    {
      "id": "primary",
      "name": "主站",
      "url": "https://api.example.com",
      "headers": {
        "X-Channel": "primary"
      }
    },
    {
      "id": "backup",
      "name": "备用站",
      "url": "https://backup.example.com"
    }
  ]
}'
magpie plugin login primary
magpie plugin login backup
```

应用中可在插件选项编辑器中填写同样的 JSON。独立站点登录时无需再填站点地址；模型名为 `primary/<模型>`、`backup/<模型>`。默认池化 provider `sub2api` 始终保留，每个账号可使用不同站点。

- 合并优先级：**全局 `headers` < 站点 `sites[].headers` < 账号元数据 `headers`**。
- 同名 header 不区分大小写；后者覆盖前者，而不是拼接。
- `sites[].headers` 仅属于该站点，不会应用到池化 provider 或其他站点。
- 合并后的配置只补充调用方未提供的同名请求头，不会覆盖 Agent 自带的请求头。
- 账号请求头保存在 Magpie 认证元数据 `metadata.headers` 中，可为对象或 JSON 对象字符串；修改后需让 Magpie 重新加载账号。
- 不做环境变量展开或模板替换，值按字面发送。敏感值不要提交到代码仓库，也不要直接写入会记录历史的终端命令。

### 自动 User-Agent 与客户端标识

Magpie 对插件 provider 发起内部请求时会使用自身的 `magpie/<version>` User-Agent，而不是把 Codex、Claude Code 等 Agent 的原始 UA 交给插件。插件会识别并替换 Magpie 自己的 `magpie/*`、`magpie-*` UA，避免它被发送到模型上游；若请求中带有可识别的 Codex/Claude Agent 标记，则优先选择对应 UA。若插件实际收到的是非 Magpie 的 Agent UA，则原样保留。

没有可用的 Agent UA 时，插件按实际 API 协议补充以下兼容标识；这些版本用于客户端识别，不代表宿主安装的 SDK 版本：

| API 协议 | 自动 `User-Agent` |
| --- | --- |
| `responses`（GPT / Codex 默认） | `codex_cli_rs/0.159.0 (<OS>; <arch>) <terminal>` |
| `anthropic`（Claude 默认） | `claude-cli/2.1.296 (external, cli)` |
| `chat-completions` | `OpenAI/JS` |
| `gemini` | `google-genai-sdk` |

选择依据是实际请求的 API 类型，不是再次解析模型名；`modelProtocols` 和自定义 `apiPaths` 同样适用。若显式 `User-Agent` 配置有效且不是 Magpie 自身 UA，它会替换内部 Magpie UA，但不会覆盖真实的非 Magpie Agent UA。配置优先级为 **内置协议默认值 < `protocolHeaders` < 全局 `headers` < 站点 `headers` < 账号 `headers`**。用量、模型列表、Codex 思考等级查询及无法识别协议的接口不添加这些推理默认值。

Responses 请求还会补齐 Codex 客户端头：`OpenAI-Beta: responses=experimental`、`originator: codex_cli_rs` 和 `version`。调用方给出的更高 `version` 会保留并使用在 UA 中。Claude 请求缺失时补充 `x-app: cli` 和 `anthropic-version: 2023-06-01`。Agent 提供的 `originator`、`session-id` 和所有 `x-codex-*` 请求头继续保留；`init.headers` 中的同名值会覆盖 `Request.headers`，认证头始终替换为当前账号凭据。

Responses 请求还会从 JSON 请求体的 `client_metadata` 补充缺失的请求头：`session_id` → `session-id`、`thread_id` → `thread-id`，以及名称不变的 `x-codex-*` 字符串字段。与 Magpie 的 Codex 签名一致，`prompt_cache_key` 会作为缺失的 `session-id` 和 `thread-id`。已有请求头（包括 `session_id` / `thread_id` 别名）优先，不复制任意其他字段，不生成安装、窗口或会话标识，也不修改请求体。此转换不应用于 Claude、Chat Completions、Gemini 或管理接口。

元数据检查支持字符串、字节、Blob 和 `Request` 副本，最多读取 1 MiB；副本读取最多等待 15 秒，并响应取消信号。直接通过 `init.body` 传入的 `ReadableStream`、编码后的请求体及过大的请求体不做转换，原样交给 fetch；已提供的 HTTP 头仍保留。无效 JSON 或头值会忽略，新增元数据请求头合计最多 8 KiB。这些头可能包含客户端、会话和本地工作区信息，只应发送给可信供应商；若无需转发某项，请在调用方移除对应元数据。

这些标识仅用于协议兼容，不会使 Magpie 成为官方客户端，也不改变账号权限。如果仍返回 `This account only allows Codex official clients`，站点可能还校验请求体或其他客户端特征；请联系管理员为该账号允许兼容客户端，或使用其支持的官方客户端。

### 校验和安全边界

请求头必须是名称合法、值为字符串的 JSON 对象；拒绝换行、NUL，以及认证和连接管理保留头。`Authorization`、`X-API-Key`、`X-Goog-API-Key` 等不允许在额外请求头中设置，请使用账号的 API key。`Host`、`Content-Length`、`Connection`、`Transfer-Encoding`、`Upgrade`、`Keep-Alive`、`TE`、`Trailer`、代理认证/连接头及 `Accept-Encoding` 也由客户端管理。

插件始终使用当前账号的 API key，避免调用方认证头覆盖账号。Anthropic 同时设置 `x-api-key`，并在未指定时补充 `anthropic-version`；Gemini 设置 `x-goog-api-key`，不携带调用方传入的 URL `key` 参数。请求头校验错误不包含其值。实际模型请求仅限账号站点的相同 origin 和已配置协议路径（含部署前缀），所有请求禁止跟随重定向，以免 key 或附加头被转发到其他地址。

站点地址禁止包含 URL 用户名、密码、查询串或 fragment。允许 HTTP 以便本地开发，生产环境请使用 HTTPS。若站点返回重定向，请配置最终 API 地址。

站点 `id` 仅支持小写字母、数字、`-`、`_`，以字母或数字开头，最长 40 字符，不可重复或使用 `sub2api`。省略时按域名生成；无效站点会被跳过并输出不含密钥的提示。已登录后不要修改站点 `id`，否则需重新登录。请求头配置非法则会报错，不会静默忽略。

## 按厂商、站点和模型配置协议

普通使用不需要配置这一节。`examples/options.json` 包含对应参考图四种厂商类别的高级配置模板；需要显式覆盖时才使用。站点地址支持 `url`、`baseURL`、`baseUrl`，API key 仍在登录时填写，不放在模板中。

同一站点也可以混用协议：

```json
{
  "protocol": "auto",
  "sites": [
    {
      "id": "all-models",··
      "name": "全部模型",
      "baseURL": "https://api.example.com",
      "protocol": "auto",
      "modelProtocols": {
        "claude-alias": "anthropic",
        "gpt-legacy": "chat-completions",
        "gpt-codex": "responses",
        "gemini-alias": "gemini",
        "my-domestic-model": "chat-completions"
      }
    }
  ]
}
```

- 默认 `protocol` 按全局 → 站点 → 账号元数据覆盖；账号未设置则继承，设为 `auto` 则恢复自动判断。
- `modelProtocols` 按模型的完整 ID 精确匹配，优先于默认 `protocol`，且按全局 → 站点 → 账号逐项合并；不同配置层不会丢掉其他模型的规则。
- 若站点给 GPT 只开放 Chat Completions，可将站点 `protocol` 设为 `chat-completions`，不必因为名字叫 GPT 就走 Responses。
- 若国产模型分组要求 Anthropic 格式，可设为 `anthropic`，不要求模型名称以 Claude 开头。
- 账号协议选项保存在 `metadata.protocol` 中；高级的账号级规则也可通过 `metadata.modelProtocols`、`metadata.apiPaths` 配置。修改后需要 Magpie 重载账号及模型列表。

### 自定义协议路径

站点默认采用上述标准路径；自定义部署或 Antigravity 专用入口可配置 `apiPaths`。值是相对于站点根地址的路径，不是完整接口 URL，也不含最后的 `messages`、`responses` 等操作名。例如：

```json
{
  "sites": [
    {
      "id": "custom-paths",
      "url": "https://api.example.com",
      "apiPaths": {
        "anthropic": "/antigravity/v1",
        "responses": "/openai/v1",
        "chat-completions": "/compatible/v1",
        "gemini": "/antigravity/v1beta"
      }
    }
  ]
}
```

例如 Anthropic 最终发送至 `https://api.example.com/antigravity/v1/messages`。全局、站点和账号的 `apiPaths` 逐项覆盖，未配置的协议仍使用默认路径。支持以 `/` 表示站点根路径；拒绝外域 URL、路径穿越和查询串。套餐及模型发现仍请求站点根地址下的 `/v1/usage`、`/v1/models`，不被推理路径配置影响。

Magpie 的账号级 `baseURL` 优先于模型地址，因此发送函数还会按实际 API 操作选择最终协议路径，确保混合池里的 Gemini 请求到达 `/v1beta/`，而非错误的 `/v1/`。

## 全量模型与多 key 路由

每次登录一个 API key，Magpie 为其保存独立账号。插件在该账号作用域内使用该 key 查询 `/v1/models`，默认保留全部有效模型 ID，不因名称陌生、厂商、视觉能力或是否为对话模型而自动删除。非对话模型也能被列出，但不代表本插件实现了对应的图片生成、嵌入等发送接口。

- 支持标准 `data` 列表、`has_more` / `last_id` 游标分页，以及 `next` URL 分页。分页只允许访问同一账号的 `/v1/models`，保留部署前缀；最多 100 页，合计 JSON 内容受体积上限约束，超限或任一页失败直接报错，不返回截断列表。
- key A 和 key B 的模型独立交给 Magpie。只有 A 列出的模型由 A 的发送函数调用；只有 B 列出的模型由 B 调用。两者都有的同名模型由 Magpie 的账号路由选择，选定后使用该账号自己的 URL、key 和请求头，不把模型静态绑定到最后登录的 key，也不把 key 放进模型对象。
- 多 key 可以属于不同站点，也可以属于同一站点的不同分组。查询缓存按地址、key 和合并后的请求头隔离，仅进程内保存摘要索引，不持久化密钥。
- 模型刷新保留 Magpie 已知的上下文、输出限制、价格、能力、选项和模型请求头；重新确定当前账号的 API 地址、模型 ID 和 SDK。未知价格不再填成零，未知视觉或推理能力不直接按协议判定。
- 模型查询失败直接抛出错误，不返回宿主默认列表、其他账号列表或过期列表。已记录的失败也阻止该账号已有发送函数继续使用宿主可能保留的旧列表，直到模型查询恢复。请求体中可安全读取的模型 ID 还会校验是否属于该账号的已发现列表；不为此消费流式上传。
- 实际模型请求只发送一次，除下述旧速度 ID 的发送前兼容转换外保持请求模型不变，原样返回上游状态、响应流或网络错误；插件不做重试、不换模型、不换 key。Magpie 自身的路由组或 provider fallback 是宿主配置，本插件不修改它们；需要端到端禁止模型回退时，请清空宿主的备用模型并直接选择 `sub2api/<模型>` 或独立站点模型。需要固定某个 key 时，可由客户端向 Magpie 发送 `X-Magpie-Account: <账号名或 ID>`，不要把它配置成发给站点的额外请求头。

### 可选筛选、名称和能力覆盖

不配置时查询并展示全部真实模型，不额外生成速度档模型。只有明确配置 `includeModels` / `excludeModels` 才筛选，均为完整 ID 精确匹配；显式空的 `includeModels: []` 表示不展示任何模型。`modelNames` 只修改显示名，不修改发送的 ID：

```json
{
  "excludeModels": ["unused-model"],
  "modelNames": {"custom-vision": "我的视觉模型"},
  "modelOverrides": {
    "custom-vision": {
      "limit": {"context": 128000, "output": 8192},
      "capabilities": {
        "attachment": true,
        "toolcall": true,
        "input": {"image": true}
      },
      "cost": {"input": 1.2, "output": 6, "cache": {"read": 0.12, "write": 1.5}}
    }
  }
}
```

数值仅为配置示例，须按站点实际能力和计价填写。覆盖项只应用于 key 本来就能查询到的模型，不会凭空添加权限。全局 < 站点 < 账号元数据；筛选数组逐层替换，名称逐 ID 合并，覆盖元数据深度合并。可覆盖 `name`、`limit`、`cost`、`capabilities`、`options`、`headers`、`variants`、`release_date`、`status` 和 `serviceTiers`，但不能改模型身份、API 地址或账号凭据。`serviceTiers` 数组逐层替换。额外模型请求头仍接受保留头校验。显式协议继续使用 `modelProtocols`。

### 在原模型上选择 Fast / Ultraspeed

模型列表只保留站点返回的真实 ID。插件把当前 key 报告的服务档位写入原模型的 `serviceTiers`，由 Magpie 提供给支持速度选择的 Agent（例如支持服务档位目录的 Codex）。不生成 `-fast` / `-ultraspeed` 模型，不更改原模型的 ID、思考等级或默认速度。显示名末尾的 `(fast)` / `（fast）`、`(ultraspeed)`、`(ultrafast)` 等速度标签会移除（包括站点、宿主缓存和自定义名称）；真实 ID 本身不清理，速度能力仅通过参数元数据声明，不根据标签推断支持。

| Agent 选择 | OpenAI 兼容请求参数 | 发给上游的模型 ID |
| --- | --- | --- |
| 普通 / 默认 | 不设置额外速度参数 | `gpt-example` |
| Fast | `service_tier: "priority"` | `gpt-example` |
| Ultraspeed / Ultrafast | `service_tier: "ultrafast"` | `gpt-example` |

例如 Agent 通过 Magpie 调用 `sub2api/gpt-example` 时选择 Fast：

```json
{"model":"sub2api/gpt-example","input":"hello","service_tier":"priority"}
```

Magpie 选择账号后，上游收到的 `model` 是 `gpt-example`，速度参数保持 `priority`。`ultraspeed` 是配置别名，线上参数使用 `ultrafast`，不是 `service_tier: "ultraspeed"`。

- **仅报告有依据的能力**：优先读取当前 key 的 `/v1/models` 中的 `service_tiers` / `serviceTiers`，支持字符串或 `{ "id": "priority" }` 数组。含 Responses 模型时，缺失字段可由同一 key 的 `/backend-api/codex/models` 补充。主列表明确返回空数组、`null` 或无效值时，不从辅助 manifest 补回权限。
- 没有速度元数据时，不按 GPT 名称、套餐名、协议或其他 key 的模型信息推断支持，也不发起收费探测。可选 manifest 失败不隐藏原模型，但不会把上次的速度能力当成当前结果。能力展示是否准确仍取决于站点报告，不能替代上游权限校验。
- 站点未报告、但你已确认某个 key 支持时，可以为原模型显式声明。以下配置也可放在站点选项或账号 `metadata` 中；同名模型在不同 key 上权限不同时，优先账号级配置：

```json
{
  "modelOverrides": {
    "gpt-example": {"serviceTiers": ["priority", "ultrafast"]}
  }
}
```

- `serviceTiers` 只声明能力，不自动启用速度；空数组明确关闭展示，支持 `fast` → `priority`、`ultraspeed` → `ultrafast` 配置别名。全局 < 站点 < 账号，数组逐层替换。声明不会添加 key 未列出的模型或授予真实权限。
- 此选择机制用于 Responses / Chat Completions 的 `service_tier`。Anthropic 原生 `speed: "fast"` 请求继续原样透传，但不把 Anthropic 或 Gemini 模型伪装成支持 OpenAI 服务档位；对这些协议显式配置非空 `serviceTiers` 会报错。站点以 OpenAI 兼容协议提供同一模型时，可按实际情况设置 `modelProtocols`。
- 每次请求仍使用所选账号自己的 Base URL、key 和协议路径。标准请求不改写 Agent 选择的模型或速度，不注入默认速度、不预读响应流；不支持时直接返回原始上游错误，不降档、不重试、不换 key 或模型。
- 需要支持插件 `serviceTiers` 的 Magpie 版本，以及能读取目录和发送对应参数的 Agent。不是所有客户端都会自动出现速度菜单；不支持菜单的客户端可自行设置标准请求参数。宿主在请求到达插件之前可能有自己的参数转换、账号重试或回退；端到端禁止回退须单独关闭这些宿主策略，插件不修改宿主配置。
- 升级后请重载插件和模型列表，并将原来的合成速度模型选择、筛选、价格覆盖或路由引用改回原模型。为兼容已保存的旧选择，当请求 ID 不在当前 key 目录、去掉末尾 `-fast` / `-ultraspeed` / `-ultrafast` 后的原 ID 在目录中，且该 key 明确声明对应档位时，插件在首次发送前转换为原 ID 加 `service_tier`（Fast 为 `priority`，另两者为 `ultrafast`）。例如 `gpt-6.1-sol-fast` 转为 `gpt-6.1-sol` 加 `service_tier: "priority"`，不增加目录模型，也不在失败后重试。真实存在的完整 ID 优先，绝不去后缀；不猜测空格、连字符或其他别名。能力未知、参数冲突或非 OpenAI 兼容协议直接报错。兼容转换仅处理大小受限的可读 JSON，流式上传不改写；旧合成模型的私有请求头标记仍明确报错，需刷新模型列表。
- 旧 `speedModels` 不再创建模型：数组仅筛选已报告的加速档，不能凭空声明支持；对象仍兼容按原 ID 显式声明能力，建议迁移到 `modelOverrides.<原模型>.serviceTiers`。默认配置和示例不再包含此旧选项。
- 原模型价格和用量元数据继续保留。速度可能影响收费；若宿主使用同一套模型单价估算所有速度档，不应把该估算当作加速档实际账单，请以站点计价和实际用量为准。

## 查询性能与诊断

管理查询有超时、响应体积限制和同账号并发合并；不对推理响应加缓冲或管理查询超时。高级配置可在全局、站点、账号 `metadata` 中逐项覆盖：

```json
{
  "diagnostics": false,
  "query": {
    "timeoutMs": 15000,
    "effortsTimeoutMs": 1000,
    "modelsTtlMs": 60000,
    "usageTtlMs": 5000,
    "effortsTtlMs": 300000,
    "maxResponseBytes": 4194304
  }
}
```

- TTL 为毫秒，设为 `0` 禁用完成结果缓存，但仍合并正在进行的相同查询；TTL 最大 1 小时。缓存是有效期内的成功结果复用，不是失败后的旧数据回退。缓存最多 128 项，超出逐出较早条目。
- 普通查询超时和思考等级查询超时分别可设为 1–60000 毫秒；JSON 大小可设为 1 字节到 64 MiB，默认 4 MiB，并检查声明长度和实际读取长度。
- 只有含 Responses 模型的列表才查询 Codex manifest，默认最多额外等 1 秒；失败后 30 秒内不重复探测，保留已知思考等级。图标发现和模型发现互不阻塞。
- 401 会清除该凭据作用域的查询缓存并标记需要登录，不影响其他 key；其他失败不作为成功缓存。没有管理查询或计费请求的自动重试。
- 开启 `diagnostics: true` 可查看固定事件名、协议、耗时、数量、缓存命中和 HTTP 状态。日志不包含账号名、模型名、站点 URL、请求体、响应体或请求头值。管理接口错误不回显站点返回的内容，避免反射密钥。

## 请求指标

这六项属于 **Magpie 的请求级统计**，不是 `/v1/usage` 返回的套餐剩余额度。插件返回原始 `Response`，不提前读取、克隆或缓存推理响应，也不调用外部用量导入接口重复上报；Magpie 据流式事件和用量字段进行统计。

| 指标 | 数据来源与口径 |
| --- | --- |
| 耗时 | 宿主测量请求开始到完成/失败；不是仅等到 HTTP 响应头的时间 |
| 首响应 | 宿主识别首个有效输出事件的时间；不是连接成功或 SSE 心跳时间 |
| token | 透传输入、输出、缓存读写和 reasoning token 等上游用量字段，不通过字符数猜测 |
| 缓存命中率 | 由宿主归一化后按缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入）计算；OpenAI 的输入包含缓存读取，Anthropic 的 `input_tokens` 则通常不含，不能重复累加 |
| 输出速度 | 宿主按有效输出 token 和首个输出后的生成时长计算；隐藏推理、非流式和瞬时突发等情况按宿主规则处理 |
| 费用 | 由宿主按该 provider/model 的有效定价及各类 token 估算；不是站点实际扣款承诺，也不以钱包前后差值代替单次费用 |

四种协议的 `usage` / `usageMetadata`、缓存细分、reasoning 用量、末尾 SSE usage 事件及上游响应头保持原样。Chat Completions 流式站点需要支持并返回 `stream_options.include_usage` 对应的 usage；若上游不报用量，缺失指标不能可靠补算。取消、失败、非流式或缺少价格时，部分指标不可得，不伪造成 0；明确的零缓存命中或零价格仍是有效数据。

价格可通过 `modelOverrides.<模型>.cost` 提供，单位为 **美元 / 百万 token**；显式价格必须同时提供输入、输出、缓存读取、缓存写入四项，0 仅用于确认免费的项。也可以使用 Magpie 自己的 provider/model 价格编辑器。不同站点的同名模型价格不同，建议用独立站点 provider，避免池化 provider 的同一模型价格歧义。插件保留上游自定义费用头，但不声称宿主会识别任意非标准费用字段。

Magpie 统计口径参考：<https://github.com/yetone/magpie/blob/main/docs/reference.md>。本仓库测试验证原始数据和流保持不变；实际 UI 展示仍需在安装的 Magpie 版本中联调。

## 套餐与余额

| Sub2API 模式 | Magpie 展示 |
| --- | --- |
| 订阅分组 | 套餐名、到期时间和已配置的日/周/月额度窗口 |
| `quota_limited` | key 总额度、5 小时/24 小时/7 天限速窗口及 key 到期时间 |
| 余额分组 | 套餐名和钱包余额 |

- 使用 Sub2API 公开接口，沿用上游插件对 Sub2API >= 0.2.14 的兼容目标；未对真实站点或服务版本矩阵完成验证。
- 只显示当前 key 绑定分组的信息，不查询用户所有分组套餐、可购买套餐或管理员接口。
- 余额不形成时间窗口，因此只显示余额，不会因余额低而触发 Magpie 的用量窗口路由。
- 优先使用服务端返回的重置时间；周窗口可按开始时间 + 7 天回退计算，日/月不猜测。
- key 失效（401）会标记为需要重新登录；模型列表失败直接报错，不回退到其他模型或把旧列表当作成功刷新。
- 协议可自动判断或显式配置，但最终能否调用取决于 Sub2API 站点、key 分组及上游开放的端点和模型权限。这里覆盖四类对话协议，不代表实现所有厂商私有协议、网页 Cookie 登录、实时音视频、图片生成、嵌入或批处理接口。

## 开发与验证

在 Git 源码仓库中运行一次 `npm run hooks:install`，启用本地提交钩子。之后普通 `git commit` 自动将 `package.json` 的补丁版本相对 HEAD 递增，并纳入同一提交；已暂存的更高版本保留，提交失败后重试不会重复递增。提交信息使用中文。`package.json` 含未暂存改动时会停止，先确认并暂存预期改动；钩子不自动收录其他文件、不创建额外提交、不发布 npm 包或打标签。每个新 clone 需重新启用，`--no-verify` 会绕过钩子，不用于普通提交。

```sh
npm run check
npm test
npm pack --dry-run
```

测试无需 API key、npm 依赖或 Docker。覆盖套餐、余额、分页全量模型、模型元数据保留、请求头覆盖顺序、账号隔离、四种协议、显式别名、协议路径重写、Gemini 认证、请求体/取消信号保留、URL 安全、失败不回退、查询缓存/体积/超时限制，以及图标发现和凭据隔离。速度测试验证无额外模型、当前 key 的服务档位发现、元数据优先级、未知能力不推断、原模型速度参数透传、并发隔离及旧选择迁移。指标测试验证四种协议的 JSON/SSE 用量、缓存与 reasoning 字段不丢失、流不被预读、未知价格不造零。真实 loopback HTTP 测试覆盖多 key 对应地址和凭据、原模型速度选择、SSE、取消、图标获取与重定向拒绝；环境禁止监听本地端口时会明确跳过相关项。CI 在 Linux/macOS 和 Node.js 20/22/24 上运行相同检查、测试和打包预览。

本地测试不等于真实 Magpie/Sub2API 联调。连接自己的站点后，请在 Magpie 中验证用量和模型列表，再发起一次模型请求；附加头是否抵达可通过自有网关访问日志确认（请勿记录认证值）。

Magpie 插件接口文档：<https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html>。

## 许可证与来源

代码使用 MIT 许可，见 [LICENSE](./LICENSE)。包内 `image.png` 来自 [Sub2API 官方 logo.svg](https://github.com/Wei-Shaw/sub2api/blob/main/assets/logo.svg)，仅用于项目图标和品牌归属，不作为 MIT 代码许可的一部分。运行时获取的网页图标仍归各站点或其权利人所有，不作为本包的 MIT 资源分发。
