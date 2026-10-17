import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import test from "node:test"
import { Sub2apiPlugin, Sub2apiSite1, Sub2apiSite2 } from "../index.mjs"

const BASE = "https://icons.example.com"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>'
const account = (base = BASE) => ({ type: "api", key: "sk-icon-test", metadata: { baseURL: base, headers: { "X-Account": "private" } } })
const missing = () => new Response(null, { status: 404 })
const image = () => new Response(PNG, { headers: { "content-type": "image/png" } })
const data = (icon) => Buffer.from(icon.split(",")[1], "base64")

function mockSite(t, route) {
  const icons = []
  const api = []
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const call = { url: String(input), ...init }
    if (init?.credentials === "omit") {
      icons.push(call)
      return route(call)
    }
    api.push(call)
    return new Response(JSON.stringify({ data: [{ id: "relay-model" }] }))
  })
  return { icons, api }
}

test("configured sites discover relative HTML icons without leaking any credentials", async (t) => {
  const { icons, api } = mockSite(t, ({ url }) => url.endsWith("/")
    ? new Response(`<head><LINK REL='shortcut ICON' href='assets/mark.svg?size=32&amp;v=&#50;'></head>`)
    : new Response(SVG))
  const plugin = await Sub2apiSite1({}, {
    headers: { "X-Global": "private" },
    sites: [{ id: "work", url: BASE + "/panel/v1/", headers: { "X-Site": "private" } }],
  })
  const cfg = { provider: { work: { name: "Custom" } } }
  await plugin.config(cfg)
  assert.equal(cfg.provider.work.name, "Custom")
  assert.equal(plugin.auth.icon, "data:image/svg+xml;base64," + Buffer.from(SVG).toString("base64"))
  assert.deepEqual(icons.map((c) => c.url), [BASE + "/panel/", BASE + "/panel/assets/mark.svg?size=32&v=2"])
  await plugin.provider.models({ models: {} }, { auth: account() })
  assert.equal(icons.length, 2)
  for (const call of icons) {
    assert.deepEqual(Object.keys(call.headers), ["accept"])
    assert.equal(call.redirect, "error")
    assert.equal(call.credentials, "omit")
    assert.ok(call.signal instanceof AbortSignal)
  }
  assert.equal(new Headers(api[0].headers).get("authorization"), "Bearer sk-icon-test")
  assert.equal(new Headers(api[0].headers).get("x-account"), "private")
})

test("missing pages fall back to favicon.ico and HTTP sites return Magpie-compatible data URIs", async (t) => {
  const base = "http://127.0.0.1:3100/panel"
  const { icons } = mockSite(t, ({ url }) => url === "http://127.0.0.1:3100/favicon.ico" ? image() : missing())
  const plugin = await Sub2apiPlugin({}, { baseUrl: base + "/v1" })
  await plugin.config({})
  assert.deepEqual(icons.map((c) => c.url), [base + "/", base + "/favicon.ico", "http://127.0.0.1:3100/favicon.ico"])
  assert.equal(plugin.auth.icon, "data:image/png;base64," + PNG.toString("base64"))
})

test("inline image links need no image request and ignore comments, scripts and non-icon links", async (t) => {
  const inline = "data:image/svg+xml," + encodeURIComponent(SVG)
  const { icons } = mockSite(t, () => new Response(`<head>
    <!-- <link rel="icon" href="/comment.png"> -->
    <script>const fake = '<link rel="icon" href="/script.png">'</script>
    <link rel="mask-icon" href="/mask.svg">
    <link rel="not-icon" href="/other.svg">
    <link rel="apple-touch-icon-precomposed" href="${inline}">
    </head><link rel="icon" href="/body.png">`))
  const plugin = await Sub2apiPlugin({}, { baseURL: BASE })
  await plugin.config({})
  assert.equal(icons.length, 1)
  assert.equal(data(plugin.auth.icon).toString(), SVG)
})

