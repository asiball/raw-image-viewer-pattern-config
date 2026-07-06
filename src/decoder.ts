/**
 * decoder.ts — 画像デコードファイル
 *
 * バイナリデータ（0と1の羅列）を画像のピクセル（RGBA値）に変換する処理を
 * すべてここに集めています。
 *
 * 重要な設計上の注意:
 * このファイルの関数は VS Code の Webview（画像を表示する内側の画面）からも
 * `src/webview/main.ts` を経由した ES import で直接呼び出されます
 * （esbuild で `out/webview/main.js` にバンドルされる）。そのため：
 * - VS Code API や Node.js 固有の機能は使えません（ブラウザでも動く必要があるため）
 * - 各フォーマットの性質（バイト数・制約・必要バイト数の計算式など）は
 *   `src/formats.ts` の記述子テーブルに集約されており、このファイルは
 *   そのテーブルを参照してデコードを行います
 */

import { getRawImageFormatDescriptor } from './formats';
import type { RawImageFormatDescriptor } from './formats';
import type {
  Float32DecodeState,
  GrayDecodeState,
  GrayscaleStreamFormat,
  RawImageDecodeState,
  RawImageFormat,
  StreamDecodableRawImageFormat,
} from './types';

// =============================================================================
// RGB/BGR 系フォーマットのストリーミングデコード
// =============================================================================

/**
 * 1ピクセルあたりのバイト数を返します。
 * 例: 'rgb24' → 3バイト（R, G, B それぞれ1バイト）
 *
 * `src/formats.ts` の記述子テーブルを参照します。
 */
export function getBytesPerPixel(format: StreamDecodableRawImageFormat): number {
  return getRawImageFormatDescriptor(format).bytesPerPixel;
}

/**
 * 16ビットグレー値を2バイトから組み立てます。
 *
 * ストリーミングデコード（appendGrayChunk）・ピクセル単位デコード
 * （decodeRawPixel）・一括デコード（decodeRawImageToRgba）で共有される
 * 単一実装です。gray16le / depth16 はリトルエンディアン、gray16be は
 * ビッグエンディアンとして呼び出します。
 *
 * この関数は src/webview/main.ts からも ES import で直接呼び出されます。
 */
export function combineGray16Bytes(byte0: number, byte1: number, littleEndian: boolean): number {
  return littleEndian ? (byte1 << 8) | byte0 : (byte0 << 8) | byte1;
}

/**
 * バイト列の offset 位置から16ビットグレー値を読み取ります。
 * 範囲外のバイトは 0 として扱います（チャンク終端の安全策）。
 *
 * この関数は src/webview/main.ts からも ES import で直接呼び出されます。
 */
export function readGray16Sample(
  source: Uint8Array,
  offset: number,
  littleEndian: boolean
): number {
  return combineGray16Bytes(source[offset] ?? 0, source[offset + 1] ?? 0, littleEndian);
}

/**
 * ストリーミングデコードの初期状態を作ります。
 * デコードを始める前に一度だけ呼び出します。
 */
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

/**
 * バイト列からピクセル1個分の RGBA 値を取り出します。
 * フォーマットごとにバイトの並び順が異なるため、ここで変換します。
 *
 * 戻り値は [R, G, B, A] の4要素の配列です（各値 0〜255）。
 */
export function decodeRawPixel(
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
      // リトルエンディアン: 低バイトが先、高バイトが後
      // 上位8ビットを表示値として使う（>> 8 で右シフト）
      const value = readGray16Sample(source, offset, true) >> 8;
      return [value, value, value, 255];
    }
    case 'gray16be': {
      // ビッグエンディアン: 高バイトが先、低バイトが後
      const value = readGray16Sample(source, offset, false) >> 8;
      return [value, value, value, 255];
    }
    case 'rgb24':
      return [source[offset] ?? 0, source[offset + 1] ?? 0, source[offset + 2] ?? 0, 255];
    case 'bgr24':
      // BGR は RGB の逆順なので B と R を入れ替える
      return [source[offset + 2] ?? 0, source[offset + 1] ?? 0, source[offset] ?? 0, 255];
    case 'rgba32':
      return [
        source[offset] ?? 0,
        source[offset + 1] ?? 0,
        source[offset + 2] ?? 0,
        source[offset + 3] ?? 0,
      ];
    case 'bgra32':
      return [
        source[offset + 2] ?? 0,
        source[offset + 1] ?? 0,
        source[offset] ?? 0,
        source[offset + 3] ?? 0,
      ];
  }
}

