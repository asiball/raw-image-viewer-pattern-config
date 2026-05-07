import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

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

import {
  findConfigPath,
  getConfigSearchDirectories,
  inferRawImageConfigFromFilename,
  loadRawImageConfig,
  parseRawImageConfig,
  resolveFallbackRawImageConfig,
} from '../config';

import { supportedFormats } from '../types';

import {
  createInitialRenderHandshake,
  decodePngDataUrl,
  getLocalResourceRoots,
  getSuggestedPngSaveUri,
} from '../extension';

// プロジェクトルート（out/test の2階層上）
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEST_DATA_DIR = path.join(PROJECT_ROOT, 'test-data');

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  // ===========================================================================
  // decoder
  // ===========================================================================

  suite('decoder', () => {
    suite('getBytesPerPixel', () => {
      test('matches supported stream formats', () => {
        assert.strictEqual(getBytesPerPixel('gray8'), 1);
        assert.strictEqual(getBytesPerPixel('gray16le'), 2);
        assert.strictEqual(getBytesPerPixel('gray16be'), 2);
        assert.strictEqual(getBytesPerPixel('rgb24'), 3);
        assert.strictEqual(getBytesPerPixel('bgr24'), 3);
        assert.strictEqual(getBytesPerPixel('rgba32'), 4);
        assert.strictEqual(getBytesPerPixel('bgra32'), 4);
      });
    });

    suite('decodeRawPixel', () => {
      test('gray8 maps single byte to RGB', () => {
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([42]), 0, 'gray8'),
          [42, 42, 42, 255]
        );
      });

      test('gray16le reads high byte as brightness', () => {
        // 0x1234 little-endian → bytes [0x34, 0x12] → high byte 0x12
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([0x34, 0x12]), 0, 'gray16le'),
          [0x12, 0x12, 0x12, 255]
        );
      });

      test('gray16be reads high byte as brightness', () => {
        // 0x1234 big-endian → bytes [0x12, 0x34] → high byte 0x12
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([0x12, 0x34]), 0, 'gray16be'),
          [0x12, 0x12, 0x12, 255]
        );
      });

      test('rgb24 maps bytes in R G B order', () => {
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([255, 128, 0]), 0, 'rgb24'),
          [255, 128, 0, 255]
        );
      });

      test('bgr24 swaps R and B channels', () => {
        // bytes: B=0, G=128, R=255 → RGBA: 255, 128, 0, 255
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([0, 128, 255]), 0, 'bgr24'),
          [255, 128, 0, 255]
        );
      });

      test('rgba32 preserves alpha channel', () => {
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([10, 20, 30, 128]), 0, 'rgba32'),
          [10, 20, 30, 128]
        );
      });

      test('bgra32 swaps R and B channels and preserves alpha', () => {
        // bytes: B=10, G=20, R=30, A=128 → RGBA: 30, 20, 10, 128
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([10, 20, 30, 128]), 0, 'bgra32'),
          [30, 20, 10, 128]
        );
      });

      test('respects offset into source array', () => {
        // 先頭2バイトをスキップして offset=2 から読む
        assert.deepStrictEqual(
          decodeRawPixel(Uint8Array.from([0, 0, 100, 150, 200]), 2, 'rgb24'),
          [100, 150, 200, 255]
        );
      });
    });

    suite('appendRawImageChunk', () => {
      test('skips headers and decodes pixels across chunk boundaries', () => {
        const pixels = new Uint8ClampedArray(8);
        const state = createRawImageDecodeState(2, 1, 2, 'rgb24');

        appendRawImageChunk(state, Uint8Array.from([9, 8, 255]), pixels);
        assert.strictEqual(state.pixelsWritten, 0);

        appendRawImageChunk(state, Uint8Array.from([0, 0, 0, 255, 0]), pixels);
        assert.strictEqual(state.pixelsWritten, 2);
        assert.deepStrictEqual(Array.from(pixels), [255, 0, 0, 255, 0, 255, 0, 255]);
      });

      test('decodes gray16 values with split samples', () => {
        const pixels = new Uint8ClampedArray(8);
        const state = createRawImageDecodeState(2, 1, 0, 'gray16le');

        appendRawImageChunk(state, Uint8Array.from([0x34]), pixels);
        assert.strictEqual(state.pixelsWritten, 0);

        appendRawImageChunk(state, Uint8Array.from([0x12, 0xcd, 0xab]), pixels);
        assert.strictEqual(state.pixelsWritten, 2);
        assert.deepStrictEqual(Array.from(pixels), [0x12, 0x12, 0x12, 255, 0xab, 0xab, 0xab, 255]);
      });

      test('ignores trailing bytes after expected pixels are filled', () => {
        const pixels = new Uint8ClampedArray(4);
        const state = createRawImageDecodeState(1, 1, 0, 'rgba32');

        appendRawImageChunk(state, Uint8Array.from([1, 2, 3, 4, 200, 201, 202, 203]), pixels);

        assert.strictEqual(state.pixelsWritten, 1);
        assert.deepStrictEqual(Array.from(pixels), [1, 2, 3, 4]);
        assert.strictEqual(state.pendingLength, 0);
      });

      test('decodes bgr24 with correct channel swap', () => {
        const pixels = new Uint8ClampedArray(8);
        const state = createRawImageDecodeState(2, 1, 0, 'bgr24');

        // [B=10, G=20, R=30] [B=40, G=50, R=60]
        appendRawImageChunk(state, Uint8Array.from([10, 20, 30, 40, 50, 60]), pixels);

        assert.strictEqual(state.pixelsWritten, 2);
        // pixel 0: RGBA = [30, 20, 10, 255]
        assert.deepStrictEqual(Array.from(pixels.subarray(0, 4)), [30, 20, 10, 255]);
        // pixel 1: RGBA = [60, 50, 40, 255]
        assert.deepStrictEqual(Array.from(pixels.subarray(4, 8)), [60, 50, 40, 255]);
      });
    });

    suite('gray decode', () => {
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

      test('createGrayDecodeState initialises depth16 same as gray16le', () => {
        const state = createGrayDecodeState(2, 1, 0, 'depth16');
        assert.strictEqual(state.bytesPerPixel, 2);
        assert.strictEqual(state.maxValue, 65535);
        assert.strictEqual(state.totalPixels, 2);
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
    });

    suite('applyWindowLevel', () => {
      test('maps values correctly', () => {
        const rawGray = new Uint16Array([0, 500, 1000]);
        const pixels = new Uint8ClampedArray(12);
        applyWindowLevel(rawGray, 3, 0, 1000, pixels);
        assert.strictEqual(pixels[0], 0);
        assert.strictEqual(pixels[4], 128);
        assert.strictEqual(pixels[8], 255);
        assert.strictEqual(pixels[3], 255);
        assert.strictEqual(pixels[7], 255);
        assert.strictEqual(pixels[11], 255);
      });

      test('clamps out-of-range values', () => {
        const rawGray = new Uint16Array([50, 200]);
        const pixels = new Uint8ClampedArray(8);
        applyWindowLevel(rawGray, 2, 100, 150, pixels);
        assert.strictEqual(pixels[0], 0);
        assert.strictEqual(pixels[4], 255);
      });

      test('uses 128 when range is zero', () => {
        const rawGray = new Uint16Array([42]);
        const pixels = new Uint8ClampedArray(4);
        applyWindowLevel(rawGray, 1, 100, 100, pixels);
        assert.strictEqual(pixels[0], 128);
      });

      test('accepts Float32Array', () => {
        const rawGray = new Float32Array([0.0, 0.5, 1.0]);
        const pixels = new Uint8ClampedArray(12);
        applyWindowLevel(rawGray, 3, 0.0, 1.0, pixels);
        assert.strictEqual(pixels[0], 0);
        assert.strictEqual(pixels[4], 128);
        assert.strictEqual(pixels[8], 255);
        assert.strictEqual(pixels[3], 255);
      });
    });

    suite('float32 decode', () => {
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
    });

    suite('decodeRawImageToRgba', () => {
      test('decodes yuv420p frames', () => {
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

      test('decodes nv12 frames', () => {
        const rgba = decodeRawImageToRgba(
          new Uint8Array([16, 82, 145, 235, 128, 128]),
          2,
          2,
          'nv12'
        );
        assert.deepStrictEqual(
          Array.from(rgba),
          [0, 0, 0, 255, 77, 77, 77, 255, 150, 150, 150, 255, 255, 255, 255, 255]
        );
      });

      test('decodes yuyv422 frames', () => {
        const rgba = decodeRawImageToRgba(new Uint8Array([16, 128, 235, 128]), 2, 1, 'yuyv422');
        assert.deepStrictEqual(Array.from(rgba), [0, 0, 0, 255, 255, 255, 255, 255]);
      });

      test('validates YUV frame geometry', () => {
        assert.throws(
          () => decodeRawImageToRgba(new Uint8Array([0, 0, 0]), 3, 2, 'yuv420p'),
          /requires even width and height/
        );
        assert.throws(
          () => decodeRawImageToRgba(new Uint8Array([0, 0, 0, 0]), 3, 1, 'yuyv422'),
          /requires an even width/
        );
      });

      test('decodes depth16 as 16-bit little-endian grayscale', () => {
        // 0x0000 → 0, 0xff00 → 255 (upper byte used after >> 8)
        const data = new Uint8Array([0x00, 0x00, 0x00, 0xff]);
        const rgba = decodeRawImageToRgba(data, 2, 1, 'depth16');
        assert.strictEqual(rgba[0], 0);
        assert.strictEqual(rgba[4], 255);
        assert.strictEqual(rgba[3], 255);
        assert.strictEqual(rgba[7], 255);
      });

      test('decodes float32 with auto normalization', () => {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setFloat32(0, 0.0, true);
        view.setFloat32(4, 1.0, true);
        const rgba = decodeRawImageToRgba(new Uint8Array(buf), 2, 1, 'float32');
        assert.strictEqual(rgba[0], 0);
        assert.strictEqual(rgba[4], 255);
        assert.strictEqual(rgba[3], 255);
        assert.strictEqual(rgba[7], 255);
      });

      test('handles float32 NaN as black', () => {
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setFloat32(0, NaN, true);
        view.setFloat32(4, 1.0, true);
        const rgba = decodeRawImageToRgba(new Uint8Array(buf), 2, 1, 'float32');
        assert.strictEqual(rgba[0], 0);
      });
    });
  });

  // ===========================================================================
  // config
  // ===========================================================================

  suite('config', () => {
    suite('getConfigSearchDirectories', () => {
      test('walks from file directory to root', () => {
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
    });

    suite('findConfigPath', () => {
      test('finds .rawimagerc in the same directory as the file', () => {
        // test-data/scenario1/.rawimagerc が存在する
        const filePath = path.join(TEST_DATA_DIR, 'scenario1', 'frame.raw');
        const result = findConfigPath(filePath);
        assert.strictEqual(
          result && path.normalize(result).toLowerCase(),
          path.normalize(path.join(TEST_DATA_DIR, 'scenario1', '.rawimagerc')).toLowerCase()
        );
      });

      test('finds .rawimagerc in a parent directory', () => {
        // test-data/scenario1/sub/ には .rawimagerc がないが、親の scenario1/ にある
        const filePath = path.join(TEST_DATA_DIR, 'scenario1', 'sub', 'frame.raw');
        const result = findConfigPath(filePath);
        assert.strictEqual(
          result && path.normalize(result).toLowerCase(),
          path.normalize(path.join(TEST_DATA_DIR, 'scenario1', '.rawimagerc')).toLowerCase()
        );
      });

      test('returns undefined when no .rawimagerc exists anywhere', () => {
        // 上位を遡っても .rawimagerc がないよう、一時ディレクトリを使う
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rawtest-'));
        try {
          const result = findConfigPath(path.join(tmpDir, 'frame.raw'));
          assert.strictEqual(result, undefined);
        } finally {
          fs.rmdirSync(tmpDir);
        }
      });
    });

    suite('loadRawImageConfig', () => {
      test('reads and parses scenario1 config correctly', () => {
        const configPath = path.join(TEST_DATA_DIR, 'scenario1', '.rawimagerc');
        const targetFile = path.join(TEST_DATA_DIR, 'scenario1', 'frame.raw');
        const config = loadRawImageConfig(configPath, targetFile);
        assert.deepStrictEqual(config, {
          width: 256,
          height: 256,
          headerSize: 0,
          format: 'rgb24',
        });
      });

      test('reads and parses scenario2 config correctly', () => {
        const configPath = path.join(TEST_DATA_DIR, 'scenario2', '.rawimagerc');
        const targetFile = path.join(TEST_DATA_DIR, 'scenario2', 'frame.raw');
        const config = loadRawImageConfig(configPath, targetFile);
        assert.deepStrictEqual(config, {
          width: 128,
          height: 128,
          headerSize: 0,
          format: 'gray8',
        });
      });
    });

    suite('parseRawImageConfig', () => {
      test('applies defaults', () => {
        assert.deepStrictEqual(
          parseRawImageConfig(
            JSON.stringify({ patterns: { '*': { width: 64, height: 32 } } }),
            'D:\\repo\\.rawimagerc',
            'D:\\repo\\frame.raw'
          ),
          { width: 64, height: 32, headerSize: 0, format: 'rgb24' }
        );
      });

      test('rejects invalid numeric fields', () => {
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

      test('rejects unsupported formats', () => {
        assert.throws(
          () =>
            parseRawImageConfig(
              JSON.stringify({
                patterns: { '*': { width: 64, height: 32, format: 'yuv420' } },
              }),
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

      test('throws when no pattern provides required width/height', () => {
        // マッチするパターンがあっても width/height が揃わなければエラー
        assert.throws(
          () =>
            parseRawImageConfig(
              JSON.stringify({ patterns: { '*.bin': { width: 64, height: 32 } } }),
              '/repo/.rawimagerc',
              '/repo/frame.raw'
            ),
          /"width" must be a positive integer/
        );
      });

      test('accepts supported YUV formats', () => {
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

      test('applies glob pattern overrides', () => {
        const config = {
          patterns: {
            '*': { width: 100, height: 100 },
            '**/thumbnails/*.bin': { width: 32, height: 32 },
            '*.depth': { format: 'depth16' },
          },
        };
        const configPath =
          process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';

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

        const depthFile =
          process.platform === 'win32' ? 'C:\\repo\\frame.depth' : '/repo/frame.depth';
        assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, depthFile), {
          width: 100,
          height: 100,
          headerSize: 0,
          format: 'depth16',
        });

        const otherFile = process.platform === 'win32' ? 'C:\\repo\\other.raw' : '/repo/other.raw';
        assert.deepStrictEqual(parseRawImageConfig(JSON.stringify(config), configPath, otherFile), {
          width: 100,
          height: 100,
          headerSize: 0,
          format: 'rgb24',
        });
      });

      test('**/ matches top-level directory relative to config', () => {
        const config = {
          patterns: {
            '*': { width: 100, height: 100 },
            '**/thumbnails/*.bin': { width: 32, height: 32 },
          },
        };
        const configPath =
          process.platform === 'win32' ? 'C:\\repo\\.rawimagerc' : '/repo/.rawimagerc';

        const topLevelThumb =
          process.platform === 'win32'
            ? 'C:\\repo\\thumbnails\\icon.bin'
            : '/repo/thumbnails/icon.bin';
        assert.deepStrictEqual(
          parseRawImageConfig(JSON.stringify(config), configPath, topLevelThumb),
          { width: 32, height: 32, headerSize: 0, format: 'rgb24' }
        );

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
    });

    suite('inferRawImageConfigFromFilename', () => {
      test('extracts dimensions and format', () => {
        assert.deepStrictEqual(
          inferRawImageConfigFromFilename('D:\\repo\\captures\\frame_1920x1080_rgb24.raw'),
          { width: 1920, height: 1080, format: 'rgb24' }
        );
      });

      test('recognizes YUV formats', () => {
        assert.deepStrictEqual(
          inferRawImageConfigFromFilename('D:\\repo\\captures\\frame-640x480-yuyv422.yuv'),
          { width: 640, height: 480, format: 'yuyv422' }
        );
      });

      test('extracts only dimensions when format is absent', () => {
        assert.deepStrictEqual(
          inferRawImageConfigFromFilename('/repo/captures/frame_320x240.raw'),
          { width: 320, height: 240 }
        );
      });

      test('returns null when no metadata found', () => {
        assert.strictEqual(inferRawImageConfigFromFilename('/repo/captures/frame.raw'), null);
      });
    });

    suite('resolveFallbackRawImageConfig', () => {
      test('merges filename inference with settings', () => {
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

      test('uses settings when filename has no metadata', () => {
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

      test('returns config: null when width/height cannot be resolved', () => {
        // ファイル名にもメタデータなし、settings にも width/height なし
        const result = resolveFallbackRawImageConfig('/repo/frame.raw', {});
        assert.deepStrictEqual(result, { config: null });
      });

      test('returns config: null when only one dimension is available', () => {
        // width はわかるが height が不明 → null
        const result = resolveFallbackRawImageConfig('/repo/frame.raw', { defaultWidth: 640 });
        assert.deepStrictEqual(result, { config: null });
      });

      test('skips filename inference when inferFromFilename is false', () => {
        // ファイル名に 1920x1080 があっても inferFromFilename: false なら無視
        const result = resolveFallbackRawImageConfig('D:\\repo\\frame_1920x1080_rgb24.raw', {
          defaultWidth: 320,
          defaultHeight: 240,
          inferFromFilename: false,
        });
        assert.deepStrictEqual(result, {
          config: {
            width: 320,
            height: 240,
            headerSize: 0,
            format: 'rgb24',
          },
          source: 'settings',
        });
      });

      test('source is filename when only filename inference is used', () => {
        // settings に何も指定しない → filename のみ
        const result = resolveFallbackRawImageConfig('/repo/frame_640x480_gray8.raw', {
          inferFromFilename: true,
        });
        assert.ok(result.config !== null);
        assert.strictEqual(result.source, 'filename');
        assert.strictEqual(result.config?.width, 640);
        assert.strictEqual(result.config?.height, 480);
        assert.strictEqual(result.config?.format, 'gray8');
      });
    });
  });

  // ===========================================================================
  // extension
  // ===========================================================================

  suite('extension', () => {
    suite('getLocalResourceRoots', () => {
      test('includes file directory and config ancestor', () => {
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

      test('returns only one root when configPath is omitted', () => {
        const isWindows = process.platform === 'win32';
        const filePath = isWindows ? 'D:\\repo\\images\\frame.raw' : '/repo/images/frame.raw';
        const roots = getLocalResourceRoots(vscode.Uri.file(filePath));

        assert.strictEqual(roots.length, 1);
        assert.strictEqual(
          path.normalize(roots[0].fsPath).toLowerCase(),
          path.normalize(isWindows ? 'D:\\repo\\images' : '/repo/images').toLowerCase()
        );
      });

      test('deduplicates when file and config are in the same directory', () => {
        const isWindows = process.platform === 'win32';
        const dir = isWindows ? 'D:\\repo\\images' : '/repo/images';
        const filePath = isWindows ? `${dir}\\frame.raw` : `${dir}/frame.raw`;
        const configPath = isWindows ? `${dir}\\.rawimagerc` : `${dir}/.rawimagerc`;
        const roots = getLocalResourceRoots(vscode.Uri.file(filePath), configPath);

        // 同一ディレクトリは重複せず1つだけ
        assert.strictEqual(roots.length, 1);
        assert.strictEqual(
          path.normalize(roots[0].fsPath).toLowerCase(),
          path.normalize(dir).toLowerCase()
        );
      });
    });

    suite('getSuggestedPngSaveUri', () => {
      test('swaps the extension for png', () => {
        const isWindows = process.platform === 'win32';
        const filePath = isWindows ? 'D:\\repo\\images\\frame.gray' : '/repo/images/frame.gray';
        const expectedPath = isWindows ? 'D:\\repo\\images\\frame.png' : '/repo/images/frame.png';

        assert.strictEqual(
          path.normalize(getSuggestedPngSaveUri(vscode.Uri.file(filePath)).fsPath).toLowerCase(),
          path.normalize(expectedPath).toLowerCase()
        );
      });
    });

    suite('decodePngDataUrl', () => {
      test('decodes PNG payloads', () => {
        assert.deepStrictEqual(
          Array.from(decodePngDataUrl('data:image/png;base64,AQID')),
          [1, 2, 3]
        );
      });

      test('rejects invalid string payloads', () => {
        assert.throws(() => decodePngDataUrl('not-a-data-url'), /Invalid PNG data/);
      });

      test('rejects non-string input', () => {
        assert.throws(() => decodePngDataUrl(null), /Missing PNG data/);
        assert.throws(() => decodePngDataUrl(42), /Missing PNG data/);
        assert.throws(() => decodePngDataUrl(undefined), /Missing PNG data/);
      });
    });

    suite('createInitialRenderHandshake', () => {
      test('clears both timers after ready', () => {
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

      test('ignores non-ready messages', () => {
        const handshake = createInitialRenderHandshake(
          () => {},
          () => {},
          () => undefined as unknown as ReturnType<typeof setTimeout>,
          () => {}
        );
        assert.strictEqual(handshake.handleMessage('other'), false);
      });

      test('dispose clears timers without sending', () => {
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
    });

    suite('schema consistency', () => {
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
    });
  });
});
