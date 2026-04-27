/**
 * extension.ts — VS Code 拡張機能のエントリーポイント
 *
 * このファイルは VS Code との接続部分だけを担います。
 * ピクセルデコード → decoder.ts
 * 設定ファイル読み込み → config.ts
 * Webview HTML 生成 → webviewHtml.ts
 * 型定義 → types.ts
 *
 * 処理の流れ（データフロー）:
 *   1. VS Code がファイルを開く
 *   2. RawImageEditorProvider が Webview パネルを作成する
 *   3. .rawimagerc を探して設定を読み込む
 *   4. `render` メッセージを Webview に送信する
 *   5. Webview が canvas に画像を描画する
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// 他のモジュールから必要な型・関数をインポートする
// （import = 他のファイルで定義された部品を「借りてくる」）
import {
  findConfigPath,
  getConfigSearchDirectories,
  loadRawImageConfig,
  resolveFallbackRawImageConfig,
  validateOptionalFormat,
  validateOptionalNonNegativeInteger,
  validateOptionalPositiveInteger,
} from './config';
import type {
  InitialRenderHandshake,
  RawImageFallbackSettings,
  TimeoutCanceler,
  TimeoutScheduler,
} from './types';
import { buildWebviewHtml } from './webviewHtml';

// =============================================================================
// VS Code カスタムエディター: ドキュメント
// =============================================================================

/**
 * RawImageDocument — VS Code のドキュメントモデル。
 *
 * VS Code は「ドキュメント」（ファイルの中身）と「エディター」（表示画面）を
 * 分けて管理します。CustomDocument はそのドキュメント側の実装です。
 * このクラスはシンプルで、ファイルの URI（パス）を保持するだけです。
 */
class RawImageDocument implements vscode.CustomDocument {
  /** @param uri — 開いたファイルのパス（例: /repo/images/frame.raw） */
  constructor(public readonly uri: vscode.Uri) {}

  /** ドキュメントが閉じられたときに呼ばれる。解放するリソースはない。 */
  dispose(): void {}
}

// =============================================================================
// VS Code カスタムエディター: プロバイダー
// =============================================================================

/**
 * RawImageEditorProvider — カスタムエディターの本体。
 *
 * VS Code の `CustomReadonlyEditorProvider` インターフェースを実装します。
 * 「読み取り専用」カスタムエディターとして、.raw ファイルを開いたときに
 * Webview パネルを表示する責務を持ちます。
 *
 * 「インターフェース」とは「この機能を持ちなさい」という約束のようなもので、
 * `implements` キーワードでその約束を実装することを宣言します。
 */
class RawImageEditorProvider implements vscode.CustomReadonlyEditorProvider<RawImageDocument> {
  /** VS Code の設定ファイル（package.json）で定義したエディタータイプの識別子 */
  static readonly viewType = 'rawviewer.rawImageEditor';

  /**
   * VS Code にカスタムエディターを登録して、返される Disposable を返します。
   * Disposable とは「後で解放できるリソース」のことです。
   */
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

  /** `private readonly` = このクラスの中だけで使い、後から書き換えない */
  constructor(private readonly _context: vscode.ExtensionContext) {}

  /**
   * VS Code がファイルを開くたびに呼ばれ、ドキュメントオブジェクトを作成します。
   */
  openCustomDocument(uri: vscode.Uri): RawImageDocument {
    return new RawImageDocument(uri);
  }

  /**
   * ドキュメントに対応する Webview パネルを作成・設定します。
   * `async` = この中で `await`（非同期処理の完了を待つ）を使えます。
   *
   * @param document    開いたファイルの情報
   * @param webviewPanel VS Code が作成した Webview パネル
   * @param _token      キャンセル用トークン（今回は使わない。_ 始まりは使わない引数の慣習）
   */
  async resolveCustomEditor(
    document: RawImageDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    // 最初に .rawimagerc を探す（後でリフレッシュのたびに再探索する）
    let currentConfigPath = findConfigPath(document.uri.fsPath);

    /**
     * Webview のオプション（アクセスできるファイルの範囲など）を更新する。
     * .rawimagerc が別ディレクトリにある場合はそのディレクトリも追加する。
     */
    const updateWebviewOptions = (): void => {
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: getLocalResourceRoots(document.uri, currentConfigPath),
      };
    };

    updateWebviewOptions();