/**
 * ファイルの1チャンク（塊）分のバイトデータをデコードして pixels に書き込みます。
 *
 * ストリーミングデコードでは、ファイルを少しずつ読むため
 * チャンクの境界でピクセルが分断されることがあります。
 * state.pendingBytes にその「中途半端なバイト」を保存して次回に引き継ぎます。
 */
export function appendRawImageChunk(
  state: RawImageDecodeState,
  chunk: Uint8Array,
  pixels: Uint8ClampedArray
): void {
  if (state.pixelsWritten >= state.totalPixels || chunk.length === 0) {
    return;
  }

  let offset = 0;

  // ヘッダー部分をスキップする
  if (state.remainingHeaderBytes > 0) {
    const skipped = Math.min(state.remainingHeaderBytes, chunk.length);
    state.remainingHeaderBytes -= skipped;
    offset += skipped;
  }

  if (offset >= chunk.length) {
    return;
  }

  // 前のチャンクから持ち越したバイトを使って未完成ピクセルを完成させる
  while (
    state.pendingLength > 0 &&
    offset < chunk.length &&
    state.pendingLength < state.bytesPerPixel
  ) {
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

  // チャンク内の完全なピクセルをすべて処理する
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

  // 1ピクセル分に満たない残りのバイトを次回に持ち越す
  while (
    offset < chunk.length &&
    state.pendingLength < state.bytesPerPixel &&
    state.pixelsWritten < state.totalPixels
  ) {
    state.pendingBytes[state.pendingLength++] = chunk[offset++];
  }
}

// =============================================================================
// グレースケール系フォーマットのストリーミングデコード
// =============================================================================

/**
 * グレースケールストリーミングデコードの初期状態を作ります。
 * RGB 系と異なり、生の16ビット値を rawGray に保存してウィンドウ調整に備えます。
 */
export function createGrayDecodeState(
  width: number,
  height: number,
  headerSize: number,
  format: GrayscaleStreamFormat
): GrayDecodeState {
  const totalPixels = width * height;
  const bytesPerPixel = format === 'gray8' ? 1 : 2;
  const maxValue = format === 'gray8' ? 255 : 65535;
  return {
    format,
    totalPixels,
    pixelsWritten: 0,
    remainingHeaderBytes: Math.max(0, headerSize),
    bytesPerPixel,
    pendingByte: 0,
    hasPendingByte: false,
    rawGray: new Uint16Array(totalPixels),
    autoMin: maxValue,
    autoMax: 0,
    maxValue,
  };
}

/**
 * グレースケール画像の1チャンク分をデコードして rawGray に書き込みます。
 * デコードと同時に autoMin / autoMax を更新し、後でウィンドウ調整に使います。
 */
export function appendGrayChunk(state: GrayDecodeState, chunk: Uint8Array): void {
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

  const writeGrayPixel = (value: number): void => {
    state.rawGray[state.pixelsWritten] = value;
    if (value < state.autoMin) {
      state.autoMin = value;
    }
    if (value > state.autoMax) {
      state.autoMax = value;
    }
    state.pixelsWritten += 1;
  };

  if (state.format === 'gray8') {
    while (offset < chunk.length && state.pixelsWritten < state.totalPixels) {
      writeGrayPixel(chunk[offset++]);
    }
  } else {
    // depth16 と gray16le はリトルエンディアン（低バイト先）
    const isLittleEndian = state.format === 'gray16le' || state.format === 'depth16';
    if (state.hasPendingByte && offset < chunk.length && state.pixelsWritten < state.totalPixels) {
      const b0 = state.pendingByte;
      const b1 = chunk[offset++];
      writeGrayPixel(combineGray16Bytes(b0, b1, isLittleEndian));
      state.hasPendingByte = false;
    }
    while (offset + 2 <= chunk.length && state.pixelsWritten < state.totalPixels) {
      const b0 = chunk[offset++];
      const b1 = chunk[offset++];
      writeGrayPixel(combineGray16Bytes(b0, b1, isLittleEndian));
    }
    if (offset < chunk.length && state.pixelsWritten < state.totalPixels) {
      state.pendingByte = chunk[offset];
      state.hasPendingByte = true;
    }
  }
}

/**
 * rawGray（生グレー値）をウィンドウ/レベルで RGBA に変換して pixels に書き込みます。
 *
 * windowMin〜windowMax の範囲を 0〜255 に線形マッピングします。
 * 範囲外の値はクランプ（切り捨て）されます。
 * Float32Array も受け付けるため、float32 フォーマットでも再利用できます。
 */
export function applyWindowLevel(
  rawGray: Uint16Array | Float32Array,
  totalPixels: number,
  windowMin: number,
  windowMax: number,
  pixels: Uint8ClampedArray
): void {
  const range = windowMax - windowMin;
  for (let p = 0; p < totalPixels; p++) {
    let mapped: number;
    if (range <= 0) {
      mapped = 128; // 範囲がゼロなら中間値にフォールバック
    } else {
      mapped = Math.round(((rawGray[p] - windowMin) / range) * 255);
      if (mapped < 0) {
        mapped = 0;
      }
      if (mapped > 255) {
        mapped = 255;
      }
    }
    const idx = p * 4;
    pixels[idx] = mapped;
    pixels[idx + 1] = mapped;
    pixels[idx + 2] = mapped;
    pixels[idx + 3] = 255;
  }
}

// =============================================================================
// float32 フォーマットのストリーミングデコード
// =============================================================================

/**
 * float32 ストリーミングデコードの初期状態を作ります。
 * 4バイトで1ピクセルを表す IEEE 754 単精度浮動小数点フォーマットを対象とします。
 */
export function createFloat32DecodeState(
  width: number,
  height: number,
  headerSize: number
): Float32DecodeState {
  const totalPixels = width * height;
  return {
    totalPixels,
    pixelsWritten: 0,
    remainingHeaderBytes: Math.max(0, headerSize),
    pendingBytes: new Uint8Array(4),
    pendingLength: 0,
    rawGrayF32: new Float32Array(totalPixels),
    autoMin: Infinity,
    autoMax: -Infinity,
  };
}

/**
 * float32 画像の1チャンク分をデコードして rawGrayF32 に書き込みます。
 * NaN や Infinity は autoMin/autoMax の計算から除外します。
 */
export function appendFloat32Chunk(state: Float32DecodeState, chunk: Uint8Array): void {
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

  const writeFloat32Pixel = (value: number): void => {
    if (isFinite(value)) {
      if (value < state.autoMin) {
        state.autoMin = value;
      }
      if (value > state.autoMax) {
        state.autoMax = value;
      }
    }
    state.rawGrayF32[state.pixelsWritten++] = value;
  };

  // 前のチャンクから持ち越した未完成の4バイトを完成させる
  while (state.pendingLength > 0 && offset < chunk.length && state.pendingLength < 4) {
    state.pendingBytes[state.pendingLength++] = chunk[offset++];
  }

  if (state.pendingLength === 4 && state.pixelsWritten < state.totalPixels) {
    const pendingView = new DataView(state.pendingBytes.buffer);
    writeFloat32Pixel(pendingView.getFloat32(0, true)); // true = リトルエンディアン
    state.pendingLength = 0;
  }

  // DataView を使ってバイト列を float32 に解釈する
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  while (offset + 4 <= chunk.length && state.pixelsWritten < state.totalPixels) {
    writeFloat32Pixel(view.getFloat32(offset, true));
    offset += 4;
  }

  // 4バイトに満たない残りを次回に持ち越す
  while (
    offset < chunk.length &&
    state.pendingLength < 4 &&
    state.pixelsWritten < state.totalPixels
  ) {
    state.pendingBytes[state.pendingLength++] = chunk[offset++];
  }
}

// =============================================================================
// 一括デコード（ストリーミングを使わない場合のフォールバック）
// =============================================================================

// 0〜255 の範囲に収める
function clampToByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function writePixel(
  pixels: Uint8ClampedArray,
  pixelIndex: number,
  r: number,
  g: number,
  b: number,
  a = 255
): void {
  const offset = pixelIndex * 4;
  pixels[offset] = clampToByte(r);
  pixels[offset + 1] = clampToByte(g);
  pixels[offset + 2] = clampToByte(b);
  pixels[offset + 3] = clampToByte(a);
}

// YUV → RGB 変換（ITU-R BT.601 の係数）
function writeYuvPixel(
  pixels: Uint8ClampedArray,
  pixelIndex: number,
  y: number,
  u: number,
  v: number
): void {
  const c = Math.max(0, y - 16);
  const d = u - 128;
  const e = v - 128;
  writePixel(
    pixels,
    pixelIndex,
    (298 * c + 409 * e + 128) >> 8,
    (298 * c - 100 * d - 208 * e + 128) >> 8,
    (298 * c + 516 * d + 128) >> 8
  );
}

/**
 * フォーマット 1 個分の一括デコード処理のシグネチャ。
 * `requiredBytes`/偶数制約のチェックは呼び出し側（decodeRawImageToRgba）で
 * 事前に済ませてあるため、ここでは変換ロジックだけを担う。
 */
type RawImageBatchDecodeFn = (
  pixelData: Uint8Array,
  width: number,
  height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
) => void;

function decodeGray8Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (let p = 0; p < totalPixels && p < pixelData.length; p++) {
    const value = pixelData[p];
    writePixel(pixels, p, value, value, value);
  }
}

