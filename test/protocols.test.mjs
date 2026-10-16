import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"
import { Sub2apiPlugin, Sub2apiSite1 } from "../index.mjs"

const BASE = "https://api.example.com/gateway"
const account = (metadata = {}) => ({ type: "api", key: "sk-test-protocols", metadata: { baseURL: BASE, ...metadata } })
const json = (value) => new Response(JSON.stringify(value))
function catalog(t, ids) {
  t.mock.method(globalThis, "fetch", async (url) => json(String(url).includes("backend-api") ? {} : { data: ids.map((id) => ({ id })) }))
}

test("the four vendor-category examples are loadable and require no embedded keys", async () => {
  const options = JSON.parse(await readFile(new URL("../examples/options.json", import.meta.url), "utf8"))
  const plugins = await import("../index.mjs")
  for (let i = 0; i < options.sites.length; i++) {
    const site = options.sites[i]
    const plugin = await plugins[`Sub2apiSite${i + 1}`]({}, options)
    assert.equal(plugin.provider.id, site.id)
    assert.equal(Object.hasOwn(site, "apiKey"), false)
    const loader = await plugin.auth.loader(async () => account())
    assert.equal(loader.baseURL, site.baseURL + "/v1")
  }
})

test("auto covers native Anthropic, OpenAI, Gemini, domestic and other compatible models", async (t) => {
  const groups = {
    "@ai-sdk/anthropic": ["claude-sonnet-test", "anthropic/claude-test", "all/claude-alias"],
    "@ai-sdk/openai": ["gpt-test", "openai/gpt-test", "o3-test", "codex-test"],
    "@ai-sdk/google": ["gemini-test", "google/gemini-test", "all/gemini-alias"],
    "@ai-sdk/openai-compatible": ["deepseek-chat", "Qwen/Qwen-test", "moonshotai/kimi-test", "glm-test", "MiniMax-test", "grok-test", "custom-alias"],
  }
  catalog(t, Object.values(groups).flat())
  const plugin = await Sub2apiPlugin()
  const models = await plugin.provider.models({ models: {} }, { auth: account() })
  for (const [npm, ids] of Object.entries(groups)) {
    for (const id of ids) {
      assert.equal(models[id].api.npm, npm, id)
      assert.equal(models[id].api.url, BASE + (npm === "@ai-sdk/google" ? "/v1beta" : "/v1"))
    }
  }
})

test("explicit model protocols beat model names and merge global, site and account rules", async (t) => {
  catalog(t, ["gpt-legacy", "claude-compatible", "custom-alias", "gemini-chat", "fallback", "auto-model"])
  const plugin = await Sub2apiSite1({}, {
    protocol: "responses",
    modelProtocols: { "gpt-legacy": "chat-completions", "custom-alias": "responses" },
    sites: [{ id: "mixed", baseURL: BASE, protocol: "anthropic", modelProtocols: { "custom-alias": "gemini" } }],
  })
  const auth = account({
    protocol: "chat-completions",
    modelProtocols: { "claude-compatible": "openai-compatible", "gemini-chat": "chat_completions", "auto-model": "auto" },
  })
  const models = await plugin.provider.models({ models: {} }, { auth })
  for (const id of ["gpt-legacy", "claude-compatible", "gemini-chat", "fallback", "auto-model"]) {
    assert.equal(models[id].api.npm, "@ai-sdk/openai-compatible")
  }
  assert.equal(models["custom-alias"].api.npm, "@ai-sdk/google")
  assert.equal((await plugin.auth.loader(async () => auth)).apiKey, auth.key)
})

test("protocol aliases select the corresponding SDK", async (t) => {
  catalog(t, ["unbranded-model"])
  for (const [protocol, npm] of Object.entries({
    anthropic: "@ai-sdk/anthropic", messages: "@ai-sdk/anthropic",
    openai: "@ai-sdk/openai", responses: "@ai-sdk/openai",
    "openai-compatible": "@ai-sdk/openai-compatible", chat_completions: "@ai-sdk/openai-compatible",
    gemini: "@ai-sdk/google", google: "@ai-sdk/google",
  })) {
    const plugin = await Sub2apiPlugin({}, { protocol })
    const models = await plugin.provider.models({ models: {} }, { auth: account() })
    assert.equal(models["unbranded-model"].api.npm, npm, protocol)
  }
})

