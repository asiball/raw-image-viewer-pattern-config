/**
 * formats.ts — ピクセルフォーマット記述子テーブル
 *
 * 対応するすべてのピクセルフォーマットの性質を、この 1 つのテーブルに集約します。
 * - `bytesPerPixel` : 1ピクセルあたりのバイト数（yuv420p/nv12 はクロマサブサンプリングにより 1.5）
 * - `streamable`     : ストリーミングデコード（createRawImageDecodeState 系）に対応するか
 * - `grayscaleStream`: グレースケールストリーム（ウィンドウ/レベル・カラーマップ対象）として扱うか
 * - `description`    : ヘルプテーブル・.rawimagerc スキーマの enumDescription と一致させる説明文
 * - `evenWidthRequired` / `evenHeightRequired`: 幅・高さの偶数制約
 * - `requiredBytes(width, height)`: ヘッダーを除く、その解像度で必要な最小バイト数
 *
 * `types.ts` の `supportedFormats` / `streamDecodableFormats` / `grayscaleStreamFormats`、
 * `decoder.ts` のデコード処理、Webview の「設定未検出時のヘルプテーブル」は、
 * いずれもこのテーブルから導出されます。
 *
 * 新しいピクセルフォーマットを追加する場合、このファイルの `rawImageFormatDescriptors`
 * に 1 エントリを追加してください（併せて types.ts の RawImageFormat 系型エイリアス、
 * schemas/rawimagerc.schema.json と package.json の enum も更新が必要です。
 * これらの整合は extension.test.ts のテストで機械的に検証されます）。
 *
 * 【循環 import に関する注意】
 * このファイルは types.ts から「型のみ」を import します（`import type`）。
 * 値としての import は行いません。TypeScript の `import type` はコンパイル後に
 * 完全に消去されるため、実行時の require グラフは types.ts → formats.ts の
 * 一方向のみになり、循環参照は発生しません（型検査上の循環は許容されます）。
 * 値の流れ（実行時に意味のあるデータ）は必ず formats.ts → types.ts の一方向です。
 */

import type { GrayscaleStreamFormat, RawImageFormat, StreamDecodableRawImageFormat } from './types';

/** 1 つのピクセルフォーマットの性質をまとめた記述子 */
export interface RawImageFormatDescriptor {
  /** フォーマット名（.rawimagerc の "format" 値と一致） */
  name: RawImageFormat;
  /** 1 ピクセルあたりのバイト数。yuv420p/nv12 はクロマサブサンプリングにより 1.5 */
  bytesPerPixel: number;
  /** ストリーミングデコード（createRawImageDecodeState 系）に対応するか */
  streamable: boolean;
  /** グレースケールストリーム（ウィンドウ/レベル・カラーマップ対象）として扱うか */
  grayscaleStream: boolean;
  /** ヘルプテーブル・.rawimagerc スキーマの enumDescription と一致させる説明文 */
  description: string;
  /** 幅が偶数である必要があるか（yuyv422/yuv420p/nv12） */
  evenWidthRequired?: boolean;
  /** 高さが偶数である必要があるか（yuv420p/nv12） */
  evenHeightRequired?: boolean;
  /** ヘッダーを除く、この解像度で必要な最小バイト数を返す */
  requiredBytes(width: number, height: number): number;
}

/**
 * `bytesPerPixel` から機械的に `requiredBytes` を計算するヘルパー。
 * 12 フォーマットすべてで「幅 × 高さ × bytesPerPixel を切り上げた値」が
 * 必要バイト数と一致するため、この 1 つの式を全フォーマットで共有します。
 */
function bytesPerPixelRequiredBytes(
  bytesPerPixel: number
): (width: number, height: number) => number {
  return (width: number, height: number): number => Math.ceil(width * height * bytesPerPixel);
}

/**
 * 全 12 フォーマットの記述子テーブル。
 *
 * `Record<RawImageFormat, RawImageFormatDescriptor>` として直接オブジェクトリテラルで
 * 書くことで、TypeScript がキーの過不足（フォーマットの追加・削除漏れ）を
 * コンパイル時に検出します。新しいフォーマットを `RawImageFormat` に追加したのに
 * ここへのエントリ追加を忘れると、コンパイルエラーになります。
 */
