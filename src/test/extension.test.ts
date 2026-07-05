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
  extractPatternKeyOrder,
  findConfigPath,
  getConfigSearchDirectories,
  inferRawImageConfigFromFilename,
  loadRawImageConfig,
  parseRawImageConfig,
  resolveFallbackRawImageConfig,
} from '../config';

// 型定数は types.ts から
import { supportedFormats } from '../types';
import type { GrayscaleStreamFormat, StreamDecodableRawImageFormat } from '../types';

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
        JSON.stringify({ patterns: { '*': { width: 64, height: 32 } } }),
        'D:\\repo\\.rawimagerc',
        'D:\\repo\\frame.raw'
      ),
      { width: 64, height: 32, headerSize: 0, format: 'rgb24' }
    );
  });

  test('parseRawImageConfig rejects invalid numeric fields', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ patterns: { '*': { width: 0, height: 32 } } }, /"width" must be a positive integer/],
      [{ patterns: { '*': { width: 64, height: -1 } } }, /"height" must be a positive integer/],
      [
        { patterns: { '*': { width: 64, height: 32, headerSize: 1.5 } } },
        /"headerSize" must be a non-negative integer/,
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
          JSON.stringify({ patterns: { '*': { width: 64, height: 32, format: 'yuv420' } } }),
          'D:\\repo\\.rawimagerc',
          'D:\\repo\\frame.raw'
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"format" must be one of/);
        return true;
      }
    );
  });

  test('parseRawImageConfig accepts supported YUV formats', () => {
    assert.deepStrictEqual(
      parseRawImageConfig(
        JSON.stringify({
          patterns: { '*': { width: 4, height: 2, headerSize: 16, format: 'yuv420p' } },
        }),
        'D:\\repo\\.rawimagerc',
        'D:\\repo\\frame.raw'
      ),
      { width: 4, height: 2, headerSize: 16, format: 'yuv420p' }
    );
  });

  test('getLocalResourceRoots includes config ancestor', () => {
    const isWindows = process.platform === 'win32';
    const filePath = isWindows
      ? 'D:\\repo\\images\\nested\\frame.raw'
      : '/repo/images/nested/frame.raw';
    const configPath = isWindows ? 'D:\\repo\\images\\.rawimagerc' : '/repo/images/.rawimagerc';
    const roots = getLocalResourceRoots(vscode.Uri.file(filePath), configPath);

    assert.deepStrictEqual(
      roots.map((root) => path.normalize(root.fsPath).toLowerCase()),
      [
        path
          .normalize(isWindows ? 'D:\\repo\\images\\nested' : '/repo/images/nested')
          .toLowerCase(),
        path.normalize(isWindows ? 'D:\\repo\\images' : '/repo/images').toLowerCase(),
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

  test('createInitialRenderHandshake clears both timers after ready', () => {
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

    assert.strictEqual(handshake.handleMessage('ready'), true);
    assert.strictEqual(sendCount, 1);
    assert.strictEqual(warningCount, 0);
    assert.deepStrictEqual(
      scheduled.map((timeout) => timeout.delay),
      [300, 5000]
    );
    assert.ok(scheduled.every((timeout) => timeout.cleared));
  });

  test('createInitialRenderHandshake dispose clears timers without sending', () => {
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
    assert.strictEqual(scheduled.length, 2);
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
      patterns: {
        '*': {
          width: 100,
          height: 100,
        },
        '**/thumbnails/*.bin': {
          width: 32,
          height: 32,
        },
        '*.depth': {
          format: 'depth16',
        },
      },
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
      patterns: {
        '*': { width: 100, height: 100 },
        '**/thumbnails/*.bin': { width: 32, height: 32 },
      },
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
    const config = { patterns: { '**': { width: 100, height: 100 } } };
    const configPath =
      process.platform === 'win32' ? 'C:\\repo\\sub\\.rawimagerc' : '/repo/sub/.rawimagerc';
    const outsideFile = process.platform === 'win32' ? 'C:\\repo\\other.raw' : '/repo/other.raw';

    // どのパターンにもマッチしない → width が未解決でエラーになる
    assert.throws(
      () => parseRawImageConfig(JSON.stringify(config), configPath, outsideFile),
      /"width" must be a positive integer/
    );
  });

  test('parseRawImageConfig respects source order for integer-like keys (last-wins)', () => {
    // 整数風キー（"12"）を "*" より後に記述した場合、記述順どおり "12" が勝つこと。
    // JSON.stringify したオブジェクトでは JS が "12" を先頭に並べ替えてしまうため、
    // 生テキストを直接組み立ててソース順を固定する。
    const raw =
      '{\n' +
      '  "patterns": {\n' +
      '    "*": { "width": 8, "height": 8, "format": "rgb24" },\n' +
      '    "12": { "width": 8, "height": 8, "format": "gray8" }\n' +
      '  }\n' +
      '}';
    const configPath = process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';
    // 相対パスが "12" になり、"*" と "12" の両方に一致する
    const target = process.platform === 'win32' ? 'C:\\repo\\12' : '/repo/12';

    const result = parseRawImageConfig(raw, configPath, target);
    assert.strictEqual(
      result.format,
      'gray8',
      'later-in-source pattern ("12") must win over earlier "*"'
    );

    // 逆順（"12" が先、"*" が後）なら "*" が勝つ
    const rawReversed =
      '{\n' +
      '  "patterns": {\n' +
      '    "12": { "width": 8, "height": 8, "format": "gray8" },\n' +
      '    "*": { "width": 8, "height": 8, "format": "rgb24" }\n' +
      '  }\n' +
      '}';
    assert.strictEqual(parseRawImageConfig(rawReversed, configPath, target).format, 'rgb24');
  });

  test('extractPatternKeyOrder returns keys in source order handling braces and escapes', () => {
    const raw =
      '{\n' +
      '  "patterns": {\n' +
      '    "*": { "width": 8, "height": 8, "format": "rgb24" },\n' +
      '    "**/a{b}/*.bin": { "width": 4, "height": 4 },\n' +
      '    "esc\\"quote": { "width": 2, "height": 2 },\n' +
      '    "12": { "width": 2, "height": 2 }\n' +
      '  }\n' +
      '}';
    assert.deepStrictEqual(extractPatternKeyOrder(raw), ['*', '**/a{b}/*.bin', 'esc"quote', '12']);
  });

  test('extractPatternKeyOrder returns null when patterns block is absent or malformed', () => {
    assert.strictEqual(extractPatternKeyOrder('{ "width": 8 }'), null);
    assert.strictEqual(extractPatternKeyOrder('{ "patterns": [1, 2] }'), null);
    assert.strictEqual(extractPatternKeyOrder('{ "patterns": {'), null);
  });

  test('rawimagerc.schema.json format enum matches extension supported formats', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'rawimagerc.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    const schema = JSON.parse(schemaContent) as {
      definitions: {
        imageConfig: {
          properties: {
            format: {
              enum: string[];
              enumDescriptions: string[];
            };
          };
        };
      };
    };
    const schemaFormats: string[] = schema.definitions.imageConfig.properties.format.enum;
    assert.deepStrictEqual(schemaFormats, [...supportedFormats]);
    assert.strictEqual(
      schema.definitions.imageConfig.properties.format.enumDescriptions.length,
      schemaFormats.length,
      'enumDescriptions count must match enum count'
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

  test('findConfigPath discovers .rawimagerc from nested paths and loadRawImageConfig loads it', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rawviewer-config-test-'));
    try {
      const configPath = path.join(tmpRoot, '.rawimagerc');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          patterns: { '**': { width: 12, height: 34, headerSize: 2, format: 'gray8' } },
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

  // buildWebviewHtml() が生成する <script nonce="..."> の中身を Node の vm モジュールで
  // 実際に実行し、構文エラーやハンドラ内の未定義参照（例: renderImage 呼び出しの
  // ReferenceError）が起きないことを検証するスモークテスト。
  suite('Webview script smoke test', () => {
    function extractWebviewScript(): string {
      const html = buildWebviewHtml('https://example.com');
      const match = html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/);
      assert.ok(match, 'expected a nonce script tag in the generated webview HTML');
      return match![1];
    }

    // document.getElementById('root') / createElement() が返す最小の要素スタブ。
    function createElementStub(): Record<string, unknown> {
      const el: Record<string, unknown> = {
        className: '',
        innerHTML: '',
        textContent: '',
        style: {},
        children: [] as unknown[],
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
      };
      return el;
    }

    function createWebviewVmContext(): {
      context: Record<string, unknown>;
      root: Record<string, unknown>;
      messageListeners: Array<(event: { data: unknown }) => void>;
      postedMessages: unknown[];
    } {
      const root = createElementStub();
      const messageListeners: Array<(event: { data: unknown }) => void> = [];
      const postedMessages: unknown[] = [];

      const windowStub = {
        addEventListener(type: string, handler: (event: { data: unknown }) => void) {
          if (type === 'message') {
            messageListeners.push(handler);
          }
        },
        removeEventListener() {
          /* no-op */
        },
      };

      const documentStub = {
        getElementById(id: string) {
          return id === 'root' ? root : null;
        },
        createElement() {
          return createElementStub();
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
        ResizeObserver: function ResizeObserverStub() {
          return { observe() {}, disconnect() {} };
        },
        fetch() {
          return Promise.reject(new Error('fetch should not be reached in this smoke test'));
        },
        AbortController: function AbortControllerStub() {
          return { abort() {}, signal: {} };
        },
        console,
      };
      vm.createContext(context);

      return { context, root, messageListeners, postedMessages };
    }

    function runWebviewScript(): {
      dispatchMessage: (data: unknown) => void;
      root: Record<string, unknown>;
      postedMessages: unknown[];
    } {
      const script = extractWebviewScript();
      const { context, root, messageListeners, postedMessages } = createWebviewVmContext();

      // 構文エラー（例: 修正① 以前の未定義 renderImage() によるブレース崩れ）が
      // あればここで例外が発生する。
      vm.runInContext(script, context);

      assert.strictEqual(messageListeners.length, 1, 'expected exactly one message listener');

      return {
        dispatchMessage: (data: unknown) => messageListeners[0]({ data }),
        root,
        postedMessages,
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

    test('embedded gray16 decode paths run in the webview script without ReferenceError', () => {
      // decoder.ts の関数が共有ヘルパー（combineGray16Bytes / readGray16Sample）に
      // 依存するようになったため、ヘルパーの埋め込み漏れがあると Webview 側で
      // 実行時 ReferenceError になる。埋め込まれた関数を vm 内で実際に呼び出して
      // デコード経路が最後まで動くことを検証する。
      const script = extractWebviewScript();
      const { context } = createWebviewVmContext();

      // decodeRawImageToRgba はスクリプト内の const のため、同一スクリプトの
      // 末尾でグローバルへ公開してから別スクリプトで呼び出す。
      vm.runInContext(
        script + '\n;globalThis.__decodeRawImageToRgba = decodeRawImageToRgba;',
        context
      );

      // 結果はクロス realm のプロトタイプ差異を避けるため JSON 文字列で受け取る
      const resultJson = vm.runInContext(
        `(function () {
          var bytes = new Uint8Array([0x34, 0x12, 0xcd, 0xab]);
          var batchLe = Array.from(__decodeRawImageToRgba(bytes, 2, 1, 'gray16le'));
          var batchBe = Array.from(__decodeRawImageToRgba(bytes, 2, 1, 'gray16be'));
          var batchDepth = Array.from(__decodeRawImageToRgba(bytes, 2, 1, 'depth16'));
          var pixels = new Uint8ClampedArray(8);
          var st = createRawImageDecodeState(2, 1, 0, 'gray16le');
          appendRawImageChunk(st, bytes, pixels);
          var stream = Array.from(pixels);
          var gs = createGrayDecodeState(2, 1, 0, 'depth16');
          appendGrayChunk(gs, bytes);
          var gray = Array.from(gs.rawGray);
          return JSON.stringify({
            batchLe: batchLe,
            batchBe: batchBe,
            batchDepth: batchDepth,
            stream: stream,
            gray: gray,
          });
        })()`,
        context
      ) as string;
      const result = JSON.parse(resultJson) as {
        batchLe: number[];
        batchBe: number[];
        batchDepth: number[];
        stream: number[];
        gray: number[];
      };

      assert.deepStrictEqual(result.batchLe, [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 255]);
      assert.deepStrictEqual(result.batchBe, [0x34, 0x34, 0x34, 255, 0xcd, 0xcd, 0xcd, 255]);
      assert.deepStrictEqual(result.batchDepth, result.batchLe);
      assert.deepStrictEqual(result.stream, result.batchLe);
      assert.deepStrictEqual(result.gray, [0x1234, 0xabcd]);
    });
  });
});
