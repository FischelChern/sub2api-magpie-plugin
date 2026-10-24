// sub2api-magpie-plugin: any sub2api site (github.com/Wei-Shaw/sub2api) as a
// magpie provider. Sign in with the site's address and an API key; the
// models the key's group serves are spoken to on the site's own endpoints,
// and auth.usage tells magpie what the key has left (its subscription's day,
// week and month, the key's own quota and rate limits, or the wallet's
// balance), as the gateway's GET /v1/usage has it.
//
// Only upstream sub2api's public endpoints are asked (/v1/models,
// /backend-api/codex/models, /v1/usage), so any sub2api site from 0.2.14
// on works. Two ways to have sites, both at once if you like:
//   - the "sub2api" provider: each sign-in is one account, its own site and
//     its own key, so keys on several sites (or several keys on one) pool
//     under the one provider, and magpie routes across them;
//   - the plugin's options, {"sites": [{"id", "name", "url"}, …]}: each
//     site is a provider of its own, named as you like, that groups and
//     fallbacks can name (id/model); its sign-ins are keys on that site.
// magpie fixes a plugin's providers when it loads it (one per exported
// function), so there are SLOTS site providers to fill, in the order the
// sites are listed.
//
// Every function this module exports is called as a plugin by magpie, so
// only the plugins are exported.

import { createHash } from "node:crypto"