// 16ビットグレー系はエンディアンだけが異なる（depth16 は gray16le と同じリトルエンディアン構造）。
// バイト結合はストリーミング経路と共有の readGray16Sample() に委譲する。
function makeGray16Batch(littleEndian: boolean): RawImageBatchDecodeFn {
  return (pixelData, _width, _height, totalPixels, pixels) => {
    for (
      let p = 0, srcIdx = 0;
      p < totalPixels && srcIdx + 1 < pixelData.length;
      p++, srcIdx += 2
    ) {
      const value = readGray16Sample(pixelData, srcIdx, littleEndian) >> 8;
      writePixel(pixels, p, value, value, value);
    }
  };
}

function decodeRgb24Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 2 < pixelData.length; p++, srcIdx += 3) {
    writePixel(pixels, p, pixelData[srcIdx], pixelData[srcIdx + 1], pixelData[srcIdx + 2]);
  }
}

function decodeBgr24Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 2 < pixelData.length; p++, srcIdx += 3) {
    writePixel(pixels, p, pixelData[srcIdx + 2], pixelData[srcIdx + 1], pixelData[srcIdx]);
  }
}

function decodeRgba32Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 3 < pixelData.length; p++, srcIdx += 4) {
    writePixel(
      pixels,
      p,
      pixelData[srcIdx],
      pixelData[srcIdx + 1],
      pixelData[srcIdx + 2],
      pixelData[srcIdx + 3]
    );
  }
}

