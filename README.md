[English](./README.en.md)

# magpie-sub2api

将 [Sub2API](https://github.com/Wei-Shaw/sub2api) 站点接入 [Magpie](https://usemagpie.ai)：查看当前 API key 对应的套餐、余额和模型，并在查询和模型发送请求中附加自定义请求头。

本项目基于 [broven/magpie-sub2api](https://github.com/broven/magpie-sub2api) 0.2.1（MIT）扩展，新增分层请求头配置、安全校验和本地测试。使用 Magpie 的 provider 插件接口，无运行时依赖，无需构建；需要 Node.js >= 20。

## 功能

- **套餐和用量**：读取 `GET /v1/usage`，显示套餐名、到期时间、日/周/月额度，或 key 总额度及限速窗口。
- **余额**：余额计费的 key 显示钱包余额，包括零余额。
- **模型列表**：读取 `GET /v1/models`，可选读取 `GET /backend-api/codex/models` 获取思考等级；后者不可用时保留已知等级或使用默认值。
- **请求头**：支持全局、站点和账号级配置，查询及实际模型发送均生效，大小写不敏感地合并。
- **多站点/多账号**：可共用 `sub2api` 池，也可配置最多 8 个独立站点 provider。

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

如果之前安装过 npm 版同名插件，先确认 `magpie plugin list`，再将插件来源切换到此本地目录。`magpie plugin add magpie-sub2api` 安装的是注册表版本，不保证包含本项目的改动。本项目没有自动修改本机现有插件、账号或配置。

普通使用只需要配置站点 **Base URL**，例如：

```text
http://179.255.97.172:3005
https://api.pingcodes.cc
```

不需要手动添加 `/v1`、选择厂商/协议、填写账号名或额外请求头。插件自动补齐接口路径、发现模型，并按模型名称选择协议；账号默认使用站点域名和 key 的后四位命名。

**认证仍需要 API key**，由 Magpie 的 API key 登录表单单独收集。仅凭公开的站点地址无法查看某个账号的私有套餐、余额或发送计费请求。

也可以直接在插件选项里只填一个 `baseUrl`：

```json
{"baseUrl":"https://api.pingcodes.cc"}
```

这样登录时连站点地址也无需再次填写，只输入 API key 即可。`baseUrl`、`baseURL`、`url` 都支持（同时存在时优先 `url`，其次 `baseURL`）。这只是没有保存站点地址的账号的默认地址，不会覆盖已有账号保存的站点。HTTP 和 HTTPS、IP 加端口、部署路径前缀均支持。

以下请求头、多站点、协议规则均为高级可选配置，正常使用无需填写。已有账号的名称和高级元数据仍兼容。Magpie 按账号名称记录模型和能力；修改名称时建议删除账号后重新登录。

## 高级：自定义请求头

需要额外请求头时，在 Magpie 的插件选项编辑器中添加 `headers` 即可，不需要重新选择协议。例如：

```json
{
  "baseUrl": "https://api.pingcodes.cc",
  "headers": {
    "User-Agent": "my-client",
    "X-Client": "magpie"
  }
}
```

这里的 `headers` 对套餐/余额查询、模型列表和实际模型发送均生效；没有特殊要求时保留空对象或省略。

### 全局和站点

```sh
magpie plugin options magpie-sub2api '{
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
- 请求发送时再次强制应用合并结果，因此调用方不能覆盖你指定的 `User-Agent` 等请求头。
- 账号请求头保存在 Magpie 认证元数据 `metadata.headers` 中，可为对象或 JSON 对象字符串；修改后需让 Magpie 重新加载账号。
- 不做环境变量展开或模板替换，值按字面发送。敏感值不要提交到代码仓库，也不要直接写入会记录历史的终端命令。

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
      "id": "all-models",
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
- key 失效（401）会标记为需要重新登录；模型列表临时失败时保留 Magpie 已有列表。
- 协议可自动判断或显式配置，但最终能否调用取决于 Sub2API 站点、key 分组及上游开放的端点和模型权限。这里覆盖四类对话协议，不代表实现所有厂商私有协议、网页 Cookie 登录、实时音视频、图片生成、嵌入或批处理接口。

## 开发与验证

```sh
npm run check
npm test
npm pack --dry-run
```

测试无需 API key、npm 依赖或 Docker。覆盖套餐、余额、模型发现、请求头覆盖顺序、账号隔离、四种协议、显式别名、协议路径重写、Gemini 认证、请求体/取消信号保留、URL 安全和错误回退。另有真实 loopback HTTP 测试覆盖发送、SSE、取消与重定向拒绝；环境禁止监听本地端口时会明确跳过该项。

本地测试不等于真实 Magpie/Sub2API 联调。连接自己的站点后，请在 Magpie 中验证用量和模型列表，再发起一次模型请求；附加头是否抵达可通过自有网关访问日志确认（请勿记录认证值）。

Magpie 插件接口文档：<https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html>。

## 许可证与来源

代码基于 broven/magpie-sub2api 0.2.1，保留原作者 Randy (broven) 的 MIT 版权声明，见 [LICENSE](./LICENSE)。本地扩展沿用 MIT。不包含上游 Sub2API 图标，以避免与代码不同的图标许可证混用。