const ID = "sub2api"
const SLOTS = 8
const CHAT = "@ai-sdk/openai-compatible"
const MESSAGES = "@ai-sdk/anthropic"
const RESPONSES = "@ai-sdk/openai"
const GEMINI = "@ai-sdk/google"
const PROTOCOLS = { anthropic: MESSAGES, responses: RESPONSES, "chat-completions": CHAT, gemini: GEMINI }
const DEFAULT_PATHS = { anthropic: "/v1", responses: "/v1", "chat-completions": "/v1", gemini: "/v1beta" }
// Magpie normally gives a plugin provider its own magpie/<version> UA. These
// fallbacks identify the protocol's agent instead, as the built-in providers do.
const CODEX_VERSION = "0.159.0"
const CLAUDE_CLI_VERSION = "2.1.296"
const PROTOCOL_USER_AGENTS = {
  anthropic: `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  "chat-completions": "OpenAI/JS",
  gemini: "google-genai-sdk",
}
const PROTOCOL_IDENTITY_HEADERS = {
  codex: {
    "openai-beta": "responses=experimental",
    originator: "codex_cli_rs",
  },
  claude: {
    "x-app": "cli",
  },
}
const TIMEOUT = 15_000
const METADATA_BODY_MAX = 1 << 20
const METADATA_HEADERS_MAX = 8 << 10
const ICON_TIMEOUT = 3_000
const ICON_MAX = 1 << 20
const ICON_PAGE_MAX = 512 << 10
const QUERY_DEFAULTS = {
  timeoutMs: TIMEOUT,
  effortsTimeoutMs: TIMEOUT,
  modelsTtlMs: 60_000,
  usageTtlMs: 5000,
  effortsTtlMs: 300_000,
  maxResponseBytes: 4 << 20,
}
const CACHE_MAX = 128
const LEGACY_SPEED_HEADERS = ["x-sub2api-magpie-plugin-speed-model", "x-magpie-sub2api-speed-model"]
const SPEEDS = { fast: "priority", ultraspeed: "ultrafast" }

const HOUR = 3600
const DAY = 24 * HOUR
const SPANS = { "5h": ["5 hours", 5 * HOUR], "1d": ["24 hours", DAY], "7d": ["7 days", 7 * DAY] }

function agentPlatform() {
  if (process.platform === "darwin") return "Mac OS"
  if (process.platform === "win32") return "Windows"
  return "Linux"
}

function agentArch() {
  return process.arch === "x64" ? "x86_64" : process.arch
}

function agentTerminal() {
  if (process.platform === "darwin") return "Apple_Terminal/455"
  if (process.platform === "win32") return "WindowsTerminal"
  return "xterm-256color"
}

function isMagpieUserAgent(value) {
  return /^magpie(?:[/-]|$)/i.test(String(value ?? "").trim())
}

function codexVersion(headers) {
  const supplied = String(headers.get("version") ?? "").trim()
  if (/^\d+(?:\.\d+){1,3}$/.test(supplied)) return supplied
  const native = /^(?:codex[^/\s]*|acp-extension-codex|Codex Desktop)\/(\d+(?:\.\d+){1,3})(?=\s|$)/i.exec(headers.get("user-agent") ?? "")
  return native?.[1] ?? CODEX_VERSION
}

function codexUserAgent(headers) {
  const version = codexVersion(headers)
  return `codex_cli_rs/${version} (${agentPlatform()}; ${agentArch()}) ${agentTerminal()}`
}

function callingAgent(headers) {
  const userAgent = String(headers.get("user-agent") ?? "").trim().toLowerCase()
  if (/^(codex|codex_cli_rs|codex_exec|codex_vscode|acp-extension-codex)/.test(userAgent)) return "codex"
  if (/^claude-cli\//.test(userAgent) || userAgent.includes("claude code")) return "claude"
  const named = String(headers.get("x-magpie-agent") ?? "").trim().toLowerCase()
  if (named === "codex" || named === "claude") return named
  const originator = String(headers.get("originator") ?? "").trim().toLowerCase()
  if (/^(codex|acp-extension-codex)/.test(originator)) return "codex"
  for (const name of headers.keys()) {
    if (name.startsWith("x-codex-") || name === "x-openai-subagent") return "codex"
    if (name.startsWith("x-claude-code-") || name === "x-anthropic-billing-header") return "claude"
  }
  return ""
}

function fallbackUserAgent(protocol, headers, agent) {
  if (agent === "codex") return codexUserAgent(headers)
  if (agent === "claude") return PROTOCOL_USER_AGENTS.anthropic
  return PROTOCOL_USER_AGENTS[protocol]
}

function fingerprint(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

function querySettings(...layers) {
  const out = { ...QUERY_DEFAULTS }
  for (const layer of layers) {
    if (layer?.query === undefined) continue
    const value = layer.query
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("query must be a JSON object")
    for (const [name, number] of Object.entries(value)) {
      if (!Object.hasOwn(out, name)) throw new Error("Unknown query option")
      const max = name === "maxResponseBytes" ? 64 << 20 : name.endsWith("TtlMs") ? 3_600_000 : 60_000
      const min = name.endsWith("TtlMs") ? 0 : 1
      if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error("query option is outside its allowed range")
      out[name] = number
    }
  }
  return out
}

function diagnostics(...layers) {
  let enabled = false
  for (const layer of layers) {
    if (layer?.diagnostics === undefined) continue
    if (typeof layer.diagnostics !== "boolean") throw new Error("diagnostics must be a boolean")
    enabled = layer.diagnostics
  }
  // Only fixed event names, status codes and timings reach stderr, never URLs,
  // account names, model names, response bodies or headers.
  return (event, details = {}) => {
    if (enabled) console.error("sub2api-magpie-plugin: " + JSON.stringify({ event, ...details }))
  }
}

function cacheSet(cache, key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
}

function accountScope(base, key, headers) {
  return fingerprint(base, key, Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))
}

// ---- the site -----------------------------------------------------------------

// root is the site's address as typed, without the /v1 an OpenAI client's
// base URL would have, nor a trailing slash.
function root(url) {
  return String(url ?? "").trim().replace(/\/+$/, "").replace(/\/v1(?:beta)?$/, "")
}

function checkURL(value) {
  try {
    const u = new URL(root(value))
    if (u.protocol !== "https:" && u.protocol !== "http:") return "The address starts with https://"
    if (u.username || u.password || u.search || u.hash) return "The address must not contain credentials, a query or a fragment"
  } catch {
    return "An address such as https://api.example.com"
  }
}

// Headers are merged case-insensitively: global < site < account. Credentials
// and transport headers belong to the selected account and HTTP client only.
const RESERVED_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-api-key", "x-goog-api-key",
  "host", "content-length", "connection", "transfer-encoding", "upgrade",
  "keep-alive", "te", "trailer", "proxy-connection", "accept-encoding",
  ...LEGACY_SPEED_HEADERS,
])

function customHeaders(value) {
  if (value === undefined || value === "") return {}
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      throw new Error("Headers must be a JSON object with string values")
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Headers must be a JSON object with string values")
  }
  const headers = new Headers()
  for (const [name, val] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new Error("Invalid or reserved request header name")
    }
    if (typeof val !== "string" || /[\r\n\0]/.test(val)) throw new Error("Header values must be strings without line breaks")
    // Do not include header values in validation errors (they may be secrets).
    try {
      headers.set(name, val)
    } catch {
      throw new Error("Invalid request header value")
    }
  }
  return Object.fromEntries(headers)
}

function mergedHeaders(...layers) {
  return Object.assign({}, ...layers.map(customHeaders))
}

function protocolOf(value = "auto") {
  const aliases = { openai: "responses", "openai-compatible": "chat-completions", chat_completions: "chat-completions", google: "gemini", messages: "anthropic" }
  const name = typeof value === "string" ? value.trim().toLowerCase() : ""
  const protocol = Object.hasOwn(aliases, name) ? aliases[name] : name
  if (protocol !== "auto" && !Object.hasOwn(PROTOCOLS, protocol)) {
    throw new Error("Protocol must be auto, anthropic, responses, chat-completions or gemini")
  }
  return protocol
}

function routingOf(...layers) {
  const routing = { protocol: "auto", modelProtocols: Object.create(null), apiPaths: { ...DEFAULT_PATHS } }
  for (const layer of layers) {
    if (!layer) continue
    if (layer.protocol !== undefined && layer.protocol !== "") routing.protocol = protocolOf(layer.protocol)
    for (const field of ["modelProtocols", "apiPaths"]) {
      const values = layer[field]
      if (values === undefined) continue
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`${field} must be a JSON object`)
      for (const [key, value] of Object.entries(values)) {
        if (field === "modelProtocols") {
          if (!key || typeof value !== "string" || !value.trim()) throw new Error("modelProtocols requires model IDs and protocol names")
          routing.modelProtocols[key] = protocolOf(value)
        } else {
          const protocol = protocolOf(key)
          if (protocol === "auto" || typeof value !== "string" || !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(value)) {
            throw new Error("apiPaths requires explicit protocols and site-relative paths without queries or traversal")
          }
          routing.apiPaths[protocol] = value.replace(/\/+$/, "") || "/"
        }
      }
    }
  }
  return routing
}

// Optional headers for a protocol are used only by inference requests for
// that protocol.  This lets Codex and Claude clients carry different identity
// headers while retaining the existing global/site/account headers.
function protocolHeadersOf(...layers) {
  const out = Object.create(null)
  for (const layer of layers) {
    if (!layer || layer.protocolHeaders === undefined) continue
    const value = layer.protocolHeaders
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("protocolHeaders must be a JSON object")
    }
    for (const [name, headers] of Object.entries(value)) {
      const protocol = protocolOf(name === "codex" ? "responses" : name === "claude" ? "anthropic" : name)
      if (protocol === "auto") throw new Error("protocolHeaders requires explicit protocols")
      out[protocol] = { ...(out[protocol] ?? {}), ...customHeaders(headers) }
    }
  }
  return out
}

function modelProtocol(id, routing) {
  const protocol = routing.modelProtocols[id] ?? routing.protocol
  if (protocol !== "auto") return protocol
  const s = id.toLowerCase().split("/").at(-1)
  if (/^claude[-.]/.test(s) || id.toLowerCase().startsWith("anthropic/")) return "anthropic"
  if (/^(gpt-|o\d|codex-|chatgpt-)/.test(s)) return "responses"
  if (/^gemini[-.]/.test(s)) return "gemini"
  return "chat-completions"
}

function mergeModel(...values) {
  const out = {}
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    for (const [key, next] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid model metadata field")
      out[key] = next && typeof next === "object" && !Array.isArray(next) ? mergeModel(out[key], next) : next
    }
  }
  return out
}

function modelSettings(...layers) {
  const out = { includeModels: undefined, excludeModels: [], modelNames: {}, modelOverrides: {}, speedModels: undefined }
  for (const layer of layers) {
    if (!layer) continue
    if (layer.speedModels !== undefined) {
      const value = layer.speedModels
      const valid = (speeds) => Array.isArray(speeds) && speeds.every((speed) => typeof speed === "string" && Object.hasOwn(SPEEDS, speed))
      if (Array.isArray(value)) {
        if (!valid(value)) throw new Error("speedModels supports only fast and ultraspeed")
        out.speedModels = [...new Set(value)]
      } else {
        if (!value || typeof value !== "object") throw new Error("speedModels must be an array or a model-to-speeds object")
        const next = Array.isArray(out.speedModels) ? {} : { ...out.speedModels }
        for (const [model, speeds] of Object.entries(value)) {
          if (!model || ["__proto__", "constructor", "prototype"].includes(model) || !valid(speeds)) throw new Error("Invalid model speed configuration")
          next[model] = [...new Set(speeds)]
        }
        out.speedModels = next
      }
    }
    for (const field of ["includeModels", "excludeModels"]) {
      if (layer[field] === undefined) continue
      if (!Array.isArray(layer[field]) || layer[field].some((id) => typeof id !== "string" || !id)) throw new Error(`${field} must be an array of model IDs`)
      out[field] = [...layer[field]]
    }
    for (const field of ["modelNames", "modelOverrides"]) {
      if (layer[field] === undefined) continue
      const values = layer[field]
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`${field} must be a JSON object`)
      for (const [id, value] of Object.entries(values)) {
        if (!id || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid model ID in model settings")
        if (field === "modelNames") {
          if (typeof value !== "string" || !value.trim()) throw new Error("modelNames requires non-empty names")
          out.modelNames[id] = value
        } else {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("modelOverrides requires model metadata objects")
          if (Object.keys(value).some((key) => !["name", "limit", "cost", "capabilities", "options", "headers", "variants", "release_date", "status", "serviceTiers"].includes(key))) {
            throw new Error("modelOverrides cannot change model identity, credentials or API routing")
          }
          for (const key of ["limit", "cost", "capabilities", "options", "headers", "variants"]) {
            if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) throw new Error("Model metadata fields must be objects")
          }
          if (value.serviceTiers !== undefined && (!Array.isArray(value.serviceTiers) || value.serviceTiers.length > 64 || value.serviceTiers.some((tier) => typeof tier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tier)))) {
            throw new Error("Model serviceTiers must be an array of valid service tier IDs")
          }
          if (value.options && ["apiKey", "baseURL", "baseUrl", "headers", "fetch"].some((key) => Object.hasOwn(value.options, key))) throw new Error("Model options cannot override account credentials or routing")
          for (const field of ["name", "status", "release_date"]) {
            if (value[field] !== undefined && typeof value[field] !== "string") throw new Error("Model display fields must be strings")
          }
          for (const number of Object.values(value.limit ?? {})) {
            if (typeof number !== "number" || !Number.isFinite(number) || number < 0) throw new Error("Model limits must be non-negative numbers")
          }
          for (const [field, flag] of Object.entries(value.capabilities ?? {})) {
            if (["input", "output"].includes(field)) {
              if (!flag || typeof flag !== "object" || Array.isArray(flag) || Object.values(flag).some((flag) => typeof flag !== "boolean")) throw new Error("Model modalities must contain boolean flags")
            } else if (field !== "interleaved" && typeof flag !== "boolean") throw new Error("Model capabilities must contain boolean flags")
          }
          const checked = { ...value, ...(value.headers === undefined ? {} : { headers: customHeaders(value.headers) }) }
          out.modelOverrides[id] = mergeModel(out.modelOverrides[id], checked)
        }
      }
    }
  }
  return out
}

function serviceTiers(value) {
  if (!Array.isArray(value)) return []
  const out = new Set()
  for (const tier of value.slice(0, 64)) {
    const raw = typeof tier === "string" ? tier : tier?.id
    if (typeof raw !== "string") continue
    const name = raw.trim().toLowerCase()
    const id = Object.hasOwn(SPEEDS, name) ? SPEEDS[name] : name
    if (/^[a-z][a-z0-9_-]{0,63}$/.test(id)) out.add(id)
  }
  return [...out]
}

function reportedTiers(model) {
  for (const field of ["service_tiers", "serviceTiers"]) {
    if (model && Object.hasOwn(model, field)) return serviceTiers(model[field])
  }
}

function modelServiceTiers(model, manifest, selection, protocol) {
  const configured = selection.modelOverrides[model.id]?.serviceTiers
  const legacy = selection.speedModels
  const legacyConfigured = legacy && !Array.isArray(legacy) && Object.hasOwn(legacy, model.id)
  const declared = configured ?? (legacyConfigured ? legacy[model.id] : undefined)
  let tiers = serviceTiers(declared ?? reportedTiers(model) ?? manifest?.serviceTiers)
  // Native service_tier selection is supported on OpenAI-compatible APIs.
  // Never borrow account eligibility from the host's merged model metadata.
  if (!["responses", "chat-completions"].includes(protocol)) {
    if (tiers.length && declared !== undefined) {
      throw new Error("Service tier selection requires an OpenAI-compatible API protocol")
    }
    return []
  }
  if (Array.isArray(legacy)) {
    const allowed = legacy.map((speed) => SPEEDS[speed])
    tiers = tiers.filter((tier) => !Object.values(SPEEDS).includes(tier) || allowed.includes(tier))
  }
  return tiers
}

function validatePrices(selection) {
  for (const override of Object.values(selection.modelOverrides)) {
    if (override.cost === undefined) continue
    const prices = [override.cost.input, override.cost.output, override.cost.cache?.read, override.cost.cache?.write]
    if (prices.some((number) => typeof number !== "number" || !Number.isFinite(number) || number < 0)) {
      throw new Error("Model cost requires input, output, cache.read and cache.write prices in USD per million tokens")
    }
  }
  return selection
}

async function metadataBody(input, init) {
  const body = init?.body
  if (typeof body === "string") return Buffer.byteLength(body) <= METADATA_BODY_MAX ? body : undefined
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    if (body.byteLength > METADATA_BODY_MAX) return
    return new TextDecoder().decode(body)
  }
  if (body instanceof Blob) return body.size <= METADATA_BODY_MAX ? body.text() : undefined
  // Do not consume streaming init.body uploads. A Request is inspected via a
  // bounded clone so its original body remains available to fetch.
  if (body !== undefined || !(input instanceof Request) || !input.body || input.bodyUsed) return
  const signal = init?.signal ?? input.signal
  if (signal?.aborted) return
  const reader = input.clone().body.getReader()
  const cancel = () => { reader.cancel().catch(() => {}) }
  const timer = setTimeout(cancel, TIMEOUT)
  signal?.addEventListener("abort", cancel, { once: true })
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, size).toString("utf8")
      size += value.byteLength
      if (size > METADATA_BODY_MAX) return
      chunks.push(Buffer.from(value))
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

async function codexMetadataHeaders(input, init, headers) {
  let payload
  try {
    payload = JSON.parse(await metadataBody(input, init))
  } catch {
    return
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return
  let size = 0
  const setMissing = (name, value) => {
    if (headers.has(name) || headers.has(name.replace(/-/g, "_"))) return
    if (typeof value !== "string" || !value.trim()) return
    const length = name.length + value.length + 4
    if (size + length > METADATA_HEADERS_MAX) return
    // Body metadata is untrusted too; ignore invalid values without logging them.
    try {
      for (const [key, val] of Object.entries(customHeaders({ [name]: value }))) headers.set(key, val)
      size += length
    } catch {}
  }
  const metadata = payload.client_metadata
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    for (const [field, value] of Object.entries(metadata)) {
      const name = field === "session_id" ? "session-id" : field === "thread_id" ? "thread-id" : field
      if (!["session-id", "thread-id"].includes(name) && !/^x-codex-[!#$%&'*+.^_`|~0-9A-Za-z-]+$/i.test(name)) continue
      setMissing(name, value)
    }
  }
  // Magpie's Codex signing uses prompt_cache_key as both conversation IDs.
  if (typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.trim()) {
    setMissing("session-id", payload.prompt_cache_key)
    setMissing("thread-id", payload.prompt_cache_key)
  }
}

