import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "sub2api-version-"))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  env.GIT_CONFIG_NOSYSTEM = "1"
  env.GIT_CONFIG_GLOBAL = "/dev/null"
  const run = (command, ...args) => {
    const result = spawnSync(command, args, { cwd, env, encoding: "utf8" })
    if (result.error) throw result.error
    return result
  }
  const git = (...args) => {
    const result = run("git", ...args)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const file = join(cwd, "package.json")
  const writePackage = (version = "0.4.1", extra = {}) => writeFileSync(file, JSON.stringify({ name: "version-fixture", version, ...extra }, null, 2) + "\n")
  git("init", "-q")
  git("config", "user.name", "Version Test")
  git("config", "user.email", "test@example.com")
  git("config", "commit.gpgsign", "false")
  git("config", "core.autocrlf", "false")
  mkdirSync(join(cwd, ".githooks"))
  mkdirSync(join(cwd, "scripts"))
  copyFileSync(new URL("../.githooks/pre-commit", import.meta.url), join(cwd, ".githooks/pre-commit"))
  chmodSync(join(cwd, ".githooks/pre-commit"), 0o755)
  copyFileSync(new URL("../scripts/bump-version.mjs", import.meta.url), join(cwd, "scripts/bump-version.mjs"))
  writePackage()
  git("add", ".")
  git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Initial fixture")
  git("config", "core.hooksPath", ".githooks")
  const change = () => {
    writeFileSync(join(cwd, "change.txt"), Math.random().toString())
    git("add", "change.txt")
  }
  const headVersion = () => JSON.parse(git("show", "HEAD:package.json")).version
  const working = () => JSON.parse(readFileSync(file, "utf8"))
  return { cwd, run, git, writePackage, change, headVersion, working }
}

test("the installed commit hook increments patch versions in each original commit", (t) => {
  const repo = repository(t)
  for (const version of ["0.4.2", "0.4.3"]) {
    repo.change()
    repo.git("commit", "-qm", "Change fixture")
    assert.equal(repo.headVersion(), version)
    assert.equal(repo.working().version, version)
    assert.equal(repo.git("status", "--porcelain"), "")
  }
  assert.equal(repo.git("rev-list", "--count", "HEAD"), "3")
})

test("rerunning the hook before a successful commit does not repeatedly bump the staged version", (t) => {
  const repo = repository(t)
  repo.change()
  for (let i = 0; i < 2; i++) {
    assert.equal(repo.run(process.execPath, "scripts/bump-version.mjs").status, 0)
    assert.equal(repo.working().version, "0.4.2")
  }
  repo.git("commit", "-qm", "Commit after retry")
  assert.equal(repo.headVersion(), "0.4.2")
})

test("manual higher release versions and staged package changes survive the hook", (t) => {
  const repo = repository(t)
  repo.writePackage("0.5.0", { description: "Intended staged change" })
  repo.git("add", "package.json")
  repo.git("commit", "-qm", "Manual release")
  assert.equal(repo.headVersion(), "0.5.0")
  assert.equal(repo.working().description, "Intended staged change")
  repo.change()
  repo.git("commit", "-qm", "Next patch")
  assert.equal(repo.headVersion(), "0.5.1")
})

test("an accidentally staged older version cannot lower the next committed version", (t) => {
  const repo = repository(t)
  repo.writePackage("0.1.0")
  repo.git("add", "package.json")
  repo.git("commit", "-qm", "Prevent version downgrade")
  assert.equal(repo.headVersion(), "0.4.2")
})

test("unstaged and partially staged package changes block the commit without staging private edits", (t) => {
  const repo = repository(t)
  repo.change()
  repo.writePackage("0.4.1", { description: "Staged change" })
  repo.git("add", "package.json")
  const staged = repo.git("show", ":package.json")
  repo.writePackage("0.4.1", { description: "Unstaged change" })
  const result = repo.run("git", "commit", "-qm", "Must not commit")
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Stage all intended package.json changes/)
  assert.equal(repo.headVersion(), "0.4.1")
  assert.equal(repo.git("show", ":package.json"), staged)
  assert.equal(repo.working().description, "Unstaged change")
  assert.equal(repo.git("rev-list", "--count", "HEAD"), "1")
})

test("unrelated unstaged files remain out of automatically versioned commits", (t) => {
  const repo = repository(t)
  repo.change()
  writeFileSync(join(repo.cwd, "private.txt"), "not intended for this commit")
  repo.git("commit", "-qm", "Keep unrelated file out")
  assert.equal(repo.headVersion(), "0.4.2")
  assert.equal(repo.git("ls-tree", "--name-only", "HEAD", "private.txt"), "")
  assert.match(repo.git("status", "--porcelain"), /\?\? private.txt/)
})

test("unsupported or unsafe version formats abort instead of inventing a release number", (t) => {
  const repo = repository(t)
  for (const version of ["0.4.2-beta.1", "04.1.0", "0.4", "1.0.9007199254740992"]) {
    repo.writePackage(version)
    repo.git("add", "package.json")
    const result = repo.run("git", "commit", "-qm", "Invalid version")
    assert.notEqual(result.status, 0)
    assert.equal(repo.headVersion(), "0.4.1")
    assert.equal(repo.working().version, version)
  }
})
