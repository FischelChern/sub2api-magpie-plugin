import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1 } from "../index.mjs"

const BASE = "https://discovery.example.com/panel"
const account = (key = "synthetic-key-a", baseURL = BASE, metadata = {}) => ({ type: "api", key, metadata: { baseURL, ...metadata } })
const catalog = (...ids) => ({ data: ids.map((id) => ({ id })) })
const previous = { models: { unrelated: { id: "unrelated" } } }
const fresh = { query: { modelsTtlMs: 0, usageTtlMs: 0, effortsTtlMs: 0 } }

function mockAPI(t, route) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const call = { url: String(input), headers: new Headers(init?.headers), init }
    calls.push(call)
    return route(call)
  })
  return calls
}

test("discovery keeps all key models including namespaced, non-chat and unfamiliar IDs", async (t) => {
  const ids = ["shared", "vendor/private-model", "text-embedding-test", "image-generator", "unknown-alias"]
  mockAPI(t, () => Response.json(catalog(...ids)))
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(previous, { auth: account() })
  assert.deepEqual(Object.keys(found), ids)
  assert.equal(found.unrelated, undefined)
  assert.equal(found["unknown-alias"].capabilities.reasoning, false)
})

test("discovery follows all cursor pages and validated next URLs with the same key and headers", async (t) => {
  const calls = mockAPI(t, ({ url }) => Response.json(url.includes("after_id=")
    ? { ...catalog("page-2"), next: "?offset=2" }
    : url.includes("offset=2") ? catalog("page-3") : { ...catalog("page-1"), has_more: true, last_id: "cursor/+" }))
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(previous, { auth: account("pagination-key", BASE, { headers: { "X-Group": "private" } }) })
  assert.deepEqual(Object.keys(found), ["page-1", "page-2", "page-3"])
  assert.deepEqual(calls.map((c) => c.url), [BASE + "/v1/models", BASE + "/v1/models?after_id=cursor%2F%2B", BASE + "/v1/models?offset=2"])
  for (const call of calls) {
    assert.equal(call.headers.get("authorization"), "Bearer pagination-key")
    assert.equal(call.headers.get("x-group"), "private")
    assert.equal(call.init.redirect, "error")
  }
})

test("pagination rejects foreign origins, credentials, management paths, cycles and partial failures", async (t) => {
  for (const next of ["https://outside.example.com/v1/models", "https://user:pass@discovery.example.com/panel/v1/models", "/panel/v1/usage", "/panel/v1/models"]) {
    await t.test(next, async (t) => {
      const calls = mockAPI(t, () => Response.json({ ...catalog("partial"), next }))
      const plugin = await Sub2apiPlugin()
      await assert.rejects(plugin.provider.models(previous, { auth: account() }), /pagination/)
      assert.equal(calls.length, 1)
    })
  }
  const calls = mockAPI(t, ({ url }) => url.includes("after_id=") ? new Response(null, { status: 503 }) : Response.json({ ...catalog("partial"), has_more: true }))
  const plugin = await Sub2apiPlugin()
  await assert.rejects(plugin.provider.models(previous, { auth: account() }), /503/)
  assert.equal(calls.length, 2)
})

test("a genuinely empty key catalog stays empty without inheriting host models", async (t) => {
  mockAPI(t, () => Response.json(catalog()))
  const plugin = await Sub2apiPlugin()
  assert.deepEqual(Object.keys(await plugin.provider.models(previous, { auth: account() })), [])
  assert.deepEqual(await plugin.provider.models(previous), {})
})

test("model refresh preserves known metadata without mutating the host or borrowing API identity", async (t) => {
  mockAPI(t, () => Response.json(catalog("vision-chat", "gpt-legacy")))
  const known = {
    id: "wrong", providerID: "wrong", name: "Vision", api: { id: "wrong", url: "https://wrong.example.com", npm: "wrong" },
    limit: { context: 128000, input: 120000, output: 8192 },
    cost: { input: 2, output: 6, cache: { read: 0.2, write: 1 } },
    capabilities: { reasoning: false, attachment: true, toolcall: true, input: { text: true, image: true, pdf: true } },
    options: { temperature: 0.4 }, headers: { "x-model": "retained" }, release_date: "2026-01-01", free: false, rate: 2,
  }
  const original = structuredClone(known)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models({ models: { "vision-chat": known } }, { auth: account() })
  const model = found["vision-chat"]
  for (const field of ["limit", "cost", "options", "headers", "release_date", "free", "rate"]) assert.deepEqual(model[field], known[field])
  assert.equal(model.capabilities.input.image, true)
  assert.equal(model.capabilities.input.pdf, true)
  assert.equal(model.capabilities.toolcall, true)
  assert.equal(model.id, "vision-chat")
  assert.equal(model.providerID, "sub2api")
  assert.deepEqual(model.api, { id: "vision-chat", url: BASE + "/v1", npm: "@ai-sdk/openai-compatible" })
  assert.equal(found["gpt-legacy"].capabilities.reasoning, false)
  model.limit.context = 1
  assert.deepEqual(known, original)
})

