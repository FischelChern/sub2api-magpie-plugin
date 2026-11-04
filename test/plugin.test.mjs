import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { readFile } from "node:fs/promises"
import test from "node:test"
import * as plugins from "../index.mjs"

const BASE = "https://api.example.com"
const CODEX_UA = /^codex_cli_rs\/0\.159\.0 \([^;]+; [^)]+\) \S+$/
const CODEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CLAUDE_UA = "claude-cli/2.1.296 (external, cli)"
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const CLAUDE_IDENTITY_BLOCK = { type: "text", text: CLAUDE_IDENTITY }
// metadata.user_id as the plugin generates it: the JSON form
// ParseMetadataUserID reads (device_id and session_id non-empty).
const CLAUDE_USER_ID = /^\{"device_id":"[0-9a-f]{64}","account_uuid":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}","session_id":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}$/
const auth = (metadata = {}, key = "sk-test-only-1234") => ({
  type: "api", key, metadata: { baseURL: BASE, ...metadata },
})
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const modelList = { data: [{ id: "claude-test" }, { id: "gpt-test" }, { id: "other-test" }] }

function mockAPI(t, usage = { balance: 12.34 }) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    calls.push({ url: String(input), ...init })
    const path = new URL(input).pathname
    if (path.endsWith("/usage")) return json(usage)
    if (path.endsWith("/backend-api/codex/models")) return json({
      models: [{ slug: "gpt-test", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
    })
    return json(modelList)
  })
  return calls
}

test("GPT generations use fallback efforts despite stale non-reasoning host metadata", async (t) => {
  const ids = ["gpt-6-astra", "gpt-6.1-sol", "vendor/gpt-6-luna", "gpt-10-sol", "gpt-4.1", "other-test"]
  t.mock.method(globalThis, "fetch", async (input) => new URL(input).pathname.endsWith("/models") && !String(input).includes("backend-api")
    ? json({ data: ids.map((id) => ({ id })) }) : json({}, 404))
  const plugin = await plugins.Sub2apiPlugin()
  const previous = Object.fromEntries(ids.map((id) => [id, { capabilities: { reasoning: false }, variants: {} }]))
  const models = await plugin.provider.models({ models: previous }, { auth: auth() })
  for (const id of ids) {
    const thinks = !["gpt-4.1", "other-test"].includes(id)
    assert.equal(models[id].capabilities.reasoning, thinks, id)
    assert.deepEqual(Object.keys(models[id].variants), thinks ? ["low", "medium", "high"] : [], id)
    assert.deepEqual(models[id].serviceTiers, [], id)
  }
})

test("primary reasoning levels win over manifest and stay isolated by account", async (t) => {
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (String(input).includes("backend-api")) return json({ models: [{ slug: "gpt-6-sol", supported_reasoning_levels: ["medium"] }] })
    const first = new Headers(init?.headers).get("authorization") === "Bearer key-a"
    return json({ data: [{ id: "gpt-6-sol", supported_reasoning_levels: first
      ? [" low ", { effort: "xhigh" }, "low", null, 7, {}] : ["high"] }] })
  })
  const plugin = await plugins.Sub2apiPlugin()
  const a = await plugin.provider.models({ models: {} }, { auth: auth({}, "key-a") })
  const b = await plugin.provider.models({ models: {} }, { auth: auth({}, "key-b") })
  assert.deepEqual(Object.keys(a["gpt-6-sol"].variants), ["low", "xhigh"])
  assert.deepEqual(Object.keys(b["gpt-6-sol"].variants), ["high"])
})

test("primary reasoning levels work without manifest and explicit overrides still win", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => String(input).includes("backend-api") ? json({}, 404)
    : json({ data: [{ id: "custom-model", supported_reasoning_levels: [{ effort: "high" }] }] }))
  const plugin = await plugins.Sub2apiPlugin()
  const models = await plugin.provider.models({ models: {} }, { auth: auth() })
  assert.equal(models["custom-model"].capabilities.reasoning, true)
  assert.deepEqual(Object.keys(models["custom-model"].variants), ["high"])
  const configured = await plugins.Sub2apiPlugin({}, { modelOverrides: {
    "custom-model": { capabilities: { reasoning: false }, variants: { low: {} } },
  } })
  const overridden = await configured.provider.models({ models: {} }, { auth: auth() })
  assert.equal(overridden["custom-model"].capabilities.reasoning, false)
  assert.deepEqual(Object.keys(overridden["custom-model"].variants), ["low"])
})

test("model discovery automatically supplements efforts and speed from the same key manifest", async (t) => {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    calls.push(new Headers(init?.headers).get("authorization"))
    if (String(input).includes("backend-api")) return json({ models: [
      { slug: "gpt-6-sol", supported_reasoning_levels: ["low", "high", "xhigh"], service_tiers: [{ id: "priority" }, "ultrafast"] },
      { slug: "gpt-6-luna", service_tiers: ["priority"] },
    ] })
    return json({ data: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna", service_tiers: [] }] })
  })
  const plugin = await plugins.Sub2apiPlugin()
  const models = await plugin.provider.models({ models: {} }, { auth: auth({}, "key-a") })
  assert.deepEqual(Object.keys(models["gpt-6-sol"].variants), ["low", "high", "xhigh"])
  assert.deepEqual(models["gpt-6-sol"].serviceTiers, ["priority", "ultrafast"])
  assert.deepEqual(models["gpt-6-luna"].serviceTiers, [])
  assert.deepEqual(calls, ["Bearer key-a", "Bearer key-a"])
})

test("all model families and aliases read reported efforts and protocol-appropriate speed tiers", async (t) => {
  const entries = [
    { id: "claude-custom", supported_reasoning_levels: ["low", "max"], service_tiers: ["priority"] },
    { id: "gemini-custom", supported_reasoning_levels: ["minimal", "high"], service_tiers: ["priority"] },
    { id: "deepseek-custom", supported_reasoning_levels: ["high"], service_tiers: ["priority"] },
    { id: "qwen-custom", supported_reasoning_levels: [{ effort: "medium" }], service_tiers: ["ultrafast"] },
    { id: "private-alias", reasoning: true, service_tiers: ["priority", "ultrafast"] },
    { id: "another-alias", capabilities: { reasoning: true } },
    { id: "opaque-model" },
  ]
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (init?.credentials === "omit") return new Response(null, { status: 404 })
    return json({ data: entries })
  })
  const plugin = await plugins.Sub2apiPlugin()
  const models = await plugin.provider.models({ models: {} }, { auth: auth() })
  const expected = [["low", "max"], ["minimal", "high"], ["high"], ["medium"], ["low", "medium", "high"], ["low", "medium", "high"], []]
  for (const [i, entry] of entries.entries()) {
    assert.deepEqual(Object.keys(models[entry.id].variants), expected[i], entry.id)
    assert.equal(models[entry.id].capabilities.reasoning, expected[i].length > 0, entry.id)
    assert.deepEqual(models[entry.id].serviceTiers, i < 2 ? [] : entry.service_tiers ?? [], entry.id)
  }
  const compatible = await plugins.Sub2apiPlugin({}, { modelProtocols: { "claude-custom": "chat-completions", "gemini-custom": "chat-completions" } })
  const openaiModels = await compatible.provider.models({ models: {} }, { auth: auth() })
  for (const id of ["claude-custom", "gemini-custom"]) assert.deepEqual(openaiModels[id].serviceTiers, ["priority"])
})

test("only provider plugin functions are exported", () => {
  assert.equal(Object.keys(plugins).length, 9)
  for (const value of Object.values(plugins)) assert.equal(typeof value, "function")
})

test("the renamed package keeps the existing provider identity for saved accounts", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.equal(pkg.name, "sub2api-magpie-plugin")
  const plugin = await plugins.Sub2apiPlugin()
  assert.equal(plugin.auth.provider, "sub2api")
  assert.equal(plugin.provider.id, "sub2api")
})

test("pooled provider signs in and names an account without dropping metadata", async () => {
  const saved = []
  const plugin = await plugins.Sub2apiPlugin({ client: { auth: { set: async (v) => saved.push(v) } } })
  assert.equal(plugin.auth.provider, "sub2api")
  assert.deepEqual(plugin.auth.methods[0].prompts.map((p) => p.key), ["baseURL"])
  const account = auth({ name: "Work", baseURL: BASE + "/v1/", headers: '{"X-Client":"work"}' })
  const loader = await plugin.auth.loader(async () => account)
  assert.equal(loader.baseURL, BASE + "/v1")
  assert.equal(loader.apiKey, account.key)
  assert.equal(saved[0].body.accountId, "Work")
  assert.deepEqual(saved[0].body.metadata, account.metadata)
  assert.deepEqual(await plugin.auth.loader(async () => undefined), {})
})

