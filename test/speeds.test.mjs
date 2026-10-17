import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1 } from "../index.mjs"

const BASE = "https://speeds.example.com/deployment"
const HEADER = "x-magpie-sub2api-speed-model"
const account = (key = "speed-test-key", baseURL = BASE, metadata = {}) => ({ type: "api", key, metadata: { baseURL, ...metadata } })
const provider = { models: {} }

function mockAPI(t, ids = ["gpt-test"], inference = () => Response.json({ ok: true })) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    if (url.endsWith("/v1/models")) return Response.json({ data: ids.map((id) => ({ id })) })
    if (url.includes("/backend-api/")) return Response.json({})
    const call = { url, init, headers: new Headers(init?.headers) }
    calls.push(call)
    return inference(call)
  })
  return calls
}

async function selectedHeaders(plugin, model) {
  const output = { headers: {} }
  await plugin["chat.headers"]({ model }, output)
  return output.headers
}

test("Responses automatically gains fast and ultraspeed presets with the same upstream model ID", async (t) => {
  mockAPI(t, ["gpt-test", "claude-test", "gemini-test", "unfamiliar"])
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test", "gpt-test-fast", "gpt-test-ultraspeed", "claude-test", "gemini-test", "unfamiliar"])
  for (const speed of ["fast", "ultraspeed"]) {
    const model = found["gpt-test-" + speed]
    assert.equal(model.id, "gpt-test-" + speed)
    assert.equal(model.name, `gpt-test (${speed})`)
    assert.equal(model.providerID, "sub2api")
    assert.deepEqual(model.api, found["gpt-test"].api)
    assert.notEqual(model.api, found["gpt-test"].api)
    assert.equal(found["gpt-test"].headers[HEADER], undefined)
  }
  assert.deepEqual(await selectedHeaders(plugin, { ...found["gpt-test-fast"], providerID: "another" }), {})
})

test("selected speed presets enforce priority or ultrafast without changing model, key, input or cancellation", async (t) => {
  const response = new Response('data: {"usage":{"input_tokens":4,"output_tokens":2}}\n\n', { headers: { "content-type": "text/event-stream" } })
  const calls = mockAPI(t, ["gpt-test"], () => response)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const controller = new AbortController()
  const original = { model: "gpt-test", input: "hello", stream: true, service_tier: "default", reasoning: { effort: "high" } }
  for (const [speed, tier] of [["fast", "priority"], ["ultraspeed", "ultrafast"]]) {
    const headers = await selectedHeaders(plugin, found["gpt-test-" + speed])
    headers["content-length"] = "1"
    headers.authorization = "Bearer wrong"
    assert.equal(await loader.fetch(BASE + "/v1/responses", { method: "POST", body: JSON.stringify(original), headers, signal: controller.signal }), response)
    const call = calls.at(-1)
    assert.deepEqual(JSON.parse(call.init.body), { ...original, service_tier: tier })
    assert.equal(call.headers.get(HEADER), null)
    assert.equal(call.headers.get("content-length"), null)
    assert.equal(call.headers.get("authorization"), "Bearer speed-test-key")
    assert.equal(call.init.signal, controller.signal)
    assert.equal(call.init.redirect, "error")
    assert.equal(response.bodyUsed, false)
  }
  assert.equal(original.service_tier, "default")
  assert.equal(calls.length, 2)
})

test("concurrent speed profiles remain request-local and normal model requests are not rewritten", async (t) => {
  const calls = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  await Promise.all(["fast", "ultraspeed"].map(async (speed) => loader.fetch(BASE + "/v1/responses", {
    method: "POST", body: '{"model":"gpt-test"}', headers: await selectedHeaders(plugin, found["gpt-test-" + speed]),
  })))
  assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).service_tier).sort(), ["priority", "ultrafast"])
  const body = '{ "model": "gpt-test", "service_tier": "flex" }'
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body })
  assert.equal(calls.at(-1).init.body, body)
})

test("speed configuration layers merge per original ID and may opt chat and Anthropic into supported presets", async (t) => {
  const calls = mockAPI(t, ["chat-alias", "claude-test", "gpt-test"])
  const plugin = await Sub2apiSite1({}, {
    speedModels: { "chat-alias": ["fast"] },
    modelProtocols: { "chat-alias": "chat-completions" },
    sites: [{ id: "speed-site", url: BASE, speedModels: { "claude-test": ["fast"] } }],
  })
  const auth = account("key", BASE, { speedModels: { "chat-alias": ["fast", "ultraspeed"] } })
  const found = await plugin.provider.models(provider, { auth })
  assert.ok(found["chat-alias-fast"])
  assert.ok(found["chat-alias-ultraspeed"])
  assert.ok(found["claude-test-fast"])
  assert.equal(found["gpt-test-fast"], undefined)
  const loader = await plugin.auth.loader(async () => auth)
  for (const [model, path] of [["chat-alias-ultraspeed", "chat/completions"], ["claude-test-fast", "messages"]]) {
    await loader.fetch(BASE + "/v1/" + path, { method: "POST", body: JSON.stringify({ model: found[model].api.id }), headers: await selectedHeaders(plugin, found[model]) })
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "chat-alias", service_tier: "ultrafast" })
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: "claude-test", speed: "fast" })
  assert.equal(calls[1].headers.get("x-api-key"), "key")
})

