import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface RawImageConfig {
    width: number;
    height: number;
    headerSize?: number;
    format?: string;
}

class RawImageDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

class RawImageEditorProvider implements vscode.CustomReadonlyEditorProvider<RawImageDocument> {
    static readonly viewType = 'rawviewer.rawImageEditor';

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            RawImageEditorProvider.viewType,
            new RawImageEditorProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: { retainContextWhenHidden: true },
            }
        );
    }

    constructor(private readonly _context: vscode.ExtensionContext) {}

    openCustomDocument(uri: vscode.Uri): RawImageDocument {
        return new RawImageDocument(uri);
    }

    async resolveCustomEditor(
        document: RawImageDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.dirname(document.uri.fsPath))],
        };

        const sendRenderPayload = (): void => {
            try {
                const config = findConfig(document.uri.fsPath);
                const fileStat = fs.statSync(document.uri.fsPath);
                const fileUri = webviewPanel.webview.asWebviewUri(document.uri).toString();
                webviewPanel.webview.postMessage({
                    type: 'render',
                    config,
                    fileUri,
                    fileSize: fileStat.size,
                });
            } catch (err: unknown) {
                webviewPanel.webview.postMessage({
                    type: 'error',
                    message: String(err),
                });
            }
        };

        // Send once even if ready handshake fails, to prevent permanent loading.
        const initialSendTimer = setTimeout(() => {
            sendRenderPayload();
        }, 300);

        const readyWarningTimer = setTimeout(() => {
            void vscode.window.showWarningMessage(
                'Raw Image Viewer: webview did not send a ready message. Open "Developer: Open Webview Developer Tools" and check console errors.'
            );
        }, 5000);

        const listener = webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.type !== 'ready') {
                return;
            }
            clearTimeout(readyWarningTimer);
            sendRenderPayload();
        });

        const nonce = getNonce();
        webviewPanel.webview.html = getWebviewHtml(nonce, webviewPanel.webview.cspSource);

        webviewPanel.onDidDispose(() => {
            clearTimeout(initialSendTimer);
            clearTimeout(readyWarningTimer);
            listener.dispose();
        });
    }
}

