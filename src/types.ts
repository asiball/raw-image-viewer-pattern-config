/**
 * types.ts — 型定義ファイル
 *
 * このファイルには「型（Type）」と「インターフェース（Interface）」が中心に集まっています。
 * TypeScript の型とは「変数やデータがどんな形をしているか」を表すものです。
 *
 * 唯一の例外として、対応ピクセルフォーマットの一覧（`supportedFormats` など）は
 * `src/formats.ts` の記述子テーブルから導出した値を再エクスポートしています。
 * これらの性質（バイト数・ストリーミング対応可否など）自体のロジックは
 * `src/formats.ts` 側に集約されており、このファイルは型と、その型に対応する
 * 名前一覧を提供するだけです。
 *
 * 他のファイルは必要な型をここから import して使います。
 */

import {
  grayscaleStreamFormatNames,
  rawImageFormatDescriptorList,
  streamableFormatNames,
} from './formats';

// =============================================================================
// 型エイリアス（対応ピクセルフォーマットの語彙）
// =============================================================================

/**
 * すべての対応フォーマットの型。
 *
 * ここに列挙される名前が唯一の正となる「語彙」です。各フォーマットの性質
 * （1ピクセルあたりのバイト数、ストリーミング対応可否、必要バイト数の計算式など）は
 * `src/formats.ts` の `rawImageFormatDescriptors`（`Record<RawImageFormat, ...>`）に
 * 集約されており、この型に追加・削除すると同ファイルがコンパイルエラーで
 * 追従を強制します。新しいフォーマットを追加する場合は、この union と
 * `src/formats.ts` の記述子テーブルの両方を更新してください
 * （詳細は AGENTS.md・docs/detailed-design.md を参照）。
 */
export type RawImageFormat =
  | 'gray8'
  | 'gray16le'
  | 'gray16be'
  | 'rgb24'
  | 'bgr24'
  | 'rgba32'
  | 'bgra32'
  | 'yuv420p'
  | 'nv12'
  | 'yuyv422'
  | 'float32'
  | 'depth16';

/**
 * ストリーミングデコード対応フォーマットの型。
 * `src/formats.ts` で `streamable: true` を持つフォーマットの集合と一致する
 * （一致は extension.test.ts のテストで検証される）。
 */
export type StreamDecodableRawImageFormat =
  | 'gray8'
  | 'gray16le'
  | 'gray16be'
  | 'rgb24'
  | 'bgr24'
  | 'rgba32'
  | 'bgra32';

/**
 * グレースケール系フォーマットの型。
 * `src/formats.ts` で `grayscaleStream: true` を持つフォーマットの集合と一致する
 * （一致は extension.test.ts のテストで検証される）。
 */
export type GrayscaleStreamFormat = 'gray8' | 'gray16le' | 'gray16be' | 'depth16';

// =============================================================================
// サポートするピクセルフォーマット（src/formats.ts の記述子テーブルから導出）
// =============================================================================

/**
 * 拡張機能が対応するすべてのピクセルフォーマット。
 * `src/formats.ts` の記述子テーブルの定義順から導出される（手書きの配列ではない）。
 */
export const supportedFormats: readonly RawImageFormat[] = rawImageFormatDescriptorList.map(
  (descriptor) => descriptor.name
);

/**
 * ストリーミング（少しずつ）デコードに対応するフォーマット。
 * これらは大きなファイルでもメモリ効率よく処理できます。
 * `src/formats.ts` の `streamable` フラグから導出される。
 */
export const streamDecodableFormats: readonly StreamDecodableRawImageFormat[] =
  streamableFormatNames;

/**
 * グレースケールとして扱うフォーマット。
 * これらはデコード後にウィンドウ/レベル（明暗範囲）の調整ができます。
 * `src/formats.ts` の `grayscaleStream` フラグから導出される。
 */
export const grayscaleStreamFormats: readonly GrayscaleStreamFormat[] = grayscaleStreamFormatNames;

