import assert from "node:assert/strict"
import test from "node:test"
import { Sub2apiPlugin } from "../index.mjs"

const BASE = "https://metrics.example.com"
const auth = { type: "api", key: "synthetic-metrics-key", metadata: { baseURL: BASE } }
const usage = {
  "chat/completions": { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 5 } },
  responses: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 5 } },
  messages: { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 } },
  "models/gemini-test:streamGenerateContent": { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 125, cachedContentTokenCount: 80, thoughtsTokenCount: 5 },
}

test("all protocols preserve JSON usage, cache and reasoning tiers and upstream timing/cost headers", async (t) => {
  const plugin = await Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  for (const [operation, counts] of Object.entries(usage)) {
    const body = operation.startsWith("models/") ? { usageMetadata: counts } : { usage: counts }
    const response = Response.json(body, { headers: { "server-timing": "upstream;dur=100", "x-request-id": "test-id", "x-usage-cost": "0.0012" } })
    t.mock.method(globalThis, "fetch", async () => response)
    const result = await loader.fetch(BASE + "/v1/" + operation, { method: "POST", body: '{"model":"test"}' })
    assert.equal(result, response)
    assert.equal(result.headers.get("server-timing"), "upstream;dur=100")
    assert.equal(result.headers.get("x-usage-cost"), "0.0012")
    assert.deepEqual(await result.json(), body)
    t.mock.restoreAll()
  }
})

test("streaming metrics pass through unchanged without pre-reading, buffering or generating tokens", async (t) => {
  const plugin = await Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth)
  for (const [operation, counts] of Object.entries(usage)) {
    let controller
    let pulls = 0
    const body = new ReadableStream({
      start(value) { controller = value },
      pull() { pulls++ },
    }, { highWaterMark: 0 })
    const response = new Response(body, { headers: { "content-type": "text/event-stream" } })
    t.mock.method(globalThis, "fetch", async () => response)
    const result = await loader.fetch(BASE + "/v1/" + operation)
    assert.equal(result, response)
    assert.equal(pulls, 0)
    const reader = result.body.getReader()
    const first = reader.read()
    const delta = 'data: {"delta":"first output"}\n\n'
    controller.enqueue(new TextEncoder().encode(delta))
    assert.equal(new TextDecoder().decode((await first).value), delta)
    const packet = operation === "responses" ? { type: "response.completed", response: { usage: counts } }
      : operation === "messages" ? { type: "message_delta", usage: counts }
      : operation.startsWith("models/") ? { usageMetadata: counts } : { choices: [], usage: counts }
    const last = "data: " + JSON.stringify(packet) + "\n\ndata: [DONE]\n\n"
    controller.enqueue(new TextEncoder().encode(last))
    controller.close()
    assert.equal(new TextDecoder().decode((await reader.read()).value), last)
    assert.equal((await reader.read()).done, true)
    reader.releaseLock()
    t.mock.restoreAll()
  }
})

test("unknown prices remain absent and explicit model pricing uses all four USD-per-million tiers", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => init?.credentials === "omit"
    ? new Response(null, { status: 404 }) : Response.json({ data: [{ id: "unknown" }, { id: "priced" }, { id: "free" }] }))
  const prices = { input: 1.2, output: 6, cache: { read: 0.12, write: 1.5 } }
  const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } }
  const plugin = await Sub2apiPlugin({}, { modelOverrides: { priced: { cost: prices }, free: { cost: zero } } })
  const found = await plugin.provider.models({ models: {} }, { auth })
  assert.equal(Object.hasOwn(found.unknown, "cost"), false)
  assert.deepEqual(found.priced.cost, prices)
  assert.deepEqual(found.free.cost, zero)
  for (const cost of [{ input: 1 }, { ...prices, output: -1 }, { ...prices, cache: { read: 1 } }]) {
    await assert.rejects(Sub2apiPlugin({}, { modelOverrides: { priced: { cost } } }), /cost requires/)
  }
})

test("a failed catalog refresh blocks an already-created transport instead of serving a host fallback", async (t) => {
  let failed = false
  let inferenceCalls = 0
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    if (String(input).endsWith("/models")) return failed ? new Response(null, { status: 503 }) : Response.json({ data: [{ id: "allowed" }] })
    inferenceCalls++
    return Response.json({ ok: true })
  })
  const plugin = await Sub2apiPlugin({}, { query: { modelsTtlMs: 0 } })
  await plugin.provider.models({ models: {} }, { auth })
  const loader = await plugin.auth.loader(async () => auth)
  await assert.rejects(loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: '{"model":"other-key-model"}' }), /not listed/)
  await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: '{"model":"allowed"}' })
  failed = true
  await assert.rejects(plugin.provider.models({ models: { fallback: {} } }, { auth }), /503/)
  await assert.rejects(loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: '{"model":"allowed"}' }), /503/)
  assert.equal(inferenceCalls, 1)
  failed = false
  await plugin.provider.models({ models: {} }, { auth })
  await loader.fetch(BASE + "/v1/chat/completions", { method: "POST", body: '{"model":"allowed"}' })
  assert.equal(inferenceCalls, 2)
})
