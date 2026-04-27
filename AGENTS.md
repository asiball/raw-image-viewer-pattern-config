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

タスクに着手する前に `docs/` を確認し、実装後は必ずドキュメントを最新状態に保つ。

1. **確認**: `docs/basic-design.md` → `docs/detailed-design.md` の順に読み、変更対象の仕様を把握する。
2. **設計更新**: アーキテクチャ・メッセージ・ファイルフォーマット・Webview の挙動に触れる変更の場合は、コードより先に該当ドキュメントを更新する。
3. **実装**: ドキュメントに定義されたフロー・メッセージスキーマ・制約と一致するよう実装する。サイレントに新しい挙動を追加しない。
4. **同期確認**: 実装後、コードとドキュメントの記述が一致しているか確認する。ずれがある場合はドキュメントを修正してからコミットする。

- タスクが曖昧な場合、またはユーザー可視の挙動が変わる場合は、コーディング前に確認を取る。
- `docs/roadmap.md` の将来要件は実装の参考にしてよいが、ロードマップに記載されていない機能を勝手に追加しないこと。

## 主要な規約

- **Webview JS は意図的にバニラ JavaScript**（TypeScript ではない）。`getWebviewHtml()` 内の文字列として存在し、残りのコードベースと一緒にコンパイル・Lint できない。
- **CSP は厳格:** `script-src 'nonce-...'` のみ。インラインスクリプトはすべて nonce を使用すること。外部スクリプトは不可。
- **`localResourceRoots`** は開いたファイルのあるディレクトリを常に含む。設定ファイル（`.rawimagerc`）が別ディレクトリで見つかった場合はそのディレクトリも追加され、最大 2 ディレクトリになる。
- TypeScript の **strict モード**が有効。`tsc` でクリーンにコンパイルできること。
- ESLint が適用するルール: `curly`、`eqeqeq`、`semi`、`no-throw-literal`、`@typescript-eslint/naming-convention`（import は camelCase または PascalCase）。
- サポートするピクセルフォーマットは `getWebviewHtml()` 内の Webview の switch 文で完全に定義される。新しいフォーマットを追加するには、switch 文と設定未検出時に表示されるヘルプテーブルの両方を更新する必要がある。

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