test("protocol paths merge per key and account URLs may end in v1beta", async (t) => {
  catalog(t, ["claude-test", "gpt-test", "deepseek-chat", "gemini-test"])
  const plugin = await Sub2apiSite1({}, {
    apiPaths: { anthropic: "/global/v1", gemini: "/global/v1beta" },
    sites: [{ id: "mixed", url: BASE + "/v1beta/", apiPaths: { anthropic: "/site/v1", "chat-completions": "/site/compatible/v1" } }],
  })
  const auth = account({ apiPaths: { anthropic: "/account/v1" } })
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(models["claude-test"].api.url, BASE + "/account/v1")
  assert.equal(models["gpt-test"].api.url, BASE + "/v1")
  assert.equal(models["deepseek-chat"].api.url, BASE + "/site/compatible/v1")
  assert.equal(models["gemini-test"].api.url, BASE + "/global/v1beta")
  const pooled = await Sub2apiPlugin()
  const loader = await pooled.auth.loader(async () => account({ baseURL: BASE + "/v1beta/" }))
  assert.equal(loader.baseURL, BASE + "/v1")
})

test("native Gemini routes loader /v1 to /v1beta, preserves streaming query and fixes authentication", async (t) => {
  const plugin = await Sub2apiPlugin({}, { headers: { "X-Client": "magpie" } })
  const auth = account()
  const loader = await plugin.auth.loader(async () => auth)
  const calls = []
  const response = new Response("data: native\n\n")
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return response })
  const controller = new AbortController()
  for (const action of ["generateContent", "streamGenerateContent", "countTokens"]) {
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    const result = await loader.fetch(`${BASE}/v1/models/gemini-test:${action}?alt=sse&key=wrong`, {
      method: "POST", body, signal: controller.signal,
      headers: { "x-goog-api-key": "wrong", authorization: "Bearer wrong" },
    })
    assert.equal(result, response)
    const { input, init } = calls.at(-1)
    assert.equal(input, `${BASE}/v1beta/models/gemini-test:${action}?alt=sse`)
    assert.equal(init.body, body)
    assert.equal(init.signal, controller.signal)
    assert.equal(init.headers.get("x-goog-api-key"), auth.key)
    assert.equal(init.headers.get("authorization"), `Bearer ${auth.key}`)
    assert.equal(init.headers.get("x-client"), "magpie")
    assert.equal(init.redirect, "error")
  }
})

test("custom protocol base paths route all APIs without moving management queries", async (t) => {
  const apiPaths = { anthropic: "/antigravity/v1/", responses: "/openai/v1", "chat-completions": "/compatible/v2", gemini: "/antigravity/v1beta" }
  catalog(t, ["claude-test", "gpt-test", "deepseek-chat", "gemini-test"])
  const plugin = await Sub2apiPlugin({}, { apiPaths })
  const auth = account()
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(models["claude-test"].api.url, BASE + "/antigravity/v1")
  assert.equal(models["gemini-test"].api.url, BASE + "/antigravity/v1beta")
  t.mock.restoreAll()
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({ balance: 1 }) })
  const loader = await plugin.auth.loader(async () => auth)
  for (const [suffix, target] of Object.entries({
    messages: "/antigravity/v1/messages", "messages/count_tokens": "/antigravity/v1/messages/count_tokens",
    responses: "/openai/v1/responses", "responses/compact": "/openai/v1/responses/compact",
    "chat/completions": "/compatible/v2/chat/completions",
    "models/gemini-test:streamGenerateContent": "/antigravity/v1beta/models/gemini-test:streamGenerateContent",
  })) {
    await loader.fetch(BASE + "/v1/" + suffix)
    assert.equal(calls.at(-1).input, BASE + target)
  }
  await plugin.auth.usage(async () => auth)
  assert.equal(calls.at(-1).input, BASE + "/v1/usage")
  // Already resolved model URLs are accepted and never gain duplicate prefixes.
  await loader.fetch(BASE + "/antigravity/v1/messages")
  assert.equal(calls.at(-1).input, BASE + "/antigravity/v1/messages")
  assert.equal(calls.at(-1).init.headers.get("x-api-key"), auth.key)
  assert.equal(calls.at(-1).init.headers.get("anthropic-version"), "2023-06-01")
  await loader.fetch(BASE + "/v1beta/models/gemini-test:generateContent")
  assert.equal(calls.at(-1).input, BASE + "/antigravity/v1beta/models/gemini-test:generateContent")
  await assert.rejects(loader.fetch("https://outside.example.com/antigravity/v1/messages"), /Refusing/)
})

test("rewriting a Request retains method, body, headers and cancellation", async (t) => {
  const plugin = await Sub2apiPlugin({}, { apiPaths: { anthropic: "/proxy/anthropic/v1" } })
  const loader = await plugin.auth.loader(async () => account())
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({}) })
  const controller = new AbortController()
  const request = new Request(BASE + "/v1/messages", {
    method: "POST", body: '{"model":"custom-alias","stream":true}', headers: { "x-trace": "kept" }, signal: controller.signal,
  })
  await loader.fetch(request)
  const { input, init } = calls[0]
  assert.ok(input instanceof Request)
  assert.equal(input.url, BASE + "/proxy/anthropic/v1/messages")
  assert.equal(input.method, "POST")
  assert.equal(await input.text(), '{"model":"custom-alias","stream":true}')
  assert.equal(init.headers.get("x-trace"), "kept")
  controller.abort()
  assert.equal(input.signal.aborted, true)
})

