/**
 * config.ts — 設定解決ファイル
 *
 * .rawimagerc ファイルの読み込み・パース・バリデーション（検証）と、
 * ファイル名推測やワークスペース設定を組み合わせた設定解決ロジックを担います。
 *
 * 設定の優先順位:
 *   1. .rawimagerc（ファイルのディレクトリから上に向かって探索）
 *   2. ファイル名推測（例: `frame_1920x1080_rgb24.raw`）
 *   3. VS Code ワークスペース設定（rawviewer.defaultWidth など）
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  RawImageConfig,
  RawImageConfigRecord,
  RawImageFallbackSettings,
  RawImageFormat,
  ResolvedRawImageConfig,
} from './types';
import { supportedFormats } from './types';

// =============================================================================
// グロブパターンのマッチング
// =============================================================================

// グロブパターン（ワイルドカードを使ったファイルパスのパターン）を正規表現に変換します。
//
// 対応するパターン:
//   - `*`      : スラッシュを含まない任意の文字列（単一ディレクトリ内）
//   - `**`     : スラッシュを含む任意の文字列
//   - `**/`    : 先頭の任意のパスプレフィックス（ゼロ個以上のディレクトリ）
//                例: `**/foo` は `foo` にも `a/b/foo` にもマッチする
//
// 注意: JSDoc の /** */ コメントに `**/` を書くと、内側の `*/` でコメントが誤って閉じられる。
//       そのため、このコメントは // スタイルで記述している。
//
// 正規表現の特殊文字の一覧（グロブ用）。
// リテラル /[...[\]\\]/ と書くと TypeScript パーサーがエラーを出すため Set を使う。
const GLOB_SPECIAL_CHARS = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

function globToRegExp(glob: string): RegExp {
  // 文字を1つずつ処理して正規表現パターンを組み立てる
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // `**/` → 任意のパスプレフィックス（空でも可）
        pattern += '(?:.*/)?';
        i += 3;
      } else {
        // `**` → 任意の文字列（パスセパレータ含む）
        pattern += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // `*` → スラッシュを含まない任意の文字列
      pattern += '[^/]*';
      i += 1;
    } else {
      // 通常文字は正規表現の特殊文字をエスケープしてそのまま追加
      pattern += GLOB_SPECIAL_CHARS.has(ch) ? '\\' + ch : ch;
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

// =============================================================================
// .rawimagerc の検索と読み込み
// =============================================================================

/**
 * 対象ファイルのディレクトリからルートに向かって
 * .rawimagerc を探すすべてのディレクトリのリストを返します。
 *
 * .editorconfig と同じ「上方向への探索」方式です。
 * 例: `/repo/images/frame.raw` なら
 *   ['/repo/images', '/repo', '/'] の順で返ります。
 */
export function getConfigSearchDirectories(filePath: string): string[] {
  const directories: string[] = [];
  let dir = path.dirname(filePath);
  while (true) {
    directories.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // ルートディレクトリに到達したら終了
    }
    dir = parent;
  }
  return directories;
}

/**
 * FileSystemWatcher を登録すべきディレクトリのリストを返します。
 *
 * `getConfigSearchDirectories()` はファイルシステムルートまで全祖先を返しますが、
 * これをそのまま watcher 登録に使うと、ファイルを開くたびにルート直下まで
 * 10〜20 個の watcher が作られてしまいます（`findConfigPath()` による .rawimagerc の
 * "探索"はルートまで行いますが、watcher の"監視"はワークスペースルートで打ち切ります）。
 *
 * @param filePath              対象ファイルのパス
 * @param workspaceRootFsPath   ファイルが属するワークスペースフォルダのパス
 *                              （`vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath`）。
 *                              ワークスペース外のファイルなど undefined の場合は、
 *                              ファイルのディレクトリのみを返す。
 */
export function getConfigWatchDirectories(
  filePath: string,
  workspaceRootFsPath?: string
): string[] {
  const startDir = path.dirname(filePath);
  if (!workspaceRootFsPath) {
    return [startDir];
  }

  // Windows は大文字小文字を区別しないパス比較にする（getLocalResourceRoots と同様の方針）
  const normalize = (p: string): string => {
    const normalized = path.normalize(p);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const normalizedRoot = normalize(workspaceRootFsPath);

  const directories: string[] = [];
  let dir = startDir;
  while (true) {
    directories.push(dir);
    if (normalize(dir) === normalizedRoot) {
      break; // ワークスペースルート自身を含めて打ち切る
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // ファイルシステムルートに到達（ワークスペースルート外にあるケースの防御的フォールバック）
    }
    dir = parent;
  }
  return directories;
}

/**
 * 対象ファイルのディレクトリからルートへ向かって .rawimagerc を探し、
 * 最初に見つかったファイルのパスを返します。見つからない場合は undefined。
 */
export function findConfigPath(filePath: string): string | undefined {
  for (const dir of getConfigSearchDirectories(filePath)) {
    const configPath = path.join(dir, '.rawimagerc');
    try {
      fs.accessSync(configPath, fs.constants.F_OK);
      return configPath;
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code !== 'ENOENT') {
        throw err; // ファイルが存在しない以外のエラーは再スロー
      }
    }
  }
  return undefined;
}

// =============================================================================
// バリデーション（入力値の検証）
// =============================================================================

/**
 * 値が JSON オブジェクト（配列でない）かどうかを確認します。
 * TypeScript の「型ガード」関数です。
 */
function isRawImageConfigRecord(value: unknown): value is RawImageConfigRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 整数かどうかを検証して返します。
 * 不正な値の場合はエラーをスローします。
 *
 * @param min   最小値（1 なら正の整数、0 なら非負の整数）
 * @param optional true のとき、undefined は合格とする
 * @param isConfigPath true のとき、エラーメッセージに configPath を使う
 */
function validateInteger(
  value: unknown,
  property: string,
  source: string,
  min: number,
  optional: boolean = false,
  isConfigPath: boolean = false
): number | undefined {
  if (optional && value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    const label = min === 1 ? 'positive' : 'non-negative';
    const prefix = isConfigPath ? `Invalid .rawimagerc at "${source}"` : `Invalid ${source}`;
    throw new Error(`${prefix}: "${property}" must be a ${label} integer.`);
  }
  return value as number;
}

function validatePositiveInteger(
  value: unknown,
  property: 'width' | 'height',
  configPath: string
): number {
  return validateInteger(value, property, configPath, 1, false, true) as number;
}

function validateNonNegativeInteger(
  value: unknown,
  property: 'headerSize',
  configPath: string
): number {
  return validateInteger(value, property, configPath, 0, false, true) as number;
}

export function validateOptionalPositiveInteger(
  value: unknown,
  property: 'defaultWidth' | 'defaultHeight',
  source: string
): number | undefined {
  return validateInteger(value, property, source, 1, true, false);
}

export function validateOptionalNonNegativeInteger(
  value: unknown,
  property: 'defaultHeaderSize',
  source: string
): number | undefined {
  return validateInteger(value, property, source, 0, true, false);
}

export function validateOptionalFormat(
  value: unknown,
  property: 'defaultFormat',
  source: string
): RawImageFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !supportedFormats.includes(value as RawImageFormat)) {
    throw new Error(
      `Invalid ${source}: "${property}" must be one of ${supportedFormats.join(', ')}.`
    );
  }
  return value as RawImageFormat;
}

// =============================================================================
// .rawimagerc のパース
// =============================================================================

/**
 * 旧オブジェクト形式（`"patterns": { "<glob>": {...} }`）で書かれた .rawimagerc を
 * 検出した際に投げる、配列形式への移行方法を示すエラーを組み立てます。
 */
function buildPatternsArrayMigrationError(configPath: string): Error {
  return new Error(
    `Invalid .rawimagerc at "${configPath}": "patterns" must be an array. ` +
      'The object-keyed format (e.g. "patterns": { "*": { "width": 1920, "height": 1080 } }) ' +
      'is no longer supported. Migrate each entry to an array item with an explicit "match" field, for example:\n' +
      '{\n' +
      '  "patterns": [\n' +
      '    { "match": "*", "width": 1920, "height": 1080, "format": "rgb24" },\n' +
      '    { "match": "**/thumbnails/*.bin", "width": 128, "height": 128 }\n' +
      '  ]\n' +
      '}'
  );
}

/**
 * patterns 配列の1エントリの "match" フィールドを検証します。
 * 非空文字列でない場合はエラーをスローします。
 */
function validatePatternMatch(value: unknown, index: number, configPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Invalid .rawimagerc at "${configPath}": "patterns[${index}].match" must be a non-empty string.`
    );
  }
  return value;
}

