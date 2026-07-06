import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';

// デコード関数は decoder.ts から
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
} from '../decoder';

// 設定関連の関数は config.ts から
import {
  findConfigPath,
  getConfigSearchDirectories,
  getConfigWatchDirectories,
  inferRawImageConfigFromFilename,
  loadRawImageConfig,
  parseRawImageConfig,
  resolveFallbackRawImageConfig,
} from '../config';

// 型定数は types.ts から
import { grayscaleStreamFormats, streamDecodableFormats, supportedFormats } from '../types';
import type { GrayscaleStreamFormat, StreamDecodableRawImageFormat } from '../types';

// フォーマット記述子テーブルは formats.ts から
import { rawImageFormatDescriptorList } from '../formats';

// VS Code 統合層の関数は extension.ts から
import {
  createInitialRenderHandshake,
  decodePngDataUrl,
  getLocalResourceRoots,
  getSuggestedPngSaveUri,
  parseWebviewMessage,
} from '../extension';

// Webview HTML/JS 生成は webviewHtml.ts から
import { buildWebviewHtml } from '../webviewHtml';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('parseRawImageConfig applies defaults', () => {
    assert.deepStrictEqual(
      parseRawImageConfig(
        JSON.stringify({ patterns: [{ match: '*', width: 64, height: 32 }] }),
        'D:\\repo\\.rawimagerc',
        'D:\\repo\\frame.raw'
      ),
      { width: 64, height: 32, headerSize: 0, format: 'rgb24' }
    );
  });

  test('parseRawImageConfig rejects invalid numeric fields', () => {
    // 各エントリのフィールドはマージ前に検証されるため、エラーメッセージには
    // 該当エントリのインデックス（patterns[0] など）が含まれる。
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [
        { patterns: [{ match: '*', width: 0, height: 32 }] },
        /"patterns\[0\]\.width" must be a positive integer/,
      ],
      [
        { patterns: [{ match: '*', width: 64, height: -1 }] },
        /"patterns\[0\]\.height" must be a positive integer/,
      ],
      [
        { patterns: [{ match: '*', width: 64, height: 32, headerSize: 1.5 }] },
        /"patterns\[0\]\.headerSize" must be a non-negative integer/,
      ],
    ];

    for (const [input, expectedMessage] of cases) {
      assert.throws(
        () =>
          parseRawImageConfig(
            JSON.stringify(input),
            'D:\\repo\\.rawimagerc',
            'D:\\repo\\frame.raw'
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, expectedMessage);
          return true;
        }
      );
    }
  });

  test('parseRawImageConfig rejects unsupported formats', () => {
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({ patterns: [{ match: '*', width: 64, height: 32, format: 'yuv420' }] }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"patterns\[0\]\.format" must be one of/);
        return true;
      }
    );
  });

  test('parseRawImageConfig rejects an invalid field on a losing (overridden) pattern entry', () => {
    // entry 0 の width は不正だが、entry 1 が width を上書きして最終的なマージ結果には
    // 現れない。以前は最終マージ後の値だけを検証していたため、この不正値は握りつぶされて
    // いた。フィールド単位でマージ前に検証するようになったため、負けたエントリの型不正
    // でもエラーになる。
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({
            patterns: [
              { match: '*', width: 'not-a-number', height: 32 },
              { match: '*', width: 100 },
            ],
          }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"patterns\[0\]\.width" must be a positive integer/);
        return true;
      }
    );
  });

  test('parseRawImageConfig rejects an explicit "format": null entry instead of falling back to rgb24', () => {
    // 以前は resolved.format ?? 'rgb24' が null を吸収してしまい、width/height と非対称に
    // 無警告で rgb24 にフォールバックしていた。now: null は明示的にエラーになる。
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({ patterns: [{ match: '*', width: 64, height: 32, format: null }] }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"patterns\[0\]\.format" must be one of/);
        return true;
      }
    );
  });

  test('parseRawImageConfig rejects an explicit "width": null / "height": null entry with a patterns[i]-qualified message', () => {
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({ patterns: [{ match: '*', width: null, height: 32 }] }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      /"patterns\[0\]\.width" must be a positive integer/
    );
  });

  test('parseRawImageConfig accepts supported YUV formats', () => {
    assert.deepStrictEqual(
      parseRawImageConfig(
        JSON.stringify({
          patterns: [{ match: '*', width: 4, height: 2, headerSize: 16, format: 'yuv420p' }],
        }),
        'D:\\repo\\.rawimagerc',
        'D:\\repo\\frame.raw'
      ),
      { width: 4, height: 2, headerSize: 16, format: 'yuv420p' }
    );
  });

  test('parseRawImageConfig rejects legacy object-keyed patterns with a migration error', () => {
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({ patterns: { '*': { width: 64, height: 32 } } }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"patterns" must be an array/);
        assert.match(error.message, /no longer supported/);
        assert.match(error.message, /"match": "\*"/);
        return true;
      }
    );
  });

  test('parseRawImageConfig rejects a pattern entry with a missing or non-string match', () => {
    const cases: Array<Record<string, unknown>> = [
      { patterns: [{ width: 64, height: 32 }] },
      { patterns: [{ match: 42, width: 64, height: 32 }] },
      { patterns: [{ match: '', width: 64, height: 32 }] },
    ];

    for (const input of cases) {
      assert.throws(
        () =>
          parseRawImageConfig(
            JSON.stringify(input),
            'D:\\repo\\.rawimagerc',
            'D:\\repo\\frame.raw'
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /"patterns\[0\]\.match" must be a non-empty string/);
          return true;
        }
      );
    }
  });

  test('parseRawImageConfig treats an empty patterns array as no match (unresolved width/height)', () => {
    assert.throws(
      () =>
        parseRawImageConfig(
          JSON.stringify({ patterns: [] }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      /"width" must be a positive integer/
    );
  });

  test('parseRawImageConfig merges duplicate match entries with array-order last-wins', () => {
    // 同一の match を持つエントリが重複していても、単純に配列順で後勝ちマージされる。
    const config = {
      patterns: [
        { match: '*', width: 100, height: 100, format: 'rgb24' },
        { match: '*', format: 'gray8' },
        { match: '*', width: 200 },
      ],
    };
    const configPath = process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';
    const target = process.platform === 'win32' ? 'C:\\repo\\frame.raw' : '/repo/frame.raw';

    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, target), {
      width: 200,
      height: 100,
      headerSize: 0,
      format: 'gray8',
    });
  });

  test('getLocalResourceRoots includes config ancestor and extension webview dir', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows
      ? 'D:\\repo\\images\\nested\\frame.raw'
      : '/repo/images/nested/frame.raw';
    const configPath = isWindows ? 'D:\\repo\\images\\.rawimagerc' : '/repo/images/.rawimagerc';
    const extensionPath = isWindows ? 'D:\\ext' : '/ext';
    const roots = getLocalResourceRoots(
      vscode.Uri.file(filePath),
      vscode.Uri.file(extensionPath),
      configPath
    );

    assert.deepStrictEqual(
      roots.map((root) => path.normalize(root.fsPath).toLowerCase()),
      [
        path
          .normalize(isWindows ? 'D:\\repo\\images\\nested' : '/repo/images/nested')
          .toLowerCase(),
        path.normalize(isWindows ? 'D:\\repo\\images' : '/repo/images').toLowerCase(),
        path.normalize(isWindows ? 'D:\\ext\\out\\webview' : '/ext/out/webview').toLowerCase(),
      ]
    );
  });

  test('getSuggestedPngSaveUri swaps the extension for png', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows ? 'D:\\repo\\images\\frame.gray' : '/repo/images/frame.gray';
    const expectedPath = isWindows ? 'D:\\repo\\images\\frame.png' : '/repo/images/frame.png';

    assert.strictEqual(
      path.normalize(getSuggestedPngSaveUri(vscode.Uri.file(filePath)).fsPath).toLowerCase(),
      path.normalize(expectedPath).toLowerCase()
    );
  });

  test('getConfigSearchDirectories walks from file directory to root', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows
      ? 'D:\\repo\\images\\nested\\frame.raw'
      : '/repo/images/nested/frame.raw';
    assert.deepStrictEqual(
      getConfigSearchDirectories(filePath).map((dir) => path.normalize(dir).toLowerCase()),
      isWindows
        ? [
            path.normalize('D:\\repo\\images\\nested').toLowerCase(),
            path.normalize('D:\\repo\\images').toLowerCase(),
            path.normalize('D:\\repo').toLowerCase(),
            path.normalize('D:\\').toLowerCase(),
          ]
        : [
            path.normalize('/repo/images/nested').toLowerCase(),
            path.normalize('/repo/images').toLowerCase(),
            path.normalize('/repo').toLowerCase(),
            path.normalize('/').toLowerCase(),
          ]
    );
  });

  test('getConfigWatchDirectories stops at the workspace root (inclusive) when inside a workspace', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows
      ? 'D:\\repo\\images\\nested\\frame.raw'
      : '/repo/images/nested/frame.raw';
    const workspaceRoot = isWindows ? 'D:\\repo' : '/repo';

    assert.deepStrictEqual(
      getConfigWatchDirectories(filePath, workspaceRoot).map((dir) =>
        path.normalize(dir).toLowerCase()
      ),
      [
        path
          .normalize(isWindows ? 'D:\\repo\\images\\nested' : '/repo/images/nested')
          .toLowerCase(),
        path.normalize(isWindows ? 'D:\\repo\\images' : '/repo/images').toLowerCase(),
        path.normalize(workspaceRoot).toLowerCase(),
      ]
    );
  });

  test('getConfigWatchDirectories returns only the file directory when outside any workspace', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows
      ? 'D:\\repo\\images\\nested\\frame.raw'
      : '/repo/images/nested/frame.raw';

    assert.deepStrictEqual(
      getConfigWatchDirectories(filePath, undefined).map((dir) =>
        path.normalize(dir).toLowerCase()
      ),
      [path.normalize(isWindows ? 'D:\\repo\\images\\nested' : '/repo/images/nested').toLowerCase()]
    );
  });

  test('getConfigWatchDirectories returns a single entry when the file sits directly under the workspace root', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows ? 'D:\\repo\\frame.raw' : '/repo/frame.raw';
    const workspaceRoot = isWindows ? 'D:\\repo' : '/repo';

    assert.deepStrictEqual(
      getConfigWatchDirectories(filePath, workspaceRoot).map((dir) =>
        path.normalize(dir).toLowerCase()
      ),
      [path.normalize(workspaceRoot).toLowerCase()]
    );
  });

  test('inferRawImageConfigFromFilename extracts dimensions and format', () => {
    assert.deepStrictEqual(
      inferRawImageConfigFromFilename('D:\\repo\\captures\\frame_1920x1080_rgb24.raw'),
      { width: 1920, height: 1080, format: 'rgb24' }
    );
  });

  test('inferRawImageConfigFromFilename recognizes YUV formats', () => {
    assert.deepStrictEqual(
      inferRawImageConfigFromFilename('D:\\repo\\captures\\frame-640x480-yuyv422.yuv'),
      { width: 640, height: 480, format: 'yuyv422' }
    );
  });

  test('resolveFallbackRawImageConfig merges filename inference with settings', () => {
    assert.deepStrictEqual(
      resolveFallbackRawImageConfig('D:\\repo\\captures\\frame_1920x1080.raw', {
        defaultHeaderSize: 128,
        defaultFormat: 'gray8',
      }),
      {
        config: {
          width: 1920,
          height: 1080,
          headerSize: 128,
          format: 'gray8',
        },
        source: 'filename+settings',
      }
    );
  });

  test('resolveFallbackRawImageConfig uses settings when filename has no metadata', () => {
    assert.deepStrictEqual(
      resolveFallbackRawImageConfig('D:\\repo\\captures\\frame.raw', {
        defaultWidth: 640,
        defaultHeight: 480,
        defaultFormat: 'gray8',
      }),
      {
        config: {
          width: 640,
          height: 480,
          headerSize: 0,
          format: 'gray8',
        },
        source: 'settings',
      }
    );
  });

  test('decodePngDataUrl decodes PNG payloads', () => {
    assert.deepStrictEqual(Array.from(decodePngDataUrl('data:image/png;base64,AQID')), [1, 2, 3]);
  });

  test('decodePngDataUrl rejects invalid payloads', () => {
    assert.throws(() => decodePngDataUrl('not-a-data-url'), /Invalid PNG data/);
  });

  test('parseWebviewMessage narrows valid messages and rejects malformed ones', () => {
    assert.deepStrictEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepStrictEqual(
      parseWebviewMessage({ type: 'savePng', dataUrl: 'data:image/png;base64,AQID' }),
      { type: 'savePng', dataUrl: 'data:image/png;base64,AQID' }
    );
    assert.strictEqual(parseWebviewMessage({ type: 'savePng' }), undefined);
    assert.strictEqual(parseWebviewMessage({ type: 'savePng', dataUrl: 42 }), undefined);
    assert.strictEqual(parseWebviewMessage({ type: 'unknown' }), undefined);
    assert.strictEqual(parseWebviewMessage(null), undefined);
    assert.strictEqual(parseWebviewMessage('ready'), undefined);
  });

  test('getBytesPerPixel matches supported stream formats', () => {
    assert.strictEqual(getBytesPerPixel('gray8'), 1);
    assert.strictEqual(getBytesPerPixel('gray16le'), 2);
    assert.strictEqual(getBytesPerPixel('gray16be'), 2);
    assert.strictEqual(getBytesPerPixel('rgb24'), 3);
    assert.strictEqual(getBytesPerPixel('bgr24'), 3);
    assert.strictEqual(getBytesPerPixel('rgba32'), 4);
    assert.strictEqual(getBytesPerPixel('bgra32'), 4);
  });

  test('appendRawImageChunk skips headers and decodes pixels across chunk boundaries', () => {
    const pixels = new Uint8ClampedArray(8);
    const state = createRawImageDecodeState(2, 1, 2, 'rgb24');

    appendRawImageChunk(state, Uint8Array.from([9, 8, 255]), pixels);
    assert.strictEqual(state.pixelsWritten, 0);

    appendRawImageChunk(state, Uint8Array.from([0, 0, 0, 255, 0]), pixels);
    assert.strictEqual(state.pixelsWritten, 2);
    assert.deepStrictEqual(Array.from(pixels), [255, 0, 0, 255, 0, 255, 0, 255]);
  });

  test('appendRawImageChunk decodes gray16 values with split samples', () => {
    const pixels = new Uint8ClampedArray(8);
    const state = createRawImageDecodeState(2, 1, 0, 'gray16le');

    appendRawImageChunk(state, Uint8Array.from([0x34]), pixels);
    assert.strictEqual(state.pixelsWritten, 0);

    appendRawImageChunk(state, Uint8Array.from([0x12, 0xcd, 0xab]), pixels);
    assert.strictEqual(state.pixelsWritten, 2);
    assert.deepStrictEqual(Array.from(pixels), [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 255]);
  });

  test('appendRawImageChunk ignores trailing bytes after expected pixels are filled', () => {
    const pixels = new Uint8ClampedArray(4);
    const state = createRawImageDecodeState(1, 1, 0, 'rgba32');

    appendRawImageChunk(state, Uint8Array.from([1, 2, 3, 4, 200, 201, 202, 203]), pixels);

    assert.strictEqual(state.pixelsWritten, 1);
    assert.deepStrictEqual(Array.from(pixels), [1, 2, 3, 4]);
    assert.strictEqual(state.pendingLength, 0);
  });

  test('createGrayDecodeState initialises state correctly', () => {
    const state = createGrayDecodeState(4, 2, 0, 'gray8');
    assert.strictEqual(state.totalPixels, 8);
    assert.strictEqual(state.bytesPerPixel, 1);
    assert.strictEqual(state.maxValue, 255);
    assert.strictEqual(state.pixelsWritten, 0);

    const state16 = createGrayDecodeState(2, 1, 0, 'gray16le');
    assert.strictEqual(state16.bytesPerPixel, 2);
    assert.strictEqual(state16.maxValue, 65535);
  });

  test('appendGrayChunk decodes gray8 and tracks auto min/max', () => {
    const state = createGrayDecodeState(3, 1, 0, 'gray8');
    appendGrayChunk(state, Uint8Array.from([10, 200, 100]));
    assert.strictEqual(state.pixelsWritten, 3);
    assert.deepStrictEqual(Array.from(state.rawGray), [10, 200, 100]);
    assert.strictEqual(state.autoMin, 10);
    assert.strictEqual(state.autoMax, 200);
  });

  test('appendGrayChunk decodes gray16le across chunk boundaries', () => {
    const state = createGrayDecodeState(2, 1, 0, 'gray16le');
    appendGrayChunk(state, Uint8Array.from([0x34]));
    assert.strictEqual(state.pixelsWritten, 0);
    assert.strictEqual(state.hasPendingByte, true);

    appendGrayChunk(state, Uint8Array.from([0x12, 0xcd, 0xab]));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.deepStrictEqual(Array.from(state.rawGray), [0x1234, 0xabcd]);
    assert.strictEqual(state.autoMin, 0x1234);
    assert.strictEqual(state.autoMax, 0xabcd);
  });

  test('appendGrayChunk decodes gray16be', () => {
    const state = createGrayDecodeState(1, 1, 0, 'gray16be');
    appendGrayChunk(state, Uint8Array.from([0x12, 0x34]));
    assert.strictEqual(state.pixelsWritten, 1);
    assert.strictEqual(state.rawGray[0], 0x1234);
  });

  test('appendGrayChunk skips header bytes', () => {
    const state = createGrayDecodeState(2, 1, 2, 'gray8');
    appendGrayChunk(state, Uint8Array.from([0xff, 0xff, 50, 100]));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.deepStrictEqual(Array.from(state.rawGray), [50, 100]);
  });

  test('applyWindowLevel maps values correctly', () => {
    const rawGray = new Uint16Array([0, 500, 1000]);
    const pixels = new Uint8ClampedArray(12);
    applyWindowLevel(rawGray, 3, 0, 1000, pixels);
    assert.strictEqual(pixels[0], 0);
    assert.strictEqual(pixels[4], 128);
    assert.strictEqual(pixels[8], 255);
    // alpha channels
    assert.strictEqual(pixels[3], 255);
    assert.strictEqual(pixels[7], 255);
    assert.strictEqual(pixels[11], 255);
  });

  test('applyWindowLevel clamps out-of-range values', () => {
    const rawGray = new Uint16Array([50, 200]);
    const pixels = new Uint8ClampedArray(8);
    applyWindowLevel(rawGray, 2, 100, 150, pixels);
    assert.strictEqual(pixels[0], 0); // 50 < min → clamped to 0
    assert.strictEqual(pixels[4], 255); // 200 > max → clamped to 255
  });

  test('applyWindowLevel uses 128 when range is zero', () => {
    const rawGray = new Uint16Array([42]);
    const pixels = new Uint8ClampedArray(4);
    applyWindowLevel(rawGray, 1, 100, 100, pixels);
    assert.strictEqual(pixels[0], 128);
  });

  test('createInitialRenderHandshake sends render exactly once when ready is received', () => {
    type ScheduledTimeout = {
      callback: () => void;
      delay: number;
      cleared: boolean;
    };

    const scheduled: ScheduledTimeout[] = [];
    const scheduleTimeout = (
      callback: () => void,
      delay: number
    ): ReturnType<typeof setTimeout> => {
      const handle: ScheduledTimeout = { callback, delay, cleared: false };
      scheduled.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelTimeout = (handle: ReturnType<typeof setTimeout>): void => {
      (handle as unknown as ScheduledTimeout).cleared = true;
    };
    let sendCount = 0;
    let warningCount = 0;

    const handshake = createInitialRenderHandshake(
      () => {
        sendCount += 1;
      },
      () => {
        warningCount += 1;
      },
      scheduleTimeout,
      cancelTimeout
    );

    // フォールバック送信は撤去されているため、スケジュールされるタイマーは
    // 5秒の ready 未受信警告タイマーのみになる
    assert.deepStrictEqual(
      scheduled.map((timeout) => timeout.delay),
      [5000]
    );

    assert.strictEqual(handshake.handleMessage('ready'), true);
    assert.strictEqual(sendCount, 1);
    assert.strictEqual(warningCount, 0);
    assert.ok(scheduled.every((timeout) => timeout.cleared));
  });

  test('createInitialRenderHandshake warns if ready is never received within 5s', () => {
    type ScheduledTimeout = {
      callback: () => void;
      delay: number;
      cleared: boolean;
    };

    const scheduled: ScheduledTimeout[] = [];
    const scheduleTimeout = (
      callback: () => void,
      delay: number
    ): ReturnType<typeof setTimeout> => {
      const handle: ScheduledTimeout = { callback, delay, cleared: false };
      scheduled.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelTimeout = (handle: ReturnType<typeof setTimeout>): void => {
      (handle as unknown as ScheduledTimeout).cleared = true;
    };
    let sendCount = 0;
    let warningCount = 0;

    createInitialRenderHandshake(
      () => {
        sendCount += 1;
      },
      () => {
        warningCount += 1;
      },
      scheduleTimeout,
      cancelTimeout
    );

    assert.strictEqual(scheduled.length, 1);
    assert.strictEqual(scheduled[0].delay, 5000);

    // 'ready' が一度も届かないまま5秒タイマーが発火したケースをシミュレートする
    scheduled[0].callback();

    assert.strictEqual(warningCount, 1);
    assert.strictEqual(sendCount, 0);
  });

  test('createInitialRenderHandshake sends render only once for duplicate ready messages', () => {
    const scheduleTimeout = (): ReturnType<typeof setTimeout> =>
      1 as unknown as ReturnType<typeof setTimeout>;
    const cancelTimeout = (): void => {
      /* no-op */
    };

    // sendInitialRenderPayload 自体が「送信済みなら無視する」ガードを持つケースを
    // 模して、'ready' の重複受信でも render が1回しか送られないことを検証する
    // （実装では extension.ts 側の initialPayloadSent フラグがこの役割を担う）。
    let payloadSent = false;
    let sendCount = 0;
    let warningCount = 0;

    const handshake = createInitialRenderHandshake(
      () => {
        if (payloadSent) {
          return;
        }
        payloadSent = true;
        sendCount += 1;
      },
      () => {
        warningCount += 1;
      },
      scheduleTimeout,
      cancelTimeout
    );

    assert.strictEqual(handshake.handleMessage('ready'), true);
    assert.strictEqual(handshake.handleMessage('ready'), true);
    assert.strictEqual(sendCount, 1);
    assert.strictEqual(warningCount, 0);
  });

  test('createInitialRenderHandshake dispose clears the warning timer without sending', () => {
    type ScheduledTimeout = {
      cleared: boolean;
    };

    const scheduled: ScheduledTimeout[] = [];
    const scheduleTimeout = (): ReturnType<typeof setTimeout> => {
      const handle: ScheduledTimeout = { cleared: false };
      scheduled.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    };
    const cancelTimeout = (handle: ReturnType<typeof setTimeout>): void => {
      (handle as unknown as ScheduledTimeout).cleared = true;
    };
    let sendCount = 0;
    let warningCount = 0;

    const handshake = createInitialRenderHandshake(
      () => {
        sendCount += 1;
      },
      () => {
        warningCount += 1;
      },
      scheduleTimeout,
      cancelTimeout
    );

    handshake.dispose();

    assert.strictEqual(sendCount, 0);
    assert.strictEqual(warningCount, 0);
    assert.strictEqual(scheduled.length, 1);
    assert.ok(scheduled.every((timeout) => timeout.cleared));
  });

  test('decodeRawImageToRgba decodes yuv420p frames', () => {
    const rgba = decodeRawImageToRgba(
      new Uint8Array([16, 82, 145, 235, 128, 128]),
      2,
      2,
      'yuv420p'
    );

    assert.deepStrictEqual(
      Array.from(rgba),
      [0, 0, 0, 255, 77, 77, 77, 255, 150, 150, 150, 255, 255, 255, 255, 255]
    );
  });

  test('decodeRawImageToRgba decodes nv12 frames', () => {
    const rgba = decodeRawImageToRgba(new Uint8Array([16, 82, 145, 235, 128, 128]), 2, 2, 'nv12');

    assert.deepStrictEqual(
      Array.from(rgba),
      [0, 0, 0, 255, 77, 77, 77, 255, 150, 150, 150, 255, 255, 255, 255, 255]
    );
  });

  test('decodeRawImageToRgba decodes yuyv422 frames', () => {
    const rgba = decodeRawImageToRgba(new Uint8Array([16, 128, 235, 128]), 2, 1, 'yuyv422');

    assert.deepStrictEqual(Array.from(rgba), [0, 0, 0, 255, 255, 255, 255, 255]);
  });

  test('decodeRawImageToRgba: yuv420p (planar) and nv12 (semi-planar) agree on a 4x4 frame with 4 distinct chroma blocks', () => {
    // レビュー指摘対応: 従来の 2x2 テスト(クロマブロック 1 個)では、プレーナー形式と
    // セミプレーナー形式のクロマアドレッシングの違いを検出できなかった。4x4(クロマ
    // ブロック 2x2 = 4 個)にして、各ブロックに異なる (U, V) を割り当てることで
    // アドレッシングの取り違えが起きれば必ずテストが失敗するようにする。
    const width = 4;
    const height = 4;
    const totalPixels = width * height;
    // 輝度は全ピクセル共通の定数にし、色の違いがクロマブロックだけに由来するようにする
    const luma = new Array<number>(totalPixels).fill(180);
    // 2x2 のクロマブロック(cx, cy)ごとに異なる (U, V) を割り当てる
    const chromaUV: Array<[number, number]> = [
      [90, 100], // (cx=0, cy=0)
      [140, 110], // (cx=1, cy=0)
      [160, 200], // (cx=0, cy=1)
      [60, 50], // (cx=1, cy=1)
    ];
    const chromaAt = (cx: number, cy: number): [number, number] => chromaUV[cy * 2 + cx];

    // yuv420p: Y面(16バイト) → U面(2x2=4バイト、行優先) → V面(2x2=4バイト、行優先)
    const yuv420pBytes = new Uint8Array(totalPixels + 4 + 4);
    yuv420pBytes.set(luma, 0);
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const [u, v] = chromaAt(cx, cy);
        yuv420pBytes[totalPixels + cy * 2 + cx] = u;
        yuv420pBytes[totalPixels + 4 + cy * 2 + cx] = v;
      }
    }

    // nv12: Y面(16バイト) → UV面(width=4 × height/2=2 行、U/V がインターリーブ)
    const nv12Bytes = new Uint8Array(totalPixels + totalPixels / 2);
    nv12Bytes.set(luma, 0);
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const [u, v] = chromaAt(cx, cy);
        const base = totalPixels + cy * width + cx * 2;
        nv12Bytes[base] = u;
        nv12Bytes[base + 1] = v;
      }
    }

    const planarRgba = decodeRawImageToRgba(yuv420pBytes, width, height, 'yuv420p');
    const semiRgba = decodeRawImageToRgba(nv12Bytes, width, height, 'nv12');

    assert.deepStrictEqual(
      Array.from(planarRgba),
      Array.from(semiRgba),
      'planar (yuv420p) and semi-planar (nv12) encodings of an equivalent frame must decode identically'
    );

    // 4つのクロマブロックが互いに異なる色であることを確認する
    // (アドレッシングのバグで全ブロックが同じ値を読んでしまうケースを検出するため)
    const topLeftPixelIndex = (cx: number, cy: number): number => cy * 2 * width + cx * 2;
    const blockColors = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ].map(([cx, cy]) => {
      const idx = topLeftPixelIndex(cx, cy) * 4;
      return [planarRgba[idx], planarRgba[idx + 1], planarRgba[idx + 2]].join(',');
    });
    assert.strictEqual(
      new Set(blockColors).size,
      4,
      'expected 4 distinct chroma-driven colors, one per 2x2 quadrant'
    );

    // 輝度が一定なので、各クロマブロック内の全ピクセルは同じ色になるはずである
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const expectedIdx = topLeftPixelIndex(cx, cy) * 4;
        const expected = [
          planarRgba[expectedIdx],
          planarRgba[expectedIdx + 1],
          planarRgba[expectedIdx + 2],
        ];
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const x = cx * 2 + dx;
            const y = cy * 2 + dy;
            const idx = (y * width + x) * 4;
            assert.deepStrictEqual(
              [planarRgba[idx], planarRgba[idx + 1], planarRgba[idx + 2]],
              expected,
              `pixel (${x},${y}) should match quadrant (${cx},${cy}) color`
            );
          }
        }
      }
    }
  });

  test('decodeRawImageToRgba throws when the buffer is short by 1 byte and succeeds at the exact required length (all formats)', () => {
    const width = 4;
    const height = 4;
    for (const descriptor of rawImageFormatDescriptorList) {
      const required = descriptor.requiredBytes(width, height);

      const shortBuffer = new Uint8Array(Math.max(0, required - 1));
      assert.throws(
        () => decodeRawImageToRgba(shortBuffer, width, height, descriptor.name),
        new RegExp(descriptor.name),
        `${descriptor.name}: expected a throw when the buffer is short by 1 byte`
      );

      const exactBuffer = new Uint8Array(required);
      assert.doesNotThrow(
        () => decodeRawImageToRgba(exactBuffer, width, height, descriptor.name),
        `${descriptor.name}: expected success at the exact required length (${required} bytes)`
      );
    }
  });

  test('decodeRawImageToRgba validates YUV frame geometry', () => {
    assert.throws(
      () => decodeRawImageToRgba(new Uint8Array([0, 0, 0]), 3, 2, 'yuv420p'),
      /requires even width and height/
    );
    assert.throws(
      () => decodeRawImageToRgba(new Uint8Array([0, 0, 0, 0]), 3, 1, 'yuyv422'),
      /requires an even width/
    );
  });

  test('createGrayDecodeState initialises depth16 same as gray16le', () => {
    const state = createGrayDecodeState(2, 1, 0, 'depth16');
    assert.strictEqual(state.bytesPerPixel, 2);
    assert.strictEqual(state.maxValue, 65535);
    assert.strictEqual(state.totalPixels, 2);
  });

  test('appendGrayChunk decodes depth16 as little-endian', () => {
    const state = createGrayDecodeState(2, 1, 0, 'depth16');
    appendGrayChunk(state, Uint8Array.from([0x34, 0x12, 0xcd, 0xab]));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.strictEqual(state.rawGray[0], 0x1234);
    assert.strictEqual(state.rawGray[1], 0xabcd);
  });

  test('appendGrayChunk decodes depth16 across chunk boundaries', () => {
    const state = createGrayDecodeState(2, 1, 0, 'depth16');
    appendGrayChunk(state, Uint8Array.from([0x34]));
    assert.strictEqual(state.pixelsWritten, 0);
    assert.strictEqual(state.hasPendingByte, true);

    appendGrayChunk(state, Uint8Array.from([0x12, 0xcd, 0xab]));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.strictEqual(state.rawGray[0], 0x1234);
    assert.strictEqual(state.rawGray[1], 0xabcd);
  });

  test('decodeRawImageToRgba decodes depth16 as 16-bit little-endian grayscale', () => {
    // 0x0000 → 0, 0xff00 → 255 (upper byte used after >> 8)
    const data = new Uint8Array([0x00, 0x00, 0x00, 0xff]);
    const rgba = decodeRawImageToRgba(data, 2, 1, 'depth16');
    assert.strictEqual(rgba[0], 0); // pixel 0 R
    assert.strictEqual(rgba[4], 255); // pixel 1 R
    assert.strictEqual(rgba[3], 255); // pixel 0 alpha
    assert.strictEqual(rgba[7], 255); // pixel 1 alpha
  });

  test('createFloat32DecodeState initialises state correctly', () => {
    const state = createFloat32DecodeState(4, 2, 0);
    assert.strictEqual(state.totalPixels, 8);
    assert.strictEqual(state.pixelsWritten, 0);
    assert.strictEqual(state.pendingLength, 0);
    assert.strictEqual(state.autoMin, Infinity);
    assert.strictEqual(state.autoMax, -Infinity);
    assert.strictEqual(state.rawGrayF32.length, 8);
  });

  test('appendFloat32Chunk decodes little-endian float32 pixels', () => {
    const state = createFloat32DecodeState(2, 1, 0);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat32(0, 1.5, true);
    view.setFloat32(4, 3.0, true);
    appendFloat32Chunk(state, new Uint8Array(buf));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.ok(Math.abs(state.rawGrayF32[0] - 1.5) < 1e-5);
    assert.ok(Math.abs(state.rawGrayF32[1] - 3.0) < 1e-5);
    assert.ok(Math.abs(state.autoMin - 1.5) < 1e-5);
    assert.ok(Math.abs(state.autoMax - 3.0) < 1e-5);
  });

  test('appendFloat32Chunk decodes float32 across chunk boundaries', () => {
    const state = createFloat32DecodeState(1, 1, 0);
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, 2.5, true);
    const bytes = new Uint8Array(buf);
    appendFloat32Chunk(state, bytes.subarray(0, 2));
    assert.strictEqual(state.pixelsWritten, 0);
    appendFloat32Chunk(state, bytes.subarray(2));
    assert.strictEqual(state.pixelsWritten, 1);
    assert.ok(Math.abs(state.rawGrayF32[0] - 2.5) < 1e-5);
  });

  test('appendFloat32Chunk skips header bytes', () => {
    const state = createFloat32DecodeState(1, 1, 4);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat32(4, 7.0, true);
    appendFloat32Chunk(state, new Uint8Array(buf));
    assert.strictEqual(state.pixelsWritten, 1);
    assert.ok(Math.abs(state.rawGrayF32[0] - 7.0) < 1e-5);
  });

  test('appendFloat32Chunk ignores NaN values in auto min/max', () => {
    const state = createFloat32DecodeState(2, 1, 0);
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat32(0, NaN, true);
    view.setFloat32(4, 5.0, true);
    appendFloat32Chunk(state, new Uint8Array(buf));
    assert.strictEqual(state.pixelsWritten, 2);
    assert.ok(Math.abs(state.autoMin - 5.0) < 1e-5);
    assert.ok(Math.abs(state.autoMax - 5.0) < 1e-5);
  });

  test('decodeRawImageToRgba decodes float32 with auto normalization', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat32(0, 0.0, true);
    view.setFloat32(4, 1.0, true);
    const rgba = decodeRawImageToRgba(new Uint8Array(buf), 2, 1, 'float32');
    assert.strictEqual(rgba[0], 0); // min value → 0
    assert.strictEqual(rgba[4], 255); // max value → 255
    assert.strictEqual(rgba[3], 255); // alpha
    assert.strictEqual(rgba[7], 255); // alpha
  });

  test('decodeRawImageToRgba handles float32 NaN as black', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setFloat32(0, NaN, true);
    view.setFloat32(4, 1.0, true);
    const rgba = decodeRawImageToRgba(new Uint8Array(buf), 2, 1, 'float32');
    assert.strictEqual(rgba[0], 0); // NaN → black
  });

  test('applyWindowLevel accepts Float32Array', () => {
    const rawGray = new Float32Array([0.0, 0.5, 1.0]);
    const pixels = new Uint8ClampedArray(12);
    applyWindowLevel(rawGray, 3, 0.0, 1.0, pixels);
    assert.strictEqual(pixels[0], 0);
    assert.strictEqual(pixels[4], 128);
    assert.strictEqual(pixels[8], 255);
    assert.strictEqual(pixels[3], 255);
  });

  test('parseRawImageConfig applies glob pattern overrides', () => {
    const config = {
      patterns: [
        {
          match: '*',
          width: 100,
          height: 100,
        },
        {
          match: '**/thumbnails/*.bin',
          width: 32,
          height: 32,
        },
        {
          match: '*.depth',
          format: 'depth16',
        },
      ],
    };
    const configPath = process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';

    // Match thumbnail pattern (nested under a subdirectory)
    const thumbFile =
      process.platform === 'win32'
        ? 'C:\\repo\\data\\thumbnails\\icon.bin'
        : '/repo/data/thumbnails/icon.bin';
    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, thumbFile), {
      width: 32,
      height: 32,
      headerSize: 0,
      format: 'rgb24',
    });

    // Match depth pattern
    const depthFile = process.platform === 'win32' ? 'C:\\repo\\frame.depth' : '/repo/frame.depth';
    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, depthFile), {
      width: 100,
      height: 100,
      headerSize: 0,
      format: 'depth16',
    });

    // No match
    const otherFile = process.platform === 'win32' ? 'C:\\repo\\other.raw' : '/repo/other.raw';
    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, otherFile), {
      width: 100,
      height: 100,
      headerSize: 0,
      format: 'rgb24',
    });
  });

  test('parseRawImageConfig **/ matches top-level directory relative to config', () => {
    // **/thumbnails/*.bin must match thumbnails/icon.bin (no leading path segment),
    // not just sub/thumbnails/icon.bin — this was a bug in the original globToRegExp.
    const config = {
      patterns: [
        { match: '*', width: 100, height: 100 },
        { match: '**/thumbnails/*.bin', width: 32, height: 32 },
      ],
    };
    const configPath = process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';

    // File sits directly inside thumbnails/ — no intermediate path segment
    const topLevelThumb =
      process.platform === 'win32' ? 'C:\\repo\\thumbnails\\icon.bin' : '/repo/thumbnails/icon.bin';
    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, topLevelThumb), {
      width: 32,
      height: 32,
      headerSize: 0,
      format: 'rgb24',
    });

    // File sits two levels deep — should also match
    const deepThumb =
      process.platform === 'win32'
        ? 'C:\\repo\\a\\b\\thumbnails\\icon.bin'
        : '/repo/a/b/thumbnails/icon.bin';
    assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, deepThumb), {
      width: 32,
      height: 32,
      headerSize: 0,
      format: 'rgb24',
    });
  });

  test('parseRawImageConfig ignores patterns when target is outside the config directory', () => {
    // 対象ファイルが configDir の外側（相対パスが ".." 始まり）にある場合、
    // "**" のような広いパターンでも誤ってマッチしてはならない。
    // Windows のクロスドライブ（path.relative が絶対パスを返す）も同じガードで防ぐ。
    const config = { patterns: [{ match: '**', width: 100, height: 100 }] };
    const configPath =
      process.platform === 'win32' ? 'C:\\repo\\sub\\.rawimagerc' : '/repo/sub/.rawimagerc';
    const outsideFile = process.platform === 'win32' ? 'C:\\repo\\other.raw' : '/repo/other.raw';

    // どのパターンにもマッチしない → width が未解決でエラーになる
    assert.throws(
      () => parseRawImageConfig(JSON.stringify(config), configPath, outsideFile),
      /"width" must be a positive integer/
    );
  });

  test('parseRawImageConfig respects array order for last-wins merging', () => {
    // 配列順は構文上明示されるため、キー名の見た目（例: 数字っぽい文字列）に関わらず
    // 記述（配列）順どおりに後勝ちする。
    const raw = JSON.stringify({
      patterns: [
        { match: '*', width: 8, height: 8, format: 'rgb24' },
        { match: '12', width: 8, height: 8, format: 'gray8' },
      ],
    });
    const configPath = process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';
    // 相対パスが "12" になり、"*" と "12" の両方に一致する
    const target = process.platform === 'win32' ? 'C:\\repo\\12' : '/repo/12';

    const result = parseRawImageConfig(raw, configPath, target);
    assert.strictEqual(
      result.format,
      'gray8',
      'later-in-array pattern ("12") must win over earlier "*"'
    );

    // 逆順（"12" が先、"*" が後）なら "*" が勝つ
    const rawReversed = JSON.stringify({
      patterns: [
        { match: '12', width: 8, height: 8, format: 'gray8' },
        { match: '*', width: 8, height: 8, format: 'rgb24' },
      ],
    });
    assert.strictEqual(parseRawImageConfig(rawReversed, configPath, target).format, 'rgb24');
  });

  test('rawimagerc.schema.json format enum matches extension supported formats', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'rawimagerc.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaContent) as {
      definitions: {
        patternEntry: {
          properties: {
            format: {
              enum: string[];
              enumDescriptions: string[];
            };
          };
        };
      };
    };
    const schemaFormats: string[] = schema.definitions.patternEntry.properties.format.enum;
    assert.deepStrictEqual(schemaFormats, [...supportedFormats]);
    assert.strictEqual(
      schema.definitions.patternEntry.properties.format.enumDescriptions.length,
      schemaFormats.length,
      'enumDescriptions count must match enum count'
    );
  });

  test('rawimagerc.schema.json enumDescriptions match the src/formats.ts descriptor table', () => {
    // スキーマの enumDescriptions と、Webview ヘルプテーブルが参照する
    // formats.ts の description は同じ文言を使う設計。乖離すると Webview の
    // ヘルプテーブルと .rawimagerc の補完ヒントで説明が食い違ってしまう。
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'rawimagerc.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      definitions: { patternEntry: { properties: { format: { enumDescriptions: string[] } } } };
    };
    assert.deepStrictEqual(
      schema.definitions.patternEntry.properties.format.enumDescriptions,
      rawImageFormatDescriptorList.map((descriptor) => descriptor.description)
    );
  });

  test('supportedFormats/streamDecodableFormats/grayscaleStreamFormats are derived from the src/formats.ts descriptor table', () => {
    assert.deepStrictEqual(
      [...supportedFormats],
      rawImageFormatDescriptorList.map((descriptor) => descriptor.name)
    );
    assert.deepStrictEqual(
      [...streamDecodableFormats],
      rawImageFormatDescriptorList.filter((descriptor) => descriptor.streamable).map((d) => d.name)
    );
    assert.deepStrictEqual(
      [...grayscaleStreamFormats],
      rawImageFormatDescriptorList
        .filter((descriptor) => descriptor.grayscaleStream)
        .map((d) => d.name)
    );
  });

  test('package.json rawviewer.defaultFormat enum matches extension supported formats', () => {
    // contributes.configuration の enum が types.ts の supportedFormats と
    // 乖離すると、設定 UI に存在しないフォーマットが並ぶ・新フォーマットが
    // 選べないといった不整合が起きるため、両者の一致を検証する。
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      contributes: {
        configuration: {
          properties: Record<string, { enum?: string[] }>;
        };
      };
    };
    const enumValues =
      packageJson.contributes.configuration.properties['rawviewer.defaultFormat'].enum;
    assert.deepStrictEqual(enumValues, [...supportedFormats]);
  });

  test('package.json customEditors splits selectors by priority: raw-only extensions default, generic binary extensions option', () => {
    // .bin/.data/.img はファームウェアやディスクイメージなど raw 画像とは限らない
    // 汎用バイナリ拡張子であるため、インストールしただけで自動的にビューアが
    // 乗っ取らないよう priority: "option" で登録し、.raw/.gray/.yuv のみ
    // priority: "default"（自動オープン）を維持する設計になっている。
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      contributes: {
        customEditors: Array<{
          viewType: string;
          selector: Array<{ filenamePattern: string }>;
          priority: string;
        }>;
      };
    };

    const customEditors = packageJson.contributes.customEditors;
    assert.strictEqual(customEditors.length, 2, 'expected exactly 2 customEditors entries');

    const byViewType = new Map(customEditors.map((entry) => [entry.viewType, entry]));

    const defaultEditor = byViewType.get('rawviewer.rawImageEditor');
    assert.ok(defaultEditor, 'rawviewer.rawImageEditor entry must exist');
    assert.strictEqual(defaultEditor.priority, 'default');
    assert.deepStrictEqual(
      defaultEditor.selector.map((s) => s.filenamePattern),
      ['*.raw', '*.gray', '*.yuv']
    );

    const optionalEditor = byViewType.get('rawviewer.rawImageEditorOptional');
    assert.ok(optionalEditor, 'rawviewer.rawImageEditorOptional entry must exist');
    assert.strictEqual(optionalEditor.priority, 'option');
    assert.deepStrictEqual(
      optionalEditor.selector.map((s) => s.filenamePattern),
      ['*.bin', '*.data', '*.img']
    );

    // 2 エントリを合わせても viewType は重複しない
    assert.strictEqual(byViewType.size, 2);
  });

  test('findConfigPath discovers .rawimagerc from nested paths and loadRawImageConfig loads it', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rawviewer-config-test-'));
    try {
      const configPath = path.join(tmpRoot, '.rawimagerc');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          patterns: [{ match: '**', width: 12, height: 34, headerSize: 2, format: 'gray8' }],
        }),
        'utf8'
      );
      const nestedDir = path.join(tmpRoot, 'a', 'b');
      fs.mkdirSync(nestedDir, { recursive: true });
      const targetFile = path.join(nestedDir, 'frame.raw');
      fs.writeFileSync(targetFile, Buffer.alloc(4));

      // ネストしたサブディレクトリのファイルから上方向探索で発見できる
      assert.strictEqual(findConfigPath(targetFile), configPath);

      // 発見した設定ファイルを正しくロード・解決できる
      assert.deepStrictEqual(loadRawImageConfig(configPath, targetFile), {
        width: 12,
        height: 34,
        headerSize: 2,
        format: 'gray8',
      });
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('findConfigPath returns undefined when no .rawimagerc exists in the temp tree', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rawviewer-noconfig-test-'));
    try {
      const targetFile = path.join(tmpRoot, 'frame.raw');
      fs.writeFileSync(targetFile, Buffer.alloc(1));

      const found = findConfigPath(targetFile);
      // os.tmpdir() の祖先ディレクトリに .rawimagerc が存在する環境でも壊れない
      // よう、「一時ディレクトリ配下では見つからない」ことを検証する
      assert.ok(
        found === undefined || !found.startsWith(tmpRoot),
        `expected no .rawimagerc inside ${tmpRoot}, but found ${found}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('resolveFallbackRawImageConfig returns null config when nothing resolves', () => {
    assert.deepStrictEqual(resolveFallbackRawImageConfig('/repo/captures/frame.raw', {}), {
      config: null,
    });
  });

  test('resolveFallbackRawImageConfig resolves from filename inference alone', () => {
    assert.deepStrictEqual(
      resolveFallbackRawImageConfig('/repo/captures/frame_640x480_gray8.raw'),
      {
        config: {
          width: 640,
          height: 480,
          headerSize: 0,
          format: 'gray8',
        },
        source: 'filename',
      }
    );
  });

  test('decodeRawImageToRgba decodes grayscale batch formats', () => {
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([0, 128, 255]), 3, 1, 'gray8')),
      [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]
    );
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([0x34, 0x12, 0xcd, 0xab]), 2, 1, 'gray16le')),
      [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 255]
    );
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([0x12, 0x34, 0xab, 0xcd]), 2, 1, 'gray16be')),
      [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 255]
    );
  });

  test('decodeRawImageToRgba decodes interleaved RGB-family batch formats', () => {
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, 1, 'rgb24')),
      [1, 2, 3, 255, 4, 5, 6, 255]
    );
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6]), 2, 1, 'bgr24')),
      [3, 2, 1, 255, 6, 5, 4, 255]
    );
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1, 'rgba32')),
      [1, 2, 3, 4, 5, 6, 7, 8]
    );
    assert.deepStrictEqual(
      Array.from(decodeRawImageToRgba(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 2, 1, 'bgra32')),
      [3, 2, 1, 4, 7, 6, 5, 8]
    );
  });

  // グレースケール系フォーマットについて、ストリーミング経路と一括経路が
  // 同一入力から同一の結果を生成することを検証する等価性テスト。
  //
  // 注意: gray16 系の GrayDecodeState 経路（appendGrayChunk + applyWindowLevel）は
  // ウィンドウ/レベルによる線形マッピング（round(v / 65535 * 255)）を行うため、
  // 上位バイト抽出（v >> 8）を行う一括経路とは表示マッピングが仕様上異なる。
  // したがって gray16 系の RGBA バイト一致は「同じ >> 8 マッピングを使う」
  // appendRawImageChunk ストリーミング経路と比較する。GrayDecodeState 経路は
  // チャンク分割の有無で rawGray と RGBA が一致することを検証する。
  suite('Grayscale streaming vs batch equivalence', () => {
    function decodeViaRawImageStream(
      data: Uint8Array,
      width: number,
      height: number,
      format: StreamDecodableRawImageFormat,
      chunkSize: number
    ): Uint8ClampedArray {
      const pixels = new Uint8ClampedArray(width * height * 4);
      const state = createRawImageDecodeState(width, height, 0, format);
      for (let i = 0; i < data.length; i += chunkSize) {
        appendRawImageChunk(state, data.subarray(i, Math.min(i + chunkSize, data.length)), pixels);
      }
      return pixels;
    }

    function decodeGrayStream(
      data: Uint8Array,
      width: number,
      height: number,
      format: GrayscaleStreamFormat,
      chunkSize: number
    ): { rawGray: Uint16Array; maxValue: number } {
      const state = createGrayDecodeState(width, height, 0, format);
      for (let i = 0; i < data.length; i += chunkSize) {
        appendGrayChunk(state, data.subarray(i, Math.min(i + chunkSize, data.length)));
      }
      return { rawGray: state.rawGray, maxValue: state.maxValue };
    }

    const gray8Data = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const gray16Data = Uint8Array.from([
      0x00, 0x00, 0x34, 0x12, 0xff, 0x00, 0x00, 0xff, 0xcd, 0xab, 0xff, 0xff,
    ]);

    test('appendRawImageChunk stream matches decodeRawImageToRgba batch (gray8/gray16le/gray16be)', () => {
      const cases: Array<[StreamDecodableRawImageFormat, Uint8Array]> = [
        ['gray8', gray8Data],
        ['gray16le', gray16Data],
        ['gray16be', gray16Data],
      ];
      for (const [format, data] of cases) {
        const batch = decodeRawImageToRgba(data, 3, 2, format);
        // チャンク境界でピクセルが分断されるよう 1 バイトずつ供給する
        for (const chunkSize of [1, 3, data.length]) {
          const streamed = decodeViaRawImageStream(data, 3, 2, format, chunkSize);
          assert.deepStrictEqual(
            Array.from(streamed),
            Array.from(batch),
            `${format} (chunkSize=${chunkSize}) stream/batch mismatch`
          );
        }
      }
    });

    test('appendGrayChunk chunked matches single-pass rawGray and RGBA (gray8/gray16le/gray16be/depth16)', () => {
      const cases: Array<[GrayscaleStreamFormat, Uint8Array]> = [
        ['gray8', gray8Data],
        ['gray16le', gray16Data],
        ['gray16be', gray16Data],
        ['depth16', gray16Data],
      ];
      for (const [format, data] of cases) {
        const single = decodeGrayStream(data, 3, 2, format, data.length);
        const chunked = decodeGrayStream(data, 3, 2, format, 1);
        assert.deepStrictEqual(
          Array.from(chunked.rawGray),
          Array.from(single.rawGray),
          `${format} rawGray mismatch between chunked and single-pass`
        );

        const singlePixels = new Uint8ClampedArray(3 * 2 * 4);
        const chunkedPixels = new Uint8ClampedArray(3 * 2 * 4);
        applyWindowLevel(single.rawGray, 6, 0, single.maxValue, singlePixels);
        applyWindowLevel(chunked.rawGray, 6, 0, chunked.maxValue, chunkedPixels);
        assert.deepStrictEqual(
          Array.from(chunkedPixels),
          Array.from(singlePixels),
          `${format} RGBA mismatch between chunked and single-pass`
        );
      }
    });

    test('gray8: appendGrayChunk + full-range window matches batch decodeRawImageToRgba', () => {
      // gray8 は全レンジ（0..255）のウィンドウで恒等マッピングになるため、
      // GrayDecodeState 経路と一括経路が RGBA バイト単位で一致する。
      const { rawGray } = decodeGrayStream(gray8Data, 3, 2, 'gray8', 1);
      const streamedPixels = new Uint8ClampedArray(3 * 2 * 4);
      applyWindowLevel(rawGray, 6, 0, 255, streamedPixels);
      const batch = decodeRawImageToRgba(gray8Data, 3, 2, 'gray8');
      assert.deepStrictEqual(Array.from(streamedPixels), Array.from(batch));
    });

    test('depth16 batch decode is identical to gray16le batch decode (shared implementation)', () => {
      const le = decodeRawImageToRgba(gray16Data, 3, 2, 'gray16le');
      const depth = decodeRawImageToRgba(gray16Data, 3, 2, 'depth16');
      assert.deepStrictEqual(Array.from(depth), Array.from(le));
    });

    test('appendGrayChunk raw values agree with decodeRawPixel >> 8 display values', () => {
      // GrayDecodeState が保持する生値の上位バイトは、decodeRawPixel が返す
      // 表示値（>> 8）と一致していなければならない（同じ共有ヘルパーに基づく）。
      const formats: Array<'gray16le' | 'gray16be'> = ['gray16le', 'gray16be'];
      for (const format of formats) {
        const { rawGray } = decodeGrayStream(gray16Data, 3, 2, format, 2);
        for (let p = 0; p < 6; p++) {
          const [r] = decodeRawPixel(gray16Data, p * 2, format);
          assert.strictEqual(rawGray[p] >> 8, r, `${format} pixel ${p}`);
        }
      }
    });
  });

  test('buildWebviewHtml emits a nonce script tag pointing at the given scriptUri', () => {
    const html = buildWebviewHtml('https://example.com', 'https://example.com/out/webview/main.js');
    const match = html.match(/<script nonce="([^"]+)" src="([^"]+)"><\/script>/);
    assert.ok(match, 'expected a nonce+src script tag in the generated webview HTML');
    assert.strictEqual(match![2], 'https://example.com/out/webview/main.js');
    assert.ok(
      html.includes(`script-src 'nonce-${match![1]}'`),
      'expected the CSP script-src directive to reference the same nonce as the script tag'
    );
  });

  // out/webview/main.js（esbuild が src/webview/main.ts をバンドルしたもの）を
  // Node の vm モジュールで実際に実行し、構文エラーやハンドラ内の未定義参照が
  // 起きないことを検証するスモークテスト。
  //
  // 以前は webviewHtml.ts の <script nonce="..."> インライン文字列から抽出した
  // JS を実行していたが、レンダリングロジックが src/webview/main.ts (TypeScript)
  // に移り esbuild でバンドルされるようになったため、実際に読み込まれる成果物
  // である out/webview/main.js を直接検証する。
  //
  // 旧テスト「embedded gray16 decode paths run in the webview script without
  // ReferenceError」は削除した。これは decoder.ts を `.toString()` で文字列化して
  // 埋め込む際の「埋め込み漏れ」を検出するためのテストだったが、現在は ES import +
  // esbuild バンドルに置き換わり、埋め込み漏れという失敗モード自体が構造的に
  // 存在しない（import が壊れていれば tsc/esbuild がビルド時に失敗する）。
  // decoder.ts の各関数（appendGrayChunk / decodeRawImageToRgba 等）は本ファイル
  // 上部で既に直接 import してテスト済みのため、重複したカバレッジも解消される。
  suite('Webview bundle smoke test', () => {
    function readWebviewBundle(): string {
      const bundlePath = path.join(__dirname, '..', 'webview', 'main.js');
      assert.ok(
        fs.existsSync(bundlePath),
        `expected esbuild bundle at ${bundlePath}; run "npm run compile" first`
      );
      return fs.readFileSync(bundlePath, 'utf8');
    }

    // document.getElementById('root') / createElement() が返す最小の要素スタブ。
    function createElementStub(tag?: string): Record<string, unknown> {
      const el: Record<string, unknown> = {
        className: '',
        innerHTML: '',
        textContent: '',
        style: {},
        children: [] as unknown[],
        classList: {
          add() {
            /* no-op */
          },
          remove() {
            /* no-op */
          },
          contains() {
            return false;
          },
        },
        appendChild(child: unknown) {
          (el.children as unknown[]).push(child);
          return child;
        },
        addEventListener() {
          /* no-op */
        },
        removeEventListener() {
          /* no-op */
        },
        setAttribute() {
          /* no-op */
        },
        getAttribute() {
          return null;
        },
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 1, height: 1 };
        },
      };
      if (tag === 'canvas') {
        el.width = 0;
        el.height = 0;
        el.getContext = (type: string) => {
          if (type !== '2d') {
            return null;
          }
          return {
            createImageData(w: number, h: number) {
              return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData() {
              /* no-op */
            },
          };
        };
        el.toDataURL = () => 'data:image/png;base64,';
      }
      return el;
    }

    function createWebviewVmContext(fetchImpl?: (...args: unknown[]) => Promise<unknown>): {
      context: Record<string, unknown>;
      root: Record<string, unknown>;
      messageListeners: Array<(event: { data: unknown }) => void>;
      postedMessages: unknown[];
      windowListenerCounts: Record<string, number>;
      resizeObserverState: { instancesCreated: number; disconnectCalls: number };
    } {
      const root = createElementStub();
      const messageListeners: Array<(event: { data: unknown }) => void> = [];
      const postedMessages: unknown[] = [];
      const windowListenerCounts: Record<string, number> = {};
      // ResizeObserver の生成数・disconnect() 呼び出し回数を追跡する（①のリーク回帰テスト用）。
      const resizeObserverState = { instancesCreated: 0, disconnectCalls: 0 };

      const windowStub = {
        addEventListener(type: string, handler: (event: { data: unknown }) => void) {
          if (type === 'message') {
            messageListeners.push(handler);
          }
          windowListenerCounts[type] = (windowListenerCounts[type] || 0) + 1;
        },
        removeEventListener(type: string) {
          windowListenerCounts[type] = (windowListenerCounts[type] || 0) - 1;
        },
      };

      const documentStub = {
        getElementById(id: string) {
          return id === 'root' ? root : null;
        },
        createElement(tag: string) {
          return createElementStub(tag);
        },
        createTextNode(text: string) {
          return { nodeType: 3, textContent: text };
        },
      };

      const context: Record<string, unknown> = {
        window: windowStub,
        document: documentStub,
        acquireVsCodeApi() {
          return {
            postMessage(msg: unknown) {
              postedMessages.push(msg);
            },
          };
        },
        setInterval() {
          return 1;
        },
        clearInterval() {
          /* no-op */
        },
        setTimeout() {
          return 1;
        },
        clearTimeout() {
          /* no-op */
        },
        requestAnimationFrame(cb: () => void) {
          cb();
          return 1;
        },
        ResizeObserver: function ResizeObserverStub() {
          resizeObserverState.instancesCreated += 1;
          return {
            observe() {
              /* no-op */
            },
            disconnect() {
              resizeObserverState.disconnectCalls += 1;
            },
          };
        },
        fetch:
          fetchImpl ??
          (() => Promise.reject(new Error('fetch should not be reached in this smoke test'))),
        AbortController: function AbortControllerStub() {
          return { abort() {}, signal: {} };
        },
        console,
      };
      vm.createContext(context);

      return {
        context,
        root,
        messageListeners,
        postedMessages,
        windowListenerCounts,
        resizeObserverState,
      };
    }

    function runWebviewScript(fetchImpl?: (...args: unknown[]) => Promise<unknown>): {
      dispatchMessage: (data: unknown) => void;
      root: Record<string, unknown>;
      postedMessages: unknown[];
      windowListenerCounts: Record<string, number>;
      resizeObserverState: { instancesCreated: number; disconnectCalls: number };
    } {
      const script = readWebviewBundle();
      const {
        context,
        root,
        messageListeners,
        postedMessages,
        windowListenerCounts,
        resizeObserverState,
      } = createWebviewVmContext(fetchImpl);

      // 構文エラーやハンドラ内の未定義参照があればここで例外が発生する。
      vm.runInContext(script, context);

      assert.strictEqual(messageListeners.length, 1, 'expected exactly one message listener');

      return {
        dispatchMessage: (data: unknown) => messageListeners[0]({ data }),
        root,
        postedMessages,
        windowListenerCounts,
        resizeObserverState,
      };
    }

    test('render message with no config does not throw and shows the no-config guide', () => {
      const { dispatchMessage, root } = runWebviewScript();

      assert.doesNotThrow(() => {
        dispatchMessage({
          type: 'render',
          config: null,
          configSource: 'settings',
          fileUri: 'x',
          fileSize: 0,
        });
      });

      assert.ok(
        String(root.innerHTML).includes('No .rawimagerc'),
        'expected the no-config guide to be rendered'
      );
    });

    test('render message with insufficient file data shows an explicit error instead of decoding', () => {
      // フォーマット・解像度に対してファイルが小さすぎる場合、以前はストリーミング系
      // フォーマットで無警告の黒画像になっていた。fetch が一切呼ばれないこと(= デコードに
      // 入らないこと)と、明示的なエラーメッセージが表示されることの両方を検証する。
      let fetchCalled = false;
      const fetchStub = () => {
        fetchCalled = true;
        return Promise.reject(new Error('fetch should not be called when data is insufficient'));
      };

      const { dispatchMessage, root } = runWebviewScript(fetchStub as never);

      assert.doesNotThrow(() => {
        dispatchMessage({
          type: 'render',
          // gray8 は 4x4 = 16 バイト必要だが、ファイルは 4 バイトしかない
          config: { width: 4, height: 4, headerSize: 0, format: 'gray8' },
          configSource: 'rawimagerc',
          fileUri: 'x',
          fileSize: 4,
        });
      });

      assert.strictEqual(
        fetchCalled,
        false,
        'expected decoding not to start when data is insufficient'
      );
      assert.ok(
        String(root.innerHTML).includes('Insufficient data'),
        'expected an explicit insufficient-data error message'
      );
      assert.ok(String(root.innerHTML).includes('gray8'), 'expected the format name in the error');
    });

    test('render message with an odd-width yuv420p config shows an error before fetching', () => {
      // yuv420p は幅・高さともに偶数である必要がある（src/formats.ts の
      // evenWidthRequired/evenHeightRequired）。以前はこの制約が decoder.ts の一括デコード
      // 経路でのみ検証されていたため、fetch 開始後にしかエラーにならなかった。
      // decoder.ts の validateEvenDimensions を fetch 前に呼ぶようになったため、
      // fetch には一切到達しないことを検証する。
      let fetchCalled = false;
      const fetchStub = () => {
        fetchCalled = true;
        return Promise.reject(new Error('fetch should not be called for an invalid odd width'));
      };

      const { dispatchMessage, root } = runWebviewScript(fetchStub as never);

      assert.doesNotThrow(() => {
        dispatchMessage({
          type: 'render',
          // yuv420p 3x4: 幅が奇数。requiredBytes = ceil(3*4*1.5) = 18 バイトなので、
          // データ不足チェックには引っかからないようにファイルサイズを十分にしておく。
          config: { width: 3, height: 4, headerSize: 0, format: 'yuv420p' },
          configSource: 'rawimagerc',
          fileUri: 'x',
          fileSize: 18,
        });
      });

      assert.strictEqual(
        fetchCalled,
        false,
        'expected fetch not to be called when the even-dimension constraint is violated'
      );
      assert.ok(
        String(root.innerHTML).includes('even width'),
        'expected an explicit even-dimension error message'
      );
    });

    test('error message does not throw and displays the error text', () => {
      const { dispatchMessage, root } = runWebviewScript();

      assert.doesNotThrow(() => {
        dispatchMessage({ type: 'error', message: 'boom' });
      });

      assert.ok(
        String(root.innerHTML).includes('boom'),
        'expected the error message to be rendered'
      );
    });

    test('render does not accumulate window mousemove/mouseup listeners across repeated renders', async () => {
      // 修正: パン操作用の window リスナー（mousemove/mouseup）は、以前は render
      // のたびに新規登録されるだけで解除されず、リスナーリークになっていた
      // （再描画のたびに登録数が増え続ける）。1x1 gray8 画像を成功パスで2回連続
      // レンダリングし、正味の登録数が 1 のまま増えないことを検証する。
      const fetchStub = () =>
        Promise.resolve({
          ok: true,
          body: null,
          arrayBuffer: () => Promise.resolve(new Uint8Array([128]).buffer),
        });

      const { dispatchMessage, windowListenerCounts } = runWebviewScript(fetchStub as never);

      const renderMessage = {
        type: 'render',
        config: { width: 1, height: 1, headerSize: 0, format: 'gray8' },
        configSource: 'rawimagerc',
        fileUri: 'x',
        fileSize: 1,
      };

      dispatchMessage(renderMessage);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(
        windowListenerCounts.mousemove,
        1,
        'expected exactly one mousemove listener after the first render'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        1,
        'expected exactly one mouseup listener after the first render'
      );

      dispatchMessage(renderMessage);
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(
        windowListenerCounts.mousemove,
        1,
        'mousemove listeners must not accumulate across renders'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        1,
        'mouseup listeners must not accumulate across renders'
      );
    });

    test('a successful render followed by a config:null render releases the previous ResizeObserver and window listeners', async () => {
      // 修正: 以前は render ハンドラのクリーンアップ（ResizeObserver.disconnect() /
      // window リスナー解除 / fetch の abort）が !config などの早期 return より後にあった
      // ため、「成功表示 → config:null render」という遷移で旧 canvas の ResizeObserver と
      // window リスナーが解放されずに残っていた（リーク）。releaseActiveRenderResources()
      // を早期 return より前に呼ぶようになったことで、この遷移後にリスナー数が 0 に戻り
      // ResizeObserver が disconnect されることを検証する。
      const fetchStub = () =>
        Promise.resolve({
          ok: true,
          body: null,
          arrayBuffer: () => Promise.resolve(new Uint8Array([128]).buffer),
        });

      const { dispatchMessage, windowListenerCounts, resizeObserverState } = runWebviewScript(
        fetchStub as never
      );

      dispatchMessage({
        type: 'render',
        config: { width: 1, height: 1, headerSize: 0, format: 'gray8' },
        configSource: 'rawimagerc',
        fileUri: 'x',
        fileSize: 1,
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(
        windowListenerCounts.mousemove,
        1,
        'expected one mousemove listener after success'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        1,
        'expected one mouseup listener after success'
      );
      assert.strictEqual(
        resizeObserverState.instancesCreated,
        1,
        'expected one ResizeObserver created'
      );
      assert.strictEqual(
        resizeObserverState.disconnectCalls,
        0,
        'the ResizeObserver from the successful render must still be connected'
      );

      dispatchMessage({
        type: 'render',
        config: null,
        configSource: 'settings',
        fileUri: 'x',
        fileSize: 0,
      });

      assert.strictEqual(
        windowListenerCounts.mousemove,
        0,
        'expected the mousemove listener to be released after the config:null render'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        0,
        'expected the mouseup listener to be released after the config:null render'
      );
      assert.strictEqual(
        resizeObserverState.disconnectCalls,
        1,
        'expected the previous ResizeObserver to be disconnected after the config:null render'
      );
    });

    test('a successful render followed by an insufficient-data render releases the previous ResizeObserver and window listeners', async () => {
      // 上と同じ回帰を、もう一つの早期 return 経路（データ不足エラー）でも検証する。
      const fetchStub = () =>
        Promise.resolve({
          ok: true,
          body: null,
          arrayBuffer: () => Promise.resolve(new Uint8Array([128]).buffer),
        });

      const { dispatchMessage, windowListenerCounts, resizeObserverState } = runWebviewScript(
        fetchStub as never
      );

      dispatchMessage({
        type: 'render',
        config: { width: 1, height: 1, headerSize: 0, format: 'gray8' },
        configSource: 'rawimagerc',
        fileUri: 'x',
        fileSize: 1,
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.strictEqual(
        windowListenerCounts.mousemove,
        1,
        'expected one mousemove listener after success'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        1,
        'expected one mouseup listener after success'
      );
      assert.strictEqual(
        resizeObserverState.disconnectCalls,
        0,
        'ResizeObserver must still be connected'
      );

      dispatchMessage({
        type: 'render',
        // gray8 は 4x4 = 16 バイト必要だが、ファイルは 4 バイトしかない（データ不足エラー）
        config: { width: 4, height: 4, headerSize: 0, format: 'gray8' },
        configSource: 'rawimagerc',
        fileUri: 'x',
        fileSize: 4,
      });

      assert.strictEqual(
        windowListenerCounts.mousemove,
        0,
        'expected the mousemove listener to be released after the insufficient-data render'
      );
      assert.strictEqual(
        windowListenerCounts.mouseup,
        0,
        'expected the mouseup listener to be released after the insufficient-data render'
      );
      assert.strictEqual(
        resizeObserverState.disconnectCalls,
        1,
        'expected the previous ResizeObserver to be disconnected after the insufficient-data render'
      );
    });
  });
});