function accountFetch(base, key, extra, routing, protocolExtra = {}, report = () => {}, catalogState = () => undefined) {
  // The host's loader baseURL overrides individual model URLs. Resolve the
  // protocol from its generated endpoint and route it to the configured path.
  const prefixes = [...new Set([...Object.values(DEFAULT_PATHS), ...Object.values(routing.apiPaths)])]
    .map((path) => new URL(base + path.replace(/\/+$/, "") + "/"))
    .sort((a, b) => b.pathname.length - a.pathname.length)
  return async (input, init) => {
    const state = catalogState()
    if (state?.error) throw state.error
    const url = new URL(input instanceof Request ? input.url : input)
    const allowed = prefixes.find((prefix) => url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname))
    if (!allowed || url.username || url.password) {
      throw new Error("Refusing to send Sub2API credentials outside this account's API endpoint")
    }
    const suffix = url.pathname.slice(allowed.pathname.length)
    const protocol = /^messages(?:\/|$)/.test(suffix) ? "anthropic"
      : /^responses(?:\/|$)/.test(suffix) ? "responses"
      : suffix === "chat/completions" ? "chat-completions"
      : /^models\/.+:(?:generateContent|streamGenerateContent|countTokens)$/.test(suffix) ? "gemini" : undefined
    const target = new URL(url)
    if (protocol) target.pathname = new URL(base + routing.apiPaths[protocol].replace(/\/+$/, "") + "/").pathname + suffix
    // A caller's Gemini query key must never select a different account.
    if (protocol === "gemini") target.searchParams.delete("key")
    report("inference.route", { protocol: protocol ?? "unknown" })
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    if (LEGACY_SPEED_HEADERS.some((header) => headers.has(header))) {
      throw new Error("Legacy speed models are no longer supported; refresh the model catalog and select speed on the original model")
    }
    const body = init?.body
    let payload
    // Never consume streaming init.body uploads; Request inspection uses a bounded clone.
    if (state?.ids && (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob || (body === undefined && input instanceof Request))) {
      try {
        payload = JSON.parse(await metadataBody(input, init))
      } catch {}
    }
    if (state?.ids && typeof payload?.model === "string" && !state.ids.has(payload.model)) {
      const match = /^(.*)-(fast|ultraspeed|ultrafast)$/.exec(payload.model)
      const original = match?.[1]
      const tier = match?.[2] === "fast" ? "priority" : "ultrafast"
      if (!original || !state.ids.has(original)) {
        throw new Error("The selected model is not listed for this Sub2API account; refresh the model catalog and select an exact upstream model ID")
      }
      if (!["responses", "chat-completions"].includes(protocol) || !state.tiers?.get(original)?.includes(tier)) {
        throw new Error("Legacy speed model cannot be migrated: this account has not declared the requested service tier; select the original model and verify its serviceTiers")
      }
      if (payload.service_tier !== undefined && payload.service_tier !== tier) {
        throw new Error("Legacy speed model conflicts with the explicit service_tier; select the original model and one service tier")
      }
      if (headers.has("content-encoding") && headers.get("content-encoding") !== "identity") {
        throw new Error("Legacy speed model cannot be migrated in an encoded request; select the original model and service tier")
      }
      // Compatibility normalization before the only upstream attempt, never a retry.
      init = { ...init, body: JSON.stringify({ ...payload, model: original, service_tier: tier }) }
      headers.delete("content-length")
      report("inference.speed_migrated", { protocol })
    }
    if (protocol === "responses" && (!headers.has("content-encoding") || headers.get("content-encoding") === "identity")) {
      await codexMetadataHeaders(input, init, headers)
    }
    // Built-in identity < protocol headers < global/site/account headers.
    // Agent-provided headers still win, except Magpie's own UA, which a plugin
    // provider is given instead of the calling agent's and must not forward.
    const configured = new Headers(protocolExtra[protocol])
    new Headers(extra).forEach((value, name) => configured.set(name, value))
    // Detect the agent before protocol defaults can masquerade as caller hints.
    const identity = new Headers(configured)
    headers.forEach((value, name) => identity.set(name, value))
    const agent = callingAgent(identity) || (protocol === "responses" ? "codex" : protocol === "anthropic" ? "claude" : "")
    if (protocol) {
      new Headers(PROTOCOL_IDENTITY_HEADERS[agent]).forEach((value, name) => {
        if (!configured.has(name)) configured.set(name, value)
      })
      if (agent === "codex" && !configured.has("version")) configured.set("version", codexVersion(identity))
    }
    configured.forEach((value, name) => {
      if (name !== "user-agent" && !headers.has(name)) headers.set(name, value)
    })
    const requestedUA = String(headers.get("user-agent") ?? "").trim()
    const configuredUA = String(configured.get("user-agent") ?? "").trim()
    if (protocol && (!requestedUA || isMagpieUserAgent(requestedUA))) {
      headers.set("user-agent", configuredUA && !isMagpieUserAgent(configuredUA) ? configuredUA : fallbackUserAgent(protocol, headers, agent))
    } else if (!requestedUA && configuredUA && !isMagpieUserAgent(configuredUA)) {
      headers.set("user-agent", configuredUA)
    }
    headers.delete("x-magpie-agent")
    headers.delete("x-magpie-via")
    headers.set("authorization", `Bearer ${key}`)
    if (protocol === "anthropic" || headers.has("x-api-key")) headers.set("x-api-key", key)
    if (protocol === "anthropic" && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
    if (protocol === "gemini" || headers.has("x-goog-api-key")) headers.set("x-goog-api-key", key)
    // Never follow a redirect with this account's extra headers or API key.
    const destination = target.href === url.href ? input
      : input instanceof Request ? new Request(target, input) : target.href
    const started = Date.now()
    try {
      const response = await fetch(destination, { ...init, headers, redirect: "error" })
      report("inference.response", { protocol: protocol ?? "unknown", status: response.status, elapsedMs: Date.now() - started })
      return response
    } catch (error) {
      report("inference.failed", { protocol: protocol ?? "unknown", elapsedMs: Date.now() - started })
      throw error
    }
  }
}

