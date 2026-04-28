/**
 * webviewHtml.ts — Webview HTML テンプレートファイル
 *
 * VS Code の Webview（拡張機能の内側に表示される小さなブラウザ）に渡す
 * HTML/CSS/JavaScript を生成します。
 *
 * 【Webview とは】
 * VS Code では `WebviewPanel` という仕組みで、通常の Web ページと同じように
 * HTML/CSS/JS を使った UI を表示できます。ただし、セキュリティ上の理由で
 * 外部スクリプトの読み込みは禁止されており、すべてのスクリプトは
 * nonce（ワンタイムトークン）付きの <script> タグ内に書く必要があります。
 *
 * 【関数の埋め込みについて】
 * decoder.ts の関数は `.toString()` を使って JavaScript の文字列に変換し、
 * HTML テンプレートに直接埋め込みます。これにより TypeScript で書いた
 * デコードロジックを Webview のブラウザ環境でも同じコードで動かせます。
 */

import {
  appendFloat32Chunk,
  appendGrayChunk,
  appendRawImageChunk,
  applyWindowLevel,
  createFloat32DecodeState,
  createGrayDecodeState,
  createRawImageDecodeState,
  decodeRawImageToRgba,
  decodeRawPixel,
  getBytesPerPixel,
} from './decoder';
import { grayscaleStreamFormats, streamDecodableFormats } from './types';

/**
 * セキュリティのための nonce（ワンタイムトークン）を生成します。
 *
 * nonce は Content Security Policy（CSP）でスクリプトを許可するために使います。
 * 毎回ランダムな文字列を生成することで、ページごとに異なるトークンになります。
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * Webview に渡す HTML 文字列を生成して返します。
 *
 * @param nonce     CSP 用のワンタイムトークン
 * @param cspSource VS Code が提供する Webview のオリジン文字列（fetch 用）
 */