test("headers reach usage, model list and reasoning manifest with account precedence", async (t) => {
  const calls = mockAPI(t)
  const plugin = await plugins.Sub2apiSite1({}, {
    headers: { "User-Agent": "global", "X-Global": "global", "X-Override": "global" },
    sites: [{ id: "work", name: "Work", url: BASE + "/v1/", headers: { "x-override": "site", "X-Site": "site" } }],
  })
  const account = auth({ headers: '{"X-OVERRIDE":"account","X-Account":"account"}' })
  const usage = await plugin.auth.usage(async () => account)
  assert.equal(usage.balance, "$12.34")
  const models = await plugin.provider.models({ models: {} }, { auth: account })
  assert.equal(models["claude-test"].api.npm, "@ai-sdk/anthropic")
  assert.equal(models["gpt-test"].api.npm, "@ai-sdk/openai")
  assert.equal(models["other-test"].api.npm, "@ai-sdk/openai-compatible")
  assert.equal(models["gpt-test"].providerID, "work")
  assert.deepEqual(Object.keys(models["gpt-test"].variants), ["low", "high"])
  assert.equal(calls.length, 3)
  for (const call of calls) {
    const headers = new Headers(call.headers)
    assert.equal(headers.get("x-override"), "account")
    assert.equal(headers.get("x-global"), "global")
    assert.equal(headers.get("x-site"), "site")
    assert.equal(headers.get("x-account"), "account")
    assert.equal(headers.get("user-agent"), "global")
    assert.equal(headers.get("authorization"), `Bearer ${account.key}`)
    assert.equal(call.redirect, "error")
    assert.ok(call.signal instanceof AbortSignal)
  }
  const cfg = { provider: { work: { name: "User choice" } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.work.name, "User choice")
})

test("site providers are optional, keep fixed URLs and have isolated headers", async (t) => {
  const calls = mockAPI(t)
  assert.deepEqual(await plugins.Sub2apiSite1({}, {}), {})
  const options = { sites: [
    { id: "first", url: BASE, headers: { "X-Site": "first" } },
    { id: "second", url: "https://second.example.com/prefix", headers: { "X-Site": "second" } },
  ] }
  for (const [i, name] of ["Sub2apiSite1", "Sub2apiSite2"].entries()) {
    const plugin = await plugins[name]({}, options)
    assert.deepEqual(plugin.auth.methods[0].prompts, [])
    const account = auth({}, `sk-site-${i}`)
    await plugin.auth.usage(async () => account)
    assert.equal(calls[i].url, options.sites[i].url + "/v1/usage")
    assert.equal(new Headers(calls[i].headers).get("x-site"), options.sites[i].id)
  }
})

test("inference passes through agent headers and enforces only the selected key", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "configured", "X-Client": "magpie" } })
  const account = auth()
  const loader = await plugin.auth.loader(async () => account)
  const response = new Response("data: test\n\n", { headers: { "content-type": "text/event-stream" } })
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return response })
  for (const [path, expectedUA] of [["messages", "configured"], ["responses", "configured"], ["chat/completions", "agent"]]) {
    const controller = new AbortController()
    const body = '{"stream":true}'
    const actual = await loader.fetch(`${BASE}/v1/${path}`, {
      method: "POST", body, signal: controller.signal,
      headers: { authorization: "Bearer wrong", "x-api-key": "wrong", "user-agent": "agent", "x-client": "agent", "x-trace": "trace" },
    })
    assert.equal(actual, response)
    const { init } = calls.at(-1)
    assert.equal(init.headers.get("authorization"), `Bearer ${account.key}`)
    assert.equal(init.headers.get("x-api-key"), account.key)
    if (expectedUA instanceof RegExp) assert.match(init.headers.get("user-agent"), expectedUA)
    else assert.equal(init.headers.get("user-agent"), expectedUA)
    if (path === "messages") assert.equal(init.headers.get("x-app"), "cli")
    if (path === "responses") assert.equal(init.headers.get("originator"), "codex_cli_rs")
    assert.equal(init.headers.get("x-client"), "agent")
    assert.equal(init.headers.get("x-trace"), "trace")
    if (path === "messages") assert.equal(JSON.parse(init.body).system[0].text, CLAUDE_IDENTITY)
    else assert.equal(init.body, body)
    assert.equal(init.signal, controller.signal)
    assert.equal(init.redirect, "error")
  }
})

test("inference fills missing user agents by endpoint including rewritten paths and Request inputs", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { apiPaths: { responses: "/openai/v1" } })
  const loader = await plugin.auth.loader(async () => auth({ baseURL: BASE + "/prefix" }))
  const calls = []
  const response = json({})
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return response })
  for (const [path, userAgent] of [
    ["/v1/responses", CODEX_UA],
    ["/openai/v1/responses/compact", CODEX_UA],
    ["/v1/chat/completions", "OpenAI/JS"],
    ["/v1/messages", CLAUDE_UA],
    ["/v1beta/models/gemini-test:streamGenerateContent", "google-genai-sdk"],
    ["/v1/responses", CODEX_UA],
  ]) {
    for (const kind of ["string", "URL", "Request"]) {
      const url = BASE + "/prefix" + path
      const input = kind === "Request" ? new Request(url)
        : kind === "URL" ? new URL(url) : url
      assert.equal(await loader.fetch(input), response)
      const call = calls.at(-1)
      if (userAgent instanceof RegExp) assert.match(call.init.headers.get("user-agent"), userAgent)
      else assert.equal(call.init.headers.get("user-agent"), userAgent)
      assert.equal(call.init.headers.get("authorization"), `Bearer ${auth().key}`)
      assert.equal(call.init.redirect, "error")
      if (path === "/v1/responses") {
        assert.equal(call.input instanceof Request ? call.input.url : String(call.input), BASE + "/prefix/openai/v1/responses")
      }
    }
  }
  await loader.fetch(BASE + "/prefix/v1/responses")
  assert.match(calls.at(-1).init.headers.get("user-agent"), CODEX_UA)
  const count = calls.length
  await assert.rejects(loader.fetch("https://other.example.com/prefix/v1/responses"), /Refusing/)
  assert.equal(calls.length, count)
})

test("inference preserves real agent user agents and replaces Magpie's own", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { apiPaths: { responses: "/openai/v1" } })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  for (const [path, expected] of [
    ["responses", CODEX_UA],
    ["messages", CLAUDE_UA],
    ["chat/completions", "OpenAI/JS"],
    ["models/gemini-test:generateContent", "google-genai-sdk"],
  ]) {
    const url = BASE + "/v1/" + path
    for (const input of [url, new URL(url)]) {
      await loader.fetch(input, { headers: { "uSeR-aGeNt": "magpie/0.1.1271" } })
      if (expected instanceof RegExp) assert.match(calls.at(-1).get("user-agent"), expected)
      else assert.equal(calls.at(-1).get("user-agent"), expected)
      await loader.fetch(input, { headers: { "uSeR-aGeNt": "" } })
      if (expected instanceof RegExp) assert.match(calls.at(-1).get("user-agent"), expected)
      else assert.equal(calls.at(-1).get("user-agent"), expected)
    }
    await loader.fetch(new Request(url, { headers: { "User-Agent": "codex-tui/0.162.1" } }))
    if (path === "messages") assert.equal(calls.at(-1).get("user-agent"), CLAUDE_UA)
    else assert.equal(calls.at(-1).get("user-agent"), "codex-tui/0.162.1")
    await loader.fetch(new Request(url, { headers: { "User-Agent": "opencode/0.4.0" } }))
    if (path === "responses") assert.match(calls.at(-1).get("user-agent"), CODEX_UA)
    else if (path === "messages") assert.equal(calls.at(-1).get("user-agent"), CLAUDE_UA)
    else assert.equal(calls.at(-1).get("user-agent"), "opencode/0.4.0")
    await loader.fetch(new Request(url, { headers: { "User-Agent": "magpie/0.1.1271" } }))
    if (expected instanceof RegExp) assert.match(calls.at(-1).get("user-agent"), expected)
    else assert.equal(calls.at(-1).get("user-agent"), expected)
  }
})

test("configured user agent replaces Magpie's own without overriding a real agent", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "configured-client/1.0" } })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await loader.fetch(BASE + "/v1/responses", { headers: { "User-Agent": "magpie/0.1.1271" } })
  assert.equal(calls.at(-1).get("user-agent"), "configured-client/1.0")
  await loader.fetch(BASE + "/v1/messages", { headers: { "User-Agent": "claude-cli/2.1.300 (external, cli)" } })
  assert.equal(calls.at(-1).get("user-agent"), "claude-cli/2.1.300 (external, cli)")
  await loader.fetch(BASE + "/v1/responses", { headers: { "User-Agent": "magpie-test" } })
  assert.equal(calls.at(-1).get("user-agent"), "configured-client/1.0")

  const protocol = await plugins.Sub2apiPlugin({}, { protocolHeaders: { claude: { "User-Agent": "claude-protocol/1.0" } } })
  const protocolLoader = await protocol.auth.loader(async () => auth())
  await protocolLoader.fetch(BASE + "/v1/messages", { headers: { "User-Agent": "magpie/0.1.1271" } })
  assert.equal(calls.at(-1).get("user-agent"), "claude-protocol/1.0")
})

test("Magpie agent labels select matching UAs and never reach upstream", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  for (const [path, agent, expected] of [
    ["chat/completions", "codex", CODEX_UA],
    ["models/gemini-test:generateContent", "claude", CLAUDE_UA],
  ]) {
    await loader.fetch(BASE + "/v1/" + path, {
      headers: { "User-Agent": "magpie/0.1.1271", "X-Magpie-Agent": agent },
    })
    if (expected instanceof RegExp) assert.match(calls.at(-1).get("user-agent"), expected)
    else assert.equal(calls.at(-1).get("user-agent"), expected)
    assert.equal(calls.at(-1).has("x-magpie-agent"), false)
  }
})

test("inference preserves Codex identity, native user agent and session headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const request = new Request(BASE + "/v1/responses", { headers: {
    "User-Agent": "codex_cli_rs/0.162.0",
    originator: "codex_cli_rs",
    "session-id": "request-session",
    "x-codex-turn-metadata": "request-turn",
  } })
  await loader.fetch(request, { headers: {
    "session-id": "init-session",
    "x-codex-source": "codex-tui",
  } })
  const headers = calls[0]
  assert.equal(headers.get("user-agent"), "codex_cli_rs/0.162.0")
  assert.equal(headers.get("version"), "0.162.0")
  assert.equal(headers.get("originator"), "codex_cli_rs")
  assert.equal(headers.get("session-id"), "init-session")
  assert.equal(headers.get("x-codex-turn-metadata"), "request-turn")
  assert.equal(headers.get("x-codex-source"), "codex-tui")
  // An explicit configured UA must not replace the official caller's own UA.
  const configured = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "configured-client/1.0" } })
  const configuredLoader = await configured.auth.loader(async () => auth())
  await configuredLoader.fetch(new Request(BASE + "/v1/responses", { headers: { "User-Agent": "codex_cli_rs/0.162.0" } }))
  assert.equal(calls.at(-1).get("user-agent"), "codex_cli_rs/0.162.0")
})