/**
 * 設定がどこから取得されたかを表す文字列。
 * - `'rawimagerc'`       : .rawimagerc ファイル
 * - `'filename'`         : ファイル名から推測
 * - `'settings'`         : VS Code ワークスペース設定
 * - `'filename+settings'`: ファイル名とワークスペース設定の組み合わせ
 */
export type RawImageConfigSource = 'rawimagerc' | 'filename' | 'settings' | 'filename+settings';

// =============================================================================
// インターフェース（データの形の定義）
// =============================================================================

/**
 * 画像をレンダリングするために必要な設定一式。
 * .rawimagerc やワークスペース設定から解決されて生成されます。
 */
export interface RawImageConfig {
  /** 画像の横幅（ピクセル） */
  width: number;
  /** 画像の縦幅（ピクセル） */
  height: number;
  /** ファイル先頭のスキップバイト数（独自ヘッダーがある場合に使用） */
  headerSize: number;
  /** ピクセルフォーマット（例: 'rgb24', 'gray8'） */
  format: RawImageFormat;
}

/**
 * `patterns` 配列の1エントリの形。
 * `match` はグロブパターン（必須）で、他のフィールドは従来の imageConfig と同じく
 * すべて任意です。複数のエントリが同じファイルにマッチした場合、配列の**後方が勝つ**
 * （フィールド単位でマージされ、後のエントリが指定したフィールドのみ上書きする）。
 */
export interface RawImagePatternEntry {
  /** マッチさせるグロブパターン（`.editorconfig` 方式、`.rawimagerc` のディレクトリからの相対パスに対して評価） */
  match: string;
  width?: number;
  height?: number;
  headerSize?: number;
  format?: RawImageFormat;
}

/**
 * .rawimagerc ファイルをパースした直後の生データの形。
 * JSON.parse() の結果を TypeScript で安全に扱うために定義します。
 * 実際の値検証は config.ts の parseRawImageConfig() で行います。
 *
 * `patterns` は配列で、記述順（配列のインデックス順）が後勝ちマージの順序に
 * そのまま対応します（構文上の順序が保証されるため、JSON オブジェクトキーの
 * 列挙順に関する問題は生じません）。
 */
export interface RawImageConfigRecord {
  patterns?: RawImagePatternEntry[];
}

/**
 * .rawimagerc が見つからないときのフォールバック（代替）設定。
 * VS Code のワークスペース設定から読み込みます。
 */
export interface RawImageFallbackSettings {
  defaultWidth?: number;
  defaultHeight?: number;
  defaultHeaderSize?: number;
  defaultFormat?: RawImageFormat;
  /** true のとき、ファイル名から幅・高さ・フォーマットを推測する */
  inferFromFilename?: boolean;
}

/**
 * 設定の解決結果。
 * 設定が見つからない場合は config が null になり、Webview にヘルプ画面を表示します。
 */
export interface ResolvedRawImageConfig {
  config: RawImageConfig | null;
  /** 設定の取得元。config が null の場合は undefined */
  source?: RawImageConfigSource;
}

// =============================================================================
// Extension ↔ Webview メッセージプロトコル
// =============================================================================

/**
 * Webview → Extension へ送られるメッセージの判別可能 union。
 * - `ready`   : Webview の初期化完了通知（acknowledgement を受け取るまで繰り返し送信）
 * - `savePng` : 現在表示中イメージの PNG 保存要求（canvas.toDataURL() の Data URL 付き）
 */
export type WebviewToExtensionMessage = { type: 'ready' } | { type: 'savePng'; dataUrl: string };

/**
 * Extension → Webview へ送られるメッセージの判別可能 union。
 * - `render` : 描画指示（解決済み設定・取得元・ファイル URI・ファイルサイズ）
 * - `error`  : エラー内容通知
 */
export type ExtensionToWebviewMessage =
  | {
      type: 'render';
      /** 解決済み設定。設定が見つからない場合は null（Webview はヘルプ画面を表示） */
      config: RawImageConfig | null;
      /** 設定の取得元。config が null の場合は null */
      configSource: RawImageConfigSource | null;
      /** Webview からアクセス可能な VS Code Webview URI（文字列化済み） */
      fileUri: string;
      /** ファイルサイズ（バイト） */
      fileSize: number;
    }
  | { type: 'error'; message: string };