test("discovery refuses third-party hosts, URL credentials and non-HTTP links", async (t) => {
  const { icons } = mockSite(t, ({ url }) => url.endsWith("/")
    ? new Response(`<head>
      <link rel="icon" href="https://outside.example.com/logo.png">
      <link rel="icon" href="//other.example.com/favicon.ico">
      <link rel="icon" href="https://user:password@icons.example.com/private.png">
      <link rel="icon" href="file:///private/logo.png">
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="http://icons.example.com/logo.png">
      </head>`)
    : image())
  const plugin = await Sub2apiPlugin({}, { url: BASE })
  await plugin.config({})
  assert.deepEqual(icons.map((c) => c.url), [BASE + "/", BASE + "/favicon.ico"])
  assert.deepEqual(data(plugin.auth.icon), PNG)
})

test("redirects and non-image responses fall back without following their targets", async (t) => {
  const { icons } = mockSite(t, ({ url }) => {
    if (url === BASE + "/") return new Response('<link rel=icon href=/redirect><link rel=icon href=/not-image>')
    if (url.endsWith("/redirect")) return new Response(null, { status: 302, headers: { location: "https://outside.example.com/secret" } })
    if (url.endsWith("/not-image")) return new Response("<html>not a picture</html>", { headers: { "content-type": "image/png" } })
    return image()
  })
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.deepEqual(icons.map((c) => c.url), [BASE + "/", BASE + "/redirect", BASE + "/not-image", BASE + "/favicon.ico"])
  assert.deepEqual(data(plugin.auth.icon), PNG)
})

test("oversized declared and streamed images are cancelled before trying the fallback", async (t) => {
  for (const declared of [true, false]) {
    await t.test(declared ? "content-length" : "streamed body", async (t) => {
      let cancelled = false
      mockSite(t, ({ url }) => {
        if (url.endsWith("/")) return new Response('<link rel=icon href=/large.png>')
        if (url.endsWith("/large.png")) return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array((1 << 20) + 1)) },
          cancel() { cancelled = true },
        }), { headers: declared ? { "content-length": String((1 << 20) + 1) } : {} })
        return image()
      })
      const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
      await plugin.config({})
      assert.equal(cancelled, true)
      assert.deepEqual(data(plugin.auth.icon), PNG)
    })
  }
})

test("oversized home pages are cancelled and do not prevent favicon fallback", async (t) => {
  let cancelled = false
  mockSite(t, ({ url }) => url.endsWith("/") ? new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array((512 << 10) + 1)) },
    cancel() { cancelled = true },
  })) : image())
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.equal(cancelled, true)
  assert.deepEqual(data(plugin.auth.icon), PNG)
})

test("duplicate links and long candidate lists bound the number of requests", async (t) => {
  const { icons } = mockSite(t, ({ url }) => url.endsWith("/")
    ? new Response('<link rel=icon href=/duplicate>'.repeat(2) + Array.from({ length: 50 }, (_, i) => `<link rel=icon href=/icon${i}>`).join(""))
    : url.endsWith("/favicon.ico") ? image() : missing())
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.equal(icons.filter((c) => c.url.endsWith("/duplicate")).length, 1)
  assert.ok(icons.length <= 10)
  assert.deepEqual(data(plugin.auth.icon), PNG)
})

test("concurrent config and model loading share one cached icon lookup", async (t) => {
  const { icons } = mockSite(t, ({ url }) => url.endsWith("/") ? missing() : image())
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await Promise.all([plugin.config({}), plugin.config({}), plugin.provider.models({ models: {} }, { auth: account() })])
  await plugin.config({})
  await plugin.provider.models({ models: {} }, { auth: account() })
  assert.deepEqual(icons.map((c) => c.url), [BASE + "/", BASE + "/favicon.ico"])
})

test("failed lookups retry after five minutes; successful lookups cache for one hour", async (t) => {
  let now = 0
  let available = false
  t.mock.method(Date, "now", () => now)
  const { icons } = mockSite(t, ({ url }) => available && url.endsWith("/favicon.ico") ? image() : missing())
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.equal(plugin.auth.icon, undefined)
  available = true
  await plugin.config({})
  assert.equal(icons.length, 2)
  now += 5 * 60 * 1000
  await plugin.config({})
  assert.deepEqual(data(plugin.auth.icon), PNG)
  const count = icons.length
  now += 60 * 60 * 1000 - 1
  await plugin.config({})
  assert.equal(icons.length, count)
  available = false
  now++
  await plugin.config({})
  assert.ok(icons.length > count)
  assert.deepEqual(data(plugin.auth.icon), PNG)
})

