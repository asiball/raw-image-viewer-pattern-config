# Copilot Instructions

## Build, Lint, and Test

```bash
npm run compile      # TypeScript compile (tsc)
npm run lint         # ESLint on src/
npm run watch        # TypeScript watch mode
npm test             # Full suite: compile + lint + vscode-test (requires Electron)
```

There is no way to run a single test in isolation — the test runner (`@vscode/test-cli`) runs all files matching `out/test/**/*.test.js`. Before submitting, always run `npm run lint && npm run compile`.

## Architecture

This is a single-file VS Code extension (`src/extension.ts`) with no external runtime dependencies.

**Data flow:**

1. `RawImageEditorProvider` (implements `CustomReadonlyEditorProvider`) opens a file and creates a `WebviewPanel`.
2. The webview HTML — including all rendering logic — is generated inline by `getWebviewHtml()` as a template string. There are no separate HTML/CSS/JS asset files.
3. The extension reads the `.rawimagerc` config via `findConfigPath()` (walks up the directory tree from the file's location, like `.editorconfig`), then sends a `render` message to the webview via `postMessage`.
4. The webview uses `fetch()` on the VS Code webview URI to load the binary file, then renders pixels onto an HTML5 `<canvas>` using the format specified in the config.

**Message protocol (extension ↔ webview):**

- Webview → extension: `{ type: 'ready' }` (sent on interval until acknowledged)
- Extension → webview: `{ type: 'render', config, fileUri, fileSize }` or `{ type: 'error', message }`

**Startup timing:** The extension sets a 300 ms fallback timer to send `render` even if the `ready` handshake never arrives, and a 5 s timer to show a warning if no `ready` was received.

## Spec-Driven Workflow

- Read `docs/basic-design.md` first, then any more detailed design docs under `docs/` before changing behavior.
- Treat the docs as the source of truth for implementation details; update the docs before code when behavior changes.
- If a task is ambiguous or would change user-visible behavior, ask for clarification before coding.
- Prefer adding or updating a design doc before making code changes that touch architecture, messages, file formats, or Webview behavior.
- Keep implementation aligned with the documented flow, message schema, and constraints; do not invent new behavior silently.

## Key Conventions

- **Webview JS is intentionally vanilla JavaScript** (not TypeScript). It lives as a string inside `getWebviewHtml()` and cannot be compiled or linted with the rest of the codebase.
- **CSP is strict:** `script-src 'nonce-...'` only. All inline scripts must use the nonce. No external scripts allowed.
- **`localResourceRoots`** is set to only the directory containing the opened file — the webview can only fetch that file.
- TypeScript **strict mode** is enabled. All code must compile cleanly with `tsc`.
- ESLint enforces: `curly`, `eqeqeq`, `semi`, `no-throw-literal`, and `@typescript-eslint/naming-convention` (imports must be camelCase or PascalCase).
- Supported pixel formats are defined entirely in the webview switch statement in `getWebviewHtml()`. Adding a new format requires updating both the switch and the help table shown when no config is found.

## Branch and PR Conventions

Branch prefixes: `feature/`, `fix/`, `copilot/`, `docs/`, `refactor/`

PR title prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

Direct pushes to `main` are not allowed. CI runs `npm run lint` and `npm run compile` on all PRs and pushes.

**If you modify code, create a local branch before making or finalizing the change.** Use the branch prefixes above, and use `copilot/` for AI-agent work.

**Do not stop at local code changes.** If an AI agent changed code, it must continue through the normal flow: local branch -> commit(s) -> push branch -> open a Pull Request targeting `main`.

**After pushing a branch, always open a Pull Request targeting `main`.** Include a clear description of what was changed and why. Follow the PR template checklist in `.github/PULL_REQUEST_TEMPLATE.md`.

## Issue Priority Conventions

When creating or triaging an issue, always assign exactly one priority label:

- `priority: critical`
- `priority: high`
- `priority: medium`
- `priority: low`

AI agents must add one of these priority labels when they create a new issue. Do not leave AI-created issues without a priority label.

## Release Versioning Conventions

- Treat the release version as a single value that must match across `package.json`, `package-lock.json`, `CHANGELOG.md`, the Git tag (`v<version>`), and the packaged VSIX filename.
- Before cutting a release tag, update the versioned metadata in the same branch/PR. Do not rely on the Git tag alone.
- Run `npm run validate:release` before tagging. In CI, the release workflow will fail if the release tag does not match `package.json` or if the matching `CHANGELOG.md` section is missing.
- Using a GitHub milestone or project for the target release is recommended for planning, but it does not replace the version checks above.
