# エージェント向け指示

## ビルド・Lint・テスト

```bash
npm run compile      # TypeScript コンパイル (tsc)
npm run lint         # ESLint（src/ 対象）
npm run watch        # TypeScript ウォッチモード
npm test             # フルスイート: compile + lint + vscode-test（Electron 必須）
```

テストを単独で実行する方法はない。テストランナー（`@vscode/test-cli`）は `out/test/**/*.test.js` に一致するファイルをすべて実行する。提出前に必ず `npm run lint && npm run compile` を実行すること。

## アーキテクチャ

外部ランタイム依存なしの単一ファイル VS Code 拡張（`src/extension.ts`）。

**データフロー:**

1. `RawImageEditorProvider`（`CustomReadonlyEditorProvider` 実装）がファイルを開き、`WebviewPanel` を作成する。
2. Webview の HTML（レンダリングロジックを含む）は `getWebviewHtml()` がテンプレート文字列としてインラインで生成する。HTML/CSS/JS の独立したアセットファイルは存在しない。
3. Extension が `findConfigPath()` で `.rawimagerc` を探し（ファイル位置から上位ディレクトリへ `.editorconfig` 方式で探索）、`postMessage` で `render` メッセージを Webview へ送信する。
4. Webview は VS Code の Webview URI に対して `fetch()` でバイナリファイルを読み込み、設定で指定されたフォーマットに従って HTML5 `<canvas>` にピクセルを描画する。

**メッセージプロトコル（Extension ↔ Webview）:**

- Webview → Extension: `{ type: 'ready' }`（acknowledgement を受け取るまでインターバルで送信）
- Extension → Webview: `{ type: 'render', config, fileUri, fileSize }` または `{ type: 'error', message }`

**起動タイミング:** Extension は 300 ms のフォールバックタイマーを設定し、`ready` ハンドシェイクが届かなくても `render` を送信する。また、5 秒間 `ready` を受信しなかった場合に警告を表示するタイマーも設定している。

## 仕様駆動ワークフロー

- 挙動を変更する前に、まず `docs/basic-design.md` を読み、次に `docs/` 配下の詳細設計ドキュメントを確認する。
- ドキュメントを実装の真実の情報源として扱う。挙動が変わる場合はコードより先にドキュメントを更新する。
- タスクが曖昧な場合、またはユーザー可視の挙動が変わる場合は、コーディング前に確認を取る。
- アーキテクチャ・メッセージ・ファイルフォーマット・Webview の挙動に触れるコード変更を行う前に、設計ドキュメントの追加・更新を優先する。
- ドキュメントに定義されたフロー・メッセージスキーマ・制約と実装を常に一致させる。サイレントに新しい挙動を追加しない。

## 主要な規約

- **Webview JS は意図的にバニラ JavaScript**（TypeScript ではない）。`getWebviewHtml()` 内の文字列として存在し、残りのコードベースと一緒にコンパイル・Lint できない。
- **CSP は厳格:** `script-src 'nonce-...'` のみ。インラインスクリプトはすべて nonce を使用すること。外部スクリプトは不可。
- **`localResourceRoots`** は開いたファイルのあるディレクトリのみに設定する。Webview がフェッチできるのはそのファイルだけ。
- TypeScript の **strict モード**が有効。`tsc` でクリーンにコンパイルできること。
- ESLint が適用するルール: `curly`、`eqeqeq`、`semi`、`no-throw-literal`、`@typescript-eslint/naming-convention`（import は camelCase または PascalCase）。
- サポートするピクセルフォーマットは `getWebviewHtml()` 内の Webview の switch 文で完全に定義される。新しいフォーマットを追加するには、switch 文と設定未検出時に表示されるヘルプテーブルの両方を更新する必要がある。

## ブランチと PR の規約

ブランチプレフィックス: `feature/`, `fix/`, `copilot/`, `docs/`, `refactor/`

PR タイトルプレフィックス: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

`main` への直接プッシュは禁止。CI はすべての PR とプッシュに対して `npm run lint` と `npm run compile` を実行する。

**コードを変更する場合は、変更を加える前にローカルブランチを作成すること。** 上記のブランチプレフィックスを使用し、AI エージェントの作業には `copilot/` を使用する。

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

---

以上。

このファイルを読んだ場合は "read AGENT.md" というメッセージを出力すること。