test("cross-protocol callers are masqueraded as the protocol family they call", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init.headers; return json({}) })
  // Hints and even a Claude UA prove nothing about the Responses protocol: the
  // caller is not an official Codex client, so it gets Codex identity.
  for (const headers of [
    { "user-agent": "magpie/test", "x-claude-code-session-id": "claude-session" },
    { "user-agent": "magpie/test", "x-magpie-agent": "claude" },
    { "user-agent": CLAUDE_UA, "x-magpie-agent": "codex" },
  ]) {
    await loader.fetch(BASE + "/v1/responses", { headers })
    assert.match(sent.get("user-agent"), CODEX_UA)
    assert.equal(sent.get("originator"), "codex_cli_rs")
    assert.equal(sent.get("version"), "0.159.0")
    assert.equal(sent.get("openai-beta"), "responses=experimental")
    assert.equal(sent.has("x-app"), false)
    assert.equal(sent.has("x-magpie-agent"), false)
  }
  // A Codex UA on Messages is third-party for Claude Code: the official UA and
  // compatibility headers are filled, while the caller's own headers pass.
  await loader.fetch(BASE + "/v1/messages", { headers: { "user-agent": "codex_exec/0.162.3", originator: "codex_exec" } })
  assert.equal(sent.get("user-agent"), CLAUDE_UA)
  assert.equal(sent.get("x-app"), "cli")
  assert.equal(sent.get("originator"), "codex_exec")
  assert.equal(sent.get("anthropic-version"), "2023-06-01")
})

test("official Claude callers keep their own UA and identity headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, {
    headers: { "User-Agent": "configured-client/1.0", "x-app": "configured-app", "x-client": "configured" },
  })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await loader.fetch(new Request(BASE + "/v1/messages", {
    method: "POST",
    body: '{"model":"claude-test"}',
    headers: {
      "User-Agent": "claude-cli/2.1.300 (external, cli)",
      "x-app": "claude-code",
      "x-claude-code-session-id": "cc-session",
      "anthropic-beta": "caller-beta",
    },
  }))
  const sent = calls[0]
  assert.equal(sent.get("user-agent"), "claude-cli/2.1.300 (external, cli)")
  assert.equal(sent.get("x-app"), "claude-code")
  assert.equal(sent.get("x-claude-code-session-id"), "cc-session")
  assert.equal(sent.get("anthropic-beta"), "caller-beta")
  assert.equal(sent.get("anthropic-version"), "2023-06-01")
  assert.equal(sent.get("x-client"), "configured")
})

test("third-party Messages callers speak as Claude Code, and only inference bodies are completed", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const controller = new AbortController()
  const body = JSON.stringify({ model: "claude-test", stream: true, messages: [] })
  for (const path of ["messages", "messages/count_tokens"]) {
    const response = await loader.fetch(BASE + "/v1/" + path, {
      method: "POST", body, signal: controller.signal,
      headers: { "user-agent": "opencode/0.4.0" },
    })
    const call = calls.at(-1)
    assert.equal(response.status, 200)
    assert.equal(call.headers.get("user-agent"), CLAUDE_UA)
    assert.equal(call.headers.get("x-app"), "cli")
    assert.equal(call.headers.get("anthropic-version"), "2023-06-01")
    assert.equal(call.headers.get("authorization"), `Bearer ${auth().key}`)
    // count_tokens is answered from the user agent alone: it keeps the body the
    // caller sent, while the inference path gets the gate's identity block and
    // a parseable metadata.user_id.
    if (path === "messages") {
      const sent = JSON.parse(call.body)
      assert.deepEqual(sent.system, [CLAUDE_IDENTITY_BLOCK])
      assert.match(sent.metadata.user_id, CLAUDE_USER_ID)
      assert.deepEqual(sent.messages, [])
      assert.equal(sent.stream, true)
      assert.equal(sent.model, "claude-test")
      assert.equal(call.headers.get("anthropic-beta"), "claude-code-20250219")
    } else {
      assert.equal(call.body, body)
      assert.equal(call.headers.has("anthropic-beta"), false)
    }
    assert.equal(call.signal, controller.signal)
  }
  // An explicit configured UA overrides that stand-in, but never an official UA.
  const configured = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "configured-claude/1.0" } })
  const configuredLoader = await configured.auth.loader(async () => auth())
  await configuredLoader.fetch(BASE + "/v1/messages", { headers: { "user-agent": "opencode/0.4.0" } })
  assert.equal(calls.at(-1).headers.get("user-agent"), "configured-claude/1.0")
  await configuredLoader.fetch(BASE + "/v1/messages", { headers: { "user-agent": "claude-cli/2.1.301 (external, cli)" } })
  assert.equal(calls.at(-1).headers.get("user-agent"), "claude-cli/2.1.301 (external, cli)")
})

test("Claude masquerade stays isolated per account and never forwards caller credentials", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const first = await plugin.auth.loader(async () => auth({}, "sk-first"))
  const second = await plugin.auth.loader(async () => auth({}, "sk-second"))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await first.fetch(BASE + "/v1/messages", { headers: { "user-agent": "opencode/0.4.0", authorization: "Bearer wrong" } })
  await second.fetch(BASE + "/v1/messages", { headers: { "user-agent": "opencode/0.4.0", authorization: "Bearer wrong" } })
  assert.deepEqual(calls.map((headers) => headers.get("user-agent")), [CLAUDE_UA, CLAUDE_UA])
  assert.deepEqual(calls.map((headers) => headers.get("authorization")), ["Bearer sk-first", "Bearer sk-second"])
  assert.deepEqual(calls.map((headers) => headers.get("x-api-key")), ["sk-first", "sk-second"])
})

test("Messages bodies gain the Claude Code identity, a stand-in user id and the claude-code beta", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init; return json({}) })
  const payload = {
    model: "claude-test",
    max_tokens: 4096,
    speed: "standard",
    stream: true,
    system: "You are a careful assistant.",
    tools: [{ name: "read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify(payload), headers: { "content-length": "2" } })
  const body = JSON.parse(sent.body)
  // The gate reads the prose from a text block, so the exact identity is added
  // first and the caller's own system string is kept as its own text block.
  assert.deepEqual(body.system, [CLAUDE_IDENTITY_BLOCK, { type: "text", text: payload.system }])
  assert.match(body.metadata.user_id, CLAUDE_USER_ID)
  assert.equal(sent.headers.get("anthropic-beta"), "claude-code-20250219")
  assert.equal(sent.headers.get("x-app"), "cli")
  assert.equal(sent.headers.get("anthropic-version"), "2023-06-01")
  // Nothing else is added, dropped, reordered or rewritten: no billing block,
  // no model, max_tokens, speed, tool or message change.
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "metadata", "model", "speed", "stream", "system", "tools"])
  for (const field of ["model", "max_tokens", "speed", "stream", "tools", "messages"]) assert.deepEqual(body[field], payload[field])
  assert.equal(sent.body.includes("x-anthropic-billing-header"), false)
  // A rewritten body invalidates whatever length the caller declared.
  assert.equal(sent.headers.has("content-length"), false)
})

test("Messages system arrays keep every original block and never duplicate the identity", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init; return json({}) })
  const own = [
    { type: "text", text: "first block", cache_control: { type: "ephemeral" } },
    { type: "text", text: "second block" },
  ]
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", system: own }) })
  assert.deepEqual(JSON.parse(sent.body).system, [CLAUDE_IDENTITY_BLOCK, ...own])
  // An existing identity block is recognized however its whitespace is written.
  for (const given of [
    [CLAUDE_IDENTITY_BLOCK, { type: "text", text: "second block" }],
    [{ type: "text", text: "  You are Claude Code,   Anthropic's official CLI for Claude. " }],
  ]) {
    await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", system: given }) })
    const body = JSON.parse(sent.body)
    assert.deepEqual(body.system, given)
    assert.match(body.metadata.user_id, CLAUDE_USER_ID)
  }
  for (const system of [CLAUDE_IDENTITY, "  " + CLAUDE_IDENTITY + "  "]) {
    await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", system }) })
    assert.deepEqual(JSON.parse(sent.body).system, [{ type: "text", text: system }])
  }
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", system: "" }) })
  assert.deepEqual(JSON.parse(sent.body).system, [CLAUDE_IDENTITY_BLOCK])
  // A body that already satisfies the gate is forwarded byte for byte.
  const compliant = JSON.stringify({
    model: "claude-test",
    system: [CLAUDE_IDENTITY_BLOCK, { type: "text", text: "extra" }],
    metadata: { user_id: "user_" + "a".repeat(64) + "_account__session_123e4567-e89b-12d3-a456-426614174000" },
  })
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: compliant })
  assert.equal(sent.body, compliant)
  assert.equal(sent.headers.get("anthropic-beta"), "claude-code-20250219")
})

