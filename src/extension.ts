import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const streamDecodableFormats = ['gray8', 'gray16le', 'gray16be', 'rgb24', 'bgr24', 'rgba32', 'bgra32'] as const;
const supportedFormats = [...streamDecodableFormats, 'yuv420p', 'nv12', 'yuyv422'] as const;

type StreamDecodableRawImageFormat = (typeof streamDecodableFormats)[number];
type RawImageFormat = (typeof supportedFormats)[number];
type RawImageConfigSource = 'rawimagerc' | 'filename' | 'settings' | 'filename+settings';

interface RawImageConfig {
    width: number;
    height: number;
    headerSize: number;
    format: RawImageFormat;
}

interface RawImageFallbackSettings {
    defaultWidth?: number;
    defaultHeight?: number;
    defaultHeaderSize?: number;
    defaultFormat?: RawImageFormat;
    inferFromFilename?: boolean;
}

interface ResolvedRawImageConfig {
    config: RawImageConfig | null;
    source?: RawImageConfigSource;
}

type TimeoutHandle = ReturnType<typeof setTimeout>;
type TimeoutScheduler = (callback: () => void, delay: number) => TimeoutHandle;
type TimeoutCanceler = (timeout: TimeoutHandle) => void;

interface InitialRenderHandshake {
    handleMessage(messageType: string): boolean;
    dispose(): void;
}

interface RawImageDecodeState {
    format: StreamDecodableRawImageFormat;
    totalPixels: number;
    pixelsWritten: number;
    remainingHeaderBytes: number;
    bytesPerPixel: number;
    pendingBytes: Uint8Array;
    pendingLength: number;
}

export function getBytesPerPixel(format: StreamDecodableRawImageFormat): number {
    switch (format) {
        case 'gray8':
            return 1;
        case 'gray16le':
        case 'gray16be':
            return 2;
        case 'rgb24':
        case 'bgr24':
            return 3;
        case 'rgba32':
        case 'bgra32':
            return 4;
    }
}

export function createRawImageDecodeState(
    width: number,
    height: number,
    headerSize: number,
    format: StreamDecodableRawImageFormat
): RawImageDecodeState {
    const bytesPerPixel = getBytesPerPixel(format);
    return {
        format,
        totalPixels: width * height,
        pixelsWritten: 0,
        remainingHeaderBytes: Math.max(0, headerSize),
        bytesPerPixel,
        pendingBytes: new Uint8Array(bytesPerPixel),
        pendingLength: 0,
    };
}

function decodeRawPixel(
    source: Uint8Array,
    offset: number,
    format: StreamDecodableRawImageFormat
): [number, number, number, number] {
    switch (format) {
        case 'gray8': {
            const value = source[offset] ?? 0;
            return [value, value, value, 255];
        }
        case 'gray16le': {
            const lowByte = source[offset] ?? 0;
            const highByte = source[offset + 1] ?? 0;
            const value = ((highByte << 8) | lowByte) >> 8;
            return [value, value, value, 255];
        }
        case 'gray16be': {
            const highByte = source[offset] ?? 0;
            const lowByte = source[offset + 1] ?? 0;
            const value = ((highByte << 8) | lowByte) >> 8;
            return [value, value, value, 255];
        }
        case 'rgb24':
            return [source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0, 255];
        case 'bgr24':
            return [source[offset + 2] ?? 0, source[offset + 1] ?? 0, source[offset] ?? 0, 255];
        case 'rgba32':
            return [source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0, source[offset + 3] ?? 0];
        case 'bgra32':
            return [source[offset + 2] ?? 0, source[offset + 1] ?? 0, source[offset] ?? 0, source[offset + 3] ?? 0];
    }
}