// =============================================================================
// タイマー関連（テストでモック差し替えができるよう型を定義）
// =============================================================================

/** setTimeout の戻り値の型（Node.js と ブラウザで異なるため型エイリアスで吸収） */
export type TimeoutHandle = ReturnType<typeof setTimeout>;

/** setTimeout と同じシグネチャを持つ関数の型 */
export type TimeoutScheduler = (callback: () => void, delay: number) => TimeoutHandle;

/** clearTimeout と同じシグネチャを持つ関数の型 */
export type TimeoutCanceler = (timeout: TimeoutHandle) => void;

/**
 * Webview が起動完了を通知するまでの初回ハンドシェイク処理のインターフェース。
 * インターフェースとして定義することで、テスト時にモック（偽物）と差し替えやすくなります。
 */
export interface InitialRenderHandshake {
  /** メッセージを受け取り、'ready' なら処理して true を返す */
  handleMessage(messageType: string): boolean;
  /** タイマーをすべてキャンセルしてリソースを解放する */
  dispose(): void;
}

// =============================================================================
// ストリーミングデコードの状態管理
// =============================================================================

/**
 * RGB/BGR/RGBA 系フォーマットをストリーミングデコードするときの状態。
 *
 * ストリーミングデコードとは、ファイルを全部読み込まずに少しずつ処理する方法です。
 * チャンク（塊）の境界でピクセルが分断される場合があるため、
 * 「途中まで処理したバイト」を pendingBytes に保存しておきます。
 */
export interface RawImageDecodeState {
  format: StreamDecodableRawImageFormat;
  /** 画像全体のピクセル数（幅 × 高さ） */
  totalPixels: number;
  /** これまでに書き込んだピクセル数 */
  pixelsWritten: number;
  /** まだスキップすべきヘッダーの残りバイト数 */
  remainingHeaderBytes: number;
  /** 1ピクセルあたりのバイト数（例: rgb24 なら 3） */
  bytesPerPixel: number;
  /** チャンク境界をまたいだ未完成ピクセルのバイト列 */
  pendingBytes: Uint8Array;
  /** pendingBytes のうち実際に入っているバイト数 */
  pendingLength: number;
}

/**
 * グレースケール系フォーマットをストリーミングデコードするときの状態。
 *
 * 生のグレー値（16ビット）を rawGray に保持し、デコード完了後に
 * applyWindowLevel() でウィンドウ/レベル調整を行います。
 */
export interface GrayDecodeState {
  format: GrayscaleStreamFormat;
  totalPixels: number;
  pixelsWritten: number;
  remainingHeaderBytes: number;
  /** 1ピクセルあたりのバイト数（gray8 = 1, gray16 系 = 2） */
  bytesPerPixel: number;
  /** 2バイトフォーマットで前のチャンクに残った1バイト */
  pendingByte: number;
  hasPendingByte: boolean;
  /** 全ピクセルの生グレー値を格納する配列 */
  rawGray: Uint16Array;
  /** デコード中に自動検出した最小値 */
  autoMin: number;
  /** デコード中に自動検出した最大値 */
  autoMax: number;
  /** フォーマットが表現できる最大値（gray8 = 255, gray16 = 65535） */
  maxValue: number;
}

/**
 * float32 フォーマットをストリーミングデコードするときの状態。
 *
 * 各ピクセルを 32ビット浮動小数点数として読み込み rawGrayF32 に保存します。
 * デコード後に applyWindowLevel() で 0〜255 の範囲に正規化します。
 */
export interface Float32DecodeState {
  totalPixels: number;
  pixelsWritten: number;
  remainingHeaderBytes: number;
  /** 4バイト揃っていない未完成の浮動小数点データ */
  pendingBytes: Uint8Array;
  pendingLength: number;
  /** 全ピクセルの浮動小数点グレー値を格納する配列 */
  rawGrayF32: Float32Array;
  autoMin: number;
  autoMax: number;
}
