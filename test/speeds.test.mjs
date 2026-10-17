import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1 } from "../index.mjs"

const BASE = "https://speeds.example.com/deployment"
const LEGACY_HEADERS = ["x-sub2api-magpie-plugin-speed-model", "x-magpie-sub2api-speed-model"]
const account = (key = "speed-test-key", baseURL = BASE, metadata = {}) => ({ type: "api", key, metadata: { baseURL, ...metadata } })
const provider = { models: {} }

function mockAPI(t, { entries = ["gpt-test"], manifest = {}, reply = () => Response.json({ ok: true }) } = {}) {
  const requests = []
  const queries = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    const call = { input, url, init, headers: new Headers(init?.headers) }
    if (url.endsWith("/v1/models")) {
      queries.push(call)
      const data = typeof entries === "function" ? entries(call) : entries
      return Response.json({ data: data.map((m) => typeof m === "string" ? { id: m } : m) })
    }
    if (url.includes("/backend-api/")) {
      queries.push(call)
      return typeof manifest === "function" ? manifest(call) : Response.json(manifest)
    }
    requests.push(call)
    return reply(call)
  })
  return { requests, queries }
}

test("reported speeds stay on original models without adding model IDs or changing names", async (t) => {
  mockAPI(t, { entries: [
    { id: "gpt-test", service_tiers: ["default", { id: "priority", name: "Fast" }, { id: "ultrafast" }] },
    { id: "chat-model", serviceTiers: ["priority"] }, "claude-test", "gemini-test", "unfamiliar",
  ] })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test", "chat-model", "claude-test", "gemini-test", "unfamiliar"])
  assert.deepEqual(found["gpt-test"].serviceTiers, ["default", "priority", "ultrafast"])
  assert.deepEqual(found["chat-model"].serviceTiers, ["priority"])
  assert.equal(found["gpt-test"].api.id, "gpt-test")
  assert.equal(found["gpt-test"].name, "gpt-test")
  assert.equal(found["gpt-test"].fast, undefined)
  const output = { headers: {} }
  await plugin["chat.headers"]({ model: found["gpt-test"] }, output)
  assert.deepEqual(output.headers, {})
})