    // 最初の render メッセージをまだ送っていないかを管理するフラグ
    let initialPayloadSent = false;
    // ファイル変更後のリフレッシュを少し待つためのタイマー
    let refreshTimer: NodeJS.Timeout | undefined;

    /**
     * 設定を解決して Webview に `render` または `error` メッセージを送る。
     * ファイルを最初に開いたときと、.rawimagerc が変更されたときに呼ばれる。
     */
    const postRenderPayload = (): void => {
      // 最新の設定ファイルパスを再探索する
      currentConfigPath = findConfigPath(document.uri.fsPath);
      updateWebviewOptions();

      try {
        // 設定を解決: .rawimagerc があればそれを使い、なければファイル名推測とワークスペース設定にフォールバック
        const resolvedConfig = currentConfigPath
          ? {
              config: loadRawImageConfig(currentConfigPath, document.uri.fsPath),
              source: 'rawimagerc' as const,
            }
          : resolveFallbackRawImageConfig(
              document.uri.fsPath,
              getRawImageFallbackSettings(
                vscode.workspace.getConfiguration('rawviewer', document.uri)
              )
            );

        const fileStat = fs.statSync(document.uri.fsPath);
        const fileUri = webviewPanel.webview.asWebviewUri(document.uri).toString();

        // Webview に描画指示を送る（Webview は fetch でファイルを読み込み canvas に描画する）
        webviewPanel.webview.postMessage({
          type: 'render',
          config: resolvedConfig.config,
          configSource: resolvedConfig.source ?? null,
          fileUri,
          fileSize: fileStat.size,
        });
      } catch (err: unknown) {
        // エラーが起きたら Webview にエラーメッセージを送る
        webviewPanel.webview.postMessage({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    /** 初回の render メッセージを1度だけ送る。2回目以降は無視する。 */
    const sendInitialRenderPayload = (): void => {
      if (initialPayloadSent) {
        return;
      }
      initialPayloadSent = true;
      postRenderPayload();
    };

    /**
     * ファイルや設定の変更後、少し間を置いてから再描画する（デバウンス処理）。
     * 短時間に何度も変更が来ても最後の1回だけ処理する。
     */
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

    // Webview からの 'ready' メッセージを待つハンドシェイクを開始する
    // 300ms 以内に ready が届かなくても強制送信する（フォールバック）
    const initialRenderHandshake = createInitialRenderHandshake(sendInitialRenderPayload, () => {
      void vscode.window.showWarningMessage(
        'Raw Image Viewer: webview did not send a ready message. Open "Developer: Open Webview Developer Tools" and check console errors.'
      );
    });

    // Webview からのメッセージを受け取るリスナーを登録する
    const listener = webviewPanel.webview.onDidReceiveMessage(async (message) => {
      // 'ready' メッセージはハンドシェイクが処理する
      if (initialRenderHandshake.handleMessage(message.type)) {
        return;
      }

      // 'savePng' = Webview の「Export PNG」ボタンが押された
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
          void vscode.window.showInformationMessage(
            `Raw Image Viewer: Exported PNG to ${targetUri.fsPath}`
          );
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`Raw Image Viewer: Failed to export PNG. ${detail}`);
        }
      }
    });

    // パネルが閉じられたときに解放するリソースのリスト
    const panelDisposables: vscode.Disposable[] = [listener];

    /**
     * FileSystemWatcher を作成して、ファイルの変更を監視する。
     * Disposable に追加しておくことで、パネルが閉じられたときに自動解除できる。
     */
    const registerRefreshListeners = (watcher: vscode.FileSystemWatcher): void => {
      panelDisposables.push(watcher);
      panelDisposables.push(watcher.onDidChange(scheduleRefresh));
      panelDisposables.push(watcher.onDidCreate(scheduleRefresh));
      panelDisposables.push(watcher.onDidDelete(scheduleRefresh));
    };

    // 画像ファイル自体の変更を監視する
    registerRefreshListeners(
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(
          path.dirname(document.uri.fsPath),
          path.basename(document.uri.fsPath)
        )
      )
    );

