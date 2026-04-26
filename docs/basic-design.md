# 基本設計書: Raw Image Viewer

## 1. 目的

本書は、VS Code 拡張機能 **Raw Image Viewer** の基本設計をまとめる。
本拡張は、生のバイナリ画像ファイルを VS Code のカスタムエディタで可視化することを目的とする。

## 2. 対象範囲

対象は現在の実装で提供している機能とする。

- `.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv` の自動オープン
- `.rawimagerc` による画像メタデータ指定
- ファイル名推論とワークスペース設定によるフォールバック
- Webview + Canvas による描画
- PNG 書き出し
- Fit-to-screen を含むズーム操作
- ピクセル位置と値の表示
- ファイル更新時の再描画

## 3. 全体構成

本拡張は以下の2層で構成される。

| 層 | 役割 |
| --- | --- |
| Extension Host | ファイル読み込み、設定解決、Webview へのメッセージ送信、保存処理 |
| Webview | 画像描画、UI 表示、ユーザー操作の受付 |

通信は `postMessage` を使った双方向メッセージで行う。

## 4. 主要コンポーネント

### 4.1 Custom Editor Provider

`rawviewer.rawImageEditor` を提供し、対象ファイルをカスタムエディタとして開く。
`openCustomDocument()` でドキュメントを生成し、`resolveCustomEditor()` で Webview を構成する。

### 4.2 設定解決

画像の幅・高さ・ヘッダーサイズ・フォーマットは次の優先順位で決定する。

1. `.rawimagerc`
2. ファイル名からの推論
3. ワークスペース設定

`.rawimagerc` はファイルの親ディレクトリを上位へたどって検索する。

### 4.3 画像デコード

画像形式ごとに RGBA へ変換して Canvas に描画する。
対応形式は以下のとおり。

- `gray8`, `gray16le`, `gray16be`
- `rgb24`, `bgr24`, `rgba32`, `bgra32`
- `yuv420p`, `nv12`, `yuyv422`
- `float32`, `depth16`

`float32` と `depth16` は輝度データとして扱い、自動ウィンドウ/レベルで表示する。

### 4.4 Webview UI

Webview は以下を担当する。

- Canvas 表示
- エラーメッセージ表示
- PNG エクスポート
- ズーム/パン操作
- Fit-to-screen 切り替え
- ウィンドウ/レベル調整
- ピクセル情報表示

## 5. 処理フロー

### 5.1 ファイルオープン

1. ユーザーが対象ファイルを開く
2. VS Code がカスタムエディタを起動する
3. Extension Host が `.rawimagerc` を探索する
4. 必要に応じてファイル名推論と設定フォールバックを適用する
5. Webview に `render` メッセージを送信する

### 5.2 描画開始

Webview は `ready` メッセージを送信し、拡張側はこれを受けて初回描画を開始する。
`ready` が届かない場合でも、一定時間後に初回描画を送る。

### 5.3 再描画

ファイル本体または `.rawimagerc` が変更された場合、再度設定を解決して Webview に `render` を送る。
短時間の連続変更はまとめて再描画する。

### 5.4 PNG 書き出し

Webview から `savePng` が送られると、拡張側が保存ダイアログを表示し、PNG データをファイルとして書き出す。

## 6. メッセージ仕様

### 6.1 Webview → Extension

| type | 内容 |
| --- | --- |
| `ready` | Webview の初期化完了通知 |
| `savePng` | 現在の描画結果を PNG として保存 |

### 6.2 Extension → Webview

| type | 内容 |
| --- | --- |
| `render` | 描画対象ファイルと設定を通知 |
| `error` | 読み込み・解析・保存エラーを通知 |

## 7. 設定

### 7.1 `.rawimagerc`

例:

```json
{
  "width": 640,
  "height": 480,
  "headerSize": 0,
  "format": "rgb24"
}
```

必須項目:

- `width`
- `height`

任意項目:

- `headerSize`
- `format`

### 7.2 ワークスペース設定

利用可能なフォールバック設定は以下。

- `rawviewer.defaultWidth`
- `rawviewer.defaultHeight`
- `rawviewer.defaultHeaderSize`
- `rawviewer.defaultFormat`
- `rawviewer.inferFromFilename`

## 8. 制約

- `yuv420p` と `nv12` は幅・高さが偶数である必要がある
- `yuyv422` は幅が偶数である必要がある
- Webview のスクリプトは nonce 付き CSP 下で実行する
- Webview からは対象ファイルのあるディレクトリ、または `.rawimagerc` のあるディレクトリのみ参照可能

## 9. エラーハンドリング

異常系はエラー文字列として Webview に通知する。
主な例は以下。

- `.rawimagerc` の JSON 解析失敗
- 必須項目不足
- 不正なフォーマット指定
- 保存時の I/O エラー

## 10. 今後の拡張余地

本書は現行実装を基準とする。
将来的には、ヒストグラム表示などを追加候補として扱える。

