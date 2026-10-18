import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

test("package metadata exposes the bundled Sub2API icon", () => {
  assert.equal(PACKAGE.author, undefined)
  assert.equal(PACKAGE.magpie.icon, "./image.png")
  assert.ok(PACKAGE.files.includes("image.png"))
  assert.ok(existsSync(join(ROOT, "image.png")))
})