/**
 * patterns[index] の1フィールド分の整数値を検証します（width/height/headerSize 用）。
 * `null` を含め、数値以外の値はすべてエラーとします（後勝ちマージ後の最終値だけを
 * 検証すると、後続エントリに上書きされて最終値に現れない「負けたエントリ」の型不正が
 * 握りつぶされてしまうため、マージ前にエントリ単位で検証する）。
 */
function validatePatternEntryInteger(
  value: unknown,
  field: 'width' | 'height' | 'headerSize',
  index: number,
  configPath: string,
  min: number
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    const kind = min === 1 ? 'positive' : 'non-negative';
    throw new Error(
      `Invalid .rawimagerc at "${configPath}": "patterns[${index}].${field}" must be a ${kind} integer.`
    );
  }
  return value;
}

/**
 * patterns[index].format を検証します。`null` を含め、対応フォーマット文字列以外は
 * すべてエラーとします（"format": null が width/height と非対称に無警告で rgb24 に
 * フォールバックしていた挙動を修正するため、他フィールドと同様にここで明示的に弾く）。
 */
function validatePatternEntryFormat(
  value: unknown,
  index: number,
  configPath: string
): RawImageFormat {
  if (typeof value !== 'string' || !supportedFormats.includes(value as RawImageFormat)) {
    throw new Error(
      `Invalid .rawimagerc at "${configPath}": "patterns[${index}].format" must be one of ${supportedFormats.join(', ')}.`
    );
  }
  return value as RawImageFormat;
}