test("optional exact filters, display names and model overrides merge global < site < account", async (t) => {
  mockAPI(t, () => Response.json(catalog("a", "b", "c")))
  const plugin = await Sub2apiSite1({}, {
    includeModels: ["a", "b"], modelNames: { a: "Global A" },
    modelOverrides: { a: { limit: { context: 128000 }, capabilities: { input: { image: true } }, variants: { old: {} } } },
    sites: [{ id: "site", url: BASE, excludeModels: ["b"], modelOverrides: { a: { limit: { output: 8192 } } } }],
  })
  const found = await plugin.provider.models(previous, { auth: account("key", BASE, {
    modelNames: { a: "Account A" }, modelOverrides: { a: { capabilities: { toolcall: true }, variants: { high: {} } } },
  }) })
  assert.deepEqual(Object.keys(found), ["a"])
  assert.equal(found.a.name, "Account A")
  assert.deepEqual(found.a.limit, { context: 128000, output: 8192 })
  assert.equal(found.a.capabilities.input.image, true)
  assert.equal(found.a.capabilities.toolcall, true)
  assert.deepEqual(Object.keys(found.a.variants), ["old", "high"])
  assert.equal(found.a.api.url, BASE + "/v1")
})

test("invalid model and query settings fail explicitly without exposing their values", async () => {
  const bad = [
    { includeModels: "private" }, { excludeModels: [42] }, { modelNames: { a: 1 } },
    { modelOverrides: { a: { api: { url: "secret" } } } },
    { modelOverrides: { a: { options: { apiKey: "secret" } } } },
    { modelOverrides: { a: { limit: { context: -1 } } } },
    { modelOverrides: { a: { capabilities: { input: { image: "secret" } } } } },
    { query: { timeoutMs: 0 } }, { query: { private: "secret" } }, { diagnostics: "secret" },
  ]
  for (const options of bad) await assert.rejects(Sub2apiPlugin({}, options), (error) => !error.message.includes("secret"))
  const plugin = await Sub2apiPlugin()
  await assert.rejects(plugin.provider.models(previous, { auth: account("key", BASE, { headers: { Authorization: "secret" } }) }), /reserved/)
})

test("concurrent model and usage queries coalesce, cache briefly and expire independently", async (t) => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const calls = mockAPI(t, ({ url }) => Response.json(url.endsWith("usage") ? { balance: 5 } : catalog("a")))
  const plugin = await Sub2apiPlugin()
  const getModels = () => plugin.provider.models(previous, { auth: account() })
  const getUsage = () => plugin.auth.usage(async () => account())
  await Promise.all([getModels(), getModels(), getUsage(), getUsage()])
  assert.equal(calls.length, 2)
  now += 5000
  await getUsage()
  await getModels()
  assert.equal(calls.length, 3)
  now += 55000
  await getModels()
  assert.equal(calls.length, 4)
})

test("query caches isolate keys, origins, deployment paths and header-selected groups", async (t) => {
  const calls = mockAPI(t, ({ url, headers }) => Response.json(catalog(url + ":" + headers.get("authorization") + ":" + headers.get("x-group"))))
  const plugin = await Sub2apiPlugin()
  const accounts = [account(), account("synthetic-key-b"), account("synthetic-key-a", "https://other.example.com/panel"), account("synthetic-key-a", BASE + "/other"), account("synthetic-key-a", BASE, { headers: { "X-Group": "b" } })]
  const results = await Promise.all(accounts.map((auth) => plugin.provider.models(previous, { auth })))
  assert.equal(calls.length, 5)
  assert.equal(new Set(results.map((found) => Object.keys(found)[0])).size, 5)
  await plugin.provider.models(previous, { auth: account("synthetic-key-a", BASE, { headers: {} }) })
  assert.equal(calls.length, 5)
})