    // ファイルから上に向かって各ディレクトリの .rawimagerc を監視する
    for (const dir of getConfigSearchDirectories(document.uri.fsPath)) {
      registerRefreshListeners(
        vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '.rawimagerc'))
      );
    }

    // Webview の HTML をセットする（webviewHtml.ts が生成する）
    webviewPanel.webview.html = buildWebviewHtml(webviewPanel.webview.cspSource);

    // パネルが閉じられたときのクリーンアップ処理
    webviewPanel.onDidDispose(() => {
      initialRenderHandshake.dispose();
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
      vscode.Disposable.from(...panelDisposables).dispose();
    });
  }
}

// =============================================================================
// ハンドシェイク: 起動タイミング制御
// =============================================================================

/**
 * Webview の起動ハンドシェイクを管理します。
 *
 * Webview は起動直後に 'ready' メッセージを送ってきます。
 * Extension は 'ready' を受け取ったら即座に 'render' を送り返します。
 * ただし、起動タイミングのずれで 'ready' が届かない場合に備えて
 * 300ms 後に強制送信するタイマーも持ちます。
 *
 * @param sendInitialRenderPayload 初回レンダリングを送る関数
 * @param showReadyWarning         5秒経っても ready が届かない場合の警告関数
 * @param scheduleTimeout          テスト時に差し替えられる setTimeout（省略可）
 * @param cancelTimeout            テスト時に差し替えられる clearTimeout（省略可）
 */
export function createInitialRenderHandshake(
  sendInitialRenderPayload: () => void,
  showReadyWarning: () => void,
  scheduleTimeout: TimeoutScheduler = setTimeout,
  cancelTimeout: TimeoutCanceler = clearTimeout
): InitialRenderHandshake {
  // 300ms 後に強制的に render を送るフォールバックタイマー
  const initialSendTimer = scheduleTimeout(() => {
    sendInitialRenderPayload();
  }, 300);

  // 5秒経っても ready が届かなかった場合に警告を出すタイマー
  const readyWarningTimer = scheduleTimeout(() => {
    showReadyWarning();
  }, 5000);

  return {
    handleMessage(messageType: string): boolean {
      if (messageType !== 'ready') {
        return false; // 'ready' 以外のメッセージは処理しない
      }

      // 'ready' を受け取ったので両方のタイマーをキャンセルして即座に render を送る
      cancelTimeout(initialSendTimer);
      cancelTimeout(readyWarningTimer);
      sendInitialRenderPayload();
      return true;
    },
    dispose(): void {
      // パネルが閉じられたときに未発火のタイマーをキャンセルする
      cancelTimeout(initialSendTimer);
      cancelTimeout(readyWarningTimer);
    },
  };
}

// =============================================================================
// Webview のリソースアクセス権設定
// =============================================================================

/**
 * Webview が fetch でアクセスできるディレクトリのリストを返します。
 *
 * VS Code のセキュリティ制限により、Webview は `localResourceRoots` に
 * 含まれるディレクトリのファイルしか読み込めません。
 * .rawimagerc が別ディレクトリにあるときは最大2ディレクトリになります。
 *
 * `Map` を使っているのは、同じディレクトリが重複して入らないようにするため。
 * Windows では大文字小文字を区別しないパス比較のためにキーを小文字化します。
 *
 * @param documentUri  開いたファイルの URI
 * @param configPath   .rawimagerc のパス（なければ undefined）
 */
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

// =============================================================================
// PNG エクスポート
// =============================================================================

/**
 * 保存ダイアログのデフォルトファイル名を作ります。
 * 例: `/repo/images/frame.raw` → `/repo/images/frame.png`
 *
 * @param documentUri 元のファイルの URI
 */
