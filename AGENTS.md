# エージェント向け指示

## ビルド・Lint・テスト

```bash
npm run compile      # 3 段階: tsc -p ./（拡張本体） → tsc -p tsconfig.webview.json（Webview の型検査のみ、emit なし） → esbuild で src/webview/main.ts を out/webview/main.js にバンドル
npm run lint         # ESLint（src/ 配下すべてが対象。src/webview も含む）
npm run watch        # TypeScript ウォッチモード（拡張本体のみ。tsc -watch -p ./）
npm test             # フルスイート: compile + lint + vscode-test（Electron 必須）
```

テストを単独で実行する方法はない。テストランナー（`@vscode/test-cli`）は `out/test/**/*.test.js` に一致するファイルをすべて実行する。提出前に必ず `npm run lint && npm run compile` を実行すること。

**Webview（`src/webview/` 以下）を変更した場合、`npm run watch` だけでは `out/webview/main.js` は再生成されない。** 必ず `npm run compile` を実行してバンドルを更新すること。

## アーキテクチャ

外部ランタイム依存なしの VS Code 拡張。`src/` 配下は役割ごとに分割されている。

- `extension.ts` — VS Code 統合層。`RawImageEditorProvider` の実装、コマンド登録、設定探索・Webview 生成の呼び出しなど拡張のエントリポイント。
- `config.ts` — `.rawimagerc` の探索（`findConfigPath()`）・パース・検証、ファイル名からの推論、ワークスペース設定へのフォールバックなど設定解決ロジック。
- `decoder.ts` — 各ピクセルフォーマットのデコード処理（ストリーミングデコード状態管理、YUV/グレースケール/Float32 変換、ウィンドウ/レベル適用など）。`src/webview/main.ts` からも ES import で直接呼び出され、Extension 側（Node）と Webview 側（ブラウザ）で同一実装を共有する。
- `webviewHtml.ts` — Webview の HTML シェル（CSS を含む）を生成する（`buildWebviewHtml()` / `getWebviewHtml()`）。レンダリングロジック本体は持たず、`out/webview/main.js` を nonce 付き `<script src="...">` で読み込むだけ。
- `webview/main.ts` — Webview 内で実行される TypeScript 本体（旧 `webviewHtml.ts` のインライン JS に相当）。`decoder.ts` / `types.ts` を ES import で共有し、tsc（`tsconfig.webview.json`、DOM lib 付き）による型検査と ESLint の対象。esbuild で `out/webview/main.js` に IIFE 形式でバンドルされる。
- `types.ts` — 設定・フォーマット関連の型定義と定数。

**データフロー:**

1. `RawImageEditorProvider`（`CustomReadonlyEditorProvider` 実装、`extension.ts`）がファイルを開き、`WebviewPanel` を作成する。
2. Webview の HTML シェルは `webviewHtml.ts` の `getWebviewHtml()` が生成する。レンダリングロジックは独立したアセットファイル `out/webview/main.js`（`src/webview/main.ts` を esbuild でバンドルしたもの）として、nonce 付き `<script src="...">` から読み込まれる。
3. Extension が `config.ts` の `findConfigPath()` で `.rawimagerc` を探し（ファイル位置から上位ディレクトリへ `.editorconfig` 方式で探索）、`postMessage` で `render` メッセージを Webview へ送信する。
4. Webview は VS Code の Webview URI に対して `fetch()` でバイナリファイルを読み込み、設定で指定されたフォーマットに従って HTML5 `<canvas>` にピクセルを描画する（デコードロジックは `decoder.ts` 由来、ES import で共有）。

**メッセージプロトコル（Extension ↔ Webview）:**

- Webview → Extension: `{ type: 'ready' }`（acknowledgement を受け取るまでインターバルで送信）
- Extension → Webview: `{ type: 'render', config, fileUri, fileSize }` または `{ type: 'error', message }`

**起動タイミング:** Extension は 300 ms のフォールバックタイマーを設定し、`ready` ハンドシェイクが届かなくても `render` を送信する。また、5 秒間 `ready` を受信しなかった場合に警告を表示するタイマーも設定している。

## 仕様駆動ワークフロー

タスクに着手する前に `docs/` を確認し、実装後は必ずドキュメントを最新状態に保つ。

1. **確認**: `docs/basic-design.md` → `docs/detailed-design.md` の順に読み、変更対象の仕様を把握する。
2. **設計更新**: アーキテクチャ・メッセージ・ファイルフォーマット・Webview の挙動に触れる変更の場合は、コードより先に該当ドキュメントを更新する。
3. **実装**: ドキュメントに定義されたフロー・メッセージスキーマ・制約と一致するよう実装する。サイレントに新しい挙動を追加しない。
4. **同期確認**: 実装後、コードとドキュメントの記述が一致しているか確認する。ずれがある場合はドキュメントを修正してからコミットする。

- タスクが曖昧な場合、またはユーザー可視の挙動が変わる場合は、コーディング前に確認を取る。
- `docs/roadmap.md` の将来要件は実装の参考にしてよいが、ロードマップに記載されていない機能を勝手に追加しないこと。

## 主要な規約