function hostOf(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// Icon discovery is public and separate from authenticated API requests.
// Only the configured origin is contacted, never redirects or third-party CDNs.
async function iconBytes(url, accept, limit, signal) {
  const res = await fetch(url, {
    headers: { accept },
    credentials: "omit",
    redirect: "error",
    signal,
  })
  if (!res.ok || Number(res.headers.get("content-length")) > limit) {
    await res.body?.cancel()
    throw new Error("Icon response unavailable or too large")
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error("Icon response too large")
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function iconData(bytes) {
  if (!bytes.length || bytes.length > ICON_MAX) return ""
  const hex = bytes.subarray(0, 12).toString("hex")
  const type = hex.startsWith("89504e470d0a1a0a") ? "png"
    : hex.startsWith("ffd8ff") ? "jpeg"
    : /^474946383[79]61/.test(hex) ? "gif"
    : hex.startsWith("52494646") && hex.slice(16) === "57454250" ? "webp"
    : /^00000[12]00/.test(hex) ? "x-icon"
    : /^(?:<\?xml[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<svg(?:\s|\/?>)/i.test(bytes.toString("utf8").trim()) ? "svg+xml" : ""
  return type ? `data:image/${type};base64,${bytes.toString("base64")}` : ""
}

function htmlValue(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, entity) => {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }
    const name = entity.toLowerCase()
    if (named[name]) return named[name]
    const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all
  })
}

async function siteIcon(base) {
  const home = new URL(base + "/")
  const signal = AbortSignal.timeout(ICON_TIMEOUT)
  const candidates = []
  try {
    const bytes = await iconBytes(home, "text/html", ICON_PAGE_MAX, signal)
    const head = bytes.toString("utf8")
      .replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
      .split(/<\/head\s*>|<body\b/i)[0]
    for (const [tag] of head.matchAll(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      const attrs = Object.create(null)
      for (const [, name, double, single, bare] of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        attrs[name.toLowerCase()] = htmlValue(double ?? single ?? bare)
      }
      const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/)
      if (rel.some((value) => ["icon", "apple-touch-icon", "apple-touch-icon-precomposed"].includes(value)) && attrs.href) {
        candidates.push(attrs.href)
      }
    }
  } catch {}
  candidates.push(new URL("favicon.ico", home).href, new URL("/favicon.ico", home).href)
  const seen = new Set()
  // Bound both request count and total time on pages with many icon links.
  for (const candidate of candidates.slice(0, 8).concat(candidates.slice(-2))) {
    if (signal.aborted) break
    try {
      if (/^data:image\//i.test(candidate)) {
        if (candidate.length > ICON_MAX * 1.5) continue
        const match = /^data:image\/[^;,]+(;base64)?,([\s\S]*)$/i.exec(candidate)
        if (!match) continue
        const data = iconData(match[1] ? Buffer.from(match[2], "base64") : Buffer.from(decodeURIComponent(match[2])))
        if (data) return data
        continue
      }
      const url = new URL(candidate, home)
      if (url.origin !== home.origin || url.username || url.password || !["http:", "https:"].includes(url.protocol)) continue
      url.hash = ""
      if (seen.has(url.href)) continue
      seen.add(url.href)
      const data = iconData(await iconBytes(url, "image/*", ICON_MAX, signal))
      if (data) return data
    } catch {}
  }
  return ""
}

// label is how magpie names the account: the name given at sign-in, else
// the site's host and the end of the key, so keys on different sites (or
// two on one site) tell apart. magpie keys an account's own settings (its
// models, its share) by this name, so it stays as it was given.
function label(auth, base) {
  if (typeof auth?.accountId === "string" && auth.accountId) return auth.accountId
  const given = typeof auth?.metadata?.name === "string" ? auth.metadata.name.trim().slice(0, 60) : ""
  if (given) return given
  const key = typeof auth?.key === "string" ? auth.key : ""
  const tail = key ? " …" + key.slice(-4) + " [" + fingerprint(base, key).slice(0, 8) + "]" : ""
  return base ? hostOf(base) + tail : ""
}

// named saves the label on the account, where magpie reads an account's
// name (accountId, else metadata.email). magpie's API-key sign-in keeps
// only {type, key, metadata} and hands a method's authorize no key, so the
// name is written the first time the account is used, in its own scope
// (client.auth.set replaces the account's sign-in, so it is kept whole).
async function named(client, id, auth, base) {
  const name = label(auth, base)
  if (!name || auth.accountId === name || typeof client?.auth?.set !== "function") return
  try {
    await client.auth.set({ path: { id }, body: { ...auth, accountId: name } })
  } catch {}
}

function queryError(message, status, kind) {
  const error = new Error(message)
  error.status = status
  error.kind = kind
  if (status === 401) error.signIn = "expired"
  return error
}

async function responseBytes(res, limit, signal) {
  if (Number(res.headers.get("content-length")) > limit) {
    void res.body?.cancel().catch(() => {})
    throw queryError("Management response exceeds the size limit", res.status, "size")
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > limit) throw queryError("Management response exceeds the size limit", res.status, "size")
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener("abort", cancel)
    cancel()
    reader.releaseLock()
  }
}

async function get(base, path, key, extra = {}, settings = QUERY_DEFAULTS, timeout = settings.timeoutMs) {
  const signal = AbortSignal.timeout(timeout)
  const res = await fetch(base + path, {
    headers: { accept: "application/json", ...extra, authorization: `Bearer ${key}` },
    signal,
    redirect: "error",
  })
  if (!res.ok) {
    void res.body?.cancel().catch(() => {})
    // Never echo a gateway response: it may contain reflected credentials.
    throw queryError(`Sub2API query returned HTTP ${res.status}`, res.status, "http")
  }
  const bytes = await responseBytes(res, settings.maxResponseBytes, signal)
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    throw queryError("Sub2API query response is not JSON", res.status, "json")
  }
}

