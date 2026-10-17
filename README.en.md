[中文](./README.md)

# sub2api-magpie-plugin

Connect a [Sub2API](https://github.com/Wei-Shaw/sub2api) site to [Magpie](https://usemagpie.ai). Display the current API key's plan, usage, balance and models, and attach configurable headers to discovery, usage and model requests.

Based on [broven/magpie-sub2api](https://github.com/broven/magpie-sub2api) 0.2.1 (MIT), with layered headers, validation and local tests added. No build or runtime dependencies. Node.js >= 20.

## Local Installation

From this project directory:

```sh
magpie plugin add "$PWD"
magpie plugin login sub2api
```

This package is named `sub2api-magpie-plugin`; the old name `magpie-sub2api` is no longer used for this project's plugin-options commands. If an old-name or npm version is installed, check `magpie plugin list` and switch its source to this local directory. Avoid loading two plugins that provide the same provider. Installation by package name depends on publication to npm; this rename does not publish the package. This project does not automatically change installed plugins, accounts or configuration.

Provider IDs are unchanged: sign in with `magpie plugin login sub2api` and select `sub2api/<model>`. Existing accounts and custom site IDs remain intact. Plugin options now use `magpie plugin options sub2api-magpie-plugin`.

The only extra sign-in prompt is the site's **Base URL**, such as `https://api.example.com`. Do not add API operation paths or select a vendor/protocol. Paths, account names and protocol selection are automatic. Authentication still requires an API key collected separately by Magpie's API key form; the public site address alone cannot identify a private subscription or wallet.

Alternatively, set just `{"baseUrl":"https://api.example.com"}` in plugin options. Sign-in then asks only for the API key. `url`, `baseURL` and `baseUrl` are accepted in that order of precedence. This default does not override a saved account URL. HTTP/HTTPS, IP addresses with ports and deployment prefixes are supported. All configuration below is optional and intended for advanced overrides.

Each sign-in adds an account to the `sub2api` pool. New default names contain the host, last four key characters and a short URL/key digest to reduce collisions between keys or deployment paths. Existing account IDs remain unchanged. Do not rename an account after first use: Magpie indexes its models and settings by that name. Previously saved account names and advanced metadata remain supported.

### Automatic Site Icons

With a configured site address, the plugin discovers the home page's `<link rel="icon">` / `apple-touch-icon` while loading configuration, falling back to `favicon.ico` under the deployment prefix and then at the origin root. Accounts that supply their URL only at sign-in discover their icon in the background when loading models, without blocking the catalog. The configuration hook still waits for the initial icon so the host can read it. HTTP/HTTPS, IP addresses with ports and deployment prefixes work without an extra image option.

- Separate site providers have separate icons. The pooled `sub2api` provider uses the first account whose models are loaded during this plugin instance, so later accounts cannot overwrite it. A configured default URL supplies the icon only until an account is loaded.
- Images reach Magpie through `auth.icon` as `data:image/…` URIs. PNG, JPEG, GIF, WebP, ICO and SVG are supported; no downloaded files are written into the repository or package.
- Home page and image requests send no API key, custom headers or cookies. Only the configured origin is contacted, without redirects, external CDNs or parent-domain discovery. Icons requiring authentication, redirects or cross-origin requests may be unavailable.
- Each lookup shares a three-second timeout, a 512 KiB page limit, a 1 MiB image limit and a bounded candidate count. Successful lookups cache for one hour in memory; failures cache for five minutes, with retries on later configuration/model loads. Failed refreshes retain the last icon and never break models, usage or inference.

This sets the **provider picture**. Magpie's marketplace/installed plugin card uses the static package-level `magpie.icon`, which cannot follow account URLs dynamically; this plugin does not rewrite `package.json` to change that card.

## Advanced Headers and Separate Sites

Add `headers` in Magpie's plugin options editor only when needed. A minimal configuration with advanced headers is `{"baseUrl":"https://api.example.com","headers":{"User-Agent":"my-client","X-Client":"magpie"}}`. These headers apply to usage, model discovery and actual inference requests. They do not add any ordinary sign-in prompts.

When Codex and Claude need different client identity headers, use `protocolHeaders`.
`codex` aliases `responses`, and `claude` aliases `anthropic`; these headers are attached only
to inference requests, not usage or model discovery:

```json
{
  "protocolHeaders": {
    "codex": { "originator": "codex_cli_rs" },
    "claude": { "anthropic-beta": "interleaved-thinking-2025-05-14" }
  }
}
```

Protocol headers have lower precedence than global, site and account `headers`; an explicitly
configured header with the same name still wins. Accounts may also set
`metadata.protocolHeaders`.

```sh
magpie plugin options sub2api-magpie-plugin '{
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

Inference sets a protocol-specific compatibility `User-Agent`, replacing Magpie's or the caller's UA, including an empty value. These identifiers are not the SDK versions installed by the host:

| API protocol | Default `User-Agent` |
| --- | --- |
| `responses` (default for GPT / Codex) | `codex_cli_rs/0.146.0 (sub2api-magpie-plugin)` |
| `chat-completions` | `OpenAI/JS (sub2api-magpie-plugin)` |
| `anthropic` | `anthropic-typescript (sub2api-magpie-plugin)` |
| `gemini` | `google-genai-sdk (sub2api-magpie-plugin)` |

Selection follows the actual request's API type rather than re-parsing the model name, including `modelProtocols` overrides and custom `apiPaths`. UA precedence is **caller UA < protocol default UA < protocolHeaders < global headers < site headers < account headers**, case-insensitively. Remove any old `User-Agent` override from ordinary `headers` to switch automatically by protocol; use `protocolHeaders.codex` / `protocolHeaders.claude` for separate explicit UAs. Usage, model discovery, Codex reasoning-level queries and unrecognized endpoints do not receive these defaults and keep their existing custom headers.

Except for plugin-managed fields such as UA and authentication, inference forwards the caller's other request headers. Codex's `originator`, `session-id` and all `x-codex-*` headers are preserved; duplicate values in `init.headers` override `Request.headers`, while explicitly configured protocol, global, site or account headers still have higher precedence.

Responses requests also fill missing headers from the JSON body's `client_metadata`: `session_id` becomes `session-id`, `thread_id` becomes `thread-id`, and string-valued `x-codex-*` fields keep their names. Existing headers, including `session_id` / `thread_id` aliases, win. No other arbitrary fields are copied, no installation/window/session identifiers are generated, and the body is unchanged. This conversion does not apply to Claude, Chat Completions, Gemini or management endpoints.

Metadata inspection supports strings, bytes, Blobs and a cloned `Request`, reading at most 1 MiB. Clone reads wait at most 15 seconds and honor cancellation. Direct `ReadableStream` uploads in `init.body`, encoded bodies and oversized bodies are passed to fetch without conversion; existing HTTP headers are still preserved. Invalid JSON or header values are ignored, and added metadata headers are capped at 8 KiB in total. These headers can contain client, session and local workspace information; send them only to trusted providers and remove unwanted metadata at the caller.

These identifiers provide protocol compatibility; they do not make Magpie an official client or change account permissions. If `This account only allows Codex official clients` persists, the site may also validate request bodies or other client characteristics. Ask the administrator to allow compatible clients for the account, or use a supported official client.

Headers must be a JSON object with string values and valid names. Line breaks, NUL, authentication headers and transport-managed headers are rejected. Use the account API key rather than setting `Authorization`, `X-API-Key` or `X-Goog-API-Key`. Reserved transport headers include `Host`, `Content-Length`, `Connection`, `Transfer-Encoding`, `Upgrade`, `Keep-Alive`, `TE`, `Trailer`, proxy authorization/connection headers and `Accept-Encoding`. Validation errors do not include header values.

Inference is restricted to the account's origin and configured protocol paths, including its deployment prefix. Redirects are rejected on all requests to avoid leaking credentials or custom headers; configure the final API URL instead. Site URLs cannot contain credentials, query strings or fragments. HTTP is allowed for local development; use HTTPS in production. Do not commit secrets or put them in shell history.

Site IDs must start with a lowercase letter or digit, contain only lowercase letters, digits, `-` or `_`, and be at most 40 characters. They must be unique and not `sub2api`. An omitted ID is derived from the hostname. Invalid sites are skipped with a diagnostic; invalid header configuration fails rather than silently dropping headers. Changing an ID requires signing in again.

## Models and Usage

- `GET /v1/models`: models available to this key's group. Auto mode uses Messages for Claude, Responses for OpenAI model names, native Gemini for Gemini names, and Chat Completions for domestic/other compatible models. Namespaced model IDs are recognized as well.
- `GET /backend-api/codex/models`: optional reasoning levels, queried only for catalogs containing Responses models, with a separate one-second timeout. Existing levels or model-name-based defaults are retained when unavailable.
- `GET /v1/usage`: subscription day/week/month windows and expiry, key quota/rate-limit windows, or wallet balance.
- Usage-window exhaustion participates in Magpie routing. Wallet balance is displayed only, without a routing window.
- Only the current key's group is visible, not all user subscriptions or purchasable plans.
- Reset times come from the server; weekly start + 7 days is a fallback, but daily/monthly reset times are not guessed.
- HTTP 401 marks sign-in as expired. Model-list failures propagate rather than returning host defaults, another key's models or a stale catalog as a successful refresh.
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

## Complete Catalogs and Multiple Keys

Every API-key sign-in is a separate account. Its `/v1/models` request uses that account's key and returns all valid model IDs by default, including unfamiliar names, namespaced IDs and non-chat models. Listing an image or embedding model does not implement its non-conversational API.

- Supports `data` lists, `has_more` / `last_id` cursor pagination and `next` URLs. Every page stays on this account's exact `/v1/models` endpoint, including the deployment prefix. More than 100 pages, excessive combined JSON size, cycles, unsafe URLs or a failed page produce an error, never a truncated catalog.
- Magpie receives each account's own model list. A model listed only by A uses A's transport; one listed only by B uses B's. For shared model IDs, Magpie chooses an eligible account, then uses that account's Base URL, key and headers. Keys are not embedded in model objects or bound globally to the last account loaded.
- Keys may belong to different sites or different groups on one site. In-memory query caches use digests of the address, key and merged headers, without persisting credentials.
- Refreshes preserve known context/output limits, prices, capabilities, options and model headers, while rebuilding the current account's model identity, SDK and API address. Unknown prices are omitted instead of set to zero; protocol alone does not determine vision or reasoning support.
- Failed discovery throws. It does not return a host default, another account's list or an expired list as success. Recorded failures also block an already-created account transport from using a catalog the host may retain, until discovery recovers. Safely inspectable request model IDs are checked against the discovered account catalog; streaming uploads are not consumed for this check.
- Inference sends once and leaves the model unchanged, returning the original response/status/stream or network error. The plugin does not retry, switch keys or substitute models. Host routing groups and provider fallbacks remain Magpie settings, not settings this plugin rewrites. To forbid model fallback end to end, clear host fallback models and select `sub2api/<model>` or a site model directly. To pin a key, clients can send `X-Magpie-Account: <account name or ID>` to Magpie; do not configure it as an extra upstream header.

### Optional Filters and Metadata Overrides

Without filters, every real key model remains visible, without additional speed models. `includeModels` and `excludeModels` are exact full-ID lists, applied only when explicitly configured. `includeModels: []` deliberately hides all models. `modelNames` changes display names, never wire model IDs:

```json
{
  "excludeModels": ["unused-model"],
  "modelNames": {"custom-vision": "My Vision Model"},
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

Values are illustrative: use your site's actual capabilities and prices. Overrides apply only to models already returned for the key; they do not create permissions. Precedence is global < site < account metadata. Filter arrays replace earlier arrays, names merge per ID, and metadata overrides merge deeply. Allowed fields are `name`, `limit`, `cost`, `capabilities`, `options`, `headers`, `variants`, `release_date`, `status` and `serviceTiers`, not model identity, API routing or credentials. `serviceTiers` arrays replace earlier arrays. Model headers obey reserved-header validation. Continue using `modelProtocols` for protocol overrides.

### Select Fast / Ultraspeed On The Original Model

The catalog contains only real IDs returned by the site. Supported service tiers reported for the current key are attached to each original model as `serviceTiers`. Magpie can offer them to agents that understand tier catalogs, such as compatible Codex versions. No `-fast` / `-ultraspeed` models are generated, and model IDs, display names, reasoning levels and default speeds stay unchanged.

| Agent selection | OpenAI-compatible request parameter | Upstream model ID |
| --- | --- | --- |
| Normal / default | No additional speed parameter | `gpt-example` |
| Fast | `service_tier: "priority"` | `gpt-example` |
| Ultraspeed / Ultrafast | `service_tier: "ultrafast"` | `gpt-example` |

For example, an agent selects Fast while calling `sub2api/gpt-example` through Magpie:

```json
{"model":"sub2api/gpt-example","input":"hello","service_tier":"priority"}
```

After Magpie selects an account, the upstream model is `gpt-example`, with `priority` unchanged. `ultraspeed` is a configuration alias: the wire value is `ultrafast`, not `service_tier: "ultraspeed"`.

- **Only evidence-backed capabilities are advertised.** The current key's `/v1/models` supplies `service_tiers` / `serviceTiers`, accepting strings or objects such as `{ "id": "priority" }`. For catalogs containing Responses models, absent fields can be supplemented by the same key's `/backend-api/codex/models`. An explicit empty array, `null` or malformed primary value is not filled back in from the optional manifest.
- Missing speed metadata is not inferred from a GPT name, subscription label, protocol or another key's host metadata. No billable capability probes are sent. An unavailable optional manifest does not hide the model, but its previous tiers are not reused as current capabilities. Site-reported capabilities still cannot replace upstream authorization checks.
- If metadata is missing but you have verified a key's support, declare it explicitly on the original model. This configuration also works in site options or account `metadata`; prefer account-level overrides when keys have different eligibility for the same model:

```json
{
  "modelOverrides": {
    "gpt-example": {"serviceTiers": ["priority", "ultrafast"]}
  }
}
```

- `serviceTiers` declares capability without enabling speed by default. An empty array explicitly hides it. Configuration aliases `fast` and `ultraspeed` normalize to `priority` and `ultrafast`. Precedence is global < site < account; arrays replace. Declarations neither add unlisted models nor grant real permissions.
- This mechanism targets Responses / Chat Completions `service_tier`. Native Anthropic `speed: "fast"` requests still pass through unchanged, but Anthropic and Gemini are not advertised as supporting OpenAI service tiers. Explicit nonempty `serviceTiers` on these protocols fails. If a site serves such a model over an OpenAI-compatible API, set `modelProtocols` accordingly.
- Each request uses its selected account's Base URL, key and protocol path. The plugin does not rewrite the agent's model or speed, inject a default tier or pre-read response streams. Unsupported tiers return the original upstream error without downgrading, retrying or changing keys/models.
- Magpie must support plugin `serviceTiers`, and the agent must understand the catalog and send the corresponding parameter. Not every client automatically gains a speed menu; clients without one can set standard request fields themselves. The host may translate parameters or apply account retries/fallbacks before the plugin sees a request. Disable those host policies separately for end-to-end no-fallback behavior; this plugin never changes them.
- After upgrading, reload the plugin and model catalog. Replace old synthetic-model selections, filters, prices or routing references with the original model. Cached synthetic-model selectors fail explicitly instead of silently dropping the requested speed. Real upstream IDs that happen to end in `-fast` or similar remain valid.
- Legacy `speedModels` no longer creates models: arrays only filter reported acceleration tiers and cannot invent support; objects remain compatible as per-original-ID capability declarations. Migrate to `modelOverrides.<original-id>.serviceTiers`. Defaults and examples no longer include this legacy option.
- Original price and usage metadata remain intact. Speed can affect billing: if the host estimates all tiers with one model price, do not treat that estimate as the actual accelerated-tier bill. Follow the site's pricing and actual usage.

## Query Performance and Diagnostics

Management queries have bounded bodies, timeouts and same-account concurrent request coalescing. These limits do not buffer inference responses or impose a management timeout on them. Global, site and account `metadata` layers can override these options individually:

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

- TTLs are milliseconds, up to one hour. Set a TTL to `0` to disable completed-result caching while still coalescing in-flight queries. Reusing a successful result within its TTL is not stale fallback after failure. The query cache holds at most 128 entries, evicting earlier entries when full.
- Query and reasoning timeouts accept 1-60000 milliseconds. JSON size accepts 1 byte to 64 MiB, default 4 MiB, checking both declared and actually read sizes.
- Only catalogs containing Responses models query the Codex manifest, with a separate one-second budget by default. Failed probes are cached for 30 seconds; known reasoning levels survive. Account icon discovery no longer delays model discovery.
- HTTP 401 invalidates queries for that credential scope and marks sign-in expired, without affecting other keys. Other required-query failures are not success-cached. Neither management queries nor billable inference requests automatically retry.
- `diagnostics: true` emits fixed event names, protocols, timings, counts, cache hits and HTTP status codes. Logs contain no account/model names, site URLs, bodies or header values. Management errors do not echo upstream bodies, which might reflect credentials.

## Request Metrics

These six metrics are **Magpie request-level statistics**, distinct from remaining plan allowance returned by `/v1/usage`. The plugin returns the original `Response`, without pre-reading, cloning or buffering inference bodies. It does not post duplicate records to external usage-ingestion endpoints. Magpie measures the stream and reads upstream usage fields.

| Metric | Source and meaning |
| --- | --- |
| Duration | Host-measured request start through completion/failure, not just time to HTTP headers |
| First response | First effective output event recognized by the host, not connection time or SSE heartbeats |
| Tokens | Upstream input/output, cache-read/write and reasoning counts, never character-count guesses |
| Cache hit rate | Host-normalized cache reads / (uncached input + cache reads + cache writes); OpenAI input counts already include cache reads, whereas Anthropic `input_tokens` usually exclude them |
| Output speed | Effective output tokens over the generation window after first output; hidden reasoning, unstreamed replies and bursts follow the host's rules |
| Cost | Host estimate using effective provider/model prices and token tiers, not a promise of the site's actual charge or a wallet-balance delta |

All four protocols preserve `usage` / `usageMetadata`, cache subdivisions, reasoning counts, final SSE usage events and upstream response headers unchanged. Streaming Chat Completions sites must support and return usage corresponding to `stream_options.include_usage`. Missing upstream usage cannot be reliably reconstructed. Cancelled, failed, non-streaming or unpriced requests may lack some metrics; missing is not fabricated as zero. Explicitly known zero cache hits or zero prices remain valid.

Set `modelOverrides.<id>.cost` in **USD per million tokens**, providing all four prices: input, output, cache read and cache write. Use zero only for a confirmed free tier. Alternatively, use Magpie's provider/model price editor. For different prices of the same model at different sites, prefer separate site providers instead of an ambiguous pooled provider/model price. Custom upstream cost headers are preserved, but arbitrary nonstandard cost fields are not guaranteed to be recognized by the host.

Magpie's metric definitions: <https://github.com/yetone/magpie/blob/main/docs/reference.md>. Repository tests verify transparent source data and streams; UI behavior still needs integration testing with the installed Magpie version.

## Testing

In a Git source checkout, run `npm run hooks:install` once to enable the local commit hook. Ordinary `git commit` then increments the package patch version relative to HEAD and includes it in the same commit. An already-staged higher version is preserved, so retrying a failed commit does not bump twice. Use Chinese commit messages. Unstaged `package.json` edits abort the commit: review and stage the intended changes first. The hook stages no unrelated files, creates no extra commit and does not publish to npm or create tags. Enable it again for each clone; `--no-verify` bypasses it and is not for ordinary commits.

```sh
npm run check
npm test
npm pack --dry-run
```

Tests require no dependencies, Docker or credentials. They cover usage conversion, full paginated catalogs, metadata preservation, header precedence, account isolation, all four conversational protocols, explicit aliases, path rewriting, authentication, URL checks, no-fallback failures, query caching/size/time limits and icon isolation. Speed tests verify no synthetic models, per-key tier discovery, metadata precedence, no inferred eligibility, unchanged native parameters, concurrency and legacy-selector migration. Metric tests preserve JSON/SSE usage, cache and reasoning tiers without pre-reading streams or fabricating free prices. Loopback HTTP tests check matching multi-key destinations/credentials, original-model speed selection, actual headers, SSE, cancellation, icon fetching and redirect rejection; they explicitly skip if local listening is prohibited. CI runs checks, tests and package previews on Linux/macOS with Node.js 20/22/24.

These tests do not replace live Magpie/Sub2API integration. Verify usage, model discovery and a model request in Magpie against your own site. Inspect custom headers only in logs you control, without logging credentials.

Plugin API reference: <https://github.com/yetone/magpie/blob/main/site/public/docs/plugins.html>.

## License and Attribution

Based on broven/magpie-sub2api 0.2.1 by Randy (broven), under MIT. The original copyright notice is retained in [LICENSE](./LICENSE); local extensions use MIT as well. The upstream Sub2API icon is not included because its license differs from the code's. Site icons fetched at runtime remain the property of their respective owners and are not distributed as MIT assets in this package.