test("Messages metadata keeps a parseable user id and every other field", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init; return json({}) })
  const parseable = [
    // Legacy form, including an empty account and upper-case hex.
    "user_" + "a1B2".repeat(16) + "_account_550e8400-e29b-41d4-a716-446655440000_session_123e4567-e89b-12d3-a456-426614174000",
    // JSON form, which ParseMetadataUserID reads case-insensitively.
    '{"device_id":"d61f76d0","session_id":"c72554f2-1234-5678-abcd-123456789abc"}',
    '{"DEVICE_ID":"upper","SESSION_ID":"also"}',
    '{"device_id":"device","session_id":"session","account_uuid":null}',
    '{"device_id":"device","DEVICE_ID":null,"session_id":"session"}',
  ]
  for (const userID of parseable) {
    await loader.fetch(BASE + "/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-test", system: [CLAUDE_IDENTITY_BLOCK], metadata: { user_id: userID, note: "kept" } }),
    })
    const body = JSON.parse(sent.body)
    assert.equal(body.metadata.user_id, userID)
    assert.equal(body.metadata.note, "kept")
  }
  // A value the gate cannot parse is replaced, never forwarded, and the other
  // metadata fields survive; metadata of an unusable shape is replaced instead.
  await loader.fetch(BASE + "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "claude-test", metadata: { user_id: "sk-caller-secret", note: "kept" } }),
  })
  const replaced = JSON.parse(sent.body).metadata
  assert.match(replaced.user_id, CLAUDE_USER_ID)
  assert.equal(replaced.note, "kept")
  assert.equal(sent.body.includes("sk-caller-secret"), false)
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", metadata: "not-an-object" }) })
  assert.match(JSON.parse(sent.body).metadata.user_id, CLAUDE_USER_ID)
  const invalid = '{"device_id":42,"DEVICE_ID":"later","session_id":"session"}'
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: JSON.stringify({ model: "claude-test", metadata: { user_id: invalid } }) })
  assert.match(JSON.parse(sent.body).metadata.user_id, CLAUDE_USER_ID)
})

test("Messages beta tokens are kept as sent and only a missing header is completed", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init; return json({}) })
  const body = JSON.stringify({ model: "claude-test", messages: [] })
  // A caller's own betas go upstream untouched; the plugin adds none of its own.
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body, headers: { "anthropic-beta": "prompt-caching-2024-07-31, interleaved-thinking-2025-05-14" } })
  assert.equal(sent.headers.get("anthropic-beta"), "prompt-caching-2024-07-31, interleaved-thinking-2025-05-14")
  // A missing or empty header gets the token the official client sends.
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body })
  assert.equal(sent.headers.get("anthropic-beta"), "claude-code-20250219")
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body, headers: { "anthropic-beta": "" } })
  assert.equal(sent.headers.get("anthropic-beta"), "claude-code-20250219")
  // A configured beta counts as the caller's own.
  const configured = await plugins.Sub2apiPlugin({}, { protocolHeaders: { claude: { "anthropic-beta": "configured-beta" } } })
  const configuredLoader = await configured.auth.loader(async () => auth())
  await configuredLoader.fetch(BASE + "/v1/messages", { method: "POST", body })
  assert.equal(sent.headers.get("anthropic-beta"), "configured-beta")
})

test("Messages completion accepts strings, bytes and blobs and never consumes a Request", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({}) })
  const body = JSON.stringify({ model: "claude-test", messages: [] })
  const bytes = new TextEncoder().encode(body)
  for (const [source, value] of [
    ["string", body],
    ["buffer", Buffer.from(body)],
    ["array-buffer", bytes.buffer],
    ["view", new DataView(bytes.buffer)],
    ["blob", new Blob([body])],
  ]) {
    await loader.fetch(BASE + "/v1/messages", { method: "POST", body: value, headers: { "content-length": "2" } })
    assert.deepEqual(JSON.parse(calls.at(-1).init.body).system, [CLAUDE_IDENTITY_BLOCK], source)
    assert.equal(calls.at(-1).init.headers.has("content-length"), false, source)
  }
  // A Request is inspected through a bounded clone, so the caller still holds
  // an unread body afterwards.
  const request = new Request(BASE + "/v1/messages", { method: "POST", body })
  await loader.fetch(request)
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).system, [CLAUDE_IDENTITY_BLOCK])
  assert.equal(request.bodyUsed, false)
  assert.equal(await request.text(), body)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } })
  const streamed = new Request(BASE + "/v1/messages", { method: "POST", body: stream, duplex: "half" })
  await loader.fetch(streamed)
  assert.deepEqual(JSON.parse(calls.at(-1).init.body).system, [CLAUDE_IDENTITY_BLOCK])
  assert.equal(await streamed.text(), body)
})

test("Messages completion keeps the streamed response, the signal and the account endpoint", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { apiPaths: { anthropic: "/proxy/v1" } })
  const loader = await plugin.auth.loader(async () => auth())
  const controller = new AbortController()
  const response = new Response('data: {"type":"message_start"}\n\n', { headers: { "content-type": "text/event-stream" } })
  let call
  t.mock.method(globalThis, "fetch", async (input, init) => { call = { input, init }; return response })
  const actual = await loader.fetch(BASE + "/v1/messages", { method: "POST", body: '{"model":"claude-test"}', signal: controller.signal })
  assert.equal(actual, response)
  assert.equal(call.init.signal, controller.signal)
  assert.equal(actual.bodyUsed, false)
  assert.equal(await actual.text(), 'data: {"type":"message_start"}\n\n')
  assert.equal(call.input instanceof Request ? call.input.url : String(call.input), BASE + "/proxy/v1/messages")
  assert.equal(call.init.headers.get("authorization"), `Bearer ${auth().key}`)
  assert.deepEqual(JSON.parse(call.init.body).system, [CLAUDE_IDENTITY_BLOCK])
})

test("Claude stand-in ids stay stable per account and conversation and never contain the key", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const first = await plugin.auth.loader(async () => auth({}, "sk-first"))
  const second = await plugin.auth.loader(async () => auth({}, "sk-second"))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const body = JSON.stringify({ model: "claude-test", messages: [] })
  for (const [loader, session] of [
    [first, "conversation-a"], [first, "conversation-a"], [first, "conversation-b"], [first, undefined], [second, "conversation-a"],
  ]) {
    await loader.fetch(BASE + "/v1/messages", { method: "POST", body, headers: session ? { "x-claude-code-session-id": session } : {} })
  }
  const ids = calls.map((init) => JSON.parse(init.body).metadata.user_id)
  assert.equal(ids[0], ids[1])          // one conversation keeps one id
  assert.notEqual(ids[0], ids[2])       // another conversation gets another
  assert.notEqual(ids[0], ids[3])       // no signal is its own stable scope
  assert.notEqual(ids[0], ids[4])       // another account gets another
  assert.notEqual(JSON.parse(ids[0]).device_id, JSON.parse(ids[4]).device_id)
  assert.deepEqual(calls.map((init) => init.headers.get("authorization")), Array(4).fill("Bearer sk-first").concat("Bearer sk-second"))
  assert.equal(calls.some((init) => init.body.includes("sk-first") || init.body.includes("sk-second")), false)
})

test("official Claude callers keep their own body and beta byte for byte", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({}) })
  const body = JSON.stringify({ model: "claude-test", system: "A caller's own system.", max_tokens: 64, messages: [] })
  await loader.fetch(new Request(BASE + "/v1/messages", {
    method: "POST",
    body,
    headers: { "User-Agent": "claude-cli/2.1.300 (external, cli)", "anthropic-beta": "caller-beta" },
  }))
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].input.bodyUsed, false)
  assert.equal(await calls[0].input.clone().text(), body)
  assert.equal(calls[0].init.headers.get("anthropic-beta"), "caller-beta")
  // An official caller without a beta of its own is not given one either: only
  // the calling request decides, and its own request is forwarded as sent.
  await loader.fetch(new Request(BASE + "/v1/messages", {
    method: "POST",
    body,
    headers: { "User-Agent": "claude-cli/2.1.300 (external, cli)" },
  }))
  assert.equal(calls[1].init.body, undefined)
  assert.equal(calls[1].input.bodyUsed, false)
  assert.equal(await calls[1].input.clone().text(), body)
  assert.equal(calls[1].init.headers.has("anthropic-beta"), false)
  assert.equal(calls[1].init.headers.get("user-agent"), "claude-cli/2.1.300 (external, cli)")
})

test("Claude completion applies only to third-party Messages inference bodies", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const body = JSON.stringify({ model: "claude-test", system: "kept as sent", messages: [] })
  for (const path of ["messages/count_tokens", "chat/completions", "responses", "models/gemini-test:generateContent", "models", "usage"]) {
    await loader.fetch(BASE + "/v1/" + path, { method: "POST", body })
    assert.equal(calls.at(-1).body, body, path)
    assert.equal(calls.at(-1).headers.has("anthropic-beta"), false, path)
  }
  // A bodyless Messages request (message list, probe) is forwarded untouched.
  await loader.fetch(BASE + "/v1/messages", { headers: { "user-agent": "opencode/0.4.0" } })
  assert.equal(calls.at(-1).body, undefined)
})