function queries(onExpired) {
  const cache = new Map()
  return async (base, path, key, extra, settings, report, operation) => {
    const scope = accountScope(base, key, extra)
    const name = scope + ":" + fingerprint(path, settings)
    const ttl = settings[`${operation}TtlMs`]
    const cached = cache.get(name)
    if (cached && (cached.pending || cached.expires > Date.now())) {
      report("query.cache", { operation, pending: cached.pending })
      return cached.promise
    }
    const entry = { pending: true, expires: 0 }
    const started = Date.now()
    entry.promise = get(base, path, key, extra, settings, operation === "efforts" ? settings.effortsTimeoutMs : settings.timeoutMs)
      .then((value) => {
        if (operation === "models" && !Array.isArray(value?.data)) throw queryError("Invalid model catalog", undefined, "catalog")
        entry.pending = false
        entry.expires = Date.now() + ttl
        report("query.complete", { operation, elapsedMs: Date.now() - started })
        return value
      }).catch((error) => {
        entry.pending = false
        if (error.signIn) {
          onExpired(scope, error)
          for (const name of cache.keys()) if (name.startsWith(scope + ":")) cache.delete(name)
        } else if (operation === "efforts") entry.expires = Date.now() + 30_000
        else if (cache.get(name) === entry) cache.delete(name)
        report("query.failed", { operation, status: error.status ?? 0, reason: error.kind ?? "network", elapsedMs: Date.now() - started })
        if (error.kind || error.signIn) throw error
        throw queryError("Sub2API query failed or timed out", undefined, "network")
      })
    cacheSet(cache, name, entry)
    return entry.promise
  }
}

