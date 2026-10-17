import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" })
  if (result.error) throw result.error
  return result
}

function required(...args) {
  const result = git(...args)
  if (result.status !== 0) throw new Error("Git version update failed: " + args[0])
  return result.stdout
}

function version(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error("Automatic versioning requires a stable major.minor.patch version")
  }
  const parts = value.split(".").map(Number)
  if (!parts.every(Number.isSafeInteger)) throw new Error("Package version is too large")
  return parts
}

try {
  process.chdir(required("rev-parse", "--show-toplevel").trim())
  // Never stage unrelated package changes or flatten a partially staged file.
  const unstaged = git("diff", "--quiet", "--", "package.json")
  if (unstaged.status !== 0) throw new Error("Stage all intended package.json changes before committing")
  const staged = required("show", ":package.json")
  if (readFileSync("package.json", "utf8") !== staged) throw new Error("package.json differs from the index; stage it before committing")
  const pkg = JSON.parse(staged)
  const current = version(pkg.version)
  let next = current
  if (git("rev-parse", "--verify", "HEAD").status === 0) {
    const previous = version(JSON.parse(required("show", "HEAD:package.json")).version)
    const difference = current.findIndex((part, i) => part !== previous[i])
    if (difference === -1 || current[difference] < previous[difference]) {
      next = [previous[0], previous[1], previous[2] + 1]
      if (!Number.isSafeInteger(next[2])) throw new Error("Package patch version is too large")
    }
  }
  const target = next.join(".")
  if (target !== pkg.version) {
    pkg.version = target
    writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n")
    required("add", "--", "package.json")
  }
  console.log("sub2api-magpie-plugin: commit version " + target)
} catch (error) {
  console.error("sub2api-magpie-plugin: " + error.message)
  process.exitCode = 1
}
