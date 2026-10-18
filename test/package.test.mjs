import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

test("package metadata exposes the bundled Sub2API icon", () => {
  assert.equal(PACKAGE.author, undefined)
  assert.match(PACKAGE.magpie.icon, /^(?:https:\/\/|data:image\/)/i)
  assert.ok(Buffer.byteLength(PACKAGE.magpie.icon) <= 1024 * 1024)
  assert.ok(PACKAGE.files.includes("image.png"))
  assert.ok(existsSync(join(ROOT, "image.png")))
})

test("the published MIT license uses the project contributor attribution", () => {
  const license = readFileSync(join(ROOT, "LICENSE"), "utf8")
  assert.ok(PACKAGE.files.includes("LICENSE"))
  assert.equal(PACKAGE.license, "MIT")
  assert.equal(license.split("\n")[2], "Copyright (c) 2026 sub2api-magpie-plugin contributors")
  assert.match(license, /The above copyright notice and this permission notice shall be included/)
})