test("the pooled provider uses its first loaded account, not the default or later accounts", async (t) => {
  const saved = "https://saved.example.com"
  const { icons } = mockSite(t, ({ url }) => url.endsWith("/") ? missing() : url.startsWith(saved) ? image() : new Response(SVG))
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.equal(data(plugin.auth.icon).toString(), SVG)
  await plugin.provider.models({ models: {} }, { auth: account(saved) })
  await plugin.provider.models({ models: {} }, { auth: account("https://second.example.com") })
  await plugin.config({})
  assert.deepEqual(data(plugin.auth.icon), PNG)
  assert.deepEqual([...new Set(icons.map((c) => new URL(c.url).origin))], [BASE, saved])
})

test("site and pooled provider icons remain isolated", async (t) => {
  mockSite(t, ({ url }) => url.endsWith("/") ? missing() : url.startsWith(BASE) ? image() : new Response(SVG))
  const options = { sites: [{ id: "first", url: BASE }, { id: "second", url: "https://second.example.com" }] }
  const first = await Sub2apiSite1({}, options)
  const second = await Sub2apiSite2({}, options)
  const pooled = await Sub2apiPlugin({}, options)
  await first.config({})
  await second.config({})
  await pooled.config({})
  assert.deepEqual(data(first.auth.icon), PNG)
  assert.equal(data(second.auth.icon).toString(), SVG)
  assert.equal(pooled.auth.icon, undefined)
  await first.provider.models({ models: {} }, { auth: account("https://different.example.com") })
  assert.deepEqual(data(first.auth.icon), PNG)
})

test("icon failures do not prevent discovery and invalid auth cannot inherit a model list", async (t) => {
  const { icons } = mockSite(t, () => { throw new Error("unavailable") })
  const plugin = await Sub2apiPlugin()
  const previous = { previous: {} }
  assert.deepEqual(await plugin.provider.models({ models: previous }), {})
  assert.equal(icons.length, 0)
  const models = await plugin.provider.models({ models: {} }, { auth: account() })
  assert.ok(models["relay-model"])
  assert.equal(plugin.auth.icon, undefined)
  assert.equal(icons.length, 2)
})

test("a timed-out lookup stops candidates and leaves the icon unset", async (t) => {
  const controller = new AbortController()
  t.mock.method(AbortSignal, "timeout", (ms) => { assert.equal(ms, 3000); return controller.signal })
  const { icons } = mockSite(t, ({ signal }) => {
    controller.abort()
    signal.throwIfAborted()
  })
  const plugin = await Sub2apiPlugin({}, { baseUrl: BASE })
  await plugin.config({})
  assert.equal(icons.length, 1)
  assert.equal(plugin.auth.icon, undefined)
})

test("real HTTP icon discovery keeps API credentials off public requests and refuses redirects", async (t) => {
  const calls = []
  const server = createServer((req, res) => {
    calls.push({ path: req.url, headers: req.headers })
    if (req.url === "/panel/") res.end('<link rel=icon href="/redirect">')
    else if (req.url === "/redirect") res.writeHead(302, { location: "/should-not-be-fetched" }).end()
    else if (req.url === "/panel/favicon.ico") res.end(PNG)
    else if (req.url === "/panel/v1/models") res.end('{"data":[{"id":"relay-model"}]}')
    else res.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1")
  try {
    await once(server, "listening")
  } catch (e) {
    if (!["EPERM", "EACCES"].includes(e.code)) throw e
    t.skip("This environment does not allow listening on a local TCP port")
    return
  }
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${server.address().port}/panel`
  const plugin = await Sub2apiPlugin({}, { headers: { "X-Global": "private" } })
  const models = await plugin.provider.models({ models: {} }, { auth: account(base) })
  assert.ok(models["relay-model"])
  await plugin.config({})
  assert.deepEqual(data(plugin.auth.icon), PNG)
  assert.equal(calls.some((c) => c.path === "/should-not-be-fetched"), false)
  for (const call of calls.filter((c) => !c.path.includes("/v1/") && !c.path.includes("/backend-api/"))) {
    for (const name of ["authorization", "cookie", "x-global", "x-account"]) assert.equal(call.headers[name], undefined)
  }
  assert.equal(calls.find((c) => c.path === "/panel/v1/models").headers.authorization, "Bearer sk-icon-test")
})