test("Messages bodies that cannot be completed fail explicitly", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const body = JSON.stringify({ model: "claude-test", messages: [] })
  // An encoded or streamed upload cannot be inspected, and pretending it was
  // completed would only move the rejection upstream.
  await assert.rejects(loader.fetch(BASE + "/v1/messages", { method: "POST", body, headers: { "content-encoding": "gzip" } }), /must be uncompressed/)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close() } })
  await assert.rejects(loader.fetch(BASE + "/v1/messages", { method: "POST", body: stream, duplex: "half" }), /streaming request body cannot be completed/)
  for (const invalid of ["{broken", "", "[]", "null", '"text"']) {
    await assert.rejects(loader.fetch(BASE + "/v1/messages", { method: "POST", body: invalid }), /must be a JSON object/)
  }
  // The plugin's own 32 MiB rewrite ceiling, not the 1 MiB window used for
  // header metadata: a big prompt is completed, only an outsized one is refused.
  await assert.rejects(loader.fetch(BASE + "/v1/messages", { method: "POST", body: new ArrayBuffer(33 << 20) }), /at most 32 MiB/)
  const large = JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "x".repeat(2 << 20) }] })
  await loader.fetch(BASE + "/v1/messages", { method: "POST", body: large })
  assert.deepEqual(JSON.parse(calls.at(-1).body).system, [CLAUDE_IDENTITY_BLOCK])
  // An aborted upload never reaches the site, so it is not reported here as a
  // body this plugin refused to complete; fetch raises the abort instead.
  const aborted = new AbortController()
  aborted.abort()
  const pending = new Request(BASE + "/v1/messages", { method: "POST", body, signal: aborted.signal })
  await loader.fetch(pending, { signal: aborted.signal })
  assert.equal(calls.at(-1).body, undefined)
  assert.equal(await pending.text(), body)
})

test("body and configured Codex marks cannot make a third-party caller native", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, {
    protocolHeaders: { codex: { originator: "codex_cli_rs", "x-codex-window-id": "configured-window" } },
  })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const body = JSON.stringify({ model: "gpt-test", client_metadata: {
    session_id: "body-session", "x-codex-installation-id": "body-installation",
  } })
  await loader.fetch(BASE + "/v1/responses", {
    method: "POST", body,
    headers: { "user-agent": "opencode/0.4.0", "x-magpie-agent": "codex", "x-codex-source": "opencode" },
  })
  const sent = calls[0]
  assert.match(sent.get("user-agent"), CODEX_UA)
  assert.equal(sent.get("originator"), "codex_cli_rs")
  assert.equal(sent.get("version"), "0.159.0")
  assert.equal(sent.get("session-id"), "body-session")
  assert.equal(sent.get("thread-id"), "body-session")
  assert.equal(sent.get("x-codex-window-id"), "configured-window")
  assert.equal(sent.get("x-codex-installation-id"), "body-installation")
  assert.equal(sent.get("x-codex-source"), "opencode")
  assert.equal(sent.has("x-magpie-agent"), false)
  assert.equal(sent.get("authorization"), `Bearer ${auth().key}`)
  // An official originator alone does not preserve an obviously third-party UA.
  await loader.fetch(BASE + "/v1/responses", { headers: {
    "user-agent": "opencode/0.4.0", originator: "codex_cli_rs",
  } })
  assert.match(calls.at(-1).get("user-agent"), CODEX_UA)
})

test("Codex versions preserve explicit headers and derive only missing values from native UAs", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let sent
  t.mock.method(globalThis, "fetch", async (_, init) => { sent = init.headers; return json({}) })
  for (const version of ["0.140.0", "0.200.0", "custom-build", ""]) {
    await loader.fetch(BASE + "/v1/responses", { headers: { "user-agent": "codex_cli_rs/0.162.0", version } })
    assert.equal(sent.get("version"), version)
    assert.equal(sent.get("user-agent"), "codex_cli_rs/0.162.0")
  }
  for (const ua of ["codex_exec/0.162.3", "Codex Desktop/0.162.3 (Mac OS; arm64)"]) {
    await loader.fetch(BASE + "/v1/responses", { headers: { "user-agent": ua } })
    assert.equal(sent.get("version"), "0.162.3")
    assert.equal(sent.get("user-agent"), ua)
  }
  // acp-extension-codex is not an official family the gate accepts, so its UA is
  // replaced while its version still seeds the Codex stand-in.
  await loader.fetch(BASE + "/v1/responses", { headers: { "user-agent": "acp-extension-codex/0.162.3" } })
  assert.equal(sent.get("version"), "0.162.3")
  assert.match(sent.get("user-agent"), /^codex_cli_rs\/0\.162\.3 \(/)
  for (const version of ["0.140.0", "0.200.0"]) {
    await loader.fetch(BASE + "/v1/responses", { headers: { "user-agent": "magpie/test", version } })
    assert.equal(sent.get("version"), version)
    assert.ok(sent.get("user-agent").startsWith(`codex_cli_rs/${version} `))
  }
  await loader.fetch(BASE + "/v1/responses")
  assert.equal(sent.get("version"), "0.159.0")
  assert.match(sent.get("user-agent"), CODEX_UA)
})

test("Responses promotes existing Codex body metadata without changing the body or routing", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { apiPaths: { responses: "/openai/v1" } })
  const loader = await plugin.auth.loader(async () => auth())
  const metadata = {
    session_id: "body-session",
    thread_id: "body-thread",
    "x-codex-window-id": "body-session:0",
    "x-codex-installation-id": "test-installation",
    "x-codex-turn-metadata": JSON.stringify({ turn_id: "test-turn" }),
    "x-codex-source": "test-client",
    authorization: "never-copy",
    "x-api-key": "never-copy",
    "x-other": "never-copy",
    turn_id: "never-copy",
  }
  const body = JSON.stringify({ model: "gpt-test", stream: true, client_metadata: metadata })
  const calls = []
  const response = new Response("data: test\n\n", { headers: { "content-type": "text/event-stream" } })
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), headers: init.headers, signal: init.signal, body: await new Request(input, init).text() })
    return response
  })
  const url = BASE + "/v1/responses/compact"
  for (const source of ["string", "URL", "Request", "override", "buffer", "array-buffer", "view", "blob"]) {
    const controller = new AbortController()
    const bytes = new TextEncoder().encode(body)
    const input = source === "Request" ? new Request(url, { method: "POST", body })
      : source === "override" ? new Request(url, { method: "POST", body: '{"client_metadata":{"session_id":"wrong"}}' })
      : source === "URL" ? new URL(url) : url
    const requestBody = source === "Request" ? undefined
      : source === "buffer" ? Buffer.from(body)
      : source === "array-buffer" ? bytes.buffer
      : source === "view" ? new DataView(bytes.buffer)
      : source === "blob" ? new Blob([body]) : body
    assert.equal(await loader.fetch(input, {
      method: "POST", body: requestBody, signal: controller.signal, headers: { "User-Agent": "magpie/test" },
    }), response)
    const call = calls.at(-1)
    assert.equal(call.url, BASE + "/openai/v1/responses/compact", source)
    assert.equal(call.body, body, source)
    assert.equal(call.signal, controller.signal)
    assert.match(call.headers.get("user-agent"), CODEX_UA)
    assert.equal(call.headers.get("openai-beta"), "responses=experimental")
    assert.equal(call.headers.get("version"), "0.159.0")
    assert.equal(call.headers.get("session-id"), metadata.session_id)
    assert.equal(call.headers.get("thread-id"), metadata.thread_id)
    for (const name of ["x-codex-window-id", "x-codex-installation-id", "x-codex-turn-metadata", "x-codex-source"]) {
      assert.equal(call.headers.get(name), metadata[name])
    }
    assert.equal(call.headers.get("authorization"), `Bearer ${auth().key}`)
    assert.equal(call.headers.get("originator"), "codex_cli_rs")
    for (const name of ["x-api-key", "x-other", "turn_id"]) assert.equal(call.headers.has(name), false)
  }
})

test("Responses uses prompt_cache_key for missing Codex session headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await loader.fetch(BASE + "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ prompt_cache_key: "cache-session" }),
  })
  assert.equal(calls.at(-1).get("session-id"), "cache-session")
  assert.equal(calls.at(-1).get("thread-id"), "cache-session")
  await loader.fetch(BASE + "/v1/responses", {
    method: "POST",
    headers: { "session-id": "explicit-session", "thread-id": "explicit-thread" },
    body: JSON.stringify({ prompt_cache_key: "cache-session" }),
  })
  assert.equal(calls.at(-1).get("session-id"), "explicit-session")
  assert.equal(calls.at(-1).get("thread-id"), "explicit-thread")
})

test("Responses masquerades a stable official Codex identity for non-Codex callers and preserves the body", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const body = JSON.stringify({ model: "gpt-test", input: "hello", stream: true })
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body })
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body })
  for (const call of calls) {
    assert.equal(call.headers.get("originator"), "codex_cli_rs")
    assert.match(call.headers.get("user-agent"), CODEX_UA)
    assert.equal(call.headers.get("openai-beta"), "responses=experimental")
    for (const name of ["session-id", "thread-id", "x-codex-window-id", "x-codex-installation-id"]) {
      assert.match(call.headers.get(name), CODEX_UUID, name)
    }
    assert.equal(call.headers.get("session-id"), call.headers.get("thread-id"))
    assert.equal(call.body, body)
  }
  assert.equal(calls[0].headers.get("session-id"), calls[1].headers.get("session-id"))
  assert.equal(calls[0].headers.get("x-codex-window-id"), calls[1].headers.get("x-codex-window-id"))
  assert.equal(calls[0].headers.get("x-codex-installation-id"), calls[1].headers.get("x-codex-installation-id"))
})