function decodeBgra32Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 3 < pixelData.length; p++, srcIdx += 4) {
    writePixel(
      pixels,
      p,
      pixelData[srcIdx + 2],
      pixelData[srcIdx + 1],
      pixelData[srcIdx],
      pixelData[srcIdx + 3]
    );
  }
}

// プレーナー形式: Y面・U面・V面が別々に並ぶ
function decodeYuv420pBatch(
  pixelData: Uint8Array,
  width: number,
  height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  const lumaPlaneSize = totalPixels;
  const chromaPlaneSize = totalPixels / 4;
  const uOffset = lumaPlaneSize;
  const vOffset = uOffset + chromaPlaneSize;
  const chromaWidth = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      // 4ピクセルで1つの色差（U/V）を共有する（クロマサブサンプリング）
      const chromaIndex = Math.floor(y / 2) * chromaWidth + Math.floor(x / 2);
      writeYuvPixel(
        pixels,
        pixelIndex,
        pixelData[pixelIndex],
        pixelData[uOffset + chromaIndex],
        pixelData[vOffset + chromaIndex]
      );
    }
  }
}

// セミプレーナー形式: Y面の後に UV がインターリーブされる
function decodeNv12Batch(
  pixelData: Uint8Array,
  width: number,
  height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  const lumaPlaneSize = totalPixels;
  const uvOffset = lumaPlaneSize;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const chromaIndex = uvOffset + Math.floor(y / 2) * width + Math.floor(x / 2) * 2;
      writeYuvPixel(
        pixels,
        pixelIndex,
        pixelData[pixelIndex],
        pixelData[chromaIndex],
        pixelData[chromaIndex + 1]
      );
    }
  }
}

// パック形式: Y0 U Y1 V の4バイトで2ピクセルを表す
function decodeYuyv422Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  for (
    let p = 0, srcIdx = 0;
    p + 1 < totalPixels && srcIdx + 3 < pixelData.length;
    p += 2, srcIdx += 4
  ) {
    const y0 = pixelData[srcIdx];
    const u = pixelData[srcIdx + 1];
    const y1 = pixelData[srcIdx + 2];
    const v = pixelData[srcIdx + 3];
    writeYuvPixel(pixels, p, y0, u, v);
    writeYuvPixel(pixels, p + 1, y1, u, v);
  }
}