test("generated presets do not borrow base-tier prices and accept their own explicit names and costs", async (t) => {
  mockAPI(t)
  const cost = { input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }
  const speedCost = { input: 3, output: 6, cache: { read: 0.3, write: 0.6 } }
  const known = { models: { "gpt-test": { cost, free: true, rate: 0.5, variants: { high: {} }, limit: { context: 128000 }, headers: { "x-model": "retained" } } } }
  const plugin = await Sub2apiPlugin({}, {
    modelNames: { "gpt-test": "Original", "gpt-test-fast": "Quick" },
    modelOverrides: { "gpt-test-ultraspeed": { cost: speedCost } },
  })
  const found = await plugin.provider.models(known, { auth: account() })
  assert.deepEqual(found["gpt-test"].cost, cost)
  assert.equal(found["gpt-test-fast"].cost, undefined)
  assert.equal(found["gpt-test-fast"].free, undefined)
  assert.equal(found["gpt-test-fast"].rate, undefined)
  assert.equal(found["gpt-test-fast"].name, "Quick")
  assert.deepEqual(found["gpt-test-ultraspeed"].cost, speedCost)
  assert.deepEqual(found["gpt-test-fast"].variants, { high: {} })
  assert.equal(found["gpt-test-fast"].limit.context, 128000)
  assert.equal(found["gpt-test-fast"].headers["x-model"], "retained")
  assert.equal(known.models["gpt-test"].headers[HEADER], undefined)
})

test("real upstream IDs always win over speed aliases and profiles are not recursively synthesized", async (t) => {
  mockAPI(t, ["gpt-test", "gpt-test-fast"])
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.equal(found["gpt-test-fast"].api.id, "gpt-test-fast")
  assert.equal(found["gpt-test-fast"].headers[HEADER], undefined)
  assert.equal(found["gpt-test-ultraspeed-ultraspeed"], undefined)
})

test("exact filters can select only one generated speed model while preserving its real API identity", async (t) => {
  const calls = mockAPI(t)
  const plugin = await Sub2apiPlugin({}, { includeModels: ["gpt-test-ultraspeed"] })
  const found = await plugin.provider.models(provider, { auth: account() })
  assert.deepEqual(Object.keys(found), ["gpt-test-ultraspeed"])
  const loader = await plugin.auth.loader(async () => account())
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: '{"model":"gpt-test"}', headers: await selectedHeaders(plugin, found["gpt-test-ultraspeed"]) })
  assert.equal(JSON.parse(calls[0].init.body).model, "gpt-test")
  assert.equal(JSON.parse(calls[0].init.body).service_tier, "ultrafast")
})

test("speed presets reject unsupported configuration instead of silently downgrading", async (t) => {
  for (const speedModels of [null, "fast", ["priority"], ["ultrafast"], [1], { a: "fast" }]) {
    await assert.rejects(Sub2apiPlugin({}, { speedModels }), /speed/i)
  }
  for (const [model, speed] of [["claude-test", "ultraspeed"], ["gemini-test", "fast"]]) {
    mockAPI(t, [model])
    const plugin = await Sub2apiPlugin({}, { speedModels: { [model]: [speed] } })
    await assert.rejects(plugin.provider.models(provider, { auth: account() }), /protocol/)
    t.mock.restoreAll()
  }
  mockAPI(t)
  const disabled = await Sub2apiPlugin({}, { speedModels: [] })
  assert.deepEqual(Object.keys(await disabled.provider.models(provider, { auth: account() })), ["gpt-test"])
  await assert.rejects(Sub2apiPlugin({}, { headers: { [HEADER]: "private-value" } }), /reserved/)
})