test("Masqueraded Codex identity follows the caller's session signal and stays isolated per account", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const first = await plugin.auth.loader(async () => auth({}, "sk-one"))
  const second = await plugin.auth.loader(async () => auth({}, "sk-two"))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const request = { method: "POST", body: JSON.stringify({ model: "gpt-test", input: "hello" }) }
  await first.fetch(BASE + "/v1/responses", { ...request, headers: { "x-opencode-session": "ses-one" } })
  await first.fetch(BASE + "/v1/responses", { ...request, headers: { "x-opencode-session": "ses-one" } })
  await first.fetch(BASE + "/v1/responses", { ...request, headers: { "x-opencode-session": "ses-two" } })
  await second.fetch(BASE + "/v1/responses", { ...request, headers: { "x-opencode-session": "ses-one" } })
  await first.fetch(BASE + "/v1/responses", { ...request, headers: { "x-session-id": "ses-one" } })
  for (const call of calls) assert.match(call.get("session-id"), CODEX_UUID)
  assert.equal(calls[1].get("session-id"), calls[0].get("session-id"))
  assert.equal(calls[1].get("x-codex-window-id"), calls[0].get("x-codex-window-id"))
  assert.notEqual(calls[2].get("session-id"), calls[0].get("session-id"))
  assert.notEqual(calls[2].get("x-codex-window-id"), calls[0].get("x-codex-window-id"))
  assert.notEqual(calls[3].get("session-id"), calls[0].get("session-id"))
  assert.notEqual(calls[3].get("x-codex-installation-id"), calls[0].get("x-codex-installation-id"))
  assert.equal(calls[4].get("session-id"), calls[0].get("session-id"))
  assert.equal(calls[4].get("x-codex-installation-id"), calls[0].get("x-codex-installation-id"))
})

test("Native Codex callers keep their own identity; a magpie hint alone is still masqueraded", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const request = { method: "POST", body: JSON.stringify({ model: "gpt-test", input: "hello" }) }
  await loader.fetch(BASE + "/v1/responses", { ...request, headers: { "User-Agent": "codex-tui/0.163.0" } })
  for (const name of ["session-id", "thread-id", "x-codex-window-id", "x-codex-installation-id"]) {
    assert.equal(calls[0].has(name), false, name)
  }
  assert.equal(calls[0].get("user-agent"), "codex-tui/0.163.0")
  await loader.fetch(BASE + "/v1/responses", { ...request, headers: { "x-magpie-agent": "codex", "session-id": "hinted-session" } })
  assert.equal(calls[1].get("session-id"), "hinted-session")
  assert.equal(calls[1].get("thread-id"), "hinted-session")
  assert.match(calls[1].get("x-codex-window-id"), CODEX_UUID)
  assert.match(calls[1].get("user-agent"), CODEX_UA)
})

test("Configured Codex headers win over masqueraded stand-ins", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, {
    protocolHeaders: { codex: { "x-codex-window-id": "configured-window", "x-codex-installation-id": "configured-installation" } },
  })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: JSON.stringify({ model: "gpt-test" }) })
  assert.equal(calls[0].get("x-codex-window-id"), "configured-window")
  assert.equal(calls[0].get("x-codex-installation-id"), "configured-installation")
  assert.match(calls[0].get("session-id"), CODEX_UUID)
})

test("metadata and configured headers only fill names missing from the agent request", async (t) => {
  const plugin = await plugins.Sub2apiSite1({}, {
    headers: { "User-Agent": "global" },
    protocolHeaders: { codex: { "User-Agent": "protocol", "x-codex-window-id": "protocol-window" } },
    sites: [{ id: "work", url: BASE, headers: { "User-Agent": "site" } }],
  })
  const loader = await plugin.auth.loader(async () => auth({ headers: { "USER-AGENT": "account", "x-codex-installation-id": "account-installation" } }))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const request = new Request(BASE + "/v1/responses", {
    method: "POST",
    headers: { "session-id": "request-session", "thread_id": "request-thread", "x-codex-turn-metadata": "request-turn" },
    body: JSON.stringify({ client_metadata: {
      session_id: "body-session", thread_id: "body-thread", "x-codex-turn-metadata": "body-turn",
      "x-codex-window-id": "body-window", "x-codex-installation-id": "body-installation",
    } }),
  })
  await loader.fetch(request, { headers: { "session-id": "init-session" } })
  const headers = calls[0]
  assert.equal(headers.get("user-agent"), "account")
  assert.equal(headers.get("session-id"), "init-session")
  assert.equal(headers.get("thread_id"), "request-thread")
  assert.equal(headers.get("thread-id"), "init-session")
  assert.equal(headers.get("x-codex-turn-metadata"), "request-turn")
  assert.equal(headers.get("x-codex-window-id"), "body-window")
  assert.equal(headers.get("x-codex-installation-id"), "body-installation")
})

test("Codex body metadata is not promoted on other protocols or management endpoints", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  const body = JSON.stringify({ client_metadata: { "x-codex-window-id": "not-a-codex-request", session_id: "session" } })
  for (const path of ["/v1/messages", "/v1/chat/completions", "/v1beta/models/gemini-test:generateContent", "/v1/models", "/v1/usage"]) {
    await loader.fetch(BASE + path, { method: "POST", body })
    assert.equal(calls.at(-1).headers.has("x-codex-window-id"), false)
    assert.equal(calls.at(-1).headers.has("session-id"), false)
    // The Messages path gets the Claude Code identity, never the Codex ones.
    if (path === "/v1/messages") assert.deepEqual(JSON.parse(calls.at(-1).body).system, [CLAUDE_IDENTITY_BLOCK])
    else assert.equal(calls.at(-1).body, body)
  }
})

test("missing malformed and unsafe metadata does not fail requests or leak arbitrary headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init); return json({}) })
  for (const body of [
    "", "{broken", "null", "[]", "{}", '{"client_metadata":[]}', '{"client_metadata":"not-an-object"}',
    JSON.stringify({ client_metadata: {
      "x-codex-window-id": 123,
      "x-codex-installation-id": { value: "not-a-string" },
      "x-codex-turn-metadata": "secret\r\nInjected: yes",
      "x-codex-bad name": "secret",
      "x-codex-empty": "",
      "x-codex-nul": "secret\0",
      "x-codex-unicode": "\u4e2d",
      "x-codex-oversized": "x".repeat(8193),
      "x-codex-reserved": undefined,
      session_id: null,
    } }),
  ]) {
    await loader.fetch(BASE + "/v1/responses", { method: "POST", body })
    assert.equal(calls.at(-1).body, body)
    assert.deepEqual([...calls.at(-1).headers.keys()].sort(), [
      "authorization", "openai-beta", "originator", "session-id", "thread-id",
      "user-agent", "version", "x-codex-installation-id", "x-codex-window-id",
    ])
  }
})

test("metadata inspection skips large or encoded bodies and streaming init.body uploads", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({}) })
  const body = JSON.stringify({ client_metadata: { "x-codex-source": "window" }, padding: "x".repeat(1 << 20) })
  for (const inputBody of [body, Buffer.from(body), new Blob([body])]) {
    await loader.fetch(BASE + "/v1/responses", { method: "POST", body: inputBody })
    assert.equal(calls.at(-1).init.body, inputBody)
    assert.equal(calls.at(-1).init.headers.has("x-codex-source"), false)
  }
  const request = new Request(BASE + "/v1/responses", { method: "POST", body })
  await loader.fetch(request)
  assert.equal(calls.at(-1).input, request)
  assert.equal(request.bodyUsed, false)
  assert.equal(await request.text(), body)
  assert.equal(calls.at(-1).init.headers.has("x-codex-source"), false)
  const smallBody = '{"client_metadata":{"x-codex-source":"window"}}'
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: smallBody, headers: { "content-encoding": "gzip" } })
  assert.equal(calls.at(-1).init.headers.has("x-codex-source"), false)
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(smallBody)); controller.close() } })
  await loader.fetch(BASE + "/v1/responses", { method: "POST", body: stream, duplex: "half" })
  assert.equal(calls.at(-1).init.body, stream)
  assert.equal(stream.locked, false)
  assert.equal(calls.at(-1).init.headers.has("x-codex-source"), false)
})

test("metadata headers have a total size limit and small later values can still be copied", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let headers
  t.mock.method(globalThis, "fetch", async (_, init) => { headers = init.headers; return json({}) })
  const first = "x".repeat(5000)
  await loader.fetch(BASE + "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ client_metadata: { "x-codex-first": first, "x-codex-second": first, "x-codex-window-id": "window" } }),
  })
  assert.equal(headers.get("x-codex-first"), first)
  assert.equal(headers.has("x-codex-second"), false)
  assert.equal(headers.get("x-codex-window-id"), "window")
})

test("metadata Request inspection honors aborts and timeouts without consuming the original body", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let cancelInspection
  t.mock.method(globalThis, "setTimeout", (callback) => { cancelInspection = callback; return 0 })
  t.mock.method(globalThis, "clearTimeout", () => {})
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push({ input, init })
    init.signal?.throwIfAborted()
    return json({})
  })
  for (const kind of ["abort", "timeout"]) {
    let streamController
    const stream = new ReadableStream({ start(controller) { streamController = controller } })
    const controller = new AbortController()
    const request = new Request(BASE + "/v1/responses", { method: "POST", body: stream, duplex: "half" })
    const pending = loader.fetch(request, { signal: controller.signal })
    assert.equal(calls.length, kind === "abort" ? 0 : 1)
    if (kind === "abort") {
      controller.abort()
      await assert.rejects(pending, { name: "AbortError" })
    } else {
      cancelInspection()
      await pending
    }
    assert.equal(request.bodyUsed, false)
    assert.equal(calls.at(-1).init.headers.has("x-codex-source"), false)
    const body = '{"client_metadata":{"x-codex-source":"window"}}'
    streamController.enqueue(new TextEncoder().encode(body))
    streamController.close()
    assert.equal(await request.text(), body)
  }
})