- **Webview のロジックは `src/webview/main.ts` に TypeScript として実装されている。** `decoder.ts` / `types.ts` を ES import で直接共有し、`tsconfig.webview.json` による型検査と `eslint src` による Lint の対象になる（旧来の `.toString()` 埋め込みやバニラ JS 文字列テンプレートは廃止済み）。esbuild で `out/webview/main.js` に IIFE 形式でバンドルされ、`webviewHtml.ts` が生成する HTML から nonce 付き `<script src="...">` で読み込まれる。
- **CSP は厳格:** `script-src 'nonce-...'` のみ。`out/webview/main.js` を読み込む `<script>` タグにも nonce を付与すること（外部ファイルであっても nonce があれば CSP 上許可される。ソース URL 自体を許可リスト化するものではない）。
- **`localResourceRoots`** は開いたファイルのあるディレクトリと、拡張機能の `out/webview` ディレクトリ（バンドル済み `main.js` を Webview から読み込むため）を常に含む。設定ファイル（`.rawimagerc`）が別ディレクトリで見つかった場合はそのディレクトリも追加され、最大 3 ディレクトリになる。
- TypeScript の **strict モード**が有効。`tsc -p ./` と `tsc -p tsconfig.webview.json` の両方でクリーンにコンパイルできること。
- ESLint が適用するルール: `curly`、`eqeqeq`、`semi`、`no-throw-literal`、`@typescript-eslint/naming-convention`（import は camelCase または PascalCase）。`src/webview` も対象。
- サポートするピクセルフォーマットは `src/formats.ts` の `rawImageFormatDescriptors`（`Record<RawImageFormat, RawImageFormatDescriptor>`）という単一の記述子テーブルで定義される。`types.ts` の `supportedFormats` / `streamDecodableFormats` / `grayscaleStreamFormats`、`decoder.ts` のデコード処理、Webview の「設定未検出時のヘルプテーブル」はいずれもこのテーブルから導出される。**新しいフォーマットを追加する場合は `src/formats.ts` に 1 エントリを追加すること**（併せて `types.ts` の `RawImageFormat` 系型エイリアス、`schemas/rawimagerc.schema.json` の `enum`/`enumDescriptions`、`package.json` の `rawviewer.defaultFormat` の `enum` も更新する。これらの整合は `extension.test.ts` のテストで機械的に強制される）。

## GitHub Issues・PR の確認

作業開始前に `gh` コマンドでリポジトリの現状を把握すること。

```bash
gh issue list                   # オープンな Issue 一覧
gh issue list --label "priority: high"  # 優先度別フィルタ
gh issue view <number>          # Issue の詳細確認
gh pr list                      # オープンな PR 一覧
gh pr view <number>             # PR の詳細確認
```

- 対応する Issue が存在する場合は、PR 本文に `Closes #<number>` を記載して紐付ける。
- Issue を作成する場合は `gh issue create` を使用し、必ず優先度ラベルを付与する（後述）。
- PR を作成する場合は `gh pr create` を使用し、`.github/PULL_REQUEST_TEMPLATE.md` のチェックリストに従う。

## ブランチと PR の規約

ブランチプレフィックス: `feature/`, `fix/`, `copilot/`, `docs/`, `refactor/`

PR タイトルプレフィックス: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

`main` への直接プッシュは禁止。CI はすべての PR とプッシュに対して `npm run lint`、`npm run compile`、`npm run format:check`、`xvfb-run -a npm test`（vscode-test。ヘッドレス Linux では xvfb 必須）を実行する。

**コードを変更する場合は、変更を加える前にローカルブランチを作成すること。** 上記のブランチプレフィックスを使用し、AI エージェントの作業には `copilot/` を使用する。

**ブランチをプッシュする前に必ず CI が通ることをローカルで確認すること。**

```bash
npm run lint && npm run compile && npm run format:check
```

フォーマット違反がある場合は `npm run format` で修正してからコミット・プッシュすること。CI が失敗した状態でブランチをプッシュしない。

**ローカルのコード変更で止まらないこと。** AI エージェントがコードを変更した場合は、通常のフローを最後まで続けること: ローカルブランチ → コミット → ブランチのプッシュ → `main` を対象とした Pull Request のオープン。

**ブランチをプッシュしたら、必ず `main` を対象とした Pull Request を開くこと。** 何を変更したか、なぜ変更したかを明確に説明する。`.github/PULL_REQUEST_TEMPLATE.md` のチェックリストに従うこと。

## Issue 優先度の規約

Issue を作成またはトリアージする際は、必ず優先度ラベルを 1 つ付与すること:

- `priority: critical`
- `priority: high`
- `priority: medium`
- `priority: low`

AI エージェントが Issue を作成する場合は、これらの優先度ラベルのいずれかを必ず付与すること。AI が作成した Issue を優先度ラベルなしのままにしないこと。

## リリースバージョニングの規約

- リリースバージョンは `package.json`、`package-lock.json`、`CHANGELOG.md`、Git タグ（`v<version>`）、パッケージ済み VSIX ファイル名すべてで一致する単一の値として扱う。
- リリースタグを切る前に、同じブランチ/PR でバージョン管理されたメタデータを更新すること。Git タグだけに頼らないこと。
- タグ付けの前に `npm run validate:release` を実行すること。CI では、リリースタグが `package.json` と一致しない場合、または対応する `CHANGELOG.md` セクションが存在しない場合にリリースワークフローが失敗する。
- 対象リリース向けの GitHub マイルストーンやプロジェクトの使用は推奨するが、上記のバージョンチェックの代替にはならない。

## 能動的な改善提案

タスク完了後、または明示的に調査を依頼された場合は、以下の観点でリポジトリを確認し、気づいた点をユーザーに提案すること。

- **コードの品質**: 重複ロジック、エラー処理の抜け、型安全性の問題など
- **テストの網羅**: 未テストのパス・フォーマット・エッジケースがないか
- **ドキュメントの鮮度**: 実装と設計書のずれ、`roadmap.md` の実装済み項目の更新漏れ
- **機能の改善**: `roadmap.md` の将来要件のうち実装の足がかりになるものがないか
- **CI・リリース**: ワークフローやバージョン管理の改善余地

提案は実装の押しつけではなく、ユーザーが判断できるよう変更内容・期待効果・工数感を添えて伝えること。

---

以上。

このファイルを読んだ場合は "read AGENT.md" というメッセージを出力すること。
