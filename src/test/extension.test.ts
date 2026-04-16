import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
  appendFloat32Chunk,
  appendGrayChunk,
  appendRawImageChunk,
  applyWindowLevel,
  createFloat32DecodeState,
  createGrayDecodeState,
  createInitialRenderHandshake,
  createRawImageDecodeState,
  decodeRawImageToRgba,
  decodePngDataUrl,
  getBytesPerPixel,
  getConfigSearchDirectories,
  getLocalResourceRoots,
  getSuggestedPngSaveUri,
  inferRawImageConfigFromFilename,
  parseRawImageConfig,
  resolveFallbackRawImageConfig,
  supportedFormats,
} from '../extension';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('parseRawImageConfig applies defaults', () => {
    assert.deepStrictEqual(
      parseRawImageConfig(JSON.stringify({ width: 64, height: 32 }), 'D:\\repo\\.rawimagerc'),
      { width: 64, height: 32, headerSize: 0, format: 'rgb24' }
    );
  });

  test('parseRawImageConfig rejects invalid numeric fields', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ width: 0, height: 32 }, /"width" must be a positive integer/],
      [{ width: 64, height: -1 }, /"height" must be a positive integer/],
      [{ width: 64, height: 32, headerSize: 1.5 }, /"headerSize" must be a non-negative integer/],
    ];

    for (const [input, expectedMessage] of cases) {
      assert.throws(
        () => parseRawImageConfig(JSON.stringify(input), 'D:\\repo\\.rawimagerc'),
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
          JSON.stringify({ width: 64, height: 32, format: 'yuv420' }),
          'D:\\repo\\.rawimagerc'
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
        JSON.stringify({ width: 4, height: 2, headerSize: 16, format: 'yuv420p' }),
        'D:\\repo\\.rawimagerc'
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

  test('rawimagerc.schema.json format enum matches extension supported formats', () => {
    const schemaPath = path.join(__dirname, '..', '..', 'schemas', 'rawimagerc.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as {
      properties: { format: { enum: string[]; enumDescriptions: string[] } };
    };
    const schemaFormats: string[] = schema.properties.format.enum;
    assert.deepStrictEqual(schemaFormats, [...supportedFormats]);
    assert.strictEqual(
      schema.properties.format.enumDescriptions.length,
      schemaFormats.length,
      'enumDescriptions count must match enum count'
    );
  });
});