export function appendRawImageChunk(
    state: RawImageDecodeState,
    chunk: Uint8Array,
    pixels: Uint8ClampedArray
): void {
    if (state.pixelsWritten >= state.totalPixels || chunk.length === 0) {
        return;
    }

    let offset = 0;
    if (state.remainingHeaderBytes > 0) {
        const skipped = Math.min(state.remainingHeaderBytes, chunk.length);
        state.remainingHeaderBytes -= skipped;
        offset += skipped;
    }

    if (offset >= chunk.length) {
        return;
    }

    while (state.pendingLength > 0 && offset < chunk.length && state.pendingLength < state.bytesPerPixel) {
        state.pendingBytes[state.pendingLength++] = chunk[offset++];
    }

    if (state.pendingLength === state.bytesPerPixel && state.pixelsWritten < state.totalPixels) {
        const [r, g, b, a] = decodeRawPixel(state.pendingBytes, 0, state.format);
        const destinationOffset = state.pixelsWritten * 4;
        pixels[destinationOffset] = r;
        pixels[destinationOffset + 1] = g;
        pixels[destinationOffset + 2] = b;
        pixels[destinationOffset + 3] = a;
        state.pixelsWritten += 1;
        state.pendingLength = 0;
    }

    while (offset + state.bytesPerPixel <= chunk.length && state.pixelsWritten < state.totalPixels) {
        const [r, g, b, a] = decodeRawPixel(chunk, offset, state.format);
        const destinationOffset = state.pixelsWritten * 4;
        pixels[destinationOffset] = r;
        pixels[destinationOffset + 1] = g;
        pixels[destinationOffset + 2] = b;
        pixels[destinationOffset + 3] = a;
        state.pixelsWritten += 1;
        offset += state.bytesPerPixel;
    }

    while (offset < chunk.length && state.pendingLength < state.bytesPerPixel && state.pixelsWritten < state.totalPixels) {
        state.pendingBytes[state.pendingLength++] = chunk[offset++];
    }
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
        let currentConfigPath = findConfigPath(document.uri.fsPath);
        const updateWebviewOptions = (): void => {
            webviewPanel.webview.options = {
                enableScripts: true,
                localResourceRoots: getLocalResourceRoots(document.uri, currentConfigPath),
            };
        };

        updateWebviewOptions();

        let initialPayloadSent = false;
        let refreshTimer: NodeJS.Timeout | undefined;
        const postRenderPayload = (): void => {
            currentConfigPath = findConfigPath(document.uri.fsPath);
            updateWebviewOptions();
            try {
                const resolvedConfig = currentConfigPath
                    ? { config: loadRawImageConfig(currentConfigPath), source: 'rawimagerc' as const }
                    : resolveFallbackRawImageConfig(
                          document.uri.fsPath,
                          getRawImageFallbackSettings(vscode.workspace.getConfiguration('rawviewer', document.uri))
                      );
                const fileStat = fs.statSync(document.uri.fsPath);
                const fileUri = webviewPanel.webview.asWebviewUri(document.uri).toString();
                webviewPanel.webview.postMessage({
                    type: 'render',
                    config: resolvedConfig.config,
                    configSource: resolvedConfig.source ?? null,
                    fileUri,
                    fileSize: fileStat.size,
                });
            } catch (err: unknown) {
                webviewPanel.webview.postMessage({
                    type: 'error',
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        };
        const sendInitialRenderPayload = (): void => {
            if (initialPayloadSent) {
                return;
            }
            initialPayloadSent = true;
            postRenderPayload();
        };
        const scheduleRefresh = (): void => {
            if (!initialPayloadSent) {
                return;
            }
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            refreshTimer = setTimeout(() => {
                refreshTimer = undefined;
                postRenderPayload();
            }, 100);
        };

        const initialRenderHandshake = createInitialRenderHandshake(
            sendInitialRenderPayload,
            () => {
                void vscode.window.showWarningMessage(
                    'Raw Image Viewer: webview did not send a ready message. Open "Developer: Open Webview Developer Tools" and check console errors.'
                );
            }
        );

        const listener = webviewPanel.webview.onDidReceiveMessage(async (message) => {
            if (initialRenderHandshake.handleMessage(message.type)) {
                return;
            }

            if (message.type === 'savePng') {
                try {
                    const targetUri = await vscode.window.showSaveDialog({
                        defaultUri: getSuggestedPngSaveUri(document.uri),
                        filters: { 'PNG Image': ['png'] },
                        saveLabel: 'Export PNG',
                    });
                    if (!targetUri) {
                        return;
                    }

                    await vscode.workspace.fs.writeFile(targetUri, decodePngDataUrl(message.dataUrl));
                    void vscode.window.showInformationMessage(`Raw Image Viewer: Exported PNG to ${targetUri.fsPath}`);
                } catch (err: unknown) {
                    const detail = err instanceof Error ? err.message : String(err);
                    void vscode.window.showErrorMessage(`Raw Image Viewer: Failed to export PNG. ${detail}`);
                }
            }
        });

        const panelDisposables: vscode.Disposable[] = [listener];
        const registerRefreshListeners = (watcher: vscode.FileSystemWatcher): void => {
            panelDisposables.push(watcher);
            panelDisposables.push(watcher.onDidChange(scheduleRefresh));
            panelDisposables.push(watcher.onDidCreate(scheduleRefresh));
            panelDisposables.push(watcher.onDidDelete(scheduleRefresh));
        };

        registerRefreshListeners(
            vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath))
            )
        );

        for (const dir of getConfigSearchDirectories(document.uri.fsPath)) {
            registerRefreshListeners(vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '.rawimagerc')));
        }

        const nonce = getNonce();
        webviewPanel.webview.html = getWebviewHtml(nonce, webviewPanel.webview.cspSource);

        webviewPanel.onDidDispose(() => {
            initialRenderHandshake.dispose();
            if (refreshTimer) {
                clearTimeout(refreshTimer);
            }
            vscode.Disposable.from(...panelDisposables).dispose();
        });
    }
}