// 32ビット浮動小数点: DataView で4バイトをfloatとして読み、値域全体を 0〜255 に正規化する
function decodeFloat32Batch(
  pixelData: Uint8Array,
  _width: number,
  _height: number,
  totalPixels: number,
  pixels: Uint8ClampedArray
): void {
  const f32View = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
  const floatPixels = new Float32Array(totalPixels);
  let fMin = Infinity;
  let fMax = -Infinity;
  for (let p = 0, srcIdx = 0; p < totalPixels && srcIdx + 3 < pixelData.length; p++, srcIdx += 4) {
    const value = f32View.getFloat32(srcIdx, true);
    floatPixels[p] = value;
    if (isFinite(value)) {
      if (value < fMin) {
        fMin = value;
      }
      if (value > fMax) {
        fMax = value;
      }
    }
  }
  if (!isFinite(fMin) || !isFinite(fMax) || fMin >= fMax) {
    fMin = 0;
    fMax = 1;
  }
  const fRange = fMax - fMin;
  for (let p = 0; p < totalPixels; p++) {
    const val = floatPixels[p];
    let mapped: number;
    if (!isFinite(val)) {
      mapped = 0; // NaN や Infinity は黒として扱う
    } else {
      mapped = Math.round(((val - fMin) / fRange) * 255);
      if (mapped < 0) {
        mapped = 0;
      }
      if (mapped > 255) {
        mapped = 255;
      }
    }
    writePixel(pixels, p, mapped, mapped, mapped);
  }
}

/**
 * フォーマットごとの一括デコード処理のディスパッチテーブル。
 * `Record<RawImageFormat, ...>` として書くことで、`RawImageFormat` に
 * フォーマットを追加した際にエントリの追加漏れがあればコンパイルエラーになる。
 */
const rawImageBatchDecoders: Record<RawImageFormat, RawImageBatchDecodeFn> = {
  gray8: decodeGray8Batch,
  gray16le: makeGray16Batch(true),
  gray16be: makeGray16Batch(false),
  rgb24: decodeRgb24Batch,
  bgr24: decodeBgr24Batch,
  rgba32: decodeRgba32Batch,
  bgra32: decodeBgra32Batch,
  yuv420p: decodeYuv420pBatch,
  nv12: decodeNv12Batch,
  yuyv422: decodeYuyv422Batch,
  float32: decodeFloat32Batch,
  depth16: makeGray16Batch(true), // depth16 は gray16le と同じリトルエンディアン構造
};

/**
 * 幅・高さの偶数制約（`src/formats.ts` の `evenWidthRequired`/`evenHeightRequired`）を検証する。
 * 満たさない場合は format 名を含む Error を送出する。
 *
 * `src/webview/main.ts` からも ES import で直接呼び出され、fetch/デコードを始める前の
 * 事前チェックに使われる（奇数幅の yuv420p/nv12/yuyv422 などをフェッチ前にエラー表示するため）。
 */
export function validateEvenDimensions(
  format: RawImageFormat,
  descriptor: RawImageFormatDescriptor,
  width: number,
  height: number
): void {
  if (descriptor.evenWidthRequired && descriptor.evenHeightRequired) {
    if (width % 2 !== 0 || height % 2 !== 0) {
      throw new Error(`Format ${format} requires even width and height.`);
    }
  } else if (descriptor.evenWidthRequired) {
    if (width % 2 !== 0) {
      throw new Error(`Format ${format} requires an even width.`);
    }
  } else if (descriptor.evenHeightRequired) {
    if (height % 2 !== 0) {
      throw new Error(`Format ${format} requires an even height.`);
    }
  }
}

/**
 * バイナリデータをピクセル配列（RGBA）に一括変換します。
 *
 * ストリーミング対応フォーマット（rgb24 など）は Webview のストリーミングパスで
 * 処理されるため、この関数は主に YUV 系など残りのフォーマット向けのフォールバックですが、
 * 全フォーマットに対して呼び出し可能な汎用実装です。
 * また、この関数は src/webview/main.ts からも ES import で直接呼び出されます。
 *
 * 冒頭で `src/formats.ts` の記述子テーブルを参照し、偶数幅/高さ制約と
 * 必要バイト数（`requiredBytes(width, height)`）を検証します。データが不足している場合は
 * 期待バイト数・実バイト数・フォーマット名・解像度を含む Error を送出します
 * （全フォーマット共通。以前は yuv420p/nv12 のみ明示エラーだった）。
 *
 * @param pixelData ヘッダーを除いたピクセルデータ
 */
export function decodeRawImageToRgba(
  pixelData: Uint8Array,
  width: number,
  height: number,
  format: RawImageFormat
): Uint8ClampedArray {
  const descriptor = getRawImageFormatDescriptor(format);

  validateEvenDimensions(format, descriptor, width, height);

  const requiredBytes = descriptor.requiredBytes(width, height);
  if (pixelData.length < requiredBytes) {
    throw new Error(
      `Insufficient data for ${format} ${width}x${height}: expected at least ${requiredBytes} bytes, but found ${pixelData.length}.`
    );
  }

  const totalPixels = width * height;
  const pixels = new Uint8ClampedArray(totalPixels * 4);
  rawImageBatchDecoders[format](pixelData, width, height, totalPixels, pixels);
  return pixels;
}
