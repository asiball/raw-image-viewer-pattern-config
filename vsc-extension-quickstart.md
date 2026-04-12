# Raw Image Viewer — Developer Quick-Start

## What's in the folder

| Path | Purpose |
|---|---|
| `src/extension.ts` | All extension logic — editor provider, config parsing, webview HTML/JS |
| `schemas/rawimagerc.schema.json` | JSON Schema contributed for `.rawimagerc` IntelliSense |
| `test-data/` | Sample raw binary files used by the integration tests |
| `package.json` | Extension manifest — commands, menus, settings, JSON validation, scripts |
| `.github/workflows/ci.yml` | CI: lint + compile on push / PR |
| `.github/workflows/build-vsix.yml` | Build and upload a `.vsix` artifact |
| `.github/workflows/release.yml` | Create a GitHub Release with the `.vsix` on `v*` tag push |

## Get up and running

1. Run `npm install` to install all dev dependencies.
2. Press **F5** to open a new VS Code window with the extension loaded.
3. Open any `.raw`, `.bin`, `.data`, `.img`, `.gray`, or `.yuv` file — it will render as an image if a `.rawimagerc` is present.
4. For any other file, right-click it in the Explorer and choose **Open as Raw Image**.

## Build & validate

```bash
npm run compile   # TypeScript → out/
npm run lint      # ESLint on src/
npm test          # compile + lint + vscode-test (requires Electron display)
```

CI only runs `lint` and `compile` (no Electron), so those two must pass on every branch.

## Make changes

- Edit `src/extension.ts`.
- Reload the extension host with **Ctrl+R** / **Cmd+R** in the debug window after each change.
- The webview JavaScript lives as a template string inside `getWebviewHtml()` — it is **vanilla JS**, not TypeScript, and is not compiled separately.
- Webview functions (`decodeRawImageToRgba`, `getBytesPerPixel`, etc.) are shared with the host via `.toString()` injection, so changes there affect both the host-side tests and the webview.

## Adding a new pixel format

1. Add the format string to `supportedFormats` (and `streamDecodableFormats` if it is stream-decodable) in `extension.ts`.
2. Add a `case` branch in `decodeRawPixel` (for stream-decodable formats) and in `decodeRawImageToRgba`.
3. Add a row to the help table inside `getWebviewHtml()`.
4. Add the format to the `enum` in `schemas/rawimagerc.schema.json` and in the `rawviewer.defaultFormat` setting in `package.json`.

## Explore the VS Code API

Open `node_modules/@types/vscode/index.d.ts` for the full type definitions, or visit <https://code.visualstudio.com/api>.