test("Claude completion never forwards a timed-out Request's valid JSON prefix", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  let cancelInspection
  let streamController
  let upstreamCalls = 0
  t.mock.method(globalThis, "setTimeout", (callback) => { cancelInspection = callback; return 0 })
  t.mock.method(globalThis, "clearTimeout", () => {})
  t.mock.method(globalThis, "fetch", async () => { upstreamCalls++; return json({}) })
  const body = '{"model":"claude-test","max_tokens":8,"messages":[]}'
  const stream = new ReadableStream({ start(controller) {
    streamController = controller
    controller.enqueue(new TextEncoder().encode(body))
  } })
  const request = new Request(BASE + "/v1/messages", { method: "POST", body: stream, duplex: "half" })
  const pending = assert.rejects(loader.fetch(request), /within 15 seconds/)
  await new Promise((resolve) => setImmediate(resolve))
  cancelInspection()
  await pending
  assert.equal(upstreamCalls, 0)
  assert.equal(request.bodyUsed, false)
  streamController.close()
  assert.equal(await request.text(), body)
})

test("Codex metadata is isolated between accounts and successive requests", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const first = await plugin.auth.loader(async () => auth({}, "sk-first"))
  const second = await plugin.auth.loader(async () => auth({}, "sk-second"))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  for (const [loader, session] of [[first, "first-session"], [second, "second-session"], [first, "new-first-session"]]) {
    await loader.fetch(BASE + "/v1/responses", { method: "POST", body: JSON.stringify({ client_metadata: { session_id: session, "x-codex-window-id": session + ":0" } }) })
  }
  await first.fetch(BASE + "/v1/responses", { method: "POST", body: "{}" })
  await first.fetch(BASE + "/v1/responses", { method: "POST", body: "{}" })
  await second.fetch(BASE + "/v1/responses", { method: "POST", body: "{}" })
  assert.deepEqual(calls.slice(0, 3).map((headers) => headers.get("session-id")), ["first-session", "second-session", "new-first-session"])
  assert.deepEqual(calls.slice(0, 3).map((headers) => headers.get("x-codex-window-id")), ["first-session:0", "second-session:0", "new-first-session:0"])
  for (const index of [3, 4, 5]) {
    for (const name of ["session-id", "thread-id", "x-codex-window-id", "x-codex-installation-id"]) {
      assert.match(calls[index].get(name), CODEX_UUID)
    }
  }
  assert.equal(calls[4].get("session-id"), calls[3].get("session-id"))
  assert.equal(calls[4].get("x-codex-window-id"), calls[3].get("x-codex-window-id"))
  assert.equal(calls[4].get("x-codex-installation-id"), calls[3].get("x-codex-installation-id"))
  assert.notEqual(calls[5].get("session-id"), calls[3].get("session-id"))
  assert.notEqual(calls[5].get("x-codex-installation-id"), calls[3].get("x-codex-installation-id"))
  assert.deepEqual(calls.map((headers) => headers.get("authorization")), [
    "Bearer sk-first", "Bearer sk-second", "Bearer sk-first", "Bearer sk-first", "Bearer sk-first", "Bearer sk-second",
  ])
})

test("inference applies protocol-specific Codex and Claude headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, {
    protocolHeaders: {
      codex: { originator: "codex_cli_rs", "x-codex-source": "codex-tui" },
      claude: { "anthropic-beta": "interleaved-thinking-2025-05-14" },
    },
  })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await loader.fetch(BASE + "/v1/responses")
  await loader.fetch(BASE + "/v1/messages")
  assert.equal(calls[0].get("originator"), "codex_cli_rs")
  assert.equal(calls[0].get("x-codex-source"), "codex-tui")
  assert.equal(calls[0].get("anthropic-beta"), null)
  assert.equal(calls[1].get("anthropic-beta"), "interleaved-thinking-2025-05-14")
  assert.equal(calls[1].get("originator"), null)
})

test("agent user agents pass through while configured values remain isolated", async (t) => {
  const options = {
    headers: { "USER-AGENT": "global" },
    sites: [{ id: "work", url: BASE, headers: { "User-Agent": "site" } }],
  }
  const pooled = await plugins.Sub2apiPlugin({}, options)
  const site = await plugins.Sub2apiSite1({}, options)
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const accountLoader = await site.auth.loader(async () => auth({ headers: '{"uSeR-aGeNt":"account"}' }, "sk-account"))
  for (const [plugin, metadata, configuredUA] of [
    [pooled, {}, "global"], [site, {}, "site"], [site, { headers: { "user-agent": "" } }, ""],
  ]) {
    const loader = await plugin.auth.loader(async () => auth(metadata, "sk-other"))
    for (const path of ["responses", "messages", "chat/completions", "models/gemini-test:generateContent"]) {
      await accountLoader.fetch(BASE + "/v1/" + path)
      await loader.fetch(BASE + "/v1/" + path, { headers: { "user-agent": "caller" } })
      await accountLoader.fetch(BASE + "/v1/" + path)
      const userAgents = calls.slice(-3).map((headers) => headers.get("user-agent"))
      assert.equal(userAgents[0], "account")
      assert.equal(userAgents[2], "account")
      const expected = path === "responses" || path === "messages"
        ? configuredUA || (path === "responses" ? CODEX_UA : CLAUDE_UA)
        : "caller"
      if (expected instanceof RegExp) assert.match(userAgents[1], expected)
      else assert.equal(userAgents[1], expected)
      assert.deepEqual(calls.slice(-3).map((headers) => headers.get("authorization")), ["Bearer sk-account", "Bearer sk-other", "Bearer sk-account"])
    }
  }
})

test("protocol user agents do not affect management or unrecognized endpoints", async (t) => {
  const calls = mockAPI(t)
  const plugin = await plugins.Sub2apiPlugin()
  const account = auth()
  await plugin.auth.usage(async () => account)
  await plugin.provider.models({ models: {} }, { auth: account })
  assert.equal(calls.length, 3)
  for (const call of calls) assert.equal(new Headers(call.headers).has("user-agent"), false)
  const loader = await plugin.auth.loader(async () => account)
  await loader.fetch(BASE + "/v1/models", { headers: { "User-Agent": "caller" } })
  assert.equal(new Headers(calls.at(-1).headers).get("user-agent"), "caller")
})

test("inference preserves a forbidden response without retrying or changing its body", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth())
  const body = { error: { message: "This account only allows Codex official clients", type: "forbidden_error" } }
  const response = json(body, 403)
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return response })
  const actual = await loader.fetch(BASE + "/v1/responses")
  assert.equal(actual, response)
  assert.equal(actual.status, 403)
  assert.deepEqual(await actual.json(), body)
  assert.equal(calls, 1)
})

test("inference supports Request and URL inputs, including header overrides", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth({ headers: { "X-Account": "yes" } }))
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return json({}) })
  const request = new Request(BASE + "/v1/responses", { method: "POST", body: "{}", headers: { "x-trace": "request" } })
  await loader.fetch(request, { headers: new Headers({ "x-init": "init", "x-trace": "init" }) })
  assert.equal(calls[0].input, request)
  assert.equal(calls[0].init.headers.get("x-trace"), "init")
  assert.equal(calls[0].init.headers.get("x-init"), "init")
  assert.equal(calls[0].init.headers.get("x-account"), "yes")
  await loader.fetch(new URL(BASE + "/v1/responses"))
  assert.equal(calls.length, 2)
})

test("accounts never share credentials or account-specific headers", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const first = await plugin.auth.loader(async () => auth({ headers: { "X-Account": "first" } }, "sk-first"))
  const second = await plugin.auth.loader(async () => auth({ headers: { "X-Account": "second" } }, "sk-second"))
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  await first.fetch(BASE + "/v1/responses")
  await second.fetch(BASE + "/v1/responses")
  await first.fetch(BASE + "/v1/responses")
  assert.deepEqual(calls.map((h) => h.get("x-account")), ["first", "second", "first"])
  assert.deepEqual(calls.map((h) => h.get("authorization")), ["Bearer sk-first", "Bearer sk-second", "Bearer sk-first"])
})

test("inference rejects destinations outside the account's API before fetching", async (t) => {
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return json({}) })
  const plugin = await plugins.Sub2apiPlugin()
  const loader = await plugin.auth.loader(async () => auth({ baseURL: BASE + "/prefix" }))
  for (const url of [
    "https://other.example.com/prefix/v1/responses", BASE + "/v1/responses",
    BASE + "/prefix/v1evil/responses", BASE + "/prefix/v1/../private",
    "http://api.example.com/prefix/v1/responses", "https://user:pass@api.example.com/prefix/v1/responses",
  ]) await assert.rejects(loader.fetch(url), /Refusing/)
  assert.equal(calls, 0)
})

test("invalid headers fail validation without exposing their values", async () => {
  const plugin = await plugins.Sub2apiPlugin()
  for (const value of ["", "{}", '{"X-Client":"valid"}']) {
    assert.ok(await plugin.auth.loader(async () => auth({ headers: value })))
  }
  const invalid = ["secret-invalid-json", "[]", "null", '{"X-Client":42}',
    { "bad name": "secret" }, { Authorization: "secret" }, { "X-Api-Key": "secret" },
    { Host: "secret" }, { "Content-Length": "123" }, { "X-Client": "secret\r\ninjected: yes" },
  ]
  for (const headers of invalid) {
    await assert.rejects(plugins.Sub2apiPlugin({}, { headers }))
    await assert.rejects(plugin.auth.loader(async () => auth({ headers })))
    const usage = await plugin.auth.usage(async () => auth({ headers }))
    assert.ok(usage.error)
    assert.equal(usage.error.includes("secret"), false)
  }
})

test("invalid protocol-specific headers fail validation", async () => {
  await assert.rejects(plugins.Sub2apiPlugin({}, { protocolHeaders: { codex: { Authorization: "secret" } } }), /reserved/)
  await assert.rejects(plugins.Sub2apiPlugin({}, { protocolHeaders: { unknown: { "X-Test": "value" } } }), /Protocol must be/)
})

