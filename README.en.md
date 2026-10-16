[中文](./README.md)

# magpie-sub2api

Connect a [Sub2API](https://github.com/Wei-Shaw/sub2api) site to [Magpie](https://usemagpie.ai). Display the current API key's plan, usage, balance and models, and attach configurable headers to discovery, usage and model requests.

Based on [broven/magpie-sub2api](https://github.com/broven/magpie-sub2api) 0.2.1 (MIT), with layered headers, validation and local tests added. No build or runtime dependencies. Node.js >= 20.

## Local Installation

From this project directory:

```sh
magpie plugin add "$PWD"
magpie plugin login sub2api
```

If the npm package is already installed, check `magpie plugin list` and switch its source to this local directory. Installing `magpie-sub2api` by package name uses the registry version, which may not contain these changes. This project does not automatically change your installed plugins or accounts.

The only extra sign-in prompt is the site's **Base URL**, such as `http://179.255.97.172:3005` or `https://api.pingcodes.cc`. Do not add API operation paths or select a vendor/protocol. Paths, account names and protocol selection are automatic. Authentication still requires an API key collected separately by Magpie's API key form; the public site address alone cannot identify a private subscription or wallet.

Alternatively, set just `{"baseUrl":"https://api.pingcodes.cc"}` in plugin options. Sign-in then asks only for the API key. `url`, `baseURL` and `baseUrl` are accepted in that order of precedence. This default does not override a saved account URL. HTTP/HTTPS, IP addresses with ports and deployment prefixes are supported. All configuration below is optional and intended for advanced overrides.

Each sign-in adds an account to the `sub2api` pool. Do not rename an account after first use: Magpie indexes its models and settings by that name. Previously saved account names and advanced metadata remain supported.

## Advanced Headers and Separate Sites

Add `headers` in Magpie's plugin options editor only when needed. A minimal configuration with advanced headers is `{"baseUrl":"https://api.pingcodes.cc","headers":{"User-Agent":"my-client","X-Client":"magpie"}}`. These headers apply to usage, model discovery and actual inference requests. They do not add any ordinary sign-in prompts.

```sh
magpie plugin options magpie-sub2api '{
  "headers": {
    "User-Agent": "my-magpie-client",
    "X-Client": "magpie"
  },
  "sites": [
    {
      "id": "primary",
      "name": "Primary",
      "url": "https://api.example.com",
      "headers": {"X-Channel": "primary"}
    }
  ]
}'
magpie plugin login primary
```

The same JSON can be entered in Magpie's plugin options editor. A site provider uses its fixed URL; its models are named `primary/<model>`. The pooled `sub2api` provider remains available. Up to eight independent sites are supported.

Header precedence is **global < site < account**, case-insensitively. Advanced account headers are stored as `metadata.headers` (an object or JSON object string); they are no longer a sign-in prompt. Site headers do not apply to other sites or pooled accounts. The final merged headers are enforced in the account's fetch function, so callers cannot override them. Values are literal; environment expansion and templates are not supported.

Inference automatically sets a protocol-specific compatibility `User-Agent` (not the SDK version installed by the host):

| API protocol | Default `User-Agent` |
| --- | --- |
| `responses` (default for GPT / Codex) | `codex_cli_rs/0.146.0 (magpie-sub2api)` |
| `chat-completions` | `OpenAI/JS (magpie-sub2api)` |
| `anthropic` | `anthropic-typescript (magpie-sub2api)` |
| `gemini` | `google-genai-sdk (magpie-sub2api)` |

Selection follows the actual request's API type rather than re-parsing the model name, including `modelProtocols` overrides and custom `apiPaths`. Precedence is **caller headers < protocol defaults < global headers < site headers < account headers**, case-insensitively. An explicit `User-Agent`, including an empty string, overrides the automatic value; remove any old override to enable automatic selection. Usage, model discovery and Codex reasoning-level queries do not receive these defaults and keep their existing custom headers.

These identifiers provide protocol compatibility; they do not make Magpie an official client or change account permissions. If `This account only allows Codex official clients` persists, the site may also validate request bodies or other client characteristics. Ask the administrator to allow compatible clients for the account, or use a supported official client.

Headers must be a JSON object with string values and valid names. Line breaks, NUL, authentication headers and transport-managed headers are rejected. Use the account API key rather than setting `Authorization`, `X-API-Key` or `X-Goog-API-Key`. Reserved transport headers include `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`, `Keep-Alive`, `TE`, `Trailer`, proxy authorization/connection headers and `Accept-Encoding`. Validation errors do not include header values.

Inference is restricted to the account's origin and configured protocol paths, including its deployment prefix. Redirects are rejected on all requests to avoid leaking credentials or custom headers; configure the final API URL instead. Site URLs cannot contain credentials, query strings or fragments. HTTP is allowed for local development; use HTTPS in production. Do not commit secrets or put them in shell history.

Site IDs must start with a lowercase letter or digit, contain only lowercase letters, digits, `-` or `_`, and be at most 40 characters. They must be unique and not `sub2api`. An omitted ID is derived from the hostname. Invalid sites are skipped with a diagnostic; invalid header configuration fails rather than silently dropping headers. Changing an ID requires signing in again.

## Models and Usage

- `GET /v1/models`: models available to this key's group. Auto mode uses Messages for Claude, Responses for OpenAI model names, native Gemini for Gemini names, and Chat Completions for domestic/other compatible models. Namespaced model IDs are recognized as well.
- `GET /backend-api/codex/models`: optional reasoning levels. Existing levels or defaults are retained when unavailable.
- `GET /v1/usage`: subscription day/week/month windows and expiry, key quota/rate-limit windows, or wallet balance.
- Usage-window exhaustion participates in Magpie routing. Wallet balance is displayed only, without a routing window.
- Only the current key's group is visible, not all user subscriptions or purchasable plans.
- Reset times come from the server; weekly start + 7 days is a fallback, but daily/monthly reset times are not guessed.
- HTTP 401 marks sign-in as expired; transient model-list failures retain the previous catalog.
- Model response status, streaming bodies and cancellation signals are preserved.

The inherited compatibility target is Sub2API >= 0.2.14. No live site or server-version matrix has been validated for this local extension. Endpoint availability still depends on the site and key's group. Support covers four conversational protocols, not every vendor's private web login, realtime audio/video, images, embeddings or batch APIs.

## Protocol Selection and Custom Base Paths

Vendor categories are not wire protocols. No manual selection is required in normal use. Advanced users can set `protocol` globally, per site or in account metadata (in that order of precedence). Omit it to inherit, or use `auto` to restore name-based detection. Site address keys support the same aliases as the top-level default. `examples/options.json` shows optional Anthropic, OpenAI, domestic and mixed model provider overrides.

| Protocol | Default endpoint | Aliases |
| --- | --- | --- |
| `anthropic` | `/v1/messages` | `messages` |
| `responses` | `/v1/responses` | `openai` |
| `chat-completions` | `/v1/chat/completions` | `openai-compatible`, `chat_completions` |
| `gemini` | `/v1beta/models/{model}:generateContent` or `:streamGenerateContent` | `google` |

Override misleading model names with `modelProtocols`, a map of exact full model IDs to protocol names. Rules merge global < site < account and override the default protocol. For example, use `{"modelProtocols":{"gpt-legacy":"chat-completions","custom-alias":"anthropic"}}`. Domestic models can use Anthropic format when the site requires it; Gemini can use Chat Completions when that is the endpoint your site exposes.

Set `apiPaths` to override the base path for each protocol, e.g. `{"apiPaths":{"anthropic":"/antigravity/v1","gemini":"/antigravity/v1beta"}}`. Paths are relative to the Sub2API site root, may include a deployment prefix, and must not contain the final operation (`messages`, `responses`, etc.), an external origin, traversal or query string. `/` means the site root. Management endpoints remain `/v1/models` and `/v1/usage` under that root.

The loader's base URL overrides per-model URLs in Magpie; the account fetch function therefore resolves the operation's protocol and selects the final path, including native Gemini `/v1beta/`. Only the account origin and configured API paths are allowed. Anthropic gets the selected account's `x-api-key` and a default `anthropic-version` when absent. Gemini gets `x-goog-api-key`, and caller-provided query-string `key` values are removed. These settings are also available in account metadata as `protocol`, `modelProtocols` and `apiPaths`; reload the account and model list after changing them.

## Testing

```sh
npm run check
npm test
npm pack --dry-run
```

Tests require no dependencies, Docker or credentials. They cover usage conversion, discovery, header precedence, account isolation, all four conversational protocols, explicit model aliases, path rewriting, authentication, URL checks and failure handling. A loopback HTTP test checks actual headers, SSE, cancellation and redirect rejection; it is explicitly skipped if local listening is prohibited.

These tests do not replace live Magpie/Sub2API integration. Verify usage, model discovery and a model request in Magpie against your own site. Inspect custom headers only in logs you control, without logging credentials.

Plugin API reference: <https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html>.

## License and Attribution

Based on broven/magpie-sub2api 0.2.1 by Randy (broven), under MIT. The original copyright notice is retained in [LICENSE](./LICENSE); local extensions use MIT as well. The upstream Sub2API icon is not included because its license differs from the code's.