/**
 * .rawimagerc の JSON 文字列をパースして RawImageConfig を返します。
 *
 * patterns 配列の各エントリの "match" グロブパターンを targetFilePath と照合し、
 * マッチしたエントリの設定を配列順に後勝ちでマージします。
 *
 * @param content       .rawimagerc ファイルの内容（JSON 文字列）
 * @param configPath    .rawimagerc のファイルパス（エラーメッセージ用）
 * @param targetFilePath 表示対象の画像ファイルのパス
 */
export function parseRawImageConfig(
  content: string,
  configPath: string,
  targetFilePath: string
): RawImageConfig {
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

  // configPath のディレクトリから targetFilePath への相対パスを計算し、
  // グロブマッチに使う（スラッシュで統一して OS 差異を吸収）
  const configDir = path.dirname(configPath);
  let relativePath = path.relative(configDir, targetFilePath);
  // Windows で configDir と対象ファイルが別ドライブにある場合、path.relative は
  // 相対パスではなく絶対パス（例: "D:\\foo\\bar"）を返す。また対象ファイルが
  // configDir の外側にある場合は ".." で始まる相対パスになる。いずれも
  // configDir 起点の相対グロブパターンとは意味のある照合ができないため、
  // どのパターンにもマッチしない扱いとする（誤マッチや意図しない設定適用を防ぐ）。
  const isOutsideConfigDir =
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith('..' + path.sep);
  relativePath = relativePath.split(path.sep).join('/');

  // マッチしたすべてのパターンの設定を順番にマージする（後のパターンが勝つ）
  const resolved: {
    width?: number;
    height?: number;
    headerSize?: number;
    format?: RawImageFormat;
  } = {};

  if (parsed.patterns !== undefined) {
    if (!Array.isArray(parsed.patterns)) {
      throw buildPatternsArrayMigrationError(configPath);
    }

    parsed.patterns.forEach((entry: unknown, index: number) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(
          `Invalid .rawimagerc at "${configPath}": "patterns[${index}]" must be an object.`
        );
      }
      const record = entry as Record<string, unknown>;
      const match = validatePatternMatch(record.match, index, configPath);

      // 対象ファイルが configDir の外側にある場合はどのパターンにもマッチさせない
      // （構文の妥当性検証は行うが、マージには反映しない）
      if (isOutsideConfigDir || !globToRegExp(match).test(relativePath)) {
        return;
      }

      // 配列の後方が勝つ後勝ちマージ。フィールドごとに、値を resolved にマージする
      // "前" に検証する（Object.assign 後の最終値だけを検証すると、後続エントリに
      // 上書きされて最終値に現れない「負けたエントリ」の型不正を見逃してしまうため）。
      // "match" 以外の未知フィールド（タイプミス等）は従来どおり無視する。
      if ('width' in record) {
        resolved.width = validatePatternEntryInteger(record.width, 'width', index, configPath, 1);
      }
      if ('height' in record) {
        resolved.height = validatePatternEntryInteger(
          record.height,
          'height',
          index,
          configPath,
          1
        );
      }
      if ('headerSize' in record) {
        resolved.headerSize = validatePatternEntryInteger(
          record.headerSize,
          'headerSize',
          index,
          configPath,
          0
        );
      }
      if ('format' in record) {
        resolved.format = validatePatternEntryFormat(record.format, index, configPath);
      }
    });
  }

  const width = validatePositiveInteger(resolved.width, 'width', configPath);
  const height = validatePositiveInteger(resolved.height, 'height', configPath);
  const headerSize = validateNonNegativeInteger(resolved.headerSize ?? 0, 'headerSize', configPath);
  const format = resolved.format ?? 'rgb24';

  // TypeScript の型があっても JSON 由来の値は実行時に検証が必要
  if (typeof format !== 'string' || !supportedFormats.includes(format as RawImageFormat)) {
    throw new Error(
      `Invalid .rawimagerc at "${configPath}": "format" must be one of ${supportedFormats.join(', ')}.`
    );
  }

  return { width, height, headerSize, format: format as RawImageFormat };
}

/**
 * .rawimagerc ファイルを読み込んでパースします。
 * parseRawImageConfig のファイル読み込み版です。
 */
