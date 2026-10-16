import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import * as plugins from "../index.mjs"

const BASE = "https://api.example.com"
const auth = (metadata = {}, key = "sk-test-only-1234") => ({
  type: "api", key, metadata: { baseURL: BASE, ...metadata },
})
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const modelList = { data: [{ id: "claude-test" }, { id: "gpt-test" }, { id: "other-test" }] }

function mockAPI(t, usage = { balance: 12.34 }) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
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

test("only provider plugin functions are exported", () => {
  assert.equal(Object.keys(plugins).length, 9)
  for (const value of Object.values(plugins)) assert.equal(typeof value, "function")
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
  plugin.config(cfg)
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

test("inference enforces configured headers and the selected key for all three APIs", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "configured", "X-Client": "magpie" } })
  const account = auth()
  const loader = await plugin.auth.loader(async () => account)
  const response = new Response("data: test\n\n", { headers: { "content-type": "text/event-stream" } })
  const calls = []
  t.mock.method(globalThis, "fetch", async (input, init) => { calls.push({ input, init }); return response })
  for (const path of ["messages", "responses", "chat/completions"]) {
    const controller = new AbortController()
    const body = '{"stream":true}'
    const actual = await loader.fetch(`${BASE}/v1/${path}`, {
      method: "POST", body, signal: controller.signal,
      headers: { authorization: "Bearer wrong", "x-api-key": "wrong", "user-agent": "agent", "x-trace": "trace" },
    })
    assert.equal(actual, response)
    const { init } = calls.at(-1)
    assert.equal(init.headers.get("authorization"), `Bearer ${account.key}`)
    assert.equal(init.headers.get("x-api-key"), account.key)
    assert.equal(init.headers.get("user-agent"), "configured")
    assert.equal(init.headers.get("x-client"), "magpie")
    assert.equal(init.headers.get("x-trace"), "trace")
    assert.equal(init.body, body)
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
    ["/v1/responses", "codex_cli_rs/0.146.0 (magpie-sub2api)"],
    ["/openai/v1/responses/compact", "codex_cli_rs/0.146.0 (magpie-sub2api)"],
    ["/v1/chat/completions", "OpenAI/JS (magpie-sub2api)"],
    ["/v1/messages", "anthropic-typescript (magpie-sub2api)"],
    ["/v1beta/models/gemini-test:streamGenerateContent", "google-genai-sdk (magpie-sub2api)"],
    ["/v1/responses", "codex_cli_rs/0.146.0 (magpie-sub2api)"],
  ]) {
    for (const kind of ["string", "URL", "Request"]) {
      const url = BASE + "/prefix" + path
      const input = kind === "Request" ? new Request(url)
        : kind === "URL" ? new URL(url) : url
      assert.equal(await loader.fetch(input), response)
      const call = calls.at(-1)
      assert.equal(call.init.headers.get("user-agent"), userAgent)
      assert.equal(call.init.headers.get("authorization"), `Bearer ${auth().key}`)
      assert.equal(call.init.redirect, "error")
      if (path === "/v1/responses") {
        assert.equal(call.input instanceof Request ? call.input.url : String(call.input), BASE + "/prefix/openai/v1/responses")
      }
    }
  }
  await loader.fetch(BASE + "/prefix/v1/responses")
  assert.equal(calls.at(-1).init.headers.get("user-agent"), "codex_cli_rs/0.146.0 (magpie-sub2api)")
  const count = calls.length
  await assert.rejects(loader.fetch("https://other.example.com/prefix/v1/responses"), /Refusing/)
  assert.equal(calls.length, count)
})

test("inference preserves host user agents including empty values and init overrides", async (t) => {
  const plugin = await plugins.Sub2apiPlugin({}, { apiPaths: { responses: "/openai/v1" } })
  const loader = await plugin.auth.loader(async () => auth())
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  for (const path of ["responses", "messages", "chat/completions", "models/gemini-test:generateContent"]) {
    const url = BASE + "/v1/" + path
    for (const userAgent of ["magpie/0.1.1271", "codex-tui/0.162.1", ""]) {
      for (const input of [url, new URL(url), new Request(url, { headers: { "User-Agent": "request-client" } })]) {
        await loader.fetch(input, { headers: { "uSeR-aGeNt": userAgent } })
        assert.equal(calls.at(-1).get("user-agent"), userAgent)
      }
      await loader.fetch(new Request(url, { headers: { "User-Agent": userAgent } }))
      assert.equal(calls.at(-1).get("user-agent"), userAgent)
    }
  }
})