test("root endpoint paths work and protocol options fail fast when invalid", async (t) => {
  const plugin = await Sub2apiPlugin({}, { apiPaths: { responses: "/" } })
  const loader = await plugin.auth.loader(async () => account())
  let destination
  t.mock.method(globalThis, "fetch", async (url) => { destination = url; return json({}) })
  await loader.fetch(BASE + "/v1/responses")
  assert.equal(destination, BASE + "/responses")
  const invalid = [
    { protocol: "unsupported" }, { protocol: 42 }, { modelProtocols: [] }, { modelProtocols: { alias: "invalid" } },
    { apiPaths: { auto: "/v1" } }, { apiPaths: { gemini: "https://outside.example.com" } },
    { apiPaths: { gemini: "//outside.example.com" } }, { apiPaths: { gemini: "/../private" } },
    { apiPaths: { gemini: "/%2e%2e/private" } }, { apiPaths: { gemini: "/v1?secret=x" } },
    { apiPaths: { gemini: "/v1#fragment" } },
  ]
  for (const options of invalid) await assert.rejects(Sub2apiPlugin({}, options))
  await assert.rejects(loader.fetch(BASE + "/../outside"), /Refusing/)
  await assert.rejects(plugin.auth.loader(async () => account({ protocol: "unknown" })))
})

test("a Base URL is the only extra login prompt; both example sites work without protocol settings", async (t) => {
  catalog(t, ["claude-test", "gpt-test", "deepseek-chat", "gemini-test"])
  const plugin = await Sub2apiPlugin()
  assert.deepEqual(plugin.auth.methods[0].prompts.map((p) => p.key), ["baseURL"])
  for (const baseURL of ["http://179.255.97.172:3005", "https://api.pingcodes.cc"]) {
    const auth = account({ baseURL })
    const loader = await plugin.auth.loader(async () => auth)
    assert.equal(loader.baseURL, baseURL + "/v1")
    const models = await plugin.provider.models({ models: {} }, { auth })
    for (const id of ["claude-test", "gpt-test", "deepseek-chat"]) assert.equal(models[id].api.url, baseURL + "/v1")
    assert.equal(models["gemini-test"].api.url, baseURL + "/v1beta")
  }
})

test("a single baseUrl option removes all extra prompts without retargeting saved accounts", async () => {
  const baseURL = "https://api.pingcodes.cc"
  for (const key of ["baseUrl", "baseURL", "url"]) {
    const plugin = await Sub2apiPlugin({}, { [key]: baseURL })
    assert.deepEqual(plugin.auth.methods[0].prompts, [])
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "sk-test" }))
    assert.equal(loader.baseURL, baseURL + "/v1")
    const saved = await plugin.auth.loader(async () => account())
    assert.equal(saved.baseURL, BASE + "/v1")
  }
  const site = await Sub2apiSite1({}, { sites: [{ baseUrl: baseURL }] })
  assert.deepEqual(site.auth.methods[0].prompts, [])
  assert.equal(site.provider.id, "api-pingcodes-cc")
  for (const baseUrl of ["", "ftp://invalid.example.com", baseURL + "?key=secret"]) {
    await assert.rejects(Sub2apiPlugin({}, { baseUrl }))
  }
})

test("advanced headers work with only baseUrl configured and add no login prompts", async (t) => {
  const baseUrl = "https://api.pingcodes.cc"
  const plugin = await Sub2apiPlugin({}, { baseUrl, headers: { "User-Agent": "my-client", "X-Client": "magpie" } })
  const auth = { type: "api", key: "sk-test-advanced-headers" }
  assert.deepEqual(plugin.auth.methods[0].prompts, [])
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push({ input, init })
    const url = String(input)
    return json(url.includes("backend-api") ? {} : url.endsWith("usage") ? { balance: 3 } : { data: [{ id: "deepseek-chat" }] })
  })
  const loader = await plugin.auth.loader(async () => auth)
  assert.equal((await plugin.auth.usage(async () => auth)).balance, "$3.00")
  const models = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(models["deepseek-chat"].api.url, baseUrl + "/v1")
  await loader.fetch(baseUrl + "/v1/chat/completions", { method: "POST", body: "{}" })
  assert.equal(calls.length, 4)
  for (const { init } of calls) {
    const headers = new Headers(init.headers)
    assert.equal(headers.get("user-agent"), "my-client")
    assert.equal(headers.get("x-client"), "magpie")
    assert.equal(headers.get("authorization"), `Bearer ${auth.key}`)
  }
})