export function getConfigSearchDirectories(filePath: string): string[] {
    const directories: string[] = [];
    let dir = path.dirname(filePath);
    while (true) {
        directories.push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return directories;
}

export function createInitialRenderHandshake(
    sendInitialRenderPayload: () => void,
    showReadyWarning: () => void,
    scheduleTimeout: TimeoutScheduler = setTimeout,
    cancelTimeout: TimeoutCanceler = clearTimeout
): InitialRenderHandshake {
    const initialSendTimer = scheduleTimeout(() => {
        sendInitialRenderPayload();
    }, 300);

    const readyWarningTimer = scheduleTimeout(() => {
        showReadyWarning();
    }, 5000);

    return {
        handleMessage(messageType: string): boolean {
            if (messageType !== 'ready') {
                return false;
            }

            cancelTimeout(initialSendTimer);
            cancelTimeout(readyWarningTimer);
            sendInitialRenderPayload();
            return true;
        },
        dispose(): void {
            cancelTimeout(initialSendTimer);
            cancelTimeout(readyWarningTimer);
        },
    };
}

export function findConfigPath(filePath: string): string | undefined {
    for (const dir of getConfigSearchDirectories(filePath)) {
        const configPath = path.join(dir, '.rawimagerc');
        try {
            fs.accessSync(configPath, fs.constants.F_OK);
            return configPath;
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code !== 'ENOENT') {
                throw err;
            }
        }
    }
    return undefined;
}

function isRawImageConfigRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePositiveInteger(value: unknown, property: 'width' | 'height', configPath: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid .rawimagerc at "${configPath}": "${property}" must be a positive integer.`);
    }
    return value;
}

function validateNonNegativeInteger(value: unknown, property: 'headerSize', configPath: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid .rawimagerc at "${configPath}": "${property}" must be a non-negative integer.`);
    }
    return value;
}