test("missing capabilities never infer speeds from model names, protocols or another account's host metadata", async (t) => {
  mockAPI(t, { entries: ["gpt-test", "gpt-5-test", "o3-test", "chat-model"] })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models({ models: { "gpt-test": { serviceTiers: ["priority", "ultrafast"], fast: true } } }, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test", "gpt-5-test", "o3-test", "chat-model"])
  for (const model of Object.values(found)) {
    assert.deepEqual(model.serviceTiers, [])
    assert.equal(model.fast, undefined)
  }
})

test("display names strip trailing speed labels without changing IDs or inferring tier support", async (t) => {
  const entries = [
    { id: "gpt-fast-label", display_name: "GPT Example (fast)", service_tiers: ["priority", "ultrafast"] },
    { id: "gpt-wide-label", name: "GPT Example \uFF08 FaSt \uFF09" },
    { id: "gpt-ultra-label", display_name: "GPT Example (ULTRASPEED)" },
    { id: "gpt-stacked-label", display_name: "GPT Example (fast) \uFF08ultrafast\uFF09  " },
    { id: "gpt-interior", display_name: "GPT (fast) Example (preview)" },
    { id: "gpt-label-only", display_name: " (fast) " },
    { id: "gpt-real-fast" },
    { id: "gpt-real (fast)" },
  ]
  const original = structuredClone(entries)
  mockAPI(t, { entries })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(Object.keys(found), entries.map((m) => m.id))
  for (const id of ["gpt-fast-label", "gpt-wide-label", "gpt-ultra-label", "gpt-stacked-label"]) {
    assert.equal(found[id].name, "GPT Example")
  }
  assert.equal(found["gpt-interior"].name, "GPT (fast) Example (preview)")
  for (const id of ["gpt-label-only", "gpt-real-fast", "gpt-real (fast)"]) assert.equal(found[id].name, id)
  for (const model of Object.values(found)) {
    assert.equal(model.api.id, model.id)
    assert.deepEqual(model.serviceTiers, model.id === "gpt-fast-label" ? ["priority", "ultrafast"] : [])
  }
  assert.deepEqual(entries, original)
})

test("speed labels are removed after host, override and configured name precedence without mutating sources", async (t) => {
  mockAPI(t, { entries: ["gpt-host", "gpt-override", "gpt-configured"] })
  const known = { models: {
    "gpt-host": { name: "Host Name (fast)" },
    "gpt-override": { name: "Old Name (fast)" },
    "gpt-configured": { name: "Old Name (fast)" },
  } }
  const options = {
    modelNames: { "gpt-configured": "Configured Name \uFF08ultraspeed\uFF09" },
    modelOverrides: {
      "gpt-override": { name: "Override Name (ULTRAFAST)", serviceTiers: ["fast", "ultraspeed"] },
      "gpt-configured": { name: "Lower Priority Name (fast)" },
    },
  }
  const original = structuredClone({ known, options })
  const plugin = await Sub2apiPlugin({}, options)
  const found = await plugin.provider.models(known, { auth: account() })
  assert.equal(found["gpt-host"].name, "Host Name")
  assert.equal(found["gpt-override"].name, "Override Name")
  assert.equal(found["gpt-configured"].name, "Configured Name")
  assert.deepEqual(found["gpt-override"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual({ known, options }, original)
})

test("the same key's Codex manifest supplies tiers independently of reasoning levels", async (t) => {
  mockAPI(t, {
    entries: ["gpt-test", "gpt-other", "gpt-none"],
    manifest: { models: [
      { slug: "gpt-test", service_tiers: [{ id: "priority" }, { id: "ultrafast" }] },
      { slug: "gpt-other", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], service_tiers: ["priority"] },
      { slug: "gpt-none", supported_reasoning_levels: ["none"], service_tiers: ["ultrafast"] },
      { slug: "not-listed", service_tiers: ["priority"] },
    ] },
  })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test", "gpt-other", "gpt-none"])
  assert.deepEqual(found["gpt-test"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(Object.keys(found["gpt-other"].variants), ["low", "high"])
  assert.deepEqual(found["gpt-none"].serviceTiers, ["ultrafast"])
  assert.equal(found["gpt-none"].capabilities.reasoning, false)
})

test("explicit model-list tiers including empty, null or malformed values take precedence over optional manifests", async (t) => {
  mockAPI(t, {
    entries: [
      { id: "gpt-empty", service_tiers: [] }, { id: "gpt-null", service_tiers: null },
      { id: "gpt-malformed", service_tiers: "priority" }, { id: "gpt-fast-only", service_tiers: ["priority"] },
    ],
    manifest: { models: ["gpt-empty", "gpt-null", "gpt-malformed", "gpt-fast-only"].map((slug) => ({ slug, service_tiers: ["ultrafast"] })) },
  })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  for (const id of ["gpt-empty", "gpt-null", "gpt-malformed"]) assert.deepEqual(found[id].serviceTiers, [])
  assert.deepEqual(found["gpt-fast-only"].serviceTiers, ["priority"])
})

test("tier metadata normalizes aliases and objects, deduplicates IDs and ignores invalid untrusted values", async (t) => {
  mockAPI(t, { entries: [{ id: "gpt-test", service_tiers: [" Fast ", "ultraspeed", { id: "priority" }, "FLEX", null, {}, 3, "bad tier", { id: "ultrafast" }] }] })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(found["gpt-test"].serviceTiers, ["priority", "ultrafast", "flex"])
})

test("explicit per-model tier declarations merge global < site < account without changing identity", async (t) => {
  mockAPI(t, { entries: ["gpt-test", "chat-model", "gpt-other"] })
  const plugin = await Sub2apiSite1({}, {
    modelOverrides: { "gpt-test": { serviceTiers: ["priority"], limit: { context: 128000 } }, "chat-model": { serviceTiers: ["fast"] } },
    sites: [{ id: "speed-site", url: BASE, modelOverrides: { "gpt-test": { serviceTiers: ["ultrafast"] } } }],
  })
  const auth = account("key", BASE, { modelOverrides: { "gpt-test": { serviceTiers: ["fast", "ultraspeed"] }, "chat-model": { serviceTiers: [] } } })
  const found = await plugin.provider.models(provider, { auth })
  assert.deepEqual(Object.keys(found), ["gpt-test", "chat-model", "gpt-other"])
  assert.deepEqual(found["gpt-test"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(found["chat-model"].serviceTiers, [])
  assert.deepEqual(found["gpt-other"].serviceTiers, [])
  assert.equal(found["gpt-test"].limit.context, 128000)
  assert.equal(found["gpt-test"].providerID, "speed-site")
  assert.equal(found["gpt-test"].api.id, "gpt-test")
})

test("legacy speedModels arrays only filter reported support and never manufacture capabilities or aliases", async (t) => {
  mockAPI(t, { entries: [{ id: "gpt-test", service_tiers: ["priority", "ultrafast", "flex"] }, "gpt-unknown"] })
  for (const [speedModels, tiers] of [
    [["fast", "ultraspeed"], ["priority", "ultrafast", "flex"]], [["fast"], ["priority", "flex"]], [[], ["flex"]],
  ]) {
    const plugin = await Sub2apiPlugin({}, { speedModels })
    const found = await plugin.provider.models(provider, { auth: account() })
    assert.deepEqual(Object.keys(found), ["gpt-test", "gpt-unknown"])
    assert.deepEqual(found["gpt-test"].serviceTiers, tiers)
    assert.deepEqual(found["gpt-unknown"].serviceTiers, [])
  }
})

test("legacy per-model speed declarations work on original models without generating aliases", async (t) => {
  mockAPI(t, { entries: ["gpt-test", "chat-model"] })
  const plugin = await Sub2apiSite1({}, {
    speedModels: { "gpt-test": ["fast"] }, sites: [{ id: "legacy", url: BASE, speedModels: { "chat-model": ["ultraspeed"] } }],
  })
  const found = await plugin.provider.models(provider, { auth: account("key", BASE, { speedModels: { "gpt-test": ["fast", "ultraspeed"] } }) })
  assert.deepEqual(Object.keys(found), ["gpt-test", "chat-model"])
  assert.deepEqual(found["gpt-test"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(found["chat-model"].serviceTiers, ["ultrafast"])
})

test("original models retain metadata, prices and real upstream IDs that happen to end in speed suffixes", async (t) => {
  mockAPI(t, { entries: [{ id: "gpt-test", service_tiers: ["priority"] }, "gpt-test-fast", "gpt-test-ultraspeed"] })
  const cost = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
  const known = { models: { "gpt-test": { cost, variants: { high: {} }, headers: { "x-model": "retained" } } } }
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(known, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test", "gpt-test-fast", "gpt-test-ultraspeed"])
  assert.deepEqual(found["gpt-test"].cost, cost)
  assert.deepEqual(found["gpt-test"].variants, { high: {} })
  assert.equal(found["gpt-test"].headers["x-model"], "retained")
  for (const model of Object.values(found)) assert.equal(model.id, model.api.id)
  assert.deepEqual(found["gpt-test-fast"].serviceTiers, [])
})

test("tier declarations respect filters and cannot add unlisted models", async (t) => {
  mockAPI(t, { entries: ["gpt-test", "gpt-other"] })
  const plugin = await Sub2apiPlugin({}, {
    includeModels: ["gpt-test"], excludeModels: ["gpt-other"],
    modelOverrides: { "gpt-test": { serviceTiers: ["priority"] }, missing: { serviceTiers: ["ultrafast"] } },
  })
  assert.deepEqual(Object.keys(await plugin.provider.models(provider, { auth: account() })), ["gpt-test"])
  const oldFilter = await Sub2apiPlugin({}, { includeModels: ["gpt-test-fast"] })
  assert.deepEqual(Object.keys(await oldFilter.provider.models(provider, { auth: account() })), [])
})

test("invalid tier declarations fail without exposing configuration values", async () => {
  for (const serviceTiers of [null, "priority", [3], [{}], ["bad secret"], ["x".repeat(65)], Array(65).fill("priority")]) {
    await assert.rejects(Sub2apiPlugin({}, { modelOverrides: { "gpt-test": { serviceTiers } } }), (error) => /serviceTiers/.test(error.message) && !error.message.includes("secret"))
  }
  for (const speedModels of [null, "fast", ["priority"], { a: "fast" }]) await assert.rejects(Sub2apiPlugin({}, { speedModels }), /speed/i)
})

test("unsupported protocols do not advertise OpenAI tiers or silently accept explicit tier overrides", async (t) => {
  mockAPI(t, { entries: [{ id: "claude-test", service_tiers: ["priority"] }, { id: "gemini-test", service_tiers: ["ultrafast"] }] })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(found["claude-test"].serviceTiers, [])
  assert.deepEqual(found["gemini-test"].serviceTiers, [])
  for (const model of ["claude-test", "gemini-test"]) {
    const explicit = await Sub2apiPlugin({}, { modelOverrides: { [model]: { serviceTiers: ["priority"] } } })
    await assert.rejects(explicit.provider.models(provider, { auth: account() }), /protocol/)
  }
})

test("Agent-selected speeds preserve the exact original request, key, response and cancellation", async (t) => {
  const response = new Response('data: {"usage":{"input_tokens":4,"output_tokens":2}}\n\n', { headers: { "content-type": "text/event-stream" } })
  const { requests } = mockAPI(t, { entries: ["gpt-test", "chat-model", "claude-test"], reply: () => response })
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const controller = new AbortController()
  for (const path of ["responses", "chat/completions", "messages"]) {
    for (const tier of [undefined, "priority", "ultrafast"]) {
      const model = path === "messages" ? "claude-test" : path === "responses" ? "gpt-test" : "chat-model"
      const body = JSON.stringify({ model, stream: true, ...(path === "messages" ? { speed: "fast" } : tier ? { service_tier: tier } : {}) })
      assert.equal(await loader.fetch(BASE + "/v1/" + path, { method: "POST", body, signal: controller.signal, headers: { authorization: "Bearer wrong" } }), response)
      assert.equal(requests.at(-1).init.body, body)
      assert.equal(requests.at(-1).headers.get("authorization"), "Bearer speed-test-key")
      assert.equal(requests.at(-1).init.signal, controller.signal)
      assert.equal(response.bodyUsed, false)
    }
  }
  assert.equal(requests.length, 9)
})

test("concurrent requests keep independently chosen speeds without injecting a default speed", async (t) => {
  const { requests } = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const bodies = ["priority", "ultrafast", "flex", undefined].map((tier) => JSON.stringify({ model: "gpt-test", ...(tier ? { service_tier: tier } : {}) }))
  await Promise.all(bodies.map((body) => loader.fetch(BASE + "/v1/responses", { method: "POST", body })))
  assert.deepEqual(requests.map((call) => call.init.body).sort(), bodies.sort())
})

test("native speed selection needs no buffering of binary, Request or streaming uploads", async (t) => {
  const { requests } = mockAPI(t, { entries: ["chat-model"] })
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const body = '{"model":"chat-model","service_tier":"priority"}'
  const bytes = new TextEncoder().encode(body)
  await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: bytes })
  assert.equal(requests.at(-1).init.body, bytes)
  const request = new Request(BASE + "/v1/chat/completions", { method: "POST", body })
  await loader.fetch(request)
  assert.equal(requests.at(-1).input, request)
  assert.equal(request.bodyUsed, false)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
  await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: stream, duplex: "half" })
  assert.equal(requests.at(-1).init.body, stream)
  assert.equal(stream.locked, false)
})

test("cached old speed-model selectors fail rather than silently running the original at another speed", async (t) => {
  const { requests } = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  const known = { models: { "gpt-test": { headers: Object.fromEntries(LEGACY_HEADERS.map((header) => [header, "old"])) } } }
  const found = await plugin.provider.models(known, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  for (const header of LEGACY_HEADERS) {
    assert.equal(found["gpt-test"].headers[header], undefined)
    const output = { headers: {} }
    await plugin["chat.headers"]({ model: { providerID: "sub2api", headers: { [header]: "gpt-test-fast" } } }, output)
    await assert.rejects(loader.fetch(BASE + "/v1/responses", { method: "POST", body: '{"model":"gpt-test"}', headers: output.headers }), /Legacy speed models/)
    await assert.rejects(Sub2apiPlugin({}, { headers: { [header]: "private-value" } }), /reserved/)
  }
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: '{"model":"gpt-test-fast"}' }), /not listed/)
  assert.equal(requests.length, 0)
})

test("manifest failures do not reuse stale speed support or hide available models", async (t) => {
  let failed = false
  mockAPI(t, { manifest: () => failed ? new Response(null, { status: 503 }) : Response.json({ models: [{ slug: "gpt-test", service_tiers: ["ultrafast"] }] }) })
  const plugin = await Sub2apiPlugin({}, { query: { modelsTtlMs: 0, effortsTtlMs: 0 } })
  const first = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(first["gpt-test"].serviceTiers, ["ultrafast"])
  failed = true
  const refreshed = await plugin.provider.models({ models: first }, { auth: account() })
  assert.deepEqual(Object.keys(refreshed), ["gpt-test"])
  assert.deepEqual(refreshed["gpt-test"].serviceTiers, [])
})

test("unsupported-tier responses and network failures return once without model, key or speed fallback", async (t) => {
  let result = new Response("tier not available", { status: 400 })
  const { requests } = mockAPI(t, { reply: () => { if (result instanceof Error) throw result; return result } })
  const plugin = await Sub2apiPlugin()
  await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const init = { method: "POST", body: '{"model":"gpt-test","service_tier":"ultrafast"}' }
  assert.equal(await loader.fetch(BASE + "/v1/responses", init), result)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.body, init.body)
  result = new Error("connection failed")
  await assert.rejects(loader.fetch(BASE + "/v1/responses", init), (error) => error === result)
  assert.equal(requests.length, 2)
})

test("same-name models retain per-key speed support even with host metadata from a different account", async (t) => {
  const { queries, requests } = mockAPI(t, {
    manifest: ({ headers }) => Response.json({ models: [{ slug: "gpt-test", service_tiers: headers.get("authorization") === "Bearer key-a" ? ["priority", "ultrafast"] : ["priority"] }] }),
  })
  const plugin = await Sub2apiPlugin()
  const accounts = [account("key-a", BASE + "/a"), account("key-b", BASE + "/b")]
  const first = await plugin.provider.models(provider, { auth: accounts[0] })
  const second = await plugin.provider.models({ models: first }, { auth: accounts[1] })
  assert.deepEqual(first["gpt-test"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(second["gpt-test"].serviceTiers, ["priority"])
  assert.equal(queries.length, 4)
  for (const [index, tier] of [[1, "priority"], [0, "ultrafast"], [0, "priority"], [1, undefined]]) {
    const loader = await plugin.auth.loader(async () => accounts[index])
    const body = JSON.stringify({ model: "gpt-test", ...(tier ? { service_tier: tier } : {}) })
    await loader.fetch(accounts[index].metadata.baseURL + "/v1/responses", { method: "POST", body })
    assert.equal(requests.at(-1).headers.get("authorization"), "Bearer " + accounts[index].key)
    assert.equal(requests.at(-1).url, accounts[index].metadata.baseURL + "/v1/responses")
    assert.equal(requests.at(-1).init.body, body)
  }
})

test("real HTTP uses one original model with per-key tier discovery, Agent choice and unchanged SSE usage", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    const tiers = req.headers.authorization === "Bearer key-a" ? ["priority", "ultrafast"] : ["priority"]
    if (req.url.endsWith("/v1/models")) { res.end(JSON.stringify({ data: [{ id: "gpt-test", service_tiers: tiers }] })); return }
    if (!req.url.endsWith("/v1/responses")) { res.writeHead(404).end(); return }
    let text = ""
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    calls.push({ body, headers: req.headers, url: req.url })
    if (body.service_tier && !tiers.includes(body.service_tier)) { res.writeHead(400).end("tier unavailable"); return }
    res.setHeader("content-type", "text/event-stream")
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n')
  })
  server.listen(0, "127.0.0.1")
  try { await once(server, "listening") } catch (error) {
    if (!["EPERM", "EACCES"].includes(error.code)) throw error
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const origin = `http://127.0.0.1:${server.address().port}`
  const accounts = [account("key-a", origin + "/a"), account("key-b", origin + "/b")]
  const plugin = await Sub2apiPlugin()
  const catalogs = await Promise.all(accounts.map((auth) => plugin.provider.models(provider, { auth })))
  const loaders = await Promise.all(accounts.map((auth) => plugin.auth.loader(async () => auth)))
  for (const found of catalogs) assert.deepEqual(Object.keys(found), ["gpt-test"])
  assert.deepEqual(catalogs[0]["gpt-test"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(catalogs[1]["gpt-test"].serviceTiers, ["priority"])
  for (const [index, tier] of [[0, "ultrafast"], [1, "priority"], [0, undefined]]) {
    const response = await loaders[index].fetch(accounts[index].metadata.baseURL + "/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-test", stream: true, ...(tier ? { service_tier: tier } : {}) }),
    })
    assert.match(await response.text(), /"input_tokens":3/)
    assert.equal(calls.at(-1).body.model, "gpt-test")
    assert.equal(calls.at(-1).body.service_tier, tier)
    assert.equal(calls.at(-1).headers.authorization, "Bearer " + accounts[index].key)
    assert.equal(calls.at(-1).url, (index ? "/b" : "/a") + "/v1/responses")
  }
  const before = calls.length
  const rejected = await loaders[1].fetch(accounts[1].metadata.baseURL + "/v1/responses", {
    method: "POST", body: '{"model":"gpt-test","service_tier":"ultrafast"}',
  })
  assert.equal(rejected.status, 400)
  assert.equal(await rejected.text(), "tier unavailable")
  assert.equal(calls.length, before + 1)
})