test("401 invalidates this key's cached models but leaves other accounts intact", async (t) => {
  let invalid = false
  const calls = mockAPI(t, ({ url, headers }) => invalid && headers.get("authorization") === "Bearer synthetic-key-a"
    ? new Response(null, { status: 401 }) : Response.json(url.endsWith("usage") ? { balance: 5 } : catalog("a")))
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models(previous, { auth: account() })
  await plugin.provider.models(previous, { auth: account("synthetic-key-b") })
  invalid = true
  assert.equal((await plugin.auth.usage(async () => account())).signIn, "expired")
  await assert.rejects(plugin.provider.models(previous, { auth: account() }), (error) => error.signIn === "expired")
  await plugin.provider.models(previous, { auth: account("synthetic-key-b") })
  assert.equal(calls.length, 4)
})

test("failed refreshes never use old or host models, and failed queries are not success-cached", async (t) => {
  let failed = false
  const calls = mockAPI(t, () => failed ? new Response("private error body", { status: 503 }) : Response.json(catalog("own-model")))
  const plugin = await Sub2apiPlugin({}, fresh)
  const own = await plugin.provider.models(previous, { auth: account() })
  failed = true
  await assert.rejects(plugin.provider.models({ models: own }, { auth: account() }), /503/)
  await assert.rejects(plugin.provider.models(previous, { auth: account() }), /503/)
  assert.equal(calls.length, 3)
})

test("optional Codex lookup uses a short budget, failure cache and never queries Claude-only groups", async (t) => {
  const calls = mockAPI(t, ({ url, init }) => {
    if (!url.includes("backend-api")) return Response.json(catalog("gpt-test"))
    return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
  })
  const plugin = await Sub2apiPlugin({}, { query: { effortsTimeoutMs: 10 } })
  // AbortSignal.timeout does not keep the process alive on its own.
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const known = { models: { "gpt-test": { variants: { high: {} } } } }
    const found = await plugin.provider.models(known, { auth: account() })
    assert.deepEqual(Object.keys(found["gpt-test"].variants), ["high"])
    await plugin.provider.models(known, { auth: account() })
    assert.equal(calls.filter((call) => call.url.includes("backend-api")).length, 1)
  } finally {
    clearTimeout(keepAlive)
  }
  t.mock.restoreAll()
  const claudeCalls = mockAPI(t, () => Response.json(catalog("claude-test")))
  const claude = await Sub2apiPlugin()
  await claude.provider.models(previous, { auth: account() })
  assert.equal(claudeCalls.length, 1)
})

test("a hanging public icon cannot block an available model catalog", async (t) => {
  let release
  t.mock.method(globalThis, "fetch", async (input, init) => init?.credentials === "omit"
    ? new Promise((resolve) => { release = resolve }) : Response.json(catalog("ready")))
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(previous, { auth: account() })
  assert.ok(found.ready)
  assert.equal(plugin.auth.icon, undefined)
  release(new Response('<link rel="icon" href="data:image/svg+xml,%3Csvg%2F%3E">'))
  await plugin.config({})
  assert.ok(plugin.auth.icon)
})

test("management responses enforce declared, streamed and combined pagination size limits", async (t) => {
  for (const declared of [true, false]) {
    await t.test(declared ? "declared" : "streamed", async (t) => {
      let cancelled = false
      mockAPI(t, () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(129)) },
        cancel() { cancelled = true },
      }), { headers: declared ? { "content-length": "129" } : {} }))
      const plugin = await Sub2apiPlugin({}, { query: { maxResponseBytes: 128 } })
      await assert.rejects(plugin.provider.models(previous, { auth: account() }), /size limit/)
      assert.equal(cancelled, true)
    })
  }
  mockAPI(t, ({ url }) => Response.json(url.includes("after_id") ? catalog("second-long-model-id") : { ...catalog("first-long-model-id"), has_more: true }))
  const plugin = await Sub2apiPlugin({}, { query: { maxResponseBytes: 90 } })
  await assert.rejects(plugin.provider.models(previous, { auth: account() }), /Combined model catalog/)
})