export function loadRawImageConfig(configPath: string, targetFilePath: string): RawImageConfig {
  return parseRawImageConfig(fs.readFileSync(configPath, 'utf8'), configPath, targetFilePath);
}

// =============================================================================
// ファイル名からの設定推測
// =============================================================================

/**
 * 正規表現の特殊文字をエスケープします。
 * フォーマット名を正規表現パターンに安全に組み込むために使います。
 */
// 正規表現の特殊文字の一覧（フォーマット名マッチ用）
const REGEXP_SPECIAL_CHARS = new Set([
  '.',
  '*',
  '+',
  '?',
  '^',
  '$',
  '{',
  '}',
  '(',
  ')',
  '|',
  '[',
  ']',
  '\\',
]);

function escapeRegExp(value: string): string {
  // 文字を1つずつチェックし、特殊文字の前にバックスラッシュを挿入する
  return [...value].map((ch) => (REGEXP_SPECIAL_CHARS.has(ch) ? '\\' + ch : ch)).join('');
}

/**
 * ファイル名から幅・高さ・フォーマットを推測します。
 *
 * 例: `frame_1920x1080_rgb24.raw` → { width: 1920, height: 1080, format: 'rgb24' }
 *
 * 何も推測できない場合は null を返します。
 */
export function inferRawImageConfigFromFilename(filePath: string): Partial<RawImageConfig> | null {
  const baseName = path.parse(filePath).name.toLowerCase();

  // `数字x数字` のパターンを探す（例: 1920x1080）
  const sizeMatch = baseName.match(/(?:^|[^0-9])(\d+)x(\d+)(?:[^0-9]|$)/);
  const width = sizeMatch ? Number.parseInt(sizeMatch[1], 10) : undefined;
  const height = sizeMatch ? Number.parseInt(sizeMatch[2], 10) : undefined;

  // フォーマット名がファイル名に含まれているか確認する
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

// =============================================================================
// フォールバック設定の解決（.rawimagerc がない場合）
// =============================================================================

/**
 * ファイル名推測とフォールバック設定を組み合わせて RawImageConfig を解決します。
 *
 * width と height のどちらも解決できない場合は config: null を返します。
 * この場合 Webview には設定ガイドの画面が表示されます。
 */
export function resolveFallbackRawImageConfig(
  filePath: string,
  settings: RawImageFallbackSettings = {}
): ResolvedRawImageConfig {
  // 入力値を再検証する（外部から直接呼ばれる公開 API のため）
  const validatedSettings: RawImageFallbackSettings = {
    defaultWidth: validateOptionalPositiveInteger(
      settings.defaultWidth,
      'defaultWidth',
      'rawviewer fallback settings'
    ),
    defaultHeight: validateOptionalPositiveInteger(
      settings.defaultHeight,
      'defaultHeight',
      'rawviewer fallback settings'
    ),
    defaultHeaderSize: validateOptionalNonNegativeInteger(
      settings.defaultHeaderSize,
      'defaultHeaderSize',
      'rawviewer fallback settings'
    ),
    defaultFormat: validateOptionalFormat(
      settings.defaultFormat,
      'defaultFormat',
      'rawviewer fallback settings'
    ),
    inferFromFilename: settings.inferFromFilename ?? true,
  };

  const inferred = validatedSettings.inferFromFilename
    ? inferRawImageConfigFromFilename(filePath)
    : null;

  const width = inferred?.width ?? validatedSettings.defaultWidth;
  const height = inferred?.height ?? validatedSettings.defaultHeight;

  if (width === undefined || height === undefined) {
    return { config: null };
  }

  // 設定ソースを判定（ファイル名推測・設定のどちらを使ったか）
  // inferRawImageConfigFromFilename() は width/height/format のいずれか1つでも
  // 推測できた場合にのみ非 null を返す（すべて undefined なら null）。そのため
  // inferred !== null は「width/height/format のいずれかを推測できた」と同値。
  const usedInference = inferred !== null;
  const usedSettings =
    validatedSettings.defaultWidth !== undefined ||
    validatedSettings.defaultHeight !== undefined ||
    validatedSettings.defaultHeaderSize !== undefined ||
    validatedSettings.defaultFormat !== undefined;

  let source: import('./types').RawImageConfigSource = 'settings';
  if (usedInference && usedSettings) {
    source = 'filename+settings';
  } else if (usedInference) {
    source = 'filename';
  }

  return {
    config: {
      width,
      height,
      // inferRawImageConfigFromFilename() はファイル名から headerSize を推測しないため、
      // 常に validatedSettings.defaultHeaderSize（ワークスペース設定）にフォールバックする。
      headerSize: validatedSettings.defaultHeaderSize ?? 0,
      format: inferred?.format ?? validatedSettings.defaultFormat ?? 'rgb24',
    },
    source,
  };
}