export function getSuggestedPngSaveUri(documentUri: vscode.Uri): vscode.Uri {
  const parsed = path.parse(documentUri.fsPath);
  return vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.png`));
}

/**
 * Webview の canvas.toDataURL() が返す Data URL を Uint8Array に変換します。
 * Data URL の形式: `data:image/png;base64,<base64文字列>`
 *
 * @param dataUrl Webview から送られてきた Data URL 文字列
 * @throws Data URL でない場合や PNG データでない場合
 */
export function decodePngDataUrl(dataUrl: unknown): Uint8Array {
  if (typeof dataUrl !== 'string') {
    throw new Error('Missing PNG data.');
  }

  const match = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Invalid PNG data received from the webview.');
  }

  // Base64 文字列を Buffer にデコードして Uint8Array に変換する
  return Uint8Array.from(Buffer.from(match[1], 'base64'));
}

// =============================================================================
// ワークスペース設定の読み込み
// =============================================================================

/**
 * VS Code のワークスペース設定から rawviewer の設定を読み込みます。
 *
 * `inspect()` を使うことで、グローバル設定よりワークスペース設定を優先するなど
 * 設定のスコープを正しく考慮できます。
 * （単純な `.get()` はスコープの優先順位を考慮しません）
 *
 * @param configuration VS Code のワークスペース設定オブジェクト
 */
function getRawImageFallbackSettings(
  configuration: vscode.WorkspaceConfiguration
): RawImageFallbackSettings {
  // スコープを考慮した設定値の取得ヘルパー
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

  // 各設定値をバリデーションしてから返す（不正な設定値はここでエラーになる）
  return {
    defaultWidth: validateOptionalPositiveInteger(
      defaultWidth,
      'defaultWidth',
      'rawviewer settings'
    ),
    defaultHeight: validateOptionalPositiveInteger(
      defaultHeight,
      'defaultHeight',
      'rawviewer settings'
    ),
    defaultHeaderSize: validateOptionalNonNegativeInteger(
      defaultHeaderSize,
      'defaultHeaderSize',
      'rawviewer settings'
    ),
    defaultFormat: validateOptionalFormat(defaultFormat, 'defaultFormat', 'rawviewer settings'),
    inferFromFilename: configuration.get<boolean>('inferFromFilename', true),
  };
}

// =============================================================================
// 拡張機能のライフサイクル
// =============================================================================

/**
 * activate — VS Code が拡張機能を有効化したときに1回だけ呼ばれます。
 *
 * `context.subscriptions` にコマンドやプロバイダーを登録します。
 * 拡張機能が無効化されたとき、VS Code が自動で `dispose()` を呼んで解放します。
 */
export function activate(context: vscode.ExtensionContext): void {
  // カスタムエディターを登録する（.raw ファイルを開いたときに使われる）
  context.subscriptions.push(RawImageEditorProvider.register(context));

  // コマンドパレットから任意のファイルを Raw Image Viewer で開くコマンド
  context.subscriptions.push(
    vscode.commands.registerCommand('rawviewer.openAsRawImage', async (uri?: vscode.Uri) => {
      if (!uri) {
        // コマンドパレットから呼んだ場合はアクティブエディターのファイルを使う
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          uri = editor.document.uri;
        }
      }
      if (uri) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          RawImageEditorProvider.viewType
        );
      }
    })
  );

  // .rawimagerc の雛形を作成・開くコマンド
  context.subscriptions.push(
    vscode.commands.registerCommand('rawviewer.createConfig', async () => {
      // 作成先ディレクトリを決める: アクティブファイルのディレクトリ → ワークスペースルート
      let targetDir: string | undefined;

      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        targetDir = path.dirname(activeEditor.document.uri.fsPath);
      } else {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          targetDir = workspaceFolders[0].uri.fsPath;
        }
      }

      if (!targetDir) {
        void vscode.window.showErrorMessage(
          'Raw Image Viewer: Could not determine where to create .rawimagerc. Open a file or workspace first.'
        );
        return;
      }

      const configUri = vscode.Uri.file(path.join(targetDir, '.rawimagerc'));

      // パターンベースの設定ファイルの雛形
      const template = {
        patterns: {
          '*': {
            width: 1920,
            height: 1080,
            headerSize: 0,
            format: 'rgb24',
          },
          '**/thumbnails/*.bin': {
            width: 128,
            height: 128,
          },
        },
      };

      try {
        try {
          await vscode.workspace.fs.stat(configUri);
          // ファイルが既に存在する場合はそのまま開く
        } catch {
          // ファイルが存在しない場合は新規作成する
          await vscode.workspace.fs.writeFile(
            configUri,
            Buffer.from(JSON.stringify(template, null, 2), 'utf8')
          );
        }
        const doc = await vscode.workspace.openTextDocument(configUri);
        await vscode.window.showTextDocument(doc);
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(
          `Raw Image Viewer: Failed to create .rawimagerc: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })
  );
}

/**
 * deactivate — VS Code が拡張機能を無効化するときに呼ばれます。
 * `context.subscriptions` のリソースは VS Code が自動で解放するので
 * ここでは特に何もしなくて大丈夫です。
 */
export function deactivate(): void {}
