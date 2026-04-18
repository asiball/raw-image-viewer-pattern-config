# Raw Image Viewer

この VS Code 拡張機能は、バイナリ形式の RAW 画像ファイルをエディタ上で直接表示するためのツールです。Canvas ベースのレンダラーを使用し、多彩なピクセルフォーマットに対応しています。

## 特徴

- バイナリ画像ファイル（`.raw`, `.bin`, `.data`, `.img`, `.gray`, `.yuv`）を画像として表示。
- `.rawimagerc` ファイルによる詳細なレンダリング設定（ディレクトリ階層を遡って検索）。
- `.rawimagerc` がない場合でも、ファイル名（例: `frame_1920x1080_rgb24.raw`）やワークスペース設定から推論。
- `.rawimagerc` の編集時にスキーマベースのオートコンプリートとバリデーションを提供。
- エクスプローラーの右クリックメニュー「**Open as Raw Image**」から任意のファイルを開くことが可能。
- 各種ピクセルフォーマット（RGB, BGR, グレースケール, YUV, Float32 等）をサポート。
- レンダリングされた画像を PNG としてエクスポート可能。
- ズーム（Ctrl+スクロール）、パン（ドラッグ）、ウィンドウレベル調整（グレースケール/Float32時）に対応。

## 設定方法: `.rawimagerc`

バイナリファイルと同じディレクトリ、または親ディレクトリに `.rawimagerc` ファイルを作成して設定を記述します。

```json
{
  "width": 640,
  "height": 480,
  "headerSize": 0,
  "format": "rgb24"
}
```

### 設定項目

| フィールド | 型 | デフォルト | 説明 |
| :--- | :--- | :--- | :--- |
| `width` | integer | (必須) | 画像の幅（ピクセル） |
| `height` | integer | (必須) | 画像の高さ（ピクセル） |
| `headerSize` | integer | `0` | ファイル先頭でスキップするバイト数 |
| `format` | enum | `"rgb24"` | ピクセルフォーマット（下記参照） |

### サポートされているピクセルフォーマット

| フォーマット | 説明 | 1ピクセルあたりのバイト数 |
| :--- | :--- | :--- |
| `gray8` | 8-bit グレースケール | 1 |
| `gray16le` | 16-bit グレースケール (リトルエンディアン) | 2 |
| `gray16be` | 16-bit グレースケール (ビッグエンディアン) | 2 |
| `rgb24` | 24-bit RGB | 3 |
| `bgr24` | 24-bit BGR | 3 |
| `rgba32` | 32-bit RGBA | 4 |
| `bgra32` | 32-bit BGRA | 4 |
| `yuv420p` | Planar YUV 4:2:0 | 1.5 |
| `nv12` | Semi-planar YUV 4:2:0 | 1.5 |
| `yuyv422` | Packed YUV 4:2:2 | 2 |
| `float32` | 32-bit float グレースケール | 4 |
| `depth16` | 16-bit depth (リトルエンディアン) | 2 |

- `yuv420p` と `nv12` は、画像の幅と高さが偶数である必要があります。
- `yuyv422` は、画像の幅が偶数である必要があります。
- `float32` と `depth16` では、表示後にスライダーで最小/最大範囲（ウィンドウレベル）を調整できます。

## 使い方

1. 画像ファイルと同じディレクトリに `.rawimagerc` を配置するか、ワークスペース設定でデフォルト値を設定します。
2. 対応する拡張子（`.raw`, `.bin` 等）のファイルを開くと、自動的にレンダラーが起動します。
3. その他のファイルは、右クリックから「**Open as Raw Image**」を選択してください。
4. キャンバス上部の「**Export PNG**」ボタンで、現在の表示を `.png` ファイルとして保存できます。

## デフォルト設定（フォールバック）

`.rawimagerc` が存在しない場合に備え、以下の設定をワークスペース設定（`settings.json`）に追加できます。

```json
{
  "rawviewer.defaultWidth": 1920,
  "rawviewer.defaultHeight": 1080,
  "rawviewer.defaultHeaderSize": 0,
  "rawviewer.defaultFormat": "rgb24",
  "rawviewer.inferFromFilename": true
}
```

`rawviewer.inferFromFilename` が `true` の場合、`capture_1280x720_gray8.raw` のようなファイル名から自動的に幅、高さ、フォーマットを推論します。

## 開発者向け

### セットアップ

リポジトリをクローンした後、以下のコマンドを実行して依存関係をインストールし、初回ビルドを行ってください。

```bash
npm install
npm run compile
```

### デバッグ実行

VS Code でこのプロジェクトを開き、`F5` キーを押すと、別の VS Code ウィンドウ（拡張機能開発ホスト）が立ち上がります。

- デバッグ開始時に `test-data/generate_images.py` が自動的に走り、テスト用のバイナリ画像が生成されます。
- `test-data/` フォルダが自動的に開かれるので、生成された `.raw` ファイルなどを開いて動作を確認できます。

### 手動での画像生成

手動でテスト画像を生成する場合は、以下のコマンドを実行してください。

```bash
python3 test-data/generate_images.py
```