// ---- models -------------------------------------------------------------------

// LEVELS are a thinking model's reasoning levels when nothing tells them.
const LEVELS = ["low", "medium", "high"]

const variantsOf = (levels) => Object.fromEntries(levels.map((l) => [l, {}]))

function reasoningLevels(model) {
  if (!Array.isArray(model?.supported_reasoning_levels)) return undefined
  const levels = []
  for (const level of model.supported_reasoning_levels) {
    const effort = typeof level === "string" ? level : level?.effort
    if (typeof effort === "string" && effort.trim() && !levels.includes(effort.trim())) levels.push(effort.trim())
  }
  return levels.some((level) => level !== "none") ? levels : undefined
}

function modelDisplayName(name, id) {
  if (typeof name !== "string" || name === id) return id
  // Speed belongs in serviceTiers, not trailing display labels. Keep real IDs intact.
  const clean = name.replace(/(?:\s*(?:\(\s*(?:fast|ultraspeed|ultrafast)\s*\)|\uFF08\s*(?:fast|ultraspeed|ultrafast)\s*\uFF09))+\s*$/i, "")
  return clean.trim() ? clean : id
}

// runtimeModel is magpie's model. Its variants are its reasoning levels
// (magpie offers a thinking model's variants' keys as its efforts), the
// first of: the primary/manifest levels the site tells (told), the variants magpie already
// has for the model (was: models.dev's, the config's), LEVELS when the
// model thinks.
function runtimeModel(m, url, providerID, told, was, npm, override = {}) {
  const kept = was?.variants && typeof was.variants === "object" && Object.keys(was.variants).length ? was.variants : undefined
  const reasoning = m.reasoning === true || !!told?.length || !!kept || /think|reason|(?:^|\/)(?:o\d|gpt-(?:[5-9]|[1-9]\d+)(?:[.-]|$)|codex-)/i.test(m.id)
  const defaults = {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url, npm },
    status: "active",
    headers: {},
    options: {},
    limit: { context: 0, output: 0 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: false,
      toolcall: true,
      input: { text: true },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: told?.length ? variantsOf(told) : (kept ?? (reasoning ? variantsOf(LEVELS) : {})),
  }
  const out = mergeModel(defaults, was, override)
  // Account ownership and transport are never inherited from another source.
  out.id = m.id
  out.providerID = providerID
  out.api = { id: m.id, url, npm }
  for (const header of LEGACY_SPEED_HEADERS) delete out.headers[header]
  delete out.fast
  out.name = override.name ?? (m.named ? m.name : was?.name ?? m.name)
  if (told?.length && override.variants === undefined) out.variants = variantsOf(told)
  if (override.variants !== undefined) out.variants = mergeModel(override.variants)
  if (override.capabilities?.reasoning === undefined && reasoning) out.capabilities.reasoning = true
  return out
}

// The optional Codex manifest supplies per-key reasoning levels and service
// tiers. Missing levels must not hide tier-only entries (and vice versa).
async function codexModels(query, base, key, extra, settings, report) {
  let body
  try {
    body = await query(base, "/backend-api/codex/models", key, extra, settings, report, "efforts")
  } catch {
    return {}
  }
  const out = Object.create(null)
  for (const m of Array.isArray(body?.models) ? body.models : []) {
    if (typeof m?.slug !== "string" || !m.slug) continue
    out[m.slug] = {
      levels: reasoningLevels(m),
      serviceTiers: reportedTiers(m),
    }
  }
  return out
}

// models is what GET /v1/models lists for the key: its group's, in
// Anthropic's shape or OpenAI's as the group's platform has it; was is the
// models magpie already has.
async function models(id, base, auth, was, extra, routing, settings, selection, query, report) {
  const entries = []
  const seen = new Set()
  let totalBytes = 0
  let path = "/v1/models"
  for (let page = 0; path; page++) {
    if (page >= 100 || seen.has(path)) throw queryError("Invalid or excessive model pagination", undefined, "pagination")
    seen.add(path)
    const body = await query(base, path, auth.key, extra, settings, report, "models")
    if (!Array.isArray(body?.data)) throw queryError("Invalid model catalog", undefined, "catalog")
    totalBytes += Buffer.byteLength(JSON.stringify(body))
    if (totalBytes > settings.maxResponseBytes) throw queryError("Combined model catalog exceeds the size limit", undefined, "size")
    for (const entry of body.data) entries.push(entry)
    if (typeof body.next === "string" && body.next) {
      const endpoint = new URL(base + "/v1/models")
      let next
      try { next = new URL(body.next, base + path) } catch { throw queryError("Invalid model pagination URL", undefined, "pagination") }
      if (next.origin !== endpoint.origin || next.pathname !== endpoint.pathname || next.username || next.password || next.hash) {
        throw queryError("Refusing model pagination outside this account's model endpoint", undefined, "pagination")
      }
      path = "/v1/models" + next.search
    } else if (body.has_more === true) {
      const last = body.last_id ?? body.data.at(-1)?.id
      if (typeof last !== "string" || !last) throw queryError("Missing model pagination cursor", undefined, "pagination")
      path = "/v1/models?after_id=" + encodeURIComponent(last)
    } else path = undefined
  }
  const told = entries.some((m) => typeof m?.id === "string" && modelProtocol(m.id, routing) === "responses")
    ? await codexModels(query, base, auth.key, extra, settings, report) : {}
  const out = Object.create(null)
  for (const m of entries) {
    if (typeof m?.id !== "string" || !m.id) continue
    if ((selection.includeModels && !selection.includeModels.includes(m.id)) || selection.excludeModels.includes(m.id)) continue
    const display = selection.modelNames[m.id] ?? m.display_name ?? m.name
    const named = typeof display === "string" && !!display
    const name = named ? display : m.id
    const protocol = modelProtocol(m.id, routing)
    out[m.id] = runtimeModel({ id: m.id, name, named, reasoning: m.reasoning === true || m.capabilities?.reasoning === true }, base + routing.apiPaths[protocol].replace(/\/+$/, ""), id, reasoningLevels(m) ?? told[m.id]?.levels, was?.[m.id], PROTOCOLS[protocol], selection.modelOverrides[m.id])
    out[m.id].name = modelDisplayName(selection.modelNames[m.id] ?? out[m.id].name, m.id)
    out[m.id].serviceTiers = modelServiceTiers(m, told[m.id], selection, protocol)
  }
  report("models.ready", { discovered: entries.length, visible: Object.keys(out).length })
  return out
}