test("addresses reject embedded credentials, queries, fragments and non-HTTP schemes", async () => {
  const plugin = await plugins.Sub2apiPlugin()
  const prompt = plugin.auth.methods[0].prompts.find((p) => p.key === "baseURL")
  for (const url of [BASE, BASE + "/prefix/v1/", "http://127.0.0.1:8080"]) assert.equal(prompt.validate(url), undefined)
  for (const url of ["", "ftp://example.com", "https://user:pass@example.com", BASE + "?key=secret", BASE + "#secret"]) {
    assert.ok(prompt.validate(url))
    if (url) await assert.rejects(plugin.auth.loader(async () => auth({ baseURL: url })))
  }
})

test("usage maps subscription windows, expiry and rolling weekly reset", async (t) => {
  mockAPI(t, {
    planName: "Pro", subscription: {
      daily_usage_usd: 2, daily_limit_usd: 10, daily_reset_at: "2099-01-02T00:00:00Z",
      weekly_usage_usd: 5, weekly_limit_usd: 50, weekly_window_start: "2099-01-01T00:00:00Z",
      monthly_usage_usd: 12, monthly_limit_usd: 100, expires_at: "2099-02-01T00:00:00Z",
    },
  })
  const plugin = await plugins.Sub2apiPlugin()
  const usage = await plugin.auth.usage(async () => auth())
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.until, "2099-02-01T00:00:00Z")
  assert.deepEqual(usage.windows.map((w) => w.used), [20, 10, 12])
  assert.deepEqual(usage.windows.map((w) => w.span), [86400, 604800, 2592000])
  assert.equal(usage.windows[0].resetsAt, "2099-01-02T00:00:00Z")
  assert.equal(usage.windows[1].resetsAt, "2099-01-08T00:00:00.000Z")
  assert.equal(usage.windows[2].resetsAt, undefined)
})

test("usage handles balance, quota, expired, unlimited and missing subscriptions", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { query: { usageTtlMs: 0 } })
  const cases = [
    [{ planName: "Wallet", balance: 0 }, (u) => { assert.equal(u.plan, "Wallet"); assert.equal(u.balance, "$0.00") }],
    [{ balance: -1.25 }, (u) => assert.equal(u.balance, "$-1.25")],
    [{ mode: "quota_limited", status: "quota_exhausted", quota: { used: 12, limit: 10 },
      rate_limits: [{ window: "5h", used: 1, limit: 2, reset_at: "2099-01-01T00:00:00Z" }],
    }, (u) => { assert.equal(u.windows[0].used, 120); assert.equal(u.windows[1].used, 50); assert.match(u.error, /used up/) }],
    [{ mode: "quota_limited", status: "expired" }, (u) => assert.match(u.error, /expired/)],
    [{ subscription: { daily_limit_usd: 0, weekly_limit_usd: null } }, (u) => { assert.equal(u.balance, "Unlimited"); assert.equal(u.windows.length, 0) }],
    [{ subscription: { expires_at: "2000-01-01T00:00:00Z" } }, (u) => assert.match(u.error, /expired/)],
    [{}, (u) => assert.match(u.error, /No active subscription/)],
  ]
  for (const [body, check] of cases) {
    await t.test(JSON.stringify(body), async (t) => {
      mockAPI(t, body)
      check(await plugin.auth.usage(async () => auth()))
    })
  }
  assert.match((await plugin.auth.usage(async () => undefined)).error, /not signed in/)
  assert.match((await plugin.auth.usage(async () => ({ type: "api", key: "key" }))).error, /address/)
})

test("401 marks sign-in as expired and other model failures propagate without fallback", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  t.mock.method(globalThis, "fetch", async () => json({ error: { message: "invalid key" } }, 401))
  const usage = await plugin.auth.usage(async () => auth())
  assert.equal(usage.signIn, "expired")
  await assert.rejects(plugin.provider.models({ models: {} }, { auth: auth() }), /401/)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }))
  const previous = { old: { id: "old" } }
  await assert.rejects(plugin.provider.models({ models: previous }, { auth: auth() }), /503/)
  assert.equal((await plugin.auth.usage(async () => auth())).signIn, undefined)
})

test("a transient catalog failure stops blocking inference after its cache TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const plugin = await plugins.Sub2apiPlugin({}, { query: { modelsTtlMs: 0 } })
  let modelCalls = 0
  const calls = []
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith("/v1/models")) {
      modelCalls++
      if (modelCalls === 1) throw new TypeError("simulated network failure")
      return json(modelList)
    }
    if (url.includes("/backend-api/codex/models")) return json({ models: [] })
    return json({ ok: true })
  })
  const account = auth()
  let catalogError
  try {
    await plugin.provider.models({ models: {} }, { auth: account })
  } catch (error) {
    catalogError = error
  }
  assert.equal(catalogError?.message, "Sub2API query failed or timed out")
  const loader = await plugin.auth.loader(async () => account)
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-test", input: "hi" }) }
  await assert.rejects(loader.fetch(BASE + "/v1/responses", request), /Sub2API query failed or timed out/)
  t.mock.timers.setTime(Date.now() + 30_001)
  const response = await loader.fetch(BASE + "/v1/responses", request)
  assert.equal(response.status, 200)
  assert.equal(modelCalls, 1)
  assert.ok(calls.some((url) => url.endsWith("/v1/responses")))
})

test("manifest failures retain known reasoning levels but malformed model lists fail explicitly", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { query: { modelsTtlMs: 0 } })
  const previous = { "gpt-test": { variants: { medium: {}, high: {} } } }
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("backend-api") ? json({}, 404) : json(modelList))
  const models = await plugin.provider.models({ models: previous }, { auth: auth() })
  assert.deepEqual(models["gpt-test"].variants, previous["gpt-test"].variants)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => json({ data: {} }))
  await assert.rejects(plugin.provider.models({ models: previous }, { auth: auth() }), /Invalid model catalog/)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"))
  assert.match((await plugin.auth.usage(async () => auth())).error, /not JSON/)
})

test("real HTTP sends headers, preserves streaming, cancellation and refuses redirects", async (t) => {
  const calls = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() })
    if (req.url === "/v1/redirect") {
      res.writeHead(302, { location: "/v1/target" }).end()
    } else if (req.url === "/v1/usage") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"balance":9.99}')
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write('data: {"ok":true}\n\n')
      res.end("data: [DONE]\n\n")
    }
  })
  server.listen(0, "127.0.0.1")
  try {
    await once(server, "listening")
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") throw e
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}`
  const plugin = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "upstream-client/1.0", "X-Client": "real-http" } })
  const account = auth({ baseURL: base })
  assert.equal((await plugin.auth.usage(async () => account)).balance, "$9.99")
  const loader = await plugin.auth.loader(async () => account)
  const request = new Request(base + "/v1/responses", { method: "POST", body: '{"stream":true}', headers: { "x-trace": "real" } })
  const response = await loader.fetch(request)
  assert.match(response.headers.get("content-type"), /text\/event-stream/)
  assert.equal(await response.text(), 'data: {"ok":true}\n\ndata: [DONE]\n\n')
  assert.equal(calls[1].body, '{"stream":true}')
  assert.equal(calls[1].headers["x-trace"], "real")
  for (const call of calls) {
    assert.equal(call.headers.authorization, `Bearer ${account.key}`)
    assert.equal(call.headers["x-client"], "real-http")
    assert.equal(call.headers["user-agent"], "upstream-client/1.0")
  }
  const automatic = await plugins.Sub2apiPlugin({}, { apiPaths: { responses: "/openai/v1" } })
  const automaticLoader = await automatic.auth.loader(async () => account)
  const body = JSON.stringify({ stream: true, client_metadata: {
    session_id: "loopback-session", "x-codex-window-id": "loopback-session:0",
    "x-codex-turn-metadata": JSON.stringify({ turn_id: "loopback-turn" }),
  } })
  const metadataRequest = new Request(base + "/v1/responses", { method: "POST", body, headers: { "User-Agent": "magpie/test" } })
  const metadataResponse = await automaticLoader.fetch(metadataRequest)
  assert.equal(await metadataResponse.text(), 'data: {"ok":true}\n\ndata: [DONE]\n\n')
  assert.equal(calls.at(-1).path, "/openai/v1/responses")
  assert.equal(calls.at(-1).body, body)
  assert.match(calls.at(-1).headers["user-agent"], CODEX_UA)
  assert.equal(calls.at(-1).headers["originator"], "codex_cli_rs")
  assert.equal(calls.at(-1).headers["openai-beta"], "responses=experimental")
  assert.equal(calls.at(-1).headers.version, "0.159.0")
  assert.equal(calls.at(-1).headers["session-id"], "loopback-session")
  assert.equal(calls.at(-1).headers["x-codex-window-id"], "loopback-session:0")
  assert.equal(calls.at(-1).headers["x-codex-turn-metadata"], '{"turn_id":"loopback-turn"}')
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${account.key}`)
  const claudeResponse = await automaticLoader.fetch(base + "/v1/messages", { method: "POST", body, headers: { "User-Agent": "magpie/test" } })
  await claudeResponse.text()
  assert.equal(calls.at(-1).headers["user-agent"], CLAUDE_UA)
  assert.equal(calls.at(-1).headers["x-app"], "cli")
  assert.equal(calls.at(-1).headers["x-codex-window-id"], undefined)
  await assert.rejects(loader.fetch(base + "/v1/redirect"))
  assert.equal(calls.some((c) => c.path === "/v1/target"), false)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loader.fetch(base + "/v1/responses", { signal: controller.signal }), { name: "AbortError" })
})