test("a speed model refuses mismatched models, protocols, unknown presets and streaming bodies before sending", async (t) => {
  const calls = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const headers = await selectedHeaders(plugin, found["gpt-test-ultraspeed"])
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: '{"model":"different"}', headers }), /match/)
  await assert.rejects(loader.fetch(BASE + "/v1/chat/completions", { body: '{"model":"gpt-test"}', headers }), /protocol/)
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: '{"model":"gpt-test"}', headers: { [HEADER]: "unknown" } }), /not listed/)
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: "{}", headers: { [HEADER]: "%" } }), /not listed/)
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: '{"model":"gpt-test"}', headers: { ...headers, "content-encoding": "gzip" } }), /uncompressed/)
  await assert.rejects(loader.fetch(BASE + "/v1/responses", { body: new ReadableStream(), headers }), /match/)
  assert.equal(calls.length, 0)
})

test("speed presets accept Request, binary and direct alias bodies and strip the private selector", async (t) => {
  const calls = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const headers = await selectedHeaders(plugin, found["gpt-test-fast"])
  await loader.fetch(new Request(BASE + "/v1/responses", { method: "POST", body: '{"model":"gpt-test"}', headers }))
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: new TextEncoder().encode('{"model":"gpt-test"}'), headers })
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: '{"model":"gpt-test-fast"}' })
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.deepEqual(JSON.parse(call.init.body), { model: "gpt-test", service_tier: "priority" })
    assert.equal(call.headers.get(HEADER), null)
  }
})

test("unsupported speed responses and network failures are returned once without tier, model or key fallback", async (t) => {
  let result = new Response("tier not available", { status: 400 })
  const calls = mockAPI(t, ["gpt-test"], () => { if (result instanceof Error) throw result; return result })
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth: account() })
  const loader = await plugin.auth.loader(async () => account())
  const init = { method: "POST", body: '{"model":"gpt-test"}', headers: await selectedHeaders(plugin, found["gpt-test-ultraspeed"]) }
  assert.equal(await loader.fetch(BASE + "/v1/responses", init), result)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].init.body).service_tier, "ultrafast")
  result = new Error("connection failed")
  await assert.rejects(loader.fetch(BASE + "/v1/responses", init), (error) => error === result)
  assert.equal(calls.length, 2)
})

test("same-named speed models on multiple keys keep their own URL, credentials and available presets", async (t) => {
  const calls = mockAPI(t)
  const plugin = await Sub2apiPlugin()
  const accounts = [account("key-a", BASE + "/a"), account("key-b", BASE + "/b", { speedModels: ["fast"] })]
  const catalogs = await Promise.all(accounts.map((auth) => plugin.provider.models(provider, { auth })))
  const loaders = await Promise.all(accounts.map((auth) => plugin.auth.loader(async () => auth)))
  for (const index of [1, 0, 1, 0]) {
    await loaders[index].fetch(accounts[index].metadata.baseURL + "/v1/responses", {
      method: "POST", body: '{"model":"gpt-test"}', headers: await selectedHeaders(plugin, catalogs[index]["gpt-test-fast"]),
    })
    assert.equal(calls.at(-1).headers.get("authorization"), "Bearer " + accounts[index].key)
    assert.equal(calls.at(-1).url, accounts[index].metadata.baseURL + "/v1/responses")
  }
  await assert.rejects(loaders[1].fetch(BASE + "/b/v1/responses", {
    body: '{"model":"gpt-test"}', headers: await selectedHeaders(plugin, catalogs[0]["gpt-test-ultraspeed"]),
  }), /not listed/)
  assert.equal(calls.length, 4)
})

test("real HTTP speed requests keep the wire model unchanged while sending the selected service tier", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    if (req.url.endsWith("/v1/models")) { res.end(JSON.stringify({ data: [{ id: "gpt-test" }] })); return }
    if (!req.url.endsWith("/v1/responses")) { res.writeHead(404).end(); return }
    let text = ""
    for await (const chunk of req) text += chunk
    calls.push({ body: JSON.parse(text), headers: req.headers })
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
  const baseURL = `http://127.0.0.1:${server.address().port}/deployment`
  const auth = account("loopback-key", baseURL)
  const plugin = await Sub2apiPlugin()
  const found = await plugin.provider.models(provider, { auth })
  const loader = await plugin.auth.loader(async () => auth)
  for (const speed of ["fast", "ultraspeed"]) {
    const response = await loader.fetch(baseURL + "/v1/responses", {
      method: "POST", body: '{"model":"gpt-test","stream":true}', headers: await selectedHeaders(plugin, found["gpt-test-" + speed]),
    })
    assert.match(await response.text(), /"input_tokens":3/)
    assert.equal(calls.at(-1).body.model, "gpt-test")
    assert.equal(calls.at(-1).body.service_tier, speed === "fast" ? "priority" : "ultrafast")
    assert.equal(calls.at(-1).headers.authorization, "Bearer loopback-key")
    assert.equal(calls.at(-1).headers[HEADER], undefined)
  }
})