// ---- usage --------------------------------------------------------------------

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const money = (v) => "$" + (Math.round(v * 100) / 100).toFixed(2)
const pct = (used, limit) => (limit > 0 ? (100 * used) / limit : used > 0 ? 100 : 0)
const after = (iso, secs) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t + secs * 1000).toISOString() : undefined
}

function win(name, used, limit, extra = {}) {
  return { name, used: pct(used, limit), display: money(used) + " / " + money(limit), ...extra }
}

// fromUsage is magpie's usage from /v1/usage's reply, one of three:
//   - "quota_limited": the key has its own quota or rate limits; sub2api
//     then tells those and hides the subscription and the wallet;
//   - a subscription group: its day, week and month, each a window when
//     the group limits it;
//   - a balance group: the wallet, shown but not a window, since a balance
//     has no span to route by.
function fromUsage(u) {
  if (u?.mode === "quota_limited") {
    const out = { plan: "API key limits", windows: [] }
    const q = u.quota
    if (q && num(q.limit) > 0) out.windows.push(win("Key quota", num(q.used) ?? 0, q.limit))
    for (const r of Array.isArray(u.rate_limits) ? u.rate_limits : []) {
      const limit = num(r?.limit)
      if (!(limit > 0)) continue
      const [name, span] = SPANS[r.window] ?? [String(r.window ?? "Window"), undefined]
      out.windows.push(win(name, num(r.used) ?? 0, limit, { ...(r.reset_at ? { resetsAt: r.reset_at } : {}), ...(span ? { span } : {}) }))
    }
    if (u.expires_at) out.until = u.expires_at
    if (u.status === "quota_exhausted") out.error = "The key's quota is used up"
    else if (u.status === "expired") out.error = "The key has expired"
    return out
  }

  const plan = typeof u?.planName === "string" && u.planName ? u.planName : undefined
  const s = u?.subscription
  if (s && typeof s === "object") {
    const out = { plan, windows: [] }
    // A window's reset time is the one sub2api tells (daily_reset_at /
    // weekly_reset_at / monthly_reset_at, RFC 3339; being added upstream,
    // absent on 0.2.14). It isn't worked out from the window starts: the
    // day resets at the next midnight in the server's time zone, and the
    // day's and the month's windows roll over only when next used, so a
    // start + 24 hours or + 30 days would be a wrong guess. Without a told
    // reset time the day and the month have a span but no reset time. The
    // week is a rolling 7 days from its start upstream, so its start
    // + 7 days stands in until weekly_reset_at is told.
    const told = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined)
    const rows = [
      ["24 hours", s.daily_usage_usd, s.daily_limit_usd, DAY, told(s.daily_reset_at)],
      ["7 days", s.weekly_usage_usd, s.weekly_limit_usd, 7 * DAY, told(s.weekly_reset_at) ?? after(s.weekly_window_start, 7 * DAY)],
      ["30 days", s.monthly_usage_usd, s.monthly_limit_usd, 30 * DAY, told(s.monthly_reset_at)],
    ]
    for (const [name, used, limit, span, resetsAt] of rows) {
      if (!(num(limit) > 0)) continue // null or 0: no limit on this window
      out.windows.push(win(name, num(used) ?? 0, limit, { span, ...(resetsAt ? { resetsAt } : {}) }))
    }
    if (s.expires_at) {
      out.until = s.expires_at
      if (Date.parse(s.expires_at) <= Date.now()) out.error = "The subscription has expired"
    }
    if (!out.windows.length) out.balance = "Unlimited"
    return out
  }
  if (num(u?.balance) !== undefined) return { plan, balance: money(u.balance) }
  // a subscription group the user has no subscription to (or one gone):
  // the gateway lets the request through to fail, and tells no usage
  return { plan, error: "No active subscription for this key's group", windows: [] }
}

async function usage(client, id, auth, base, extra, query, settings, report) {
  if (auth?.type !== "api" || !auth.key) return { error: "not signed in" }
  if (!base) return { error: "No sub2api address saved with this key; sign in again" }
  await named(client, id, auth, base)
  const user = label(auth, base)
  try {
    return { user, ...fromUsage(await query(base, "/v1/usage", auth.key, extra, settings, report, "usage")) }
  } catch (e) {
    return { user, error: String(e?.message ?? e), windows: [], ...(e?.signIn ? { signIn: e.signIn } : {}) }
  }
}

// ---- the sites in the plugin's options -----------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