export const rawImageFormatDescriptors: Record<RawImageFormat, RawImageFormatDescriptor> = {
  gray8: {
    name: 'gray8',
    bytesPerPixel: 1,
    streamable: true,
    grayscaleStream: true,
    description: '8-bit grayscale (1 byte/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(1),
  },
  gray16le: {
    name: 'gray16le',
    bytesPerPixel: 2,
    streamable: true,
    grayscaleStream: true,
    description: '16-bit grayscale, little-endian (2 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(2),
  },
  gray16be: {
    name: 'gray16be',
    bytesPerPixel: 2,
    streamable: true,
    grayscaleStream: true,
    description: '16-bit grayscale, big-endian (2 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(2),
  },
  rgb24: {
    name: 'rgb24',
    bytesPerPixel: 3,
    streamable: true,
    grayscaleStream: false,
    description: '24-bit RGB (3 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(3),
  },
  bgr24: {
    name: 'bgr24',
    bytesPerPixel: 3,
    streamable: true,
    grayscaleStream: false,
    description: '24-bit BGR (3 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(3),
  },
  rgba32: {
    name: 'rgba32',
    bytesPerPixel: 4,
    streamable: true,
    grayscaleStream: false,
    description: '32-bit RGBA (4 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(4),
  },
  bgra32: {
    name: 'bgra32',
    bytesPerPixel: 4,
    streamable: true,
    grayscaleStream: false,
    description: '32-bit BGRA (4 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(4),
  },
  yuv420p: {
    name: 'yuv420p',
    bytesPerPixel: 1.5,
    streamable: false,
    grayscaleStream: false,
    description: 'Planar YUV 4:2:0 — requires even width and height (1.5 bytes/pixel)',
    evenWidthRequired: true,
    evenHeightRequired: true,
    requiredBytes: bytesPerPixelRequiredBytes(1.5),
  },
  nv12: {
    name: 'nv12',
    bytesPerPixel: 1.5,
    streamable: false,
    grayscaleStream: false,
    description: 'Semi-planar YUV 4:2:0 — requires even width and height (1.5 bytes/pixel)',
    evenWidthRequired: true,
    evenHeightRequired: true,
    requiredBytes: bytesPerPixelRequiredBytes(1.5),
  },
  yuyv422: {
    name: 'yuyv422',
    bytesPerPixel: 2,
    streamable: false,
    grayscaleStream: false,
    description: 'Packed YUV 4:2:2 — requires even width (2 bytes/pixel)',
    evenWidthRequired: true,
    requiredBytes: bytesPerPixelRequiredBytes(2),
  },
  float32: {
    name: 'float32',
    bytesPerPixel: 4,
    streamable: false,
    grayscaleStream: false,
    description: '32-bit float grayscale, little-endian — auto window/level (4 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(4),
  },
  depth16: {
    name: 'depth16',
    bytesPerPixel: 2,
    streamable: false,
    grayscaleStream: true,
    description: '16-bit depth, little-endian — auto window/level (2 bytes/pixel)',
    requiredBytes: bytesPerPixelRequiredBytes(2),
  },
};

/**
 * 記述子を順序付き配列としても提供します（ヘルプテーブル生成・`supportedFormats` 導出用）。
 * オブジェクトの列挙順は文字列キー（整数風でない）であるため、上の定義順がそのまま保たれます。
 */
export const rawImageFormatDescriptorList: readonly RawImageFormatDescriptor[] =
  Object.values(rawImageFormatDescriptors);

/** フォーマット名から記述子を取得します。 */
export function getRawImageFormatDescriptor(format: RawImageFormat): RawImageFormatDescriptor {
  return rawImageFormatDescriptors[format];
}

/**
 * ストリーミングデコード対応フォーマット名の配列（`types.ts` の `streamDecodableFormats` 導出用）。
 * `streamable` フラグを立てたフォーマットのみを、テーブルの定義順で抽出します。
 */
export const streamableFormatNames: readonly StreamDecodableRawImageFormat[] =
  rawImageFormatDescriptorList
    .filter((descriptor) => descriptor.streamable)
    .map((descriptor) => descriptor.name) as StreamDecodableRawImageFormat[];

/**
 * グレースケールストリームフォーマット名の配列（`types.ts` の `grayscaleStreamFormats` 導出用）。
 * `grayscaleStream` フラグを立てたフォーマットのみを、テーブルの定義順で抽出します。
 */
export const grayscaleStreamFormatNames: readonly GrayscaleStreamFormat[] =
  rawImageFormatDescriptorList
    .filter((descriptor) => descriptor.grayscaleStream)
    .map((descriptor) => descriptor.name) as GrayscaleStreamFormat[];