function validateOptionalPositiveInteger(
    value: unknown,
    property: 'defaultWidth' | 'defaultHeight',
    source: string
): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${source}: "${property}" must be a positive integer.`);
    }
    return value;
}

function validateOptionalNonNegativeInteger(value: unknown, property: 'defaultHeaderSize', source: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`Invalid ${source}: "${property}" must be a non-negative integer.`);
    }
    return value;
}

function validateOptionalFormat(value: unknown, property: 'defaultFormat', source: string): RawImageFormat | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !supportedFormats.includes(value as RawImageFormat)) {
        throw new Error(`Invalid ${source}: "${property}" must be one of ${supportedFormats.join(', ')}.`);
    }
    return value as RawImageFormat;
}

export function parseRawImageConfig(content: string, configPath: string): RawImageConfig {
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to parse .rawimagerc at "${configPath}": ${message}`);
    }

    if (!isRawImageConfigRecord(parsed)) {
        throw new Error(`Invalid .rawimagerc at "${configPath}": expected a JSON object.`);
    }

    const width = validatePositiveInteger(parsed.width, 'width', configPath);
    const height = validatePositiveInteger(parsed.height, 'height', configPath);
    const headerSize = validateNonNegativeInteger(parsed.headerSize ?? 0, 'headerSize', configPath);
    const format = parsed.format ?? 'rgb24';

    if (typeof format !== 'string' || !supportedFormats.includes(format as RawImageFormat)) {
        throw new Error(
            `Invalid .rawimagerc at "${configPath}": "format" must be one of ${supportedFormats.join(', ')}.`
        );
    }

    return {
        width,
        height,
        headerSize,
        format: format as RawImageFormat,
    };
}

function loadRawImageConfig(configPath: string): RawImageConfig {
    return parseRawImageConfig(fs.readFileSync(configPath, 'utf8'), configPath);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferRawImageConfigFromFilename(filePath: string): Partial<RawImageConfig> | null {
    const baseName = path.parse(filePath).name.toLowerCase();
    const sizeMatch = baseName.match(/(?:^|[^0-9])(\d+)x(\d+)(?:[^0-9]|$)/);
    const width = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : undefined;
    const height = sizeMatch ? Number.parseInt(sizeMatch[2], 10) : undefined;
    const format = supportedFormats.find((candidate) =>
        new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(candidate)}(?:[^a-z0-9]|$)`).test(baseName)
    );

    if (width === undefined && height === undefined && format === undefined) {
        return null;
    }

    const inferred: Partial<RawImageConfig> = {};
    if (width !== undefined && Number.isInteger(width) && width > 0) {
        inferred.width = width;
    }
    if (height !== undefined && Number.isInteger(height) && height > 0) {
        inferred.height = height;
    }
    if (format) {
        inferred.format = format;
    }

    return Object.keys(inferred).length > 0 ? inferred : null;
}

function getRawImageFallbackSettings(configuration: vscode.WorkspaceConfiguration): RawImageFallbackSettings {
    const getConfiguredValue = <T>(key: string): T | undefined => {
        const inspected = configuration.inspect<T>(key);
        return (
            inspected?.workspaceFolderLanguageValue ??
            inspected?.workspaceFolderValue ??
            inspected?.workspaceLanguageValue ??
            inspected?.workspaceValue ??
            inspected?.globalLanguageValue ??
            inspected?.globalValue
        );
    };

    const defaultWidth = getConfiguredValue<number>('defaultWidth');
    const defaultHeight = getConfiguredValue<number>('defaultHeight');
    const defaultHeaderSize = getConfiguredValue<number>('defaultHeaderSize');
    const defaultFormat = getConfiguredValue<string>('defaultFormat');

    return {
        defaultWidth: validateOptionalPositiveInteger(defaultWidth, 'defaultWidth', 'rawviewer settings'),
        defaultHeight: validateOptionalPositiveInteger(defaultHeight, 'defaultHeight', 'rawviewer settings'),
        defaultHeaderSize: validateOptionalNonNegativeInteger(defaultHeaderSize, 'defaultHeaderSize', 'rawviewer settings'),
        defaultFormat: validateOptionalFormat(defaultFormat, 'defaultFormat', 'rawviewer settings'),
        inferFromFilename: configuration.get<boolean>('inferFromFilename', true),
    };
}

export function resolveFallbackRawImageConfig(
    filePath: string,
    settings: RawImageFallbackSettings = {}
): ResolvedRawImageConfig {
    const validatedSettings: RawImageFallbackSettings = {
        defaultWidth: validateOptionalPositiveInteger(settings.defaultWidth, 'defaultWidth', 'rawviewer fallback settings'),
        defaultHeight: validateOptionalPositiveInteger(settings.defaultHeight, 'defaultHeight', 'rawviewer fallback settings'),
        defaultHeaderSize: validateOptionalNonNegativeInteger(
            settings.defaultHeaderSize,
            'defaultHeaderSize',
            'rawviewer fallback settings'
        ),
        defaultFormat: validateOptionalFormat(settings.defaultFormat, 'defaultFormat', 'rawviewer fallback settings'),
        inferFromFilename: settings.inferFromFilename ?? true,
    };

    const inferred = validatedSettings.inferFromFilename ? inferRawImageConfigFromFilename(filePath) : null;
    const width = inferred?.width ?? validatedSettings.defaultWidth;
    const height = inferred?.height ?? validatedSettings.defaultHeight;

    if (width === undefined || height === undefined) {
        return { config: null };
    }

    const usedInference = inferred !== null && (inferred.width !== undefined || inferred.height !== undefined || inferred.format !== undefined);
    const usedSettings =
        validatedSettings.defaultWidth !== undefined ||
        validatedSettings.defaultHeight !== undefined ||
        validatedSettings.defaultHeaderSize !== undefined ||
        validatedSettings.defaultFormat !== undefined;

    let source: RawImageConfigSource = 'settings';
    if (usedInference && usedSettings) {
        source = 'filename+settings';
    } else if (usedInference) {
        source = 'filename';
    }

    return {
        config: {
            width,
            height,
            headerSize: inferred?.headerSize ?? validatedSettings.defaultHeaderSize ?? 0,
            format: inferred?.format ?? validatedSettings.defaultFormat ?? 'rgb24',
        },
        source,
    };
}

export function getLocalResourceRoots(documentUri: vscode.Uri, configPath?: string): vscode.Uri[] {
    const roots = new Map<string, vscode.Uri>();
    const addRoot = (fsPath: string): void => {
        const uri = vscode.Uri.file(fsPath);
        const key = process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;
        roots.set(key, uri);
    };

    addRoot(path.dirname(documentUri.fsPath));
    if (configPath) {
        addRoot(path.dirname(configPath));
    }

    return [...roots.values()];
}

export function getSuggestedPngSaveUri(documentUri: vscode.Uri): vscode.Uri {
    const parsed = path.parse(documentUri.fsPath);
    return vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.png`));
}