test("a stalled management response body is cancelled on timeout", async (t) => {
  let cancelled = false
  mockAPI(t, () => new Response(new ReadableStream({ cancel() { cancelled = true } })))
  const plugin = await Sub2apiPlugin({}, { query: { timeoutMs: 10 } })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(plugin.provider.models(previous, { auth: account() }), /timed out/)
    assert.equal(cancelled, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

test("diagnostics are opt-in and never log credentials, model names, URLs, metadata or upstream errors", async (t) => {
  const lines = []
  t.mock.method(console, "error", (line) => lines.push(line))
  mockAPI(t, ({ url }) => url.endsWith("usage") ? new Response("reflected-private-key", { status: 429 }) : Response.json(catalog("private-model-id")))
  const auth = account("private-key", BASE, { name: "private-account", headers: { "X-Group": "private-header" } })
  const silent = await Sub2apiPlugin()
  await silent.provider.models(previous, { auth })
  assert.equal(lines.length, 0)
  const plugin = await Sub2apiPlugin({}, { diagnostics: true })
  await plugin.provider.models(previous, { auth })
  await plugin.provider.models(previous, { auth })
  const usage = await plugin.auth.usage(async () => auth)
  assert.match(usage.error, /429/)
  const loader = await plugin.auth.loader(async () => auth)
  await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: '{"model":"private-model-id"}' })
  assert.ok(lines.some((line) => line.includes("query.cache")))
  assert.ok(lines.some((line) => line.includes("inference.route")))
  assert.ok(lines.some((line) => line.includes('"status":429')))
  for (const secret of ["private-key", "private-header", "private-account", "private-model-id", BASE, "reflected"]) {
    assert.equal(lines.join("\n").includes(secret), false)
    assert.equal(usage.error.includes(secret), false)
  }
})

test("new account identities do not collide on equal key suffixes and existing identities are preserved", async () => {
  const saved = []
  const plugin = await Sub2apiPlugin({ client: { auth: { set: async ({ body }) => saved.push(body) } } })
  for (const auth of [account("first-same"), account("other-same"), account("first-same", BASE + "/different")]) await plugin.auth.loader(async () => auth)
  assert.equal(new Set(saved.map((auth) => auth.accountId)).size, 3)
  const existing = { ...account("key"), accountId: "Keep this identity" }
  await plugin.auth.loader(async () => existing)
  assert.equal(saved.length, 3)
})

test("inference failures preserve the exact response and never retry or substitute a model or key", async (t) => {
  const plugin = await Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => account())
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const response = new Response("unchanged failure", { status })
    const calls = mockAPI(t, () => response)
    const body = '{"model":"selected-model","stream":true}'
    assert.equal(await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body }), response)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.body, body)
    assert.equal(calls[0].headers.get("authorization"), "Bearer synthetic-key-a")
    t.mock.restoreAll()
  }
  const failure = new Error("network failed")
  const calls = mockAPI(t, () => { throw failure })
  await assert.rejects(loader.fetch(BASE + "/v1/chat/completions"), (error) => error === failure)
  assert.equal(calls.length, 1)
})

test("real HTTP multi-key catalogs and selected-account transports retain the matching base URL and key", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    if (!req.url.includes("/v1/")) { res.writeHead(404).end(); return }
    let body = ""
    for await (const chunk of req) body += chunk
    calls.push({ url: req.url, authorization: req.headers.authorization, group: req.headers["x-group"], body })
    const group = req.headers.authorization === "Bearer key-a" ? "a" : "b"
    if (req.url.endsWith("/models")) res.end(JSON.stringify(catalog("shared", "only-" + group)))
    else res.end(JSON.stringify({ group }))
  })
  server.listen(0, "127.0.0.1")
  try { await once(server, "listening") } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const plugin = await Sub2apiPlugin()
  const accounts = [account("key-a", origin + "/a", { headers: { "X-Group": "a" } }), account("key-b", origin + "/b", { headers: { "X-Group": "b" } })]
  const catalogs = await Promise.all(accounts.map((auth) => plugin.provider.models(previous, { auth })))
  assert.deepEqual(Object.keys(catalogs[0]), ["shared", "only-a"])
  assert.deepEqual(Object.keys(catalogs[1]), ["shared", "only-b"])
  const loaders = await Promise.all(accounts.map((auth) => plugin.auth.loader(async () => auth)))
  for (const [index, model] of [[1, "only-b"], [0, "only-a"], [1, "shared"], [0, "shared"]]) {
    const response = await loaders[index].fetch(catalogs[index][model].api.url + "/chat/completions", { method: "POST", body: JSON.stringify({ model }), headers: { authorization: "Bearer wrong-key" } })
    assert.equal((await response.json()).group, index ? "b" : "a")
    assert.equal(calls.at(-1).url, (index ? "/b" : "/a") + "/v1/chat/completions")
    assert.equal(calls.at(-1).authorization, "Bearer " + accounts[index].key)
    assert.equal(calls.at(-1).group, index ? "b" : "a")
    assert.equal(JSON.parse(calls.at(-1).body).model, model)
  }
  await assert.rejects(loaders[0].fetch(origin + "/b/v1/chat/completions"), /outside/)
  await plugin.config({})
})