// slug is an id made from a site's host: api.example.com → api-example-com.
function slug(base) {
  return hostOf(base).toLowerCase().replace(/:\d+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
}

// sites are the options' sites that can be providers, at most SLOTS: each
// with an address, an id (given, else the host's) no other has, and a name
// (given, else the id). The rest are left out, and told on stderr when
// tell (once, by the first slot).
function sitesOf(options, tell) {
  const list = Array.isArray(options?.sites) ? options.sites : []
  const out = []
  const seen = new Set([ID])
  for (const [i, s] of list.entries()) {
    const why = (m) => tell && console.error(`sub2api-magpie-plugin: options.sites[${i}] left out: ${m}`)
    const bad = checkURL(s?.url ?? s?.baseURL ?? s?.baseUrl)
    if (bad) {
      why(bad)
      continue
    }
    const base = root(s.url ?? s.baseURL ?? s.baseUrl)
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : slug(base)
    if (!ID_RE.test(id)) {
      why(`id "${id}": lower-case letters, digits, - and _, at most 40`)
      continue
    }
    if (seen.has(id)) {
      why(`id "${id}" is taken`)
      continue
    }
    if (out.length === SLOTS) {
      why(`only ${SLOTS} sites can be providers`)
      continue
    }
    seen.add(id)
    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : id
    out.push({ ...s, id, name, base })
  }
  return out
}

// ---- the plugin ---------------------------------------------------------------

// hooks are one provider's: id, with its site fixed (a site from the
// options) or each account's own (the "sub2api" provider's, asked at
// sign-in).
// Normalize the static option/site layers once. Account metadata is applied
// later, per request, so credentials and account-specific routing stay isolated.
function pluginSettings(options, site) {
  const defaultURL = options?.url ?? options?.baseURL ?? options?.baseUrl
  const settings = {
    query: querySettings(options, site),
    models: validatePrices(modelSettings(options, site)),
    headers: mergedHeaders(options?.headers, site?.headers),
    routing: routingOf(options, site),
    protocolHeaders: protocolHeadersOf(options, site),
    defaultURL,
  }
  if (defaultURL !== undefined) {
    const bad = checkURL(defaultURL)
    if (bad) throw new Error(bad)
  }
  return settings
}

function hooks(client, id, site, options) {
  const catalogs = new Map()
  const expired = new Map()
  const query = queries((scope, error) => { cacheSet(expired, scope, error) })
  const settings = pluginSettings(options, site)
  const queryFor = (auth) => querySettings({ query: settings.query }, auth?.metadata)
  const modelsFor = (auth) => validatePrices(modelSettings(settings.models, auth?.metadata))
  diagnostics(options, site)
  const reportFor = (auth) => diagnostics(options, site, auth?.metadata)
  // Validate even overridden layers, so invalid config cannot silently drop a header.
  const headersOf = (auth) => mergedHeaders(settings.headers, auth?.metadata?.headers)
  const routingFor = (auth) => routingOf(settings.routing, auth?.metadata)
  const protocolHeadersFor = (auth) => protocolHeadersOf({ protocolHeaders: settings.protocolHeaders }, auth?.metadata)
  const { defaultURL } = settings
  const baseOf = (auth) => {
    const base = site?.base ?? root(auth?.metadata?.baseURL ?? auth?.metadata?.baseUrl ?? defaultURL)
    if (!base) return ""
    const bad = checkURL(base)
    if (bad) throw new Error(bad)
    return base
  }
  const prompts = site || defaultURL !== undefined
    ? []
    : [
        {
          type: "text",
          key: "baseURL",
          message: "Sub2API Base URL",
          placeholder: "https://api.example.com",
          validate: checkURL,
        },
      ]
  let iconBase = site?.base ?? root(defaultURL)
  let accountIconSelected = false
  const icons = new Map()
  const refreshIcon = async (base, account = false) => {
    if (account && !site && !accountIconSelected) {
      accountIconSelected = true
      if (iconBase !== base) delete authHook.icon
      iconBase = base
    }
    if (!base || base !== iconBase) return
    let cached = icons.get(base)
    if (!cached || cached.expires <= Date.now()) {
      cached = { expires: Infinity }
      cached.pending = siteIcon(base).catch(() => "").then((icon) => {
        cached.expires = Date.now() + (icon ? HOUR : 5 * 60) * 1000
        return icon
      })
      icons.set(base, cached)
    }
    const icon = await cached.pending
    if (icon && base === iconBase) authHook.icon = icon
  }
  const authHook = {
    provider: id,
    // each account's own site: the loader runs once per account
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      const base = baseOf(auth)
      if (!base) return {}
      await named(client, id, auth, base)
      // Bearer for chat and responses, x-api-key for messages: the
      // gateway takes either
      const headers = headersOf(auth)
      const routing = routingFor(auth)
      const protocolHeaders = protocolHeadersFor(auth)
      queryFor(auth)
      modelsFor(auth)
      const report = reportFor(auth)
      const scope = accountScope(base, auth.key, headers)
      const catalogKey = fingerprint(scope, routing, modelsFor(auth))
      const state = () => expired.has(scope) ? { error: expired.get(scope) } : catalogs.get(catalogKey)
      return { baseURL: base + "/v1", apiKey: auth.key, headers, fetch: accountFetch(base, auth.key, headers, routing, protocolHeaders, report, state) }
    },
    methods: [
      {
        type: "api",
        label: site ? `${site.name} API key` : "sub2api API key",
        placeholder: "sk-…",
        prompts,
      },
    ],
    // magpie's: the plan and how much of it is used
    async usage(getAuth) {
      const auth = await getAuth()
      try {
        return await usage(client, id, auth, baseOf(auth), headersOf(auth), query, queryFor(auth), reportFor(auth))
      } catch (e) {
        return { error: e.message, windows: [] }
      }
    },
  }
  return {
    auth: authHook,
    "chat.headers": async ({ model }, output) => {
      // Carry only obsolete selectors so cached pre-migration models fail
      // explicitly in fetch instead of silently losing their chosen speed.
      if (model?.providerID !== id) return
      for (const header of LEGACY_SPEED_HEADERS) {
        if (model.headers?.[header]) output.headers[header] = model.headers[header]
      }
    },
    // the key's group's list, asked of the account's site
    provider: {
      id,
      async models(provider, { auth } = {}) {
        if (auth?.type !== "api" || !auth.key) return {}
        const base = baseOf(auth)
        if (!base) throw new Error("No Sub2API address saved with this key")
        const routing = routingFor(auth)
        const headers = headersOf(auth)
        const settings = queryFor(auth)
        const selection = modelsFor(auth)
        const report = reportFor(auth)
        const scope = accountScope(base, auth.key, headers)
        const catalogKey = fingerprint(scope, routing, selection)
        // Cosmetic discovery must not hold up the account's model catalog.
        void refreshIcon(base, true).catch(() => report("icon.failed"))
        try {
          const found = await models(id, base, auth, provider?.models, headers, routing, settings, selection, query, report)
          expired.delete(scope)
          cacheSet(catalogs, catalogKey, {
            ids: new Set(Object.keys(found)),
            tiers: new Map(Object.entries(found).map(([model, metadata]) => [model, [...metadata.serviceTiers]])),
          })
          return found
        } catch (e) {
          cacheSet(catalogs, catalogKey, { error: e })
          report("models.failed", { status: e.status ?? 0, reason: e.kind ?? "configuration" })
          // Never replace an unavailable model with the host's or another key's
          // catalog, and never return an old list as a successful refresh.
          throw e
        }
      },
    },
    // Discover configured sites even before sign-in; keep user-given names.
    async config(cfg) {
      if (site) {
        cfg.provider ??= {}
        const was = cfg.provider[id] ?? {}
        cfg.provider[id] = { ...was, name: was.name ?? site.name }
      }
      await refreshIcon(iconBase)
    },
  }
}

export async function Sub2apiPlugin({ client } = {}, options) {
  return hooks(client, ID, undefined, options)
}

// slot(i) is the provider of the options' i-th site; nothing while there
// is none.
const slot = (i) => async ({ client } = {}, options) => {
  const site = sitesOf(options, i === 0)[i]
  return site ? hooks(client, site.id, site, options) : {}
}

export const Sub2apiSite1 = slot(0)
export const Sub2apiSite2 = slot(1)
export const Sub2apiSite3 = slot(2)
export const Sub2apiSite4 = slot(3)
export const Sub2apiSite5 = slot(4)
export const Sub2apiSite6 = slot(5)
export const Sub2apiSite7 = slot(6)
export const Sub2apiSite8 = slot(7)