export function decodePngDataUrl(dataUrl: unknown): Uint8Array {
    if (typeof dataUrl !== 'string') {
        throw new Error('Missing PNG data.');
    }

    const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
        throw new Error('Invalid PNG data received from the webview.');
    }

    return Uint8Array.from(Buffer.from(match[1], 'base64'));
}

export function decodeRawImageToRgba(
    pixelData: Uint8Array,
    width: number,
    height: number,
    format: RawImageFormat
): Uint8ClampedArray {
    const totalPixels = width * height;
    const pixels = new Uint8ClampedArray(totalPixels * 4);

    const clampToByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
    const writePixel = (pixelIndex: number, r: number, g: number, b: number, a = 255): void => {
        const offset = pixelIndex * 4;
        pixels[offset] = clampToByte(r);
        pixels[offset + 1] = clampToByte(g);
        pixels[offset + 2] = clampToByte(b);
        pixels[offset + 3] = clampToByte(a);
    };
    const writeYuvPixel = (pixelIndex: number, y: number, u: number, v: number): void => {
        const c = Math.max(0, y - 16);
        const d = u - 128;
        const e = v - 128;
        writePixel(
            pixelIndex,
            (298 * c + 409 * e + 128) >> 8,
            (298 * c - 100 * d - 208 * e + 128) >> 8,
            (298 * c + 516 * d + 128) >> 8
        );
    };
    const requireBytes = (requiredLength: number): void => {
        if (pixelData.length < requiredLength) {
            throw new Error(`Expected at least ${requiredLength} bytes for ${width}x${height} ${format}, but found ${pixelData.length}.`);
        }
    };

    switch (format) {
        case 'gray8':
            for (let p = 0; p < totalPixels && p < pixelData.length; p++) {
                const value = pixelData[p];
                writePixel(p, value, value, value);
            }
            return pixels;
        case 'gray16le':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 1 < pixelData.length; p++, srcIdx += 2) {
                const value = ((pixelData[srcIdx + 1] << 8) | pixelData[srcIdx]) >> 8;
                writePixel(p, value, value, value);
            }
            return pixels;
        case 'gray16be':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 1 < pixelData.length; p++, srcIdx += 2) {
                const value = ((pixelData[srcIdx] << 8) | pixelData[srcIdx + 1]) >> 8;
                writePixel(p, value, value, value);
            }
            return pixels;
        case 'rgb24':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 2 < pixelData.length; p++, srcIdx += 3) {
                writePixel(p, pixelData[srcIdx], pixelData[srcIdx + 1], pixelData[srcIdx + 2]);
            }
            return pixels;
        case 'bgr24':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 2 < pixelData.length; p++, srcIdx += 3) {
                writePixel(p, pixelData[srcIdx + 2], pixelData[srcIdx + 1], pixelData[srcIdx]);
            }
            return pixels;
        case 'rgba32':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 3 < pixelData.length; p++, srcIdx += 4) {
                writePixel(p, pixelData[srcIdx], pixelData[srcIdx + 1], pixelData[srcIdx + 2], pixelData[srcIdx + 3]);
            }
            return pixels;
        case 'bgra32':
            for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 3 < pixelData.length; p++, srcIdx += 4) {
                writePixel(p, pixelData[srcIdx + 2], pixelData[srcIdx + 1], pixelData[srcIdx], pixelData[srcIdx + 3]);
            }
            return pixels;
        case 'yuv420p': {
            if (width % 2 !== 0 || height % 2 !== 0) {
                throw new Error(`Format ${format} requires even width and height.`);
            }
            const lumaPlaneSize = totalPixels;
            const chromaPlaneSize = totalPixels / 4;
            requireBytes(lumaPlaneSize + chromaPlaneSize * 2);
            const uOffset = lumaPlaneSize;
            const vOffset = uOffset + chromaPlaneSize;
            const chromaWidth = width / 2;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const pixelIndex = y * width + x;
                    const chromaIndex = Math.floor(y / 2) * chromaWidth + Math.floor(x / 2);
                    writeYuvPixel(pixelIndex, pixelData[pixelIndex], pixelData[uOffset + chromaIndex], pixelData[vOffset + chromaIndex]);
                }
            }
            return pixels;
        }
        case 'nv12': {
            if (width % 2 !== 0 || height % 2 !== 0) {
                throw new Error(`Format ${format} requires even width and height.`);
            }
            const lumaPlaneSize = totalPixels;
            requireBytes(lumaPlaneSize + totalPixels / 2);
            const uvOffset = lumaPlaneSize;
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const pixelIndex = y * width + x;
                    const chromaIndex = uvOffset + Math.floor(y / 2) * width + Math.floor(x / 2) * 2;
                    writeYuvPixel(pixelIndex, pixelData[pixelIndex], pixelData[chromaIndex], pixelData[chromaIndex + 1]);
                }
            }
            return pixels;
        }
        case 'yuyv422':
            if (width % 2 !== 0) {
                throw new Error(`Format ${format} requires an even width.`);
            }
            for (let p = 0, srcIdx = 0; p + 1 < totalPixels && srcIdx + 3 < pixelData.length; p += 2, srcIdx += 4) {
                const y0 = pixelData[srcIdx];
                const u = pixelData[srcIdx + 1];
                const y1 = pixelData[srcIdx + 2];
                const v = pixelData[srcIdx + 3];
                writeYuvPixel(p, y0, u, v);
                writeYuvPixel(p + 1, y1, u, v);
            }
            return pixels;
    }
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
        .viewer-header {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            justify-content: center;
        }
        .info-bar {
            color: #9cdcfe;
            font-size: 13px;
            font-family: 'Consolas', 'Courier New', monospace;
        }
        .action-button {
            appearance: none;
            border: 1px solid #1177bb;
            border-radius: 4px;
            background: #0e639c;
            color: #ffffff;
            cursor: pointer;
            font-size: 13px;
            line-height: 1.2;
            padding: 6px 12px;
        }
        .action-button:hover {
            background: #1177bb;
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
        const decodeRawImageToRgba = ${decodeRawImageToRgba.toString()};
        const streamDecodableFormats = new Set(${JSON.stringify(streamDecodableFormats)});
        var readyTimer = null;
        var startupTimeout = null;
        var activeAbortController = null;
        var activeRenderId = 0;

        ${getBytesPerPixel.toString()}
        ${createRawImageDecodeState.toString()}
        ${decodeRawPixel.toString()}
        ${appendRawImageChunk.toString()}

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
                var configSource = msg.configSource;
                var fileUri = msg.fileUri;
                var fileSize = msg.fileSize;

                if (!config) {
                    root.className = 'center';
                    root.innerHTML =
                        '<div class="no-config-box">' +
                        '<h3>\u2699 No .rawimagerc configuration found</h3>' +
                        '<p>Create a <code>.rawimagerc</code> file in the same directory as the file, or any parent directory, to configure how to render this binary file as an image.</p>' +
                        '<p>Alternatively, set workspace defaults such as <code>rawviewer.defaultWidth</code> and <code>rawviewer.defaultHeight</code>, or include metadata in the filename like <code>frame_1920x1080_rgb24.raw</code>.</p>' +
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
                        '<tr><td><code>yuv420p</code></td><td>Planar YUV 4:2:0</td><td>1.5</td></tr>' +
                        '<tr><td><code>nv12</code></td><td>Semi-planar YUV 4:2:0</td><td>1.5</td></tr>' +
                        '<tr><td><code>yuyv422</code></td><td>Packed YUV 4:2:2</td><td>2</td></tr>' +
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

                if (activeAbortController) {
                    activeAbortController.abort();
                }

                activeAbortController = typeof AbortController === 'function' ? new AbortController() : null;
                var currentRenderId = ++activeRenderId;
                var shouldStreamDecode = streamDecodableFormats.has(format);

                root.className = 'center';
                root.innerHTML = '<div class="spinner"></div><p>Loading...</p>';

                fetch(fileUri, activeAbortController ? { signal: activeAbortController.signal } : undefined)
                    .then(async function(response) {
                        if (!response.ok) {
                            throw new Error('Failed to read file in webview: HTTP ' + response.status);
                        }

                        var canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;

                        var ctx = canvas.getContext('2d');
                        if (!ctx) {
                            throw new Error('2D canvas context is not available.');
                        }
                        var imageData = ctx.createImageData(width, height);
                        var pixels = imageData.data;

                        if (response.body && typeof response.body.getReader === 'function' && shouldStreamDecode) {
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
                            var rawBytes = new Uint8Array(await response.arrayBuffer());
                            imageData.data.set(decodeRawImageToRgba(rawBytes.subarray(headerSize), width, height, format));
                        }

                        if (currentRenderId !== activeRenderId) {
                            return;
                        }

                        ctx.putImageData(imageData, 0, 0);

                        root.className = 'viewer';
                        root.innerHTML = '';

                        var viewerHeader = document.createElement('div');
                        viewerHeader.className = 'viewer-header';

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
                            vscode.postMessage({ type: 'savePng', dataUrl: canvas.toDataURL('image/png') });
                        });

                        viewerHeader.appendChild(infoBar);
                        viewerHeader.appendChild(exportButton);
                        root.appendChild(viewerHeader);
                        root.appendChild(canvas);
                    })
                    .catch(function(err) {
                        if (err && err.name === 'AbortError') {
                            return;
                        }
                        if (currentRenderId !== activeRenderId) {
                            return;
                        }
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