export function getWebviewHtml(nonce: string, cspSource: string): string {
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
    <script nonce="${nonce}">
        // VS Code の Webview API（postMessage などの通信に使う）
        const vscode = acquireVsCodeApi();

        // decoder.ts の関数を .toString() で文字列化してここに埋め込む。
        // こうすることで TypeScript のコードをブラウザ環境でも動かせる。
        const decodeRawImageToRgba = ${decodeRawImageToRgba.toString()};
        const streamDecodableFormats = new Set(${JSON.stringify(streamDecodableFormats)});
        const grayscaleStreamFormats = new Set(${JSON.stringify(grayscaleStreamFormats)});

        // 以下の関数は decodeRawImageToRgba 内や他の関数から参照されるため
        // グローバルスコープに展開する
        ${getBytesPerPixel.toString()}
        ${createRawImageDecodeState.toString()}
        ${decodeRawPixel.toString()}
        ${appendRawImageChunk.toString()}
        ${createGrayDecodeState.toString()}
        ${appendGrayChunk.toString()}
        ${applyWindowLevel.toString()}
        ${createFloat32DecodeState.toString()}
        ${appendFloat32Chunk.toString()}

        // --- 状態変数 ---
        var readyTimer = null;         // Extension への ready 送信インターバル
        var startupTimeout = null;     // タイムアウト表示用タイマー
        var activeAbortController = null; // fetch のキャンセル用
        var activeRenderId = 0;        // 最新のレンダリング ID（古いレンダリングを無視するため）
        var activeResizeObserver = null; // ResizeObserver の参照（再レンダリング時に解放するため）

        // --- ユーティリティ ---

        function clearReadyTimer() {
            if (readyTimer) {
                clearInterval(readyTimer);
                readyTimer = null;
            }
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }
        }

        // HTML を安全に表示するためにエスケープする（XSS 対策）
        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        function showRuntimeError(err) {
            var root = document.getElementById('root');
            if (!root) {
                return;
            }
            root.className = 'center';
            root.innerHTML = '<div class="error-box"><strong>Webview Error:</strong> ' + escapeHtml(String(err)) + '</div>';
        }

        // --- メッセージハンドラ（Extension からのメッセージを受け取る）---

        window.addEventListener('message', function(event) {
            var msg = event.data;
            var root = document.getElementById('root');

            if (msg.type === 'error') {
                clearReadyTimer();
                root.className = 'center';
                root.innerHTML = '<div class="error-box"><strong>Error:</strong> ' + escapeHtml(msg.message) + '</div>';
                return;
            }

            if (msg.type === 'render') {
                clearReadyTimer();
                var config = msg.config;
                var configSource = msg.configSource;
                var fileUri = msg.fileUri;
                var fileSize = msg.fileSize;

                // 設定が見つからない場合はヘルプ画面を表示する
                if (!config) {
                    root.className = 'center';
                    root.innerHTML =
                        '<div class="no-config-box">' +
                        '<h3>⚙ No .rawimagerc configuration found</h3>' +
                        '<p>Create a <code>.rawimagerc</code> file in the same directory as the file, or any parent directory, to configure how to render this binary file as an image.</p>' +
                        '<p>Alternatively, set workspace defaults such as <code>rawviewer.defaultWidth</code> and <code>rawviewer.defaultHeight</code>, or include metadata in the filename like <code>frame_1920x1080_rgb24.raw</code>.</p>' +
                        '<pre>{\\n  "patterns": {\\n    "*": {\\n      "width": 640,\\n      "height": 480,\\n      "headerSize": 0,\\n      "format": "rgb24"\\n    }\\n  }\\n}</pre>' +
                        '<p>Supported formats:</p>' +
                        '<table>' +
                        '<tr><th>Format</th><th>Description</th><th>Bytes/pixel</th></tr>' +
                        '<tr><td><code>gray8</code></td><td>8-bit grayscale</td><td>1</td></tr>' +
                        '<tr><td><code>gray16le</code></td><td>16-bit grayscale (little-endian)</td><td>2</td></tr>' +
                        '<tr><td><code>gray16be</code></td><td>16-bit grayscale (big-endian)</td><td>2</td></tr>' +
                        '<tr><td><code>rgb24</code></td><td>24-bit RGB</td><td>3</td></tr>' +
                        '<tr><td><code>bgr24</code></td><td>24-bit BGR</td><td>3</td></tr>' +
                        '<tr><td><code>rgba32</code></td><td>32-bit RGBA</td><td>4</td></tr>' +
                        '<tr><td><code>bgra32</code></td><td>32-bit BGRA</td><td>4</td></tr>' +
                        '<tr><td><code>yuv420p</code></td><td>Planar YUV 4:2:0</td><td>1.5</td></tr>' +
                        '<tr><td><code>nv12</code></td><td>Semi-planar YUV 4:2:0</td><td>1.5</td></tr>' +
                        '<tr><td><code>yuyv422</code></td><td>Packed YUV 4:2:2</td><td>2</td></tr>' +
                        '<tr><td><code>float32</code></td><td>32-bit float grayscale</td><td>4</td></tr>' +
                        '<tr><td><code>depth16</code></td><td>16-bit depth (little-endian)</td><td>2</td></tr>' +
                        '</table>' +
                        '</div>';
                    return;
                }

                var width = config.width;
                var height = config.height;
                var headerSize = config.headerSize || 0;
                var format = config.format || 'rgb24';

                if (!fileUri) {
                    root.className = 'center';
                    root.innerHTML = '<div class="error-box"><strong>Error:</strong> Missing file URI for webview fetch.</div>';
                    return;
                }

                // 既存のフェッチをキャンセルして新しいレンダリングを開始する
                if (activeAbortController) {
                    activeAbortController.abort();
                }
                if (activeResizeObserver) {
                    activeResizeObserver.disconnect();
                    activeResizeObserver = null;
                }

                activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;
                var currentRenderId = ++activeRenderId;
                var shouldStreamDecode = streamDecodableFormats.has(format);

                root.className = 'center';
                root.innerHTML = '<div class="spinner"></div><p>Loading...</p>';

                // VS Code の Webview URI スキームを使ってファイルを fetch する
                fetch(fileUri, activeAbortController ? { signal: activeAbortController.signal } : undefined)
                    .then(async function(response) {
                        if (!response.ok) {
                            throw new Error('Failed to read file in webview: HTTP ' + response.status);
                        }

                        // Canvas を作成してデコードしたピクセルを書き込む準備をする
                        var canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;

                        var ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error('2D canvas context is not available.');
                        }
                        var imageData = ctx.createImageData(width, height);
                        var pixels = imageData.data;

                        var isGrayscale = grayscaleStreamFormats.has(format);
                        var isFloat32 = (format === 'float32');
                        var rawGray = null;        // ウィンドウ調整用の生グレー値
                        var grayMinValue = 0;
                        var grayMaxValue = 255;
                        var grayWindowMin = 0;
                        var grayWindowMax = 255;
                        var isFloatGray = false;

                        // --- フォーマット別デコード処理 ---

                        if (isGrayscale) {
                            // グレースケール: ストリーミングで rawGray に書き込み後、ウィンドウ適用
                            var grayState = createGrayDecodeState(width, height, headerSize, format);
                            if (response.body && typeof response.body.getReader === 'function') {
                                var grayReader = response.body.getReader();
                                try {
                                    while (grayState.pixelsWritten < grayState.totalPixels) {
                                        var grayStep = await grayReader.read();
                                        if (grayStep.done) { break; }
                                        if (grayStep.value) { appendGrayChunk(grayState, grayStep.value); }
                                    }
                                    if (grayState.pixelsWritten >= grayState.totalPixels && typeof grayReader.cancel === 'function') {
                                        await grayReader.cancel();
                                    }
                                } finally {
                                    grayReader.releaseLock();
                                }
                            } else {
                                var rawBuf = new Uint8Array(await response.arrayBuffer());
                                appendGrayChunk(grayState, rawBuf);
                            }
                            rawGray = grayState.rawGray;
                            grayMaxValue = grayState.maxValue;
                            var autoMin = grayState.autoMin;
                            var autoMax = grayState.autoMax;
                            if (autoMin >= autoMax) { autoMin = 0; autoMax = grayMaxValue; }
                            grayWindowMin = autoMin;
                            grayWindowMax = autoMax;
                            applyWindowLevel(rawGray, width * height, grayWindowMin, grayWindowMax, pixels);
                        } else if (isFloat32) {
                            // float32: ストリーミングで rawGrayF32 に書き込み後、ウィンドウ適用
                            var f32State = createFloat32DecodeState(width, height, headerSize);
                            if (response.body && typeof response.body.getReader === 'function') {
                                var f32Reader = response.body.getReader();
                                try {
                                    while (f32State.pixelsWritten < f32State.totalPixels) {
                                        var f32Step = await f32Reader.read();
                                        if (f32Step.done) { break; }
                                        if (f32Step.value) { appendFloat32Chunk(f32State, f32Step.value); }
                                    }
                                    if (f32State.pixelsWritten >= f32State.totalPixels && typeof f32Reader.cancel === 'function') {
                                        await f32Reader.cancel();
                                    }
                                } finally {
                                    f32Reader.releaseLock();
                                }
                            } else {
                                var f32Buf = new Uint8Array(await response.arrayBuffer());
                                appendFloat32Chunk(f32State, f32Buf);
                            }
                            rawGray = f32State.rawGrayF32;
                            isFloatGray = true;
                            var f32AutoMin = f32State.autoMin;
                            var f32AutoMax = f32State.autoMax;
                            if (!isFinite(f32AutoMin) || !isFinite(f32AutoMax) || f32AutoMin >= f32AutoMax) {
                                f32AutoMin = 0; f32AutoMax = 1;
                            }
                            grayMinValue = f32AutoMin;
                            grayMaxValue = f32AutoMax;
                            grayWindowMin = f32AutoMin;
                            grayWindowMax = f32AutoMax;
                            applyWindowLevel(rawGray, width * height, grayWindowMin, grayWindowMax, pixels);
                        } else if (response.body && typeof response.body.getReader === 'function' && shouldStreamDecode) {
                            // RGB/BGR 系: ストリーミングで直接 pixels に書き込む
                            var reader = response.body.getReader();
                            var decodeState = createRawImageDecodeState(width, height, headerSize, format);
                            try {
                                while (decodeState.pixelsWritten < decodeState.totalPixels) {
                                    var step = await reader.read();
                                    if (step.done) {
                                        break;
                                    }
                                    if (step.value) {
                                        appendRawImageChunk(decodeState, step.value, pixels);
                                    }
                                }
                                if (decodeState.pixelsWritten >= decodeState.totalPixels && typeof reader.cancel === 'function') {
                                    await reader.cancel();
                                }
                            } finally {
                                reader.releaseLock();
                            }
                        } else {
                            // YUV 系など: 全バイトを一括でデコードする
                            var rawBytes = new Uint8Array(await response.arrayBuffer());
                            imageData.data.set(decodeRawImageToRgba(rawBytes.subarray(headerSize), width, height, format));
                        }

                        // レンダリング中に新しいレンダリングが始まった場合は破棄する
                        if (currentRenderId !== activeRenderId) {
                            return;
                        }

                        ctx.putImageData(imageData, 0, 0);

                        // --- UI の構築 ---

                        root.className = 'viewer';
                        root.innerHTML = '';

                        var viewerHeader = document.createElement('div');
                        viewerHeader.className = 'viewer-header';

                        // 画像情報バー（幅・高さ・フォーマット・ファイルサイズなど）
                        var infoBar = document.createElement('div');
                        infoBar.className = 'info-bar';
                        infoBar.textContent =
                            width +
                            ' \xd7 ' +
                            height +
                            ' | ' +
                            format +
                            ' | header: ' +
                            headerSize +
                            ' B | file: ' +
                            fileSize +
                            ' B | source: ' +
                            (configSource || '.rawimagerc');

                        var exportButton = document.createElement('button');
                        exportButton.type = 'button';
                        exportButton.className = 'action-button';
                        exportButton.textContent = 'Export PNG';
                        exportButton.addEventListener('click', function() {
                            // Canvas の内容を PNG として Extension に送信する
                            vscode.postMessage({ type: 'savePng', dataUrl: canvas.toDataURL('image/png') });
                        });

                        var fitButton = document.createElement('button');
                        fitButton.type = 'button';
                        fitButton.className = 'action-button active';
                        fitButton.textContent = 'Fit';

                        var zoom1to1Button = document.createElement('button');
                        zoom1to1Button.type = 'button';
                        zoom1to1Button.className = 'action-button';
                        zoom1to1Button.textContent = '1:1';

                        // ズーム・パン用のビューポート
                        var viewport = document.createElement('div');
                        viewport.className = 'canvas-viewport';

                        var zoomIndicator = document.createElement('div');
                        zoomIndicator.className = 'zoom-indicator';
                        zoomIndicator.textContent = '100%';

                        var zoomHint = document.createElement('div');
                        zoomHint.className = 'zoom-hint';
                        zoomHint.textContent = 'Ctrl+Scroll: zoom · Drag: pan · Dbl-click: fit';

                        canvas.style.transformOrigin = '0 0';

                        // ズーム・パンの状態変数
                        var panX = 0;
                        var panY = 0;
                        var zoom = 1.0;
                        var fitMode = true;
                        var isPanning = false;
                        var dragStartX = 0;
                        var dragStartY = 0;
                        var dragStartPanX = 0;
                        var dragStartPanY = 0;

                        function applyTransform() {
                            canvas.style.transform = 'translate(' + panX + 'px, ' + panY + 'px) scale(' + zoom + ')';
                            zoomIndicator.textContent = Math.round(zoom * 100) + '%';
                        }

                        function fitToViewport() {
                            var vw = viewport.clientWidth;
                            var vh = viewport.clientHeight;
                            if (vw > 0 && vh > 0 && canvas.width > 0 && canvas.height > 0) {
                                zoom = Math.min(vw / canvas.width, vh / canvas.height);
                                panX = (vw - canvas.width * zoom) / 2;
                                panY = (vh - canvas.height * zoom) / 2;
                            } else {
                                zoom = 1;
                                panX = 0;
                                panY = 0;
                            }
                            applyTransform();
                        }

                        function setFitMode(enabled) {
                            fitMode = enabled;
                            if (enabled) {
                                fitButton.classList.add('active');
                                fitToViewport();
                            } else {
                                fitButton.classList.remove('active');
                            }
                        }

                        fitButton.addEventListener('click', function() {
                            setFitMode(!fitMode);
                        });

                        zoom1to1Button.addEventListener('click', function() {
                            setFitMode(false);
                            zoom = 1.0;
                            var vw = viewport.clientWidth;
                            var vh = viewport.clientHeight;
                            panX = (vw - canvas.width) / 2;
                            panY = (vh - canvas.height) / 2;
                            applyTransform();
                        });

                        // Ctrl+スクロールでズーム（マウス位置を中心に拡縮）
                        viewport.addEventListener('wheel', function(e) {
                            if (!e.ctrlKey) { return; }
                            e.preventDefault();
                            fitMode = false;
                            fitButton.classList.remove('active');
                            var rect = viewport.getBoundingClientRect();
                            var cx = (e.clientX - rect.left - panX) / zoom;
                            var cy = (e.clientY - rect.top - panY) / zoom;
                            var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
                            zoom = Math.max(0.01, Math.min(32, zoom * factor));
                            panX = (e.clientX - rect.left) - cx * zoom;
                            panY = (e.clientY - rect.top) - cy * zoom;
                            applyTransform();
                        }, { passive: false });

                        // ドラッグでパン
                        viewport.addEventListener('mousedown', function(e) {
                            if (e.button !== 0) { return; }
                            isPanning = true;
                            dragStartX = e.clientX;
                            dragStartY = e.clientY;
                            dragStartPanX = panX;
                            dragStartPanY = panY;
                            viewport.classList.add('panning');
                            e.preventDefault();
                        });

                        window.addEventListener('mousemove', function(e) {
                            if (!isPanning) { return; }
                            var dx = e.clientX - dragStartX;
                            var dy = e.clientY - dragStartY;
                            if (fitMode && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
                                fitMode = false;
                                fitButton.classList.remove('active');
                            }
                            panX = dragStartPanX + dx;
                            panY = dragStartPanY + dy;
                            applyTransform();
                        });

                        window.addEventListener('mouseup', function() {
                            if (isPanning) {
                                isPanning = false;
                                viewport.classList.remove('panning');
                            }
                        });

                        // ダブルクリックでフィットモードに戻る
                        viewport.addEventListener('dblclick', function() {
                            setFitMode(true);
                        });

                        // ビューポートサイズ変更時にフィットモードなら再フィットする
                        if (typeof ResizeObserver === 'function') {
                            activeResizeObserver = new ResizeObserver(function() {
                                if (fitMode) {
                                    fitToViewport();
                                }
                            });
                            activeResizeObserver.observe(viewport);
                        }

                        var spacer = document.createElement('div');
                        spacer.className = 'spacer';

                        var buttonGroup = document.createElement('div');
                        buttonGroup.className = 'button-group';
                        buttonGroup.appendChild(fitButton);
                        buttonGroup.appendChild(zoom1to1Button);

                        viewerHeader.appendChild(infoBar);
                        viewerHeader.appendChild(spacer);
                        viewerHeader.appendChild(exportButton);
                        viewerHeader.appendChild(buttonGroup);
                        root.appendChild(viewerHeader);

                        viewport.appendChild(canvas);
                        viewport.appendChild(zoomIndicator);
                        viewport.appendChild(zoomHint);
                        root.appendChild(viewport);

                        requestAnimationFrame(fitToViewport);

                        // ピクセル情報バー（マウスオーバーで座標と値を表示）
                        var pixelInfoBar = document.createElement('div');
                        pixelInfoBar.className = 'pixel-info-bar';
                        root.appendChild(pixelInfoBar);

                        canvas.addEventListener('mousemove', function(e) {
                            var rect = canvas.getBoundingClientRect();
                            var scaleX = canvas.width / rect.width;
                            var scaleY = canvas.height / rect.height;
                            var px = Math.floor((e.clientX - rect.left) * scaleX);
                            var py = Math.floor((e.clientY - rect.top) * scaleY);
                            if (px < 0 || px >= width || py < 0 || py >= height) {
                                pixelInfoBar.textContent = '';
                                return;
                            }
                            var text = '(' + px + ', ' + py + ')';
                            if (rawGray !== null) {
                                var rawVal = rawGray[py * width + px];
                                text += '  Gray: ' + (isFloatGray ? rawVal.toFixed(4) : rawVal);
                            } else {
                                var idx4 = (py * width + px) * 4;
                                text += '  R: ' + imageData.data[idx4] + '  G: ' + imageData.data[idx4 + 1] + '  B: ' + imageData.data[idx4 + 2];
                            }
                            pixelInfoBar.textContent = text;
                        });

                        canvas.addEventListener('mouseleave', function() {
                            pixelInfoBar.textContent = '';
                        });

                        // グレースケール・float32 の場合はウィンドウ/レベルスライダーを表示する
                        if (rawGray !== null) {
                            var totalPx = width * height;
                            var wlControls = document.createElement('div');
                            wlControls.className = 'window-controls';

                            var minValSpan = document.createElement('span');
                            minValSpan.textContent = isFloatGray ? grayWindowMin.toFixed(3) : String(grayWindowMin);
                            var minLbl = document.createElement('label');
                            minLbl.appendChild(document.createTextNode('Min\u00A0'));
                            var minSlider = document.createElement('input');
                            minSlider.type = 'range';
                            minSlider.min = String(grayMinValue);
                            minSlider.max = String(grayMaxValue);
                            minSlider.value = String(grayWindowMin);
                            if (isFloatGray) { minSlider.step = 'any'; }
                            minLbl.appendChild(minSlider);
                            minLbl.appendChild(document.createTextNode('\u00A0'));
                            minLbl.appendChild(minValSpan);

                            var maxValSpan = document.createElement('span');
                            maxValSpan.textContent = isFloatGray ? grayWindowMax.toFixed(3) : String(grayWindowMax);
                            var maxLbl = document.createElement('label');
                            maxLbl.appendChild(document.createTextNode('Max\u00A0'));
                            var maxSlider = document.createElement('input');
                            maxSlider.type = 'range';
                            maxSlider.min = String(grayMinValue);
                            maxSlider.max = String(grayMaxValue);
                            maxSlider.value = String(grayWindowMax);
                            if (isFloatGray) { maxSlider.step = 'any'; }
                            maxLbl.appendChild(maxSlider);
                            maxLbl.appendChild(document.createTextNode('\u00A0'));
                            maxLbl.appendChild(maxValSpan);

                            var resetBtn = document.createElement('button');
                            resetBtn.type = 'button';
                            resetBtn.className = 'window-reset';
                            resetBtn.textContent = 'Reset';

                            var initialMin = grayWindowMin;
                            var initialMax = grayWindowMax;
                            var capturedRawGray = rawGray;
                            var capturedCtx = ctx;
                            var capturedImageData = imageData;
                            var capturedIsFloat = isFloatGray;
                            var rafPending = false;

                            function readSliderVal(slider) {
                                return capturedIsFloat ? parseFloat(slider.value) : parseInt(slider.value, 10);
                            }
                            function fmtSliderVal(val) {
                                return capturedIsFloat ? val.toFixed(3) : String(val);
                            }

                            // requestAnimationFrame でまとめて再描画する（スライダー操作を滑らかにする）
                            function scheduleWindowRender() {
                                if (!rafPending) {
                                    rafPending = true;
                                    requestAnimationFrame(function() {
                                        rafPending = false;
                                        var wMin = readSliderVal(minSlider);
                                        var wMax = readSliderVal(maxSlider);
                                        minValSpan.textContent = fmtSliderVal(wMin);
                                        maxValSpan.textContent = fmtSliderVal(wMax);
                                        applyWindowLevel(capturedRawGray, totalPx, wMin, wMax, capturedImageData.data);
                                        capturedCtx.putImageData(capturedImageData, 0, 0);
                                    });
                                }
                            }

                            minSlider.addEventListener('input', function() {
                                var wMin = readSliderVal(minSlider);
                                var wMax = readSliderVal(maxSlider);
                                if (wMin > wMax) { minSlider.value = String(wMax); }
                                scheduleWindowRender();
                            });
                            maxSlider.addEventListener('input', function() {
                                var wMin = readSliderVal(minSlider);
                                var wMax = readSliderVal(maxSlider);
                                if (wMax < wMin) { maxSlider.value = String(wMin); }
                                scheduleWindowRender();
                            });
                            resetBtn.addEventListener('click', function() {
                                minSlider.value = String(initialMin);
                                maxSlider.value = String(initialMax);
                                scheduleWindowRender();
                            });

                            wlControls.appendChild(minLbl);
                            wlControls.appendChild(maxLbl);
                            wlControls.appendChild(resetBtn);
                            root.appendChild(wlControls);
                        }
                    })
                    .catch(function(err) {
                        if (err && err.name === 'AbortError') {
                            return; // 意図的なキャンセルは無視する
                        }
                        if (currentRenderId !== activeRenderId) {
                            return;
                        }
                        root.className = 'center';
                        root.innerHTML = '<div class="error-box"><strong>Error:</strong> ' + escapeHtml(String(err)) + '</div>';
                    });
            }
        });

        // --- エラーハンドラ ---

        window.addEventListener('error', function(event) {
            clearReadyTimer();
            showRuntimeError(event.error || event.message || 'Unknown script error');
        });

        window.addEventListener('unhandledrejection', function(event) {
            clearReadyTimer();
            showRuntimeError(event.reason || 'Unhandled promise rejection');
        });

        // --- 起動時の Extension との同期 ---

        // Extension が 'render' メッセージを送るまで 'ready' を繰り返し送信する。
        // 起動タイミングのずれで最初のメッセージが届かないことがあるための対策。
        readyTimer = setInterval(function() {
            vscode.postMessage({ type: 'ready' });
        }, 250);
        vscode.postMessage({ type: 'ready' });

        // 4秒以内に 'render' が届かない場合はエラーを表示する
        startupTimeout = setTimeout(function() {
            var root = document.getElementById('root');
            if (!root) {
                return;
            }
            root.className = 'center';
            root.innerHTML = '<div class="error-box"><strong>Error:</strong> Extension host did not respond in time. Reload the extension host and reopen the file.</div>';
        }, 4000);
    </script>
</body>
</html>`;
}

/**
 * getWebviewHtml の nonce を自動生成するラッパーです。
 * 本番コード（extension.ts）から呼び出します。
 */
export function buildWebviewHtml(cspSource: string): string {
  return getWebviewHtml(getNonce(), cspSource);
}
