# Repository Guidelines

## Project Structure & Module Organization

This is a dependency-free Magpie provider plugin for Sub2API, using Node.js 20+ and native JavaScript ES modules.

- `index.mjs`: plugin entry point, account authentication, site configuration, request routing, model discovery, and usage conversion.
- `test/plugin.test.mjs`: automated regression tests and loopback HTTP integration coverage.
- `README.md` and `README.en.md`: Chinese and English installation, configuration, and behavior documentation; keep both synchronized when changing user-facing behavior.
- `image.png`: repository image asset; the package's published files are explicitly listed in `package.json`.

Keep internal helpers private: Magpie treats every exported function as a provider plugin. Preserve the pooled provider and eight optional site exports.

## Build, Test, and Development Commands

No dependency installation, compilation, or standalone development server is required.

- `npm run check`: syntax-check `index.mjs`.
- `npm test`: run the suite through Node's built-in test runner.
- `npm pack --dry-run`: inspect the package contents without creating a release archive.
- `npm run hooks:install`: enable the repository's automatic version bump on commits in this clone.
- `magpie plugin add "$PWD"`: register this local directory in an installed Magpie client.
- `magpie plugin login sub2api`: configure an account for manual integration testing.

## Coding Style & Naming Conventions

Match existing `.mjs` files: two-space indentation, double-quoted strings, and no statement-ending semicolons. Use `camelCase` for helpers and variables, uppercase constants, and the established `Sub2apiPlugin` / `Sub2apiSiteN` export names. Prefer native Node and Web APIs over dependencies. No formatter or linter is configured.

## Testing Guidelines

Use `node:test`, `node:assert/strict`, and test-scoped fetch mocks. Add descriptive `test("behavior", ...)` cases in `test/*.test.mjs` for changes, covering failure paths and account isolation alongside success cases. No numeric coverage threshold is configured. Loopback tests may explicitly skip when local listening is prohibited. Live Magpie/Sub2API verification remains separate; never require real credentials in automated tests.

## Commit & Pull Request Guidelines

Use concise Chinese commit subjects describing one focused change. Every commit must increase `package.json`'s version; enable `.githooks/pre-commit` with `npm run hooks:install` before committing. The hook increments the patch version relative to HEAD unless a higher version is already staged, and refuses unstaged package changes. Do not skip the hook or create a separate version-only commit for an ordinary change. Pull requests should explain behavior changes, link relevant issues, list validation commands and results, and update both READMEs where appropriate. Include screenshots only for display changes.

## Security & Configuration

Never commit API keys or sensitive headers. Preserve case-insensitive header precedence (global < site < account), account credential isolation, destination validation, and redirect rejection. Validation errors must not expose header values. Use HTTPS for production sites.
