/**
 * webviewHtml.ts — Webview HTML シェルファイル
 *
 * VS Code の Webview（拡張機能の内側に表示される小さなブラウザ）に渡す
 * HTML/CSS を生成します。
 *
 * 【Webview とは】
 * VS Code では `WebviewPanel` という仕組みで、通常の Web ページと同じように
 * HTML/CSS/JS を使った UI を表示できます。ただし、セキュリティ上の理由で
 * 外部スクリプトの読み込みは禁止されており、すべてのスクリプトは
 * nonce（ワンタイムトークン）付きの <script> タグ内で実行される必要があります。
 * nonce を付与すれば、`src` 属性で読み込む外部ファイルであっても CSP 上
 * 許可されます（許可されるのは nonce の有無であり、読み込み元 URL 自体では
 * ありません）。
 *
 * 【レンダリングロジックについて】
 * 以前はこのファイルの中にレンダリングロジック（JavaScript）を文字列として
 * 直接埋め込んでいましたが、現在は `src/webview/main.ts`（TypeScript）に
 * 分離されています。`main.ts` は esbuild で `out/webview/main.js` に
 * バンドルされ、このファイルが生成する HTML からは nonce 付きの
 * `<script src="...">` として読み込まれるだけです。
 */

import { randomBytes } from 'crypto';

/**
 * セキュリティのための nonce（ワンタイムトークン）を生成します。
 *
 * nonce は Content Security Policy（CSP）でスクリプトを許可するために使います。
 * `Math.random()` は暗号論的に安全な乱数源ではなく予測され得るため、Node の
 * `crypto.randomBytes()`（CSPRNG）で生成した 16 バイトを base64url エンコードして使う。
 * このファイルは拡張機能本体（Node 側）でのみ実行され、Webview バンドルには含まれない。
 */
function getNonce(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Webview に渡す HTML 文字列を生成して返します。
 *
 * @param nonce     CSP 用のワンタイムトークン
 * @param cspSource VS Code が提供する Webview のオリジン文字列（fetch 用）
 * @param scriptUri Webview からアクセス可能な out/webview/main.js の URI（文字列化済み）
 */
export function getWebviewHtml(nonce: string, cspSource: string, scriptUri: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src ${cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Raw Image Viewer</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            font-weight: var(--vscode-font-weight);
            font-size: var(--vscode-font-size);
            padding: 16px;
            min-height: 100vh;
        }
        .center {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 80vh;
            gap: 12px;
        }
        .viewer {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 12px;
        }
        .viewer-header {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            width: 100%;
        }
        .spacer {
            flex: 1;
        }
        .button-group {
            display: flex;
            gap: 4px;
        }
        .info-bar {
            color: var(--vscode-textPreformat-foreground);
            font-size: 13px;
            font-family: var(--vscode-editor-font-family);
        }
        .pixel-info-bar {
            color: var(--vscode-textPreformat-foreground);
            font-size: 13px;
            font-family: var(--vscode-editor-font-family);
            min-height: 1.2em;
        }
        .action-button {
            appearance: none;
            border: 1px solid transparent;
            border-radius: 2px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 13px;
            line-height: 1.2;
            padding: 6px 12px;
        }
        .action-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .action-button.active {
            background: var(--vscode-button-hoverBackground);
            border-color: var(--vscode-focusBorder);
        }
        .action-button:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .colormap-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 8px;
            font-size: 13px;
            cursor: pointer;
            border-radius: 2px;
            outline: none;
            font-family: inherit;
        }
        .colormap-select:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .error-box {
            background: #5a1d1d;
            border: 1px solid #f48771;
            border-radius: 4px;
            padding: 16px 24px;
            max-width: 600px;
        }
        .no-config-box {
            background: #2d2d30;
            border: 1px solid #555;
            border-radius: 6px;
            padding: 20px 28px;
            max-width: 600px;
        }
        .no-config-box h3 { margin-bottom: 12px; color: #e2c08d; }
        .no-config-box p { margin-bottom: 10px; line-height: 1.5; }
        code {
            background: var(--vscode-editor-background);
            padding: 1px 5px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }
        pre {
            background: var(--vscode-editor-background);
            padding: 12px 16px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 10px;
        }
        table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
        th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
        th { color: var(--vscode-textPreformat-foreground); }
        canvas {
            image-rendering: pixelated;
            border: 1px solid var(--vscode-panel-border);
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
            display: block;
        }
        .canvas-viewport {
            overflow: hidden;
            cursor: grab;
            position: relative;
            align-self: stretch;
            height: calc(100vh - 120px);
            min-height: 200px;
            background-color: var(--vscode-editor-background);
            background-image:
                linear-gradient(45deg, rgba(128,128,128,0.1) 25%, transparent 25%),
                linear-gradient(-45deg, rgba(128,128,128,0.1) 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.1) 75%),
                linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.1) 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .canvas-viewport.panning {
            cursor: grabbing;
        }
        .zoom-indicator {
            position: absolute;
            bottom: 8px;
            right: 8px;
            background: rgba(0, 0, 0, 0.6);
            color: var(--vscode-textPreformat-foreground);
            font-size: 11px;
            font-family: var(--vscode-editor-font-family);
            padding: 2px 6px;
            border-radius: 3px;
            pointer-events: none;
            user-select: none;
        }
        .zoom-hint {
            position: absolute;
            bottom: 8px;
            left: 8px;
            background: rgba(0, 0, 0, 0.5);
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            font-family: var(--vscode-editor-font-family);
            padding: 2px 6px;
            border-radius: 3px;
            pointer-events: none;
            user-select: none;
        }
        .window-controls {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            color: #9cdcfe;
            font-family: 'Consolas', 'Courier New', monospace;
            width: 100%;
            max-width: 640px;
        }
        .window-controls label {
            display: flex;
            align-items: center;
            gap: 4px;
            white-space: nowrap;
        }
        .window-controls input[type=range] {
            width: 140px;
            accent-color: #0e639c;
            cursor: pointer;
        }
        .window-controls input[type=range]:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        .window-reset {
            appearance: none;
            background: none;
            border: 1px solid #555;
            border-radius: 4px;
            color: #9cdcfe;
            cursor: pointer;
            font-size: 11px;
            padding: 3px 8px;
        }
        .window-reset:hover { border-color: #9cdcfe; }
        .window-reset:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }
        .spinner {
            width: 40px; height: 40px;
            border: 3px solid #333;
            border-top-color: #9cdcfe;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div id="root" class="center">
        <div class="spinner"></div>
        <p>Loading...</p>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/**
 * getWebviewHtml の nonce を自動生成するラッパーです。
 * 本番コード（extension.ts）から呼び出します。
 *
 * @param cspSource VS Code が提供する Webview のオリジン文字列（fetch 用）
 * @param scriptUri Webview からアクセス可能な out/webview/main.js の URI（文字列化済み）
 */
export function buildWebviewHtml(cspSource: string, scriptUri: string): string {
  return getWebviewHtml(getNonce(), cspSource, scriptUri);
}