test("inference preserves Codex identity and session headers", async (t) => {
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
  assert.equal(headers.get("originator"), "codex_cli_rs")
  assert.equal(headers.get("session-id"), "init-session")
  assert.equal(headers.get("x-codex-turn-metadata"), "request-turn")
  assert.equal(headers.get("x-codex-source"), "codex-tui")
})

test("explicit user agents override protocol defaults with isolated global site and account precedence", async (t) => {
  const options = {
    headers: { "USER-AGENT": "global" },
    sites: [{ id: "work", url: BASE, headers: { "User-Agent": "site" } }],
  }
  const pooled = await plugins.Sub2apiPlugin({}, options)
  const site = await plugins.Sub2apiSite1({}, options)
  const calls = []
  t.mock.method(globalThis, "fetch", async (_, init) => { calls.push(init.headers); return json({}) })
  const accountLoader = await site.auth.loader(async () => auth({ headers: '{"uSeR-aGeNt":"account"}' }, "sk-account"))
  for (const [plugin, metadata, expected] of [
    [pooled, {}, "global"], [site, {}, "site"], [site, { headers: { "user-agent": "" } }, ""],
  ]) {
    const loader = await plugin.auth.loader(async () => auth(metadata, "sk-other"))
    for (const path of ["responses", "messages", "chat/completions", "models/gemini-test:generateContent"]) {
      await accountLoader.fetch(BASE + "/v1/" + path)
      await loader.fetch(BASE + "/v1/" + path, { headers: { "user-agent": "caller" } })
      await accountLoader.fetch(BASE + "/v1/" + path)
      assert.deepEqual(calls.slice(-3).map((h) => h.get("user-agent")), ["account", expected, "account"])
      assert.deepEqual(calls.slice(-3).map((h) => h.get("authorization")), ["Bearer sk-account", "Bearer sk-other", "Bearer sk-account"])
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
  const plugin = await plugins.Sub2apiPlugin()
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

test("401 marks sign-in as expired, other model failures preserve the previous catalog", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  t.mock.method(globalThis, "fetch", async () => json({ error: { message: "invalid key" } }, 401))
  const usage = await plugin.auth.usage(async () => auth())
  assert.equal(usage.signIn, "expired")
  await assert.rejects(plugin.provider.models({ models: {} }, { auth: auth() }), /401/)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }))
  const previous = { old: { id: "old" } }
  assert.equal(await plugin.provider.models({ models: previous }, { auth: auth() }), previous)
  assert.equal((await plugin.auth.usage(async () => auth())).signIn, undefined)
})

test("manifest failures retain known reasoning levels and malformed model lists fall back", async (t) => {
  const plugin = await plugins.Sub2apiPlugin()
  const previous = { "gpt-test": { variants: { medium: {}, high: {} } } }
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("backend-api") ? json({}, 404) : json(modelList))
  const models = await plugin.provider.models({ models: previous }, { auth: auth() })
  assert.deepEqual(models["gpt-test"].variants, previous["gpt-test"].variants)
  t.mock.restoreAll()
  t.mock.method(globalThis, "fetch", async () => json({ data: {} }))
  assert.equal(await plugin.provider.models({ models: previous }, { auth: auth() }), previous)
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
  const plugin = await plugins.Sub2apiPlugin({}, { headers: { "User-Agent": "magpie-test", "X-Client": "real-http" } })
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
    assert.equal(call.headers["user-agent"], "magpie-test")
  }
  await assert.rejects(loader.fetch(base + "/v1/redirect"))
  assert.equal(calls.some((c) => c.path === "/v1/target"), false)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(loader.fetch(base + "/v1/responses", { signal: controller.signal }), { name: "AbortError" })
})