function findConfig(filePath: string): RawImageConfig | null {
    let dir = path.dirname(filePath);
    while (true) {
        const configPath = path.join(dir, '.rawimagerc');
        try {
            const content = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(content) as RawImageConfig;
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code !== 'ENOENT') {
                throw err;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

function getWebviewHtml(nonce: string, cspSource: string): string {
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
            background: #1e1e1e;
            color: #cccccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
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
        .info-bar {
            color: #9cdcfe;
            font-size: 13px;
            font-family: 'Consolas', 'Courier New', monospace;
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
            background: #1e1e1e;
            padding: 1px 5px;
            border-radius: 3px;
            font-family: 'Consolas', monospace;
            font-size: 0.9em;
        }
        pre {
            background: #1e1e1e;
            padding: 12px 16px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 13px;
            line-height: 1.5;
            margin-bottom: 10px;
        }
        table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
        th, td { text-align: left; padding: 4px 10px; border-bottom: 1px solid #444; }
        th { color: #9cdcfe; }
        canvas {
            max-width: 100%;
            image-rendering: pixelated;
            border: 1px solid #444;
            box-shadow: 0 0 20px rgba(0,0,0,0.5);
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
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        var readyTimer = null;
        var startupTimeout = null;

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

        function showRuntimeError(err) {
            var root = document.getElementById('root');
            if (!root) {
                return;
            }
            root.className = 'center';
            root.innerHTML = '<div class="error-box"><strong>Webview Error:</strong> ' + escapeHtml(String(err)) + '</div>';
        }

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

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
                var fileUri = msg.fileUri;
                var fileSize = msg.fileSize;

                if (!config) {
                    root.className = 'center';
                    root.innerHTML =
                        '<div class="no-config-box">' +
                        '<h3>\u2699 No .rawimagerc configuration found</h3>' +
                        '<p>Create a <code>.rawimagerc</code> file in the same directory as the file, or any parent directory, to configure how to render this binary file as an image.</p>' +
                        '<pre>{\\n  "width": 640,\\n  "height": 480,\\n  "headerSize": 0,\\n  "format": "rgb24"\\n}</pre>' +
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

                fetch(fileUri)
                    .then(function(response) {
                        if (!response.ok) {
                            throw new Error('Failed to read file in webview: HTTP ' + response.status);
                        }
                        return response.arrayBuffer();
                    })
                    .then(function(buffer) {
                        var rawBytes = new Uint8Array(buffer);
                        var pixelData = rawBytes.subarray(headerSize);

                        var canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;

                        var ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error('2D canvas context is not available.');
                        }
                        var imageData = ctx.createImageData(width, height);
                        var pixels = imageData.data;

                        var srcIdx = 0;
                        var dstIdx = 0;
                        var totalPixels = width * height;

                        for (var p = 0; p < totalPixels && srcIdx < pixelData.length; p++) {
                            var r = 0, g = 0, b = 0, a = 255;
                            switch (format) {
                                case 'gray8':
                                    r = g = b = pixelData[srcIdx++] || 0;
                                    break;
                                case 'gray16le': {
                                    var lowByte = pixelData[srcIdx++] || 0;
                                    var highByte = pixelData[srcIdx++] || 0;
                                    r = g = b = ((highByte << 8) | lowByte) >> 8;
                                    break;
                                }
                                case 'gray16be': {
                                    var highByte2 = pixelData[srcIdx++] || 0;
                                    var lowByte2 = pixelData[srcIdx++] || 0;
                                    r = g = b = ((highByte2 << 8) | lowByte2) >> 8;
                                    break;
                                }
                                case 'rgb24':
                                    r = pixelData[srcIdx++] || 0;
                                    g = pixelData[srcIdx++] || 0;
                                    b = pixelData[srcIdx++] || 0;
                                    break;
                                case 'bgr24':
                                    b = pixelData[srcIdx++] || 0;
                                    g = pixelData[srcIdx++] || 0;
                                    r = pixelData[srcIdx++] || 0;
                                    break;
                                case 'rgba32':
                                    r = pixelData[srcIdx++] || 0;
                                    g = pixelData[srcIdx++] || 0;
                                    b = pixelData[srcIdx++] || 0;
                                    a = pixelData[srcIdx++] || 0;
                                    break;
                                case 'bgra32':
                                    b = pixelData[srcIdx++] || 0;
                                    g = pixelData[srcIdx++] || 0;
                                    r = pixelData[srcIdx++] || 0;
                                    a = pixelData[srcIdx++] || 0;
                                    break;
                                default:
                                    r = g = b = 0;
                                    break;
                            }
                            pixels[dstIdx++] = r;
                            pixels[dstIdx++] = g;
                            pixels[dstIdx++] = b;
                            pixels[dstIdx++] = a;
                        }

                        ctx.putImageData(imageData, 0, 0);

                        root.className = 'viewer';
                        root.innerHTML = '';

                        var infoBar = document.createElement('div');
                        infoBar.className = 'info-bar';
                        infoBar.textContent = width + ' \xd7 ' + height + ' | ' + format + ' | header: ' + headerSize + ' B | file: ' + fileSize + ' B';

                        root.appendChild(infoBar);
                        root.appendChild(canvas);
                    })
                    .catch(function(err) {
                        root.className = 'center';
                        root.innerHTML = '<div class="error-box"><strong>Error:</strong> ' + escapeHtml(String(err)) + '</div>';
                    });
            }
        });

        window.addEventListener('error', function(event) {
            clearReadyTimer();
            showRuntimeError(event.error || event.message || 'Unknown script error');
        });

        window.addEventListener('unhandledrejection', function(event) {
            clearReadyTimer();
            showRuntimeError(event.reason || 'Unhandled promise rejection');
        });

        // Retry ready handshake in case startup timing drops the first message.
        readyTimer = setInterval(function() {
            vscode.postMessage({ type: 'ready' });
        }, 250);
        vscode.postMessage({ type: 'ready' });

        // Surface a visible diagnostic instead of infinite loading.
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

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(RawImageEditorProvider.register(context));

    context.subscriptions.push(
        vscode.commands.registerCommand('rawviewer.openAsRawImage', async (uri?: vscode.Uri) => {
            if (!uri) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    uri = editor.document.uri;
                }
            }
            if (uri) {
                await vscode.commands.executeCommand('vscode.openWith', uri, RawImageEditorProvider.viewType);
            }
        })
    );
}

export function deactivate(): void {}
